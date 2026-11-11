// End-to-end offline smoke: real Codex/MCP -> authenticated model bridge -> cloud
// account/entitlements/ledger -> scripted provider. No paid service is called.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const cloudRequire = createRequire(
  new URL("../services/cloud/package.json", import.meta.url),
);
const { PGlite } = cloudRequire("@electric-sql/pglite");
const { schema } = await tsImport(
  "../services/cloud/src/db.ts",
  import.meta.url,
);
const { createCloudServer } = await tsImport(
  "../services/cloud/src/server.ts",
  import.meta.url,
);
const { grantProduct } = await tsImport(
  "../services/cloud/src/domain.ts",
  import.meta.url,
);
const { startModelBridge } = await tsImport(
  "../src/lib/runtime/model-bridge.ts",
  import.meta.url,
);
const { runCodexTailoring } = await tsImport(
  "../src/lib/runtime/codex-app-server.ts",
  import.meta.url,
);
const { createCareerTools } = await tsImport(
  "../src/lib/tasks/career-tools.ts",
  import.meta.url,
);
const { startCareerMcpServer } = await tsImport(
  "../src/lib/tasks/mcp-server.ts",
  import.meta.url,
);
const { testSnapshot, testProposal } = await tsImport(
  "../src/lib/tasks/test-fixtures.ts",
  import.meta.url,
);

const pg = new PGlite();
await pg.exec(schema);
const wrap = (handle) => ({
  query: async (sql, values) => {
    const r = await handle.query(sql, values);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  },
  transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
});
const db = wrap(pg);
let calls = 0;
const model = {
  id: "synthetic-platform",
  label: "Synthetic",
  upstreamModel: "synthetic-upstream",
  baseUrl: "https://offline.invalid/v1",
  apiKey: "synthetic-platform-key",
  protocol: "responses",
  maxOutputTokens: 4096,
  maxRequestBytes: 256000,
  inputUnitsPerMillion: 1000,
  outputUnitsPerMillion: 2000,
};
const product = {
  id: "synthetic-bundle",
  name: "Synthetic bundle",
  kind: "bundle",
  term: "month",
  allowanceUnits: 1_000_000,
  modelDays: 31,
  storageBytes: 10000,
  models: [model.id],
  priceLabel: "Synthetic",
};
const storage = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
};
const provider = async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.model, model.upstreamModel);
  calls++;
  const name = [
    "read_resume",
    "read_job",
    "read_evidence",
    "submit_tailoring_proposal",
  ][calls - 1];
  const args = JSON.stringify(
    name === "submit_tailoring_proposal" ? testProposal : {},
  );
  const item = name
    ? {
        type: "function_call",
        id: `item_${calls}`,
        call_id: `call_${calls}`,
        namespace: "mcp__career",
        name,
        arguments: args,
        status: "completed",
      }
    : {
        type: "message",
        id: `item_${calls}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(testProposal),
            annotations: [],
          },
        ],
      };
  const payload = {
    id: `response_${calls}`,
    object: "response",
    created_at: 1,
    model: model.id,
    status: "in_progress",
    output: [],
    usage: null,
  };
  const frames = [];
  const event = (type, data) =>
    frames.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
  event("response.created", { response: payload });
  event("response.output_item.added", {
    output_index: 0,
    item: name
      ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, status: "in_progress", content: [] },
  });
  if (name)
    event("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: 0,
      delta: args,
    });
  else
    event("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: JSON.stringify(testProposal),
    });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", {
    response: {
      ...payload,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return new Response(frames.join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
};
const cloud = await createCloudServer({
  db,
  storage,
  products: [product],
  models: [model],
  fetch: provider,
  rateLimit: false,
});
cloud.addHook("onSend", async (request, reply, payload) => {
  if (reply.statusCode >= 400)
    console.error(
      "Synthetic platform rejection",
      reply.statusCode,
      Object.keys(request.body ?? {}),
      typeof payload === "string" ? payload : "",
    );
  return payload;
});
let bridge, mcp;
try {
  const origin = await cloud.listen({ host: "127.0.0.1", port: 0 });
  const login = await cloud.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "synthetic@example.test",
      password: "synthetic-password-12345",
    },
  });
  assert.equal(login.statusCode, 200);
  const account = login.json();
  await grantProduct(db, account.account.id, product, "synthetic-receipt");
  bridge = await startModelBridge({
    apiKey: account.token,
    model: model.id,
    baseUrl: `${origin}/v1/ai`,
    source: "platform",
    protocol: "responses",
    timeoutMs: 30000,
  });
  const tools = createCareerTools(testSnapshot, async () => {});
  mcp = await startCareerMcpServer(tools);
  const result = await runCodexTailoring({
    config: {
      apiKey: bridge.apiKey,
      model: model.id,
      baseUrl: bridge.baseUrl,
      timeoutMs: 30000,
    },
    signal: new AbortController().signal,
    tools: { ...mcp, getProposal: () => tools.proposal },
  });
  assert.deepEqual(result.proposal, testProposal);
  assert.equal(calls, 5);
  const records = (
    await db.query(
      "SELECT status,charged_units FROM cloud_usage WHERE account_id=$1",
      [account.account.id],
    )
  ).rows;
  assert.equal(records.length, 5);
  assert(
    records.every((r) => r.status === "settled" && Number(r.charged_units) > 0),
  );
  console.log(
    "Platform smoke passed: actual Codex + MCP, account auth, model gateway, 5 exactly-once usage settlements; no live model.",
  );
} finally {
  await bridge?.close();
  await mcp?.close();
  await cloud.close();
  await pg.close();
}
