import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "./db";
import { schema } from "./db";
import { createCloudServer } from "./server";
import { defaultProducts, type PlatformModel, type Product } from "./config";
import { encryptedStorage, type ObjectStorage } from "./storage";
import { grantProduct } from "./domain";
import { reconcileUploads } from "./documents";
import { resolveUncertainUsage } from "./usage";

let pg: PGlite,
  db: Database,
  app: Awaited<ReturnType<typeof createCloudServer>>,
  alice: { token: string; account: { id: string; email: string } },
  bob: typeof alice;
const objects = new Map<string, Buffer>();
const plain: ObjectStorage = {
  put: async (k, d) => {
    objects.set(k, d);
  },
  get: async (k) => objects.get(k) ?? null,
  delete: async (k) => {
    objects.delete(k);
  },
};
const storage = encryptedStorage(plain, Buffer.alloc(32, 7));
const model: PlatformModel = {
  id: "test-model",
  label: "Synthetic model",
  upstreamModel: "fake-upstream",
  baseUrl: "https://fake.invalid/v1",
  apiKey: "fake-platform-secret",
  protocol: "responses",
  maxOutputTokens: 512,
  maxRequestBytes: 100_000,
  inputUnitsPerMillion: 1000,
  outputUnitsPerMillion: 2000,
};
const bundle: Product = {
  ...defaultProducts[0],
  id: "test-bundle",
  kind: "bundle",
  allowanceUnits: 10000,
  models: [model.id],
  storageBytes: 300,
};
let providerCalls = 0,
  lastUpstream:
    | { url: string; body: Record<string, unknown>; key: string | null }
    | undefined,
  providerMode: "json" | "disconnect" | "sse" | "reject" = "json";
const fakeFetch: typeof fetch = async (input, init) => {
  providerCalls++;
  const body = JSON.parse(String(init?.body));
  lastUpstream = {
    url: String(input),
    body,
    key: new Headers(init?.headers).get("Authorization"),
  };
  if (providerMode === "disconnect") throw new Error("simulated timeout");
  if (providerMode === "reject")
    return Response.json(
      { error: "private provider details" },
      { status: 429 },
    );
  if (providerMode === "sse") {
    const s =
      "event: response.completed\ndata: " +
      JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 400, output_tokens: 80 } },
      }) +
      "\n\n";
    const bytes = new TextEncoder().encode(s);
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7)
            c.enqueue(bytes.slice(i, i + 7));
          c.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  return Response.json({
    id: "fake-result",
    usage: { input_tokens: 400, output_tokens: 80 },
    output: [],
  });
};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(schema);
  const wrap = (handle: { query: PGlite["query"] }): Database =>
    ({
      query: async (sql: string, values?: unknown[]) => {
        const r = await handle.query(sql, values);
        return {
          rows: r.rows as Record<string, unknown>[],
          rowCount: r.affectedRows ?? r.rows.length,
        };
      },
      transaction: async (fn: (tx: Database) => Promise<unknown>) =>
        pg.transaction(async (tx) =>
          fn(wrap(tx as unknown as { query: PGlite["query"] })),
        ),
    }) as unknown as Database;
  db = wrap(pg);
  app = await createCloudServer({
    db,
    storage,
    products: [...defaultProducts, bundle],
    models: [model],
    fetch: fakeFetch,
    rateLimit: false,
    registrationCode: "test-invite",
  });
  for (const email of ["alice@example.test", "bob@example.test"]) {
    const r = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email,
        password: "synthetic-password-1234",
        registrationCode: "test-invite",
      },
    });
    expect(r.statusCode).toBe(200);
    const value = r.json();
    if (email.startsWith("alice")) alice = value;
    else bob = value;
  }
}, 30_000);
afterAll(async () => {
  await app?.close();
  await pg?.close();
});
describe("isolated cloud accounts, entitlements, private documents and usage", () => {
  it("rejects uninvited registration, wrong passwords and expired sessions", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/register",
          payload: {
            email: "bad@example.test",
            password: "synthetic-password-1234",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: {
            email: alice.account.email,
            password: "wrong-password-123456",
          },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/v1/me" })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: bob.account.email,
        password: "synthetic-password-1234",
      },
    });
    const token = login.json().token;
    await db.query(
      "UPDATE cloud_sessions SET expires_at=now()-interval '1 day' WHERE token_hash IN (SELECT token_hash FROM cloud_sessions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1)",
      [bob.account.id],
    );
    expect(
      (await app.inject({ url: "/v1/me", headers: auth(token) })).statusCode,
    ).toBe(401);
    // Reconnect Bob after the deliberate expiry.
    bob.token = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
          email: bob.account.email,
          password: "synthetic-password-1234",
        },
      })
    ).json().token;
  });
  it("keeps Agent rights, monthly/yearly/permanent terms and platform allowance separate", async () => {
    const before = (
      await app.inject({ url: "/v1/me", headers: auth(alice.token) })
    ).json();
    expect(before.agent.active).toBe(false);
    const product = defaultProducts.find((p) => p.id === "agent-lifetime")!;
    await grantProduct(db, alice.account.id, product, "lifetime-receipt");
    await grantProduct(db, alice.account.id, product, "lifetime-receipt");
    expect(
      (
        await db.query("SELECT id FROM cloud_grants WHERE account_id=$1", [
          alice.account.id,
        ])
      ).rows,
    ).toHaveLength(1);
    await expect(
      grantProduct(db, alice.account.id, bundle, "lifetime-receipt"),
    ).rejects.toMatchObject({ status: 409 });
    const me = (
      await app.inject({ url: "/v1/me", headers: auth(alice.token) })
    ).json();
    expect(me.agent).toMatchObject({ active: true, lifetime: true });
    expect(me.balances).toEqual([]);
    await grantProduct(db, alice.account.id, bundle, "bundle-receipt");
    const renewed = (
      await app.inject({ url: "/v1/me", headers: auth(alice.token) })
    ).json();
    expect(renewed.agent.lifetime).toBe(true);
    expect(renewed.balances[0].remainingUnits).toBe(10000);
    await grantProduct(
      db,
      bob.account.id,
      defaultProducts.find((p) => p.id === "agent-year")!,
      "year-receipt",
    );
    const b = (
      await app.inject({ url: "/v1/me", headers: auth(bob.token) })
    ).json();
    expect(b.agent.active).toBe(true);
    expect(b.agent.lifetime).toBe(false);
    expect(new Date(b.agent.until).getTime() - Date.now()).toBeGreaterThan(
      360 * 86400_000,
    );
  });
  it("requires upload consent, encrypts stored objects and isolates list/download/delete by owner", async () => {
    const headers = {
      ...auth(alice.token),
      "content-type": "application/octet-stream",
      "x-file-name": Buffer.from("测试简历.pdf").toString("base64url"),
      "x-file-type": "application/pdf",
      "idempotency-key": randomUUID(),
    };
    const data = Buffer.from("synthetic resume content");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/documents",
          headers,
          payload: data,
        })
      ).statusCode,
    ).toBe(400);
    const r = await app.inject({
      method: "POST",
      url: "/v1/documents",
      headers: { ...headers, "x-upload-consent": "true" },
      payload: data,
    });
    expect(r.statusCode).toBe(201);
    const doc = r.json().document;
    expect(doc.status).toBe("ready");
    const stored = [...objects.values()][0];
    expect(stored.includes(data)).toBe(false);
    expect(stored.subarray(0, 4).toString()).toBe("TF01");
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/documents",
      headers: { ...headers, "x-upload-consent": "true" },
      payload: data,
    });
    expect(repeated.json().document.id).toBe(doc.id);
    expect(
      (
        await app.inject({ url: "/v1/documents", headers: auth(bob.token) })
      ).json().documents,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          url: `/v1/documents/${doc.id}/content`,
          headers: auth(bob.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/documents/${doc.id}`,
          headers: auth(bob.token),
          payload: { revision: doc.revision },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/v1/documents/${doc.id}/content`,
          headers: auth(alice.token),
        })
      ).rawPayload,
    ).toEqual(data);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/documents/${doc.id}`,
          headers: auth(alice.token),
          payload: { revision: doc.revision - 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/documents/${doc.id}`,
          headers: auth(alice.token),
          payload: { revision: doc.revision },
        })
      ).statusCode,
    ).toBe(200);
    expect(objects.size).toBe(0);
    expect(
      (await app.inject({ url: "/v1/me", headers: auth(alice.token) })).json()
        .storage.usedBytes,
    ).toBe(0);
  });
  it("enforces storage quota and reconciles ambiguous uploads without duplicate reservations", async () => {
    const headers = {
      ...auth(alice.token),
      "content-type": "application/octet-stream",
      "x-file-name": Buffer.from("materials.txt").toString("base64url"),
      "x-file-type": "text/plain",
      "x-upload-consent": "true",
      "idempotency-key": randomUUID(),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/documents",
          headers,
          payload: Buffer.alloc(301),
        })
      ).statusCode,
    ).toBe(402);
    // The storage may finish a PUT and lose its acknowledgement.
    const originalPut = storage.put;
    storage.put = async (k, d) => {
      await originalPut(k, d);
      throw new Error("lost acknowledgement");
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/documents",
          headers,
          payload: Buffer.from("pending synthetic"),
        })
      ).statusCode,
    ).toBe(500);
    storage.put = originalPut;
    expect(
      (await app.inject({ url: "/v1/me", headers: auth(alice.token) })).json()
        .storage.reservedBytes,
    ).toBeGreaterThan(0);
    await db.query(
      "UPDATE cloud_documents SET created_at=now()-interval '20 minutes' WHERE account_id=$1 AND status='pending'",
      [alice.account.id],
    );
    expect(await reconcileUploads(db, storage)).toBe(1);
    const me = (
      await app.inject({ url: "/v1/me", headers: auth(alice.token) })
    ).json();
    expect(me.storage.reservedBytes).toBe(0);
    expect(me.storage.usedBytes).toBeGreaterThan(0);
  });
  it("blocks Agent-only model access and settles trusted upstream usage once", async () => {
    const key = randomUUID(),
      payload = {
        model: model.id,
        input: "synthetic prompt",
        max_output_tokens: 128,
      };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/ai/responses",
          headers: { ...auth(bob.token), "idempotency-key": key },
          payload,
        })
      ).statusCode,
    ).toBe(402);
    const r = await app.inject({
      method: "POST",
      url: "/v1/ai/responses",
      headers: { ...auth(alice.token), "idempotency-key": key },
      payload,
    });
    expect(r.statusCode).toBe(200);
    expect(lastUpstream?.body.model).toBe("fake-upstream");
    expect(lastUpstream?.key).toBe("Bearer fake-platform-secret");
    const n = providerCalls;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/ai/responses",
          headers: { ...auth(alice.token), "idempotency-key": key },
          payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(providerCalls).toBe(n);
    const rows = (
      await app.inject({ url: "/v1/usage", headers: auth(alice.token) })
    ).json().usage;
    expect(rows[0]).toMatchObject({
      status: "settled",
      input_tokens: 400,
      output_tokens: 80,
      charged_units: 2,
    });
    expect(
      (await app.inject({ url: "/v1/usage", headers: auth(bob.token) })).json()
        .usage,
    ).toEqual([]);
    const cat = await app.inject({ url: "/v1/catalog" });
    expect(cat.body).not.toContain(model.apiKey);
    expect(cat.body).not.toContain(model.baseUrl);
  });
  it("retains reservations after an uncertain result and releases rejected requests", async () => {
    providerMode = "disconnect";
    const r = await app.inject({
      method: "POST",
      url: "/v1/ai/responses",
      headers: { ...auth(alice.token), "idempotency-key": randomUUID() },
      payload: { model: model.id, input: "synthetic" },
    });
    expect(r.statusCode).toBe(502);
    const uncertain = (
      await app.inject({ url: "/v1/usage", headers: auth(alice.token) })
    ).json().usage[0];
    expect(uncertain.status).toBe("uncertain");
    expect(Number(uncertain.reserved_units)).toBeGreaterThan(0);
    expect(uncertain.charged_units).toBe(0);
    providerMode = "reject";
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/ai/responses",
      headers: { ...auth(alice.token), "idempotency-key": randomUUID() },
      payload: { model: model.id, input: "synthetic" },
    });
    expect(rejected.statusCode).toBe(502);
    expect(rejected.body).not.toContain("private provider");
    expect(
      (
        await app.inject({ url: "/v1/usage", headers: auth(alice.token) })
      ).json().usage[0].status,
    ).toBe("released");
    providerMode = "sse";
    const stream = await app.inject({
      method: "POST",
      url: "/v1/ai/responses",
      headers: { ...auth(alice.token), "idempotency-key": randomUUID() },
      payload: { model: model.id, input: "synthetic", stream: true },
    });
    expect(stream.statusCode).toBe(200);
    expect(
      (
        await app.inject({ url: "/v1/usage", headers: auth(alice.token) })
      ).json().usage[0].status,
    ).toBe("settled");
    providerMode = "json";
  });
  it("rejects native hosted tools and client-controlled billing/upstream fields", async () => {
    const n = providerCalls;
    for (const extra of [
      { tools: [{ type: "web_search" }] },
      { upstreamUrl: "http://127.0.0.1/secret" },
      { usage: { input_tokens: 0 } },
      { max_output_tokens: 999999 },
      {
        input: [
          {
            role: "user",
            content: [{ type: "input_file", file_id: "another-tenant-file" }],
          },
        ],
      },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ai/responses",
            headers: { ...auth(alice.token), "idempotency-key": randomUUID() },
            payload: { model: model.id, input: "synthetic", ...extra },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(providerCalls).toBe(n);
  });
  it("resolves uncertain usage once after operator review", async () => {
    const row = (
      await db.query(
        "SELECT * FROM cloud_usage WHERE account_id=$1 AND status='uncertain' LIMIT 1",
        [alice.account.id],
      )
    ).rows[0];
    expect(row).toBeTruthy();
    const before = (
      await db.query(
        "SELECT reserved_units FROM cloud_grants WHERE account_id=$1 AND id=$2",
        [alice.account.id, row.grant_id],
      )
    ).rows[0];
    await resolveUncertainUsage(
      db,
      alice.account.id,
      row.id,
      model,
      "released",
    );
    await resolveUncertainUsage(
      db,
      alice.account.id,
      row.id,
      model,
      "released",
    );
    const after = (
      await db.query(
        "SELECT reserved_units FROM cloud_grants WHERE account_id=$1 AND id=$2",
        [alice.account.id, row.grant_id],
      )
    ).rows[0];
    expect(Number(before.reserved_units) - Number(after.reserved_units)).toBe(
      Number(row.reserved_units),
    );
  });
  it("blocks expired Agent rights, expired model balances and exhausted quotas before a model call", async () => {
    const calls = providerCalls;
    await db.query(
      "UPDATE cloud_grants SET lifetime=false,agent_until=now()-interval '1 day' WHERE account_id=$1",
      [bob.account.id],
    );
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/ai/responses",
        headers: { ...auth(bob.token), "idempotency-key": randomUUID() },
        payload: { model: model.id, input: "synthetic" },
      });
    expect((await request()).statusCode).toBe(403);
    await grantProduct(db, bob.account.id, bundle, "bob-bundle");
    await db.query(
      "UPDATE cloud_grants SET model_until=now()-interval '1 day' WHERE account_id=$1",
      [bob.account.id],
    );
    expect((await request()).statusCode).toBe(402);
    await db.query(
      "UPDATE cloud_grants SET model_until=now()+interval '1 day',spent_units=allowance_units WHERE account_id=$1",
      [bob.account.id],
    );
    expect((await request()).statusCode).toBe(402);
    expect(providerCalls).toBe(calls);
  });
});
