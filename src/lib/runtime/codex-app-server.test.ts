import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexTailoring, codexCommand } from "./codex-app-server";
import { createCareerTools } from "@/lib/tasks/career-tools";
import { startCareerMcpServer } from "@/lib/tasks/mcp-server";
import { testProposal, testSnapshot } from "@/lib/tasks/test-fixtures";

afterEach(() => vi.unstubAllEnvs());

describe("Codex app-server boundary", () => {
  it("uses an isolated JSON-RPC process and authenticated scoped MCP tools, preserving usage and cleaning state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracefolio-fake-runtime-"));
    const report = join(root, "report.json");
    const require = createRequire(import.meta.url);
    const sdkRoot = dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
    const script = join(root, "fake.mjs");
    await writeFile(script, `
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from ${JSON.stringify(join(sdkRoot, "index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(join(sdkRoot, "streamableHttp.js"))};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const report = ${JSON.stringify(report)};
const proposal = ${JSON.stringify(testProposal)};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    await writeFile(report, JSON.stringify({ cwd: process.cwd(), home: process.env.CODEX_HOME, env: Object.keys(process.env), capabilities: message.params.capabilities }));
    send({id: message.id, result: {userAgent: "fake"}});
  } else if (message.method === "account/login/start") send({id: message.id, result: {type: "apiKey"}});
  else if (message.method === "thread/start") {
    send({id: message.id, result: {thread: {id: "thread-test"}}});
  } else if (message.method === "turn/start") {
    send({id: message.id, result: {turn: {id: "turn-test", status: "inProgress", items: []}}});
    send({method: "turn/started", params: {threadId: "thread-test", turn: {id: "turn-test", status: "inProgress"}}});
    const config = await readFile(join(process.env.CODEX_HOME, "config.toml"), "utf8");
    const url = JSON.parse(config.match(/^url = (.+)$/m)[1]);
    const client = new Client({name: "fake-model", version: "1"});
    const transport = new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {Authorization: "Bearer " + process.env.TRACEFOLIO_TOOLS_TOKEN}}});
    await client.connect(transport);
    for (const name of ["read_resume", "read_job", "read_evidence"]) {
      const result = await client.callTool({name, arguments: {}});
      if (result.isError) throw new Error("read failed");
    }
    const submitted = await client.callTool({name: "submit_tailoring_proposal", arguments: proposal});
    if (submitted.isError) throw new Error("proposal failed");
    await client.close();
    send({method: "thread/tokenUsage/updated", params: {threadId: "thread-test", tokenUsage: {total: {inputTokens: 120, cachedInputTokens: 20, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 170}, last: {}}}});
    send({method: "turn/completed", params: {threadId: "thread-test", turn: {id: "turn-test", status: "completed", items: []}}});
  }
}
`);
    vi.stubEnv("GITHUB_TOKEN", "must-not-inherit"); vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
    const tools = createCareerTools(testSnapshot, async () => {});
    const mcp = await startCareerMcpServer(tools);
    try {
      expect((await fetch(mcp.url, { method: "POST" })).status).toBe(401);
      const result = await runCodexTailoring({
        config: { apiKey: "fake-test-key", model: "fake-model", timeoutMs: 10_000 },
        tools: { ...mcp, getProposal: () => tools.proposal }, signal: new AbortController().signal,
        command: { executable: process.execPath, args: [script], version: "fake-test" },
      });
      expect(result.proposal).toEqual(testProposal); expect(result.metrics.usage?.inputTokens).toBe(120); expect(result.metrics.cost).toBeNull();
      const observed = JSON.parse(await readFile(report, "utf8"));
      expect(observed.env).not.toContain("GITHUB_TOKEN"); expect(observed.env).not.toContain("OPENAI_API_KEY");
      expect(observed.capabilities.experimentalApi).toBe(false);
      expect(existsSync(observed.cwd)).toBe(false); expect(existsSync(observed.home)).toBe(false);
    } finally { await mcp.close(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it("aborts an unresponsive process, removes temporary state, and never treats it as success", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracefolio-abort-test-"));
    const path = join(root, "idle.mjs"); const report = join(root, "report.json");
    await writeFile(path, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(report)},JSON.stringify({cwd:process.cwd(),home:process.env.CODEX_HOME}));setInterval(()=>{},1000);`);
    try {
      await expect(runCodexTailoring({
        config: { apiKey: "fake", model: "fake", timeoutMs: 400 },
        signal: new AbortController().signal, tools: { url: "http://127.0.0.1:1/mcp", token: "fake", getProposal: () => null },
        command: { executable: process.execPath, args: [path], version: "fake" },
      })).rejects.toThrow();
      const observed = JSON.parse(await readFile(report, "utf8")); expect(existsSync(observed.home)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("resolves the pinned CLI rather than a user's global Codex binary", () => {
    const command = codexCommand(); expect(command.version).toBe("0.167.1");
    expect(command.args.join(" ")).toContain("node_modules/@openai/codex/bin/codex.js app-server");
  });

  it("executes the native CLI and scoped MCP workflow against a local scripted Responses service", async () => {
    let requests = 0;
    const namespaces: string[] = [];
    const model = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      if (!request.url?.endsWith("/responses")) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] })); return; }
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests += 1;
      if (requests === 1) namespaces.push(...body.tools.map((tool: { name: string }) => tool.name));
      const name = ["read_resume", "read_job", "read_evidence", "submit_tailoring_proposal"][requests - 1];
      const id = `response_${requests}`;
      const args = JSON.stringify(name === "submit_tailoring_proposal" ? testProposal : {});
      const item = name
        ? { type: "function_call", id: `function_${requests}`, call_id: `call_${requests}`, namespace: "mcp__career", name, arguments: args, status: "completed" }
        : { type: "message", id: `message_${requests}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(testProposal), annotations: [] }] };
      const payload = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: "fake-model", status: "in_progress", output: [], usage: null };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("response.created", { response: payload });
      event("response.output_item.added", { output_index: 0, item: name ? { ...item, arguments: "", status: "in_progress" } : { ...item, status: "in_progress", content: [] } });
      if (name) event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args });
      else event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: JSON.stringify(testProposal) });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { ...payload, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      response.end();
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const tools = createCareerTools(testSnapshot, async () => {});
    const mcp = await startCareerMcpServer(tools);
    try {
      const result = await runCodexTailoring({
        config: { apiKey: "offline-fake-key", model: "fake-model", baseUrl: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 25_000 },
        signal: new AbortController().signal, tools: { ...mcp, getProposal: () => tools.proposal },
      });
      expect(result.proposal).toEqual(testProposal); expect(requests).toBe(5);
      expect(result.metrics.usage?.inputTokens).toBe(500);
      expect(namespaces).toContain("mcp__career");
      expect(namespaces.join(" ")).not.toMatch(/multi_agent|exec_command|shell|apply_patch|create_goal/);
    } finally {
      await mcp.close(); model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    }
  }, 35_000);
});
