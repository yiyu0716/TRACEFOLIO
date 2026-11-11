import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

let root: string, db: PrismaClient, connections: typeof import("./store");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tracefolio-connections-test-"));
  const path = join(root, "test.db");
  await writeFile(path, "");
  vi.stubEnv("DATABASE_URL", `file:${path}`);
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: process.env, stdio: "pipe" },
  );
  ({ prisma: db } = await import("@/lib/db"));
  connections = await import("./store");
}, 30000);
afterAll(async () => {
  await db?.$disconnect();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("local model connections", () => {
  it("encrypts separate provider keys and switches both Codex and existing AI workflows", async () => {
    const { runtimeConfig, runtimeBinding } =
      await import("@/lib/runtime/config");
    const first = await connections.createProfile(
      {
        label: "A",
        providerId: "openai",
        model: "fake-a",
        baseUrl: "https://a.invalid/v1",
        protocol: "responses",
        apiKey: "private-a",
      },
      db,
    );
    const second = await connections.createProfile(
      {
        label: "B",
        providerId: "deepseek",
        model: "fake-b",
        baseUrl: "https://b.invalid/v1",
        protocol: "chat_completions",
        apiKey: "private-b",
      },
      db,
    );
    expect(
      (await db.modelProfile.findUniqueOrThrow({ where: { id: first } }))
        .secret,
    ).not.toContain("private-a");
    expect(JSON.stringify(await connections.listConnections(db))).not.toContain(
      "private-",
    );
    await connections.selectProfile(first, db);
    const a = await runtimeConfig(db);
    expect(a?.model).toBe("fake-a");
    expect(a?.apiKey).toBe("private-a");
    expect((await connections.activeAiConfig(db))?.protocol).toBe("responses");
    await connections.selectProfile(second, db);
    const b = await runtimeConfig(db);
    expect(b?.protocol).toBe("chat_completions");
    expect(b?.apiKey).toBe("private-b");
    expect(runtimeBinding(a!)).not.toBe(runtimeBinding(b!));
    expect((await connections.activeAiConfig(db))?.model).toBe("fake-b");
    await connections.deleteProfile(second, db);
    expect((await connections.listConnections(db)).activeProfileId).toBeNull();
  });
  it("rejects credential-bearing URLs and forged platform profiles", async () => {
    await expect(
      connections.createProfile(
        {
          label: "x",
          providerId: "openai",
          model: "x",
          baseUrl: "https://key:secret@a.invalid/v1",
          protocol: "responses",
          apiKey: "test",
        },
        db,
      ),
    ).rejects.toThrow();
    await expect(
      connections.createProfile(
        {
          label: "x",
          kind: "platform",
          providerId: "openai",
          model: "x",
          baseUrl: "https://a.invalid/v1",
          protocol: "responses",
          apiKey: "test",
        },
        db,
      ),
    ).rejects.toThrow();
    await expect(
      connections.selectProfile("missing", db),
    ).rejects.toMatchObject({ status: 404 });
  });
});
