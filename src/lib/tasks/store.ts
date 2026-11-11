import { Prisma, type PrismaClient, type CareerTask } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CareerError } from "@/lib/career/store";
import type { Evidence, Memory } from "@/lib/career/domain";
import { buildAiResumeSnapshot } from "@/lib/ai/resume-snapshot";
import { resumeContentSchema } from "@/lib/resume-content";
import { approvalSchema, citationSources, createTaskSchema, digest, editableFields, validateProposal, type SourceRef, type TaskSnapshot } from "./domain";

export const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const plain = <T>(value: unknown) => JSON.parse(JSON.stringify(value)) as T;
const sourceMessage = "简历、岗位或授权材料已变化，请使用最新材料重新生成。";
class SourceChanged extends CareerError { constructor() { super(sourceMessage, 409); } }

async function capture(tx: Prisma.TransactionClient, request: TaskSnapshot["request"], memoryIds?: string[]): Promise<TaskSnapshot> {
  const [resume, job, evidence, memories] = await Promise.all([
    tx.resumeVersion.findUnique({ where: { id: request.resumeVersionId } }),
    tx.job.findUnique({ where: { id: request.jobId } }),
    tx.capabilityEvidence.findMany({ where: { id: { in: request.evidenceIds }, status: "accepted", useInAI: true }, orderBy: { id: "asc" } }),
    request.includeMemories ? tx.careerMemory.findMany({ where: {
      ...(memoryIds ? { id: { in: memoryIds } } : {}), confirmed: true, useInAI: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    }, orderBy: { id: "asc" }, take: 20 }) : Promise.resolve([]),
  ]);
  if (!resume || !job || evidence.length !== request.evidenceIds.length) throw new SourceChanged();
  if (!job.jd.trim()) throw new CareerError("请先为岗位保存完整 JD。");
  resumeContentSchema.parse(resume.content);
  return {
    request,
    resume: plain({ id: resume.id, resumeId: resume.resumeId, name: resume.name, updatedAt: resume.updatedAt, content: resume.content }),
    job: plain({ id: job.id, company: job.company, title: job.title, jd: job.jd, updatedAt: job.updatedAt }),
    evidence: plain<Evidence[]>(evidence), memories: plain<Memory[]>(memories),
  };
}

export function snapshotSources(snapshot: TaskSnapshot): SourceRef[] {
  return [
    { kind: "resume", sourceId: snapshot.resume.id, token: digest(snapshot.resume) },
    { kind: "job", sourceId: snapshot.job.id, token: digest(snapshot.job) },
    ...snapshot.evidence.map((item): SourceRef => ({ kind: "evidence", sourceId: item.id, token: digest(item) })),
    ...snapshot.memories.map((item): SourceRef => ({ kind: "memory", sourceId: item.id, token: digest(item) })),
  ];
}

export async function assertSnapshotCurrent(tx: Prisma.TransactionClient, snapshot: TaskSnapshot) {
  const current = await capture(tx, snapshot.request, snapshot.memories.map((item) => item.id));
  if (digest(snapshotSources(current)) !== digest(snapshotSources(snapshot))) throw new SourceChanged();
}

export async function createTailoringTask(raw: unknown, db: PrismaClient = prisma, modelBinding?:string) {
  const parsed = createTaskSchema.parse(raw);
  const request = { resumeVersionId: parsed.resumeVersionId, jobId: parsed.jobId, evidenceIds: [...new Set(parsed.evidenceIds)].sort(), includeMemories: parsed.includeMemories };
  return db.$transaction(async (tx) => {
    const previous = await tx.careerTask.findUnique({ where: { requestId: parsed.requestId } });
    if (previous) {
      if (digest((previous.input as unknown as TaskSnapshot).request) !== digest(request)) throw new CareerError("相同请求标识不能用于不同材料。", 409);
      return previous;
    }
    const snapshot = await capture(tx, request);
    if (!editableFields(snapshot.resume.content).length) throw new CareerError("所选简历没有可改写的文字，请先完善简历。");
    const modelInput = { resume: buildAiResumeSnapshot(snapshot.resume.content), job: snapshot.job, evidence: snapshot.evidence, memories: snapshot.memories };
    if (JSON.stringify(modelInput).length > 70_000) throw new CareerError("所选材料过长，请减少证据数量或缩短摘录。");
    const task = await tx.careerTask.create({ data: {
      requestId: parsed.requestId, input: asJson(snapshot), inputHash: digest(snapshot),
      modelBinding,
      sources: { create: snapshotSources(snapshot) },
      events: { create: { kind: "queued", message: "任务已排队，等待生成修改提案。" } },
    } });
    return task;
  });
}

export async function revalidateTask(id: string, db: PrismaClient = prisma) {
  const task = await db.careerTask.findUnique({ where: { id } });
  if (!task) throw new CareerError("任务不存在。", 404);
  if (["queued", "running", "awaiting_approval", "needs_input", "succeeded", "cancel_requested"].includes(task.status)) {
    try { await db.$transaction((tx) => assertSnapshotCurrent(tx, task.input as unknown as TaskSnapshot)); }
    catch (error) {
      if (!(error instanceof SourceChanged)) throw error;
      await db.careerTask.updateMany({ where: { id, revision: task.revision }, data: { status: "stale", error: sourceMessage, revision: { increment: 1 } } });
      return db.careerTask.findUniqueOrThrow({ where: { id } });
    }
  }
  return task;
}

export function taskSummary(task: CareerTask) {
  const snapshot = task.input as unknown as TaskSnapshot;
  return {
    id: task.id, status: task.status, revision: task.revision, error: task.error,
    resumeName: snapshot.resume.name, jobLabel: `${snapshot.job.company} · ${snapshot.job.title}`,
    createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
    resultVersionId: task.resultVersionId, model: task.model, metrics: task.metrics,
  };
}

export async function taskDetail(id: string, db: PrismaClient = prisma) {
  const task = await revalidateTask(id, db);
  const snapshot = task.input as unknown as TaskSnapshot;
  const checked = task.proposal ? validateProposal(task.proposal, snapshot) : null;
  return {
    ...taskSummary(task), proposal: checked?.proposal ?? null, warnings: checked?.warnings ?? [],
    approvalDigest: task.approvalDigest, sources: citationSources(snapshot),
    fields: editableFields(snapshot.resume.content).map(({ path, label }) => ({ path, label })),
    events: await db.careerTaskEvent.findMany({ where: { taskId: id }, orderBy: { id: "desc" }, take: 60 }),
  };
}

export async function approveTailoringTask(id: string, raw: unknown, db: PrismaClient = prisma) {
  const input = approvalSchema.parse(raw);
  try {
    return await db.$transaction(async (tx) => {
      const task = await tx.careerTask.findUnique({ where: { id } });
      if (!task) throw new CareerError("任务不存在。", 404);
      if (task.approvalDigest !== input.digest) throw new CareerError("确认内容与当前提案不一致，请刷新后核对。", 409);
      if (task.status === "succeeded" && task.resultVersionId) {
        await assertSnapshotCurrent(tx, task.input as unknown as TaskSnapshot);
        return { versionId: task.resultVersionId };
      }
      if (task.status !== "awaiting_approval" || task.revision !== input.revision) throw new CareerError("任务状态已变化，请刷新后重新核对。", 409);
      const snapshot = task.input as unknown as TaskSnapshot;
      await assertSnapshotCurrent(tx, snapshot);
      const { proposal, content } = validateProposal(task.proposal, snapshot);
      const expected = digest({ taskId: id, inputHash: task.inputHash, proposal });
      if (expected !== input.digest || !proposal.changes.length) throw new CareerError("提案校验失败。", 409);
      const claimed = await tx.careerTask.updateMany({ where: { id, revision: input.revision, status: "awaiting_approval" }, data: { status: "succeeded", revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new CareerError("该提案已被处理。", 409);
      const version = await tx.resumeVersion.create({ data: {
        resumeId: snapshot.resume.resumeId, jobId: snapshot.job.id,
        name: `证据定制-${snapshot.job.company}-${snapshot.job.title}`.slice(0, 200),
        summary: proposal.summary, content: asJson(content),
      } });
      await tx.careerTask.update({ where: { id }, data: { resultVersionId: version.id, finishedAt: new Date() } });
      await tx.careerTaskEvent.create({ data: { taskId: id, kind: "saved", message: "已确认并保存为新的简历版本。" } });
      return { versionId: version.id };
    });
  } catch (error) {
    if (error instanceof SourceChanged) await db.careerTask.updateMany({ where: { id, status: { in: ["awaiting_approval", "succeeded"] } }, data: { status: "stale", error: sourceMessage, revision: { increment: 1 } } });
    throw error;
  }
}

export async function cancelTask(id: string, revision: number, db: PrismaClient = prisma) {
  const task = await db.careerTask.findUnique({ where: { id } });
  if (!task) throw new CareerError("任务不存在。", 404);
  if (["cancelled", "cancel_requested"].includes(task.status)) return;
  if (!["queued", "running", "awaiting_approval", "needs_input"].includes(task.status)) throw new CareerError("当前任务不能取消。", 409);
  const changed = await db.careerTask.updateMany({ where: { id, revision, status: task.status }, data: {
    status: task.status === "running" ? "cancel_requested" : "cancelled", revision: { increment: 1 },
  } });
  if (!changed.count) throw new CareerError("任务状态已变化，请刷新。", 409);
}

export async function publishProposal(id: string, workerId: string, raw: unknown, metrics: unknown, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const task = await tx.careerTask.findUniqueOrThrow({ where: { id } });
    if (task.workerId !== workerId || task.status !== "running" || !task.leaseUntil || task.leaseUntil < new Date()) return false;
    const snapshot = task.input as unknown as TaskSnapshot;
    await assertSnapshotCurrent(tx, snapshot);
    const { proposal } = validateProposal(raw, snapshot);
    const status = proposal.changes.length ? "awaiting_approval" : "needs_input";
    await tx.careerTask.update({ where: { id }, data: {
      status, proposal: asJson(proposal), approvalDigest: digest({ taskId: id, inputHash: task.inputHash, proposal }),
      metrics: asJson(metrics), revision: { increment: 1 }, leaseUntil: null,
    } });
    await tx.careerTaskEvent.create({ data: { taskId: id, kind: status, message: proposal.changes.length ? "修改提案已完成，请逐项核对引用后确认保存。" : "现有材料不足以安全改写，请补充信息后重新创建任务。" } });
    return true;
  });
}
