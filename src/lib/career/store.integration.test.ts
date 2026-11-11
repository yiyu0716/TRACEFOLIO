import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let temporary: string;
let store: typeof import("./store");
let prisma: (typeof import("@/lib/db"))["prisma"];
const memory = {
  key: "目标岗位",
  category: "goal",
  content: "AI 后端开发",
  source: "本人填写",
  confirmed: true,
  useInAI: true,
};
const evidence = {
  title: "Retrieval service",
  sourceType: "artifact",
  sourceRef: "README:10",
  excerpt: "Python retrieval endpoint",
  contribution: "Implemented the endpoint",
  skills: ["Python"],
  status: "accepted",
  useInAI: true,
};

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "tracefolio-test-"));
  const url = `file:${join(temporary, "career.db")}`;
  // Prisma's SQLite migration engine expects the file to exist on this host.
  await writeFile(join(temporary, "career.db"), "");
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", "");
  vi.stubEnv("TRACEFOLIO_CODEX_MODEL", "");
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    },
  );
  store = await import("./store");
  ({ prisma } = await import("@/lib/db"));
}, 30_000);

afterEach(async () => {
  await prisma.growthAction.deleteMany();
  await prisma.capabilityEvidence.deleteMany();
  await prisma.careerMemory.deleteMany();
});
afterAll(async () => {
  await prisma?.$disconnect();
  await rm(temporary, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("persistent career workflows", () => {
  it("persists across reads and rejects contradictory keys and stale revisions", async () => {
    const created = await store.saveMemory(memory);
    expect((await store.getCareerState()).memories[0].content).toBe(
      memory.content,
    );
    await expect(
      store.saveMemory({ ...memory, content: "different" }),
    ).rejects.toMatchObject({ status: 409 });
    await store.saveMemory(
      { ...memory, content: "AI 应用工程师" },
      created.id,
      created.revision,
    );
    await expect(
      store.saveMemory(memory, created.id, created.revision),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.deleteCareerRecord("memory", created.id, created.revision),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.getCareerState()).memories[0].content).toBe(
      "AI 应用工程师",
    );
  });

  it("uses current consent on every retrieval and removes deleted records from later context", async () => {
    const created = await store.saveMemory({ ...memory, useInAI: false });
    expect(await store.getCareerGrounding("AI")).toBe("");
    const updated = await store.saveMemory(
      memory,
      created.id,
      created.revision,
    );
    expect(await store.getCareerGrounding("AI")).toContain(memory.content);
    await store.deleteCareerRecord("memory", updated.id, updated.revision);
    expect(await store.getCareerGrounding("AI")).toBe("");
  });

  it("keeps growth creation idempotent and invalidates completion when evidence changes or disappears", async () => {
    const proof = await store.saveEvidence(evidence);
    const input = {
      skill: "py",
      title: "Build a Python API",
      evidenceTarget: "A reproducible endpoint",
    };
    const action = await store.addGrowthAction(input);
    expect((await store.addGrowthAction(input)).id).toBe(action.id);
    const claim = await store.saveEvidence({
      ...evidence,
      sourceType: "self_report",
    });
    await expect(
      store.updateGrowthAction(action.id, claim.id),
    ).rejects.toMatchObject({ status: 400 });
    const done = await store.updateGrowthAction(action.id, proof.id);
    expect(done.status).toBe("done");
    const changed = await store.saveEvidence(
      { ...evidence, status: "rejected" },
      proof.id,
      proof.revision,
    );
    expect((await store.getCareerState()).actions[0]).toMatchObject({
      status: "open",
      completionEvidenceId: null,
    });
    const accepted = await store.saveEvidence(
      evidence,
      changed.id,
      changed.revision,
    );
    await store.updateGrowthAction(action.id, accepted.id);
    await store.deleteCareerRecord("evidence", accepted.id, accepted.revision);
    expect((await store.getCareerState()).actions[0]).toMatchObject({
      status: "open",
      completionEvidenceId: null,
    });
  });

  it("validates HTTP payloads, bounds actual request bytes, and refuses cross-site writes", async () => {
    const { POST } = await import("@/app/api/career/memories/route");
    const request = (body: string, origin = "http://localhost:3000") =>
      new Request("http://localhost:3000/api/career/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin },
        body,
      });
    expect(
      (await POST(request(JSON.stringify(memory), "https://unrelated.example")))
        .status,
    ).toBe(403);
    expect((await POST(request("{"))).status).toBe(400);
    expect(
      (await POST(request(JSON.stringify({ ...memory, confirmed: "yes" }))))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(JSON.stringify({ ...memory, content: "x".repeat(70_000) })),
        )
      ).status,
    ).toBe(413);
    expect((await POST(request(JSON.stringify(memory)))).status).toBe(201);
    const normalizedRequest = new Request(
      "http://localhost:3000/api/career/memories",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
        body: JSON.stringify({ ...memory, key: "loopback-origin-regression" }),
      },
    );
    expect((await POST(normalizedRequest)).status).toBe(201);
    const { GET } = await import("@/app/api/career/route");
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).memories).toHaveLength(2);
    const review = await import("@/app/api/career/review/route");
    const unavailable = await review.POST(
      new Request("http://localhost:3000/api/career/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredSkills: ["Python"] }),
      }),
    );
    expect(unavailable.status).toBe(503);
  });
});
