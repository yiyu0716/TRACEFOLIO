import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testProposal, testResume, testSnapshot } from "./test-fixtures";

let root: string;
let db: PrismaClient;
let store: typeof import("./store");
let worker: typeof import("./worker");
let career: typeof import("@/lib/career/store");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tracefolio-tasks-test-"));
  const path = join(root, "test.db"); await writeFile(path, "");
  const url = `file:${path}`; vi.stubEnv("DATABASE_URL", url);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  ({ prisma: db } = await import("@/lib/db"));
  store = await import("./store"); worker = await import("./worker"); career = await import("@/lib/career/store");
}, 30_000);

afterEach(async () => {
  await db.careerTask.deleteMany(); await db.careerWorker.deleteMany(); await db.resumeVersion.deleteMany();
  await db.resume.deleteMany(); await db.job.deleteMany(); await db.capabilityEvidence.deleteMany(); await db.careerMemory.deleteMany();
});
afterAll(async () => { await db?.$disconnect(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function seed(includeMemories = false) {
  await db.resume.create({ data: { id: "group-1", name: "测试" } });
  await db.resumeVersion.create({ data: { id: "resume-1", resumeId: "group-1", name: "测试简历", summary: "", content: store.asJson(testResume) } });
  await db.job.create({ data: { id: "job-1", company: "合成公司", title: "Python 开发", city: "", source: "test", jd: testSnapshot.job.jd, link: "" } });
  const { id, title, sourceType, sourceRef, excerpt, contribution, skills, status, useInAI } = testSnapshot.evidence[0];
  await db.capabilityEvidence.create({ data: { id, title, sourceType, sourceRef, excerpt, contribution, skills, status, useInAI } });
  if (includeMemories) await db.careerMemory.create({ data: { id: "memory-1", key: "目标", category: "goal", source: "test", content: "Python 后端", confirmed: true, useInAI: true, expiresAt: new Date(Date.now() + 60_000) } });
  return { requestId: randomUUID(), resumeVersionId: "resume-1", jobId: "job-1", evidenceIds: ["proof-1"], includeMemories };
}

const config = { apiKey: "fake-only", model: "fake-model", timeoutMs: 2000 };
const fakeExecutor: import("./worker").TaskExecutor = async ({ tools, onMeta }) => {
  await onMeta({ threadId: "fake-thread", turnId: "fake-turn", runtimeVersion: "fake", model: "fake-model" });
  for (const tool of ["read_resume", "read_job", "read_evidence"]) await tools.call(tool, {});
  await tools.call("submit_tailoring_proposal", testProposal);
  return { proposal: testProposal, metrics: { elapsedMs: 1, usage: { inputTokens: 100, outputTokens: 50 }, cost: null, costBasis: "synthetic" } };
};

async function generate(includeMemories = false) {
  const request = await seed(includeMemories); const task = await store.createTailoringTask(request, db);
  await worker.executeNextTask({ workerId: "test-worker", config, signal: new AbortController().signal, db, execute: fakeExecutor });
  return db.careerTask.findUniqueOrThrow({ where: { id: task.id } });
}

describe("durable tailoring workflow", () => {
  it("queues idempotently, generates a proposal without saving, and saves exactly once after explicit approval", async () => {
    const request = await seed(); const task = await store.createTailoringTask(request, db);
    expect((await store.createTailoringTask(request, db)).id).toBe(task.id);
    await expect(store.createTailoringTask({ ...request, includeMemories: true }, db)).rejects.toMatchObject({ status: 409 });
    await worker.executeNextTask({ workerId: "test-worker", config, signal: new AbortController().signal, db, execute: fakeExecutor });
    const ready = await db.careerTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(ready.status).toBe("awaiting_approval"); expect(await db.resumeVersion.count()).toBe(1);
    await expect(store.approveTailoringTask(task.id, { revision: ready.revision, digest: ready.approvalDigest, confirmed: false }, db)).rejects.toThrow();
    await expect(store.approveTailoringTask(task.id, { revision: ready.revision - 1, digest: ready.approvalDigest, confirmed: true }, db)).rejects.toMatchObject({ status: 409 });
    await expect(store.approveTailoringTask(task.id, { revision: ready.revision, digest: "0".repeat(64), confirmed: true }, db)).rejects.toMatchObject({ status: 409 });
    const approval = { revision: ready.revision, digest: ready.approvalDigest, confirmed: true };
    const result = await store.approveTailoringTask(task.id, approval, db);
    expect(await store.approveTailoringTask(task.id, approval, db)).toEqual(result);
    expect(await db.resumeVersion.count()).toBe(2);
    expect((await db.resumeVersion.findUniqueOrThrow({ where: { id: result.versionId } })).content).toMatchObject({ projects: [{ highlights: [testProposal.changes[0].after] }] });
    expect((await db.resumeVersion.findUniqueOrThrow({ where: { id: "resume-1" } })).content).toEqual(testResume);
  });

  it.each(["consent", "pending", "missing"])("refuses unavailable evidence before calling a model: %s", async (kind) => {
    const request = await seed();
    if (kind === "missing") await db.capabilityEvidence.deleteMany();
    else await db.capabilityEvidence.update({ where: { id: "proof-1" }, data: kind === "consent" ? { useInAI: false } : { status: "pending" } });
    await expect(store.createTailoringTask(request, db)).rejects.toMatchObject({ status: 409 });
    expect(await db.careerTask.count()).toBe(0);
  });

  it.each(["resume", "job", "evidence", "expiry"])("rechecks all source revisions at approval: %s", async (kind) => {
    const ready = await generate(kind === "expiry");
    if (kind === "resume") await db.resumeVersion.update({ where: { id: "resume-1" }, data: { content: store.asJson({ ...testResume, selfReview: "changed" }) } });
    if (kind === "job") await db.job.update({ where: { id: "job-1" }, data: { jd: "new requirements" } });
    if (kind === "evidence") await db.capabilityEvidence.update({ where: { id: "proof-1" }, data: { useInAI: false } });
    if (kind === "expiry") await db.careerMemory.update({ where: { id: "memory-1" }, data: { expiresAt: new Date(0) } });
    await expect(store.approveTailoringTask(ready.id, { revision: ready.revision, digest: ready.approvalDigest, confirmed: true }, db)).rejects.toMatchObject({ status: 409 });
    expect((await db.careerTask.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe("stale");
    expect(await db.resumeVersion.count()).toBe(1);
  });

  it("marks saved task provenance stale when evidence is revised, preserving the user's saved resume", async () => {
    const ready = await generate();
    await store.approveTailoringTask(ready.id, { revision: ready.revision, digest: ready.approvalDigest, confirmed: true }, db);
    const { title, sourceType, sourceRef, excerpt, contribution, skills, status, useInAI } = testSnapshot.evidence[0];
    await career.saveEvidence({ title, sourceType, sourceRef, excerpt: `${excerpt} 修正`, contribution, skills, status, useInAI }, "proof-1", 1);
    expect((await db.careerTask.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe("stale");
    expect(await db.resumeVersion.count()).toBe(2);
  });

  it("invalidates pending tasks on memory/evidence deletion and refuses a second stale approval", async () => {
    const ready = await generate(true);
    await career.deleteCareerRecord("memory", "memory-1", 1);
    expect((await db.careerTask.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe("stale");
    await career.deleteCareerRecord("evidence", "proof-1", 1);
    await expect(store.approveTailoringTask(ready.id, { revision: ready.revision, digest: ready.approvalDigest, confirmed: true }, db)).rejects.toMatchObject({ status: 409 });
  });

  it("claims work once, cancels late results, and records interrupted work without automatic replay", async () => {
    const request = await seed(); const task = await store.createTailoringTask(request, db);
    await worker.executeNextTask({ workerId: "worker-1", config, signal: new AbortController().signal, db, execute: async (input) => {
      expect(await worker.claimTask("worker-2", db)).toBeNull();
      const result = await fakeExecutor(input);
      const current = await db.careerTask.findUniqueOrThrow({ where: { id: task.id } });
      await store.cancelTask(task.id, current.revision, db);
      return result;
    } });
    expect((await db.careerTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("cancelled");
    expect(await db.resumeVersion.count()).toBe(1);
    const queued = await store.createTailoringTask({ ...request, requestId: randomUUID() }, db);
    await worker.claimTask("dead-worker", db);
    await db.careerTask.update({ where: { id: queued.id }, data: { leaseUntil: new Date(0) } });
    await worker.recoverExpiredTasks(db);
    expect((await db.careerTask.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("failed");
    expect(await worker.claimTask("worker-2", db)).toBeNull();
  });

  it("sanitizes runtime errors and never saves an unconfirmed proposal", async () => {
    const request = await seed(); const task = await store.createTailoringTask(request, db);
    await worker.executeNextTask({ workerId: "worker", config, signal: new AbortController().signal, db, execute: async () => { throw new Error("secret-provider-key"); } });
    const current = await db.careerTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.status).toBe("failed"); expect(current.error).not.toContain("secret-provider-key"); expect(await db.resumeVersion.count()).toBe(1);
  });

  it("filters unconfirmed, unconsented and expired memory from the task snapshot", async () => {
    const request = await seed(true);
    await db.careerMemory.update({ where: { id: "memory-1" }, data: { expiresAt: new Date(0) } });
    const task = await store.createTailoringTask(request, db);
    expect((task.input as unknown as import("./domain").TaskSnapshot).memories).toEqual([]);
    await db.careerMemory.update({ where: { id: "memory-1" }, data: { expiresAt: null, useInAI: false } });
    const another = await store.createTailoringTask({ ...request, requestId: randomUUID() }, db);
    expect((another.input as unknown as import("./domain").TaskSnapshot).memories).toEqual([]);
  });

  it("does not send queued materials to a changed model connection",async()=>{
    const {runtimeBinding}=await import("@/lib/runtime/config");
    const task=await store.createTailoringTask(await seed(),db,runtimeBinding(config));
    const execute=vi.fn(fakeExecutor);
    await worker.executeNextTask({workerId:"worker",config:{...config,apiKey:"another-account"},signal:new AbortController().signal,db,execute});
    expect(execute).not.toHaveBeenCalled();expect((await db.careerTask.findUniqueOrThrow({where:{id:task.id}})).status).toBe("failed");
  });

  it("provides bounded task APIs with origin checks, explicit confirmation and redacted configuration", async () => {
    const request = await seed();
    vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", "fake-private-test-key"); vi.stubEnv("TRACEFOLIO_CODEX_MODEL", "fake-model");
    const route = await import("@/app/api/career/tasks/route");
    const post = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/career/tasks", {
      method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
    });
    expect((await route.POST(post(request, "https://other.example"))).status).toBe(403);
    expect((await route.POST(post(request))).status).toBe(202);
    const listing = await route.GET(); expect(listing.headers.get("cache-control")).toBe("no-store");
    const text = await listing.text(); expect(text).not.toContain("fake-private-test-key"); expect(text).toContain('"runtimeAvailable":true');
    await worker.executeNextTask({ workerId: "worker", config:{...config,apiKey:"fake-private-test-key"}, signal: new AbortController().signal, db, execute: fakeExecutor });
    const task = await db.careerTask.findFirstOrThrow();
    const approve = await import("@/app/api/career/tasks/[id]/approve/route");
    const result = await approve.POST(post({ revision: task.revision, digest: task.approvalDigest, confirmed: true }), { params: Promise.resolve({ id: task.id }) });
    expect(result.status).toBe(200); expect((await result.json()).versionId).toBeTruthy();
    vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", ""); vi.stubEnv("TRACEFOLIO_CODEX_MODEL", "");
  });
});
