import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CareerError } from "@/lib/career/store";
import { runCodexTailoring, type RuntimeMeta, type RuntimeResult } from "@/lib/runtime/codex-app-server";
import { runtimeConfig, type RuntimeConfig } from "@/lib/runtime/config";
import { createCareerTools } from "./career-tools";
import { startCareerMcpServer } from "./mcp-server";
import { asJson, assertSnapshotCurrent, publishProposal } from "./store";
import type { TaskSnapshot, TailoringProposal } from "./domain";

export type TaskExecutor = (input: {
  config: RuntimeConfig; signal: AbortSignal;
  tools: ReturnType<typeof createCareerTools>;
  onMeta: (meta: RuntimeMeta) => Promise<void>;
}) => Promise<RuntimeResult>;

export const codexExecutor: TaskExecutor = async (input) => {
  const mcp = await startCareerMcpServer(input.tools);
  try {
    return await runCodexTailoring({ ...input, tools: { ...mcp, getProposal: () => input.tools.proposal } });
  } finally { await mcp.close(); }
};

export async function recoverExpiredTasks(db: PrismaClient = prisma) {
  // An interrupted model run is never replayed automatically: it may incur cost again.
  await db.careerTask.updateMany({
    where: { status: { in: ["running", "cancel_requested"] }, OR: [{ leaseUntil: { lt: new Date() } }, { leaseUntil: null }] },
    data: { status: "failed", error: "执行进程已中断。请核对任务后重新创建；系统没有自动重复调用模型。", leaseUntil: null, finishedAt: new Date(), revision: { increment: 1 } },
  });
}

export async function claimTask(workerId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const task = await tx.careerTask.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
    if (!task) return null;
    const claimed = await tx.careerTask.updateMany({ where: { id: task.id, status: "queued", revision: task.revision }, data: {
      status: "running", workerId, startedAt: new Date(), leaseUntil: new Date(Date.now() + 30_000), revision: { increment: 1 },
    } });
    if (!claimed.count) return null;
    await tx.careerTaskEvent.create({ data: { taskId: task.id, kind: "running", message: "开始阅读所选材料并生成修改提案。" } });
    return tx.careerTask.findUniqueOrThrow({ where: { id: task.id } });
  });
}

export async function executeNextTask(input: {
  workerId: string; config: RuntimeConfig; signal: AbortSignal; db?: PrismaClient; execute?: TaskExecutor;
}) {
  const db = input.db ?? prisma;
  const task = await claimTask(input.workerId, db);
  if (!task) return false;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const current = await db.careerTask.findUnique({ where: { id: task.id } });
      if (!current || current.workerId !== input.workerId || current.status !== "running") { controller.abort(); return; }
      await db.careerTask.updateMany({ where: { id: task.id, workerId: input.workerId, status: "running" }, data: { leaseUntil: new Date(Date.now() + 30_000) } });
      await db.careerWorker.upsert({ where: { id: input.workerId }, create: { id: input.workerId }, update: { heartbeatAt: new Date() } });
    } catch { controller.abort(); }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, 1000);
  try {
    const snapshot = task.input as unknown as TaskSnapshot;
    const tools = createCareerTools(snapshot, async () => {
      signal.throwIfAborted();
      const current = await db.careerTask.findUnique({ where: { id: task.id } });
      if (!current || current.status !== "running" || current.workerId !== input.workerId) throw new CareerError("任务已取消或依据已失效。", 409);
      await db.$transaction((tx) => assertSnapshotCurrent(tx, snapshot));
    }, async (message) => {
      const count = await db.careerTaskEvent.count({ where: { taskId: task.id } });
      if (count < 80) await db.careerTaskEvent.create({ data: { taskId: task.id, kind: "progress", message } });
    });
    await db.$transaction((tx) => assertSnapshotCurrent(tx, snapshot));
    const result = await (input.execute ?? codexExecutor)({
      config: input.config, signal, tools,
      onMeta: async (meta) => {
        await db.careerTask.updateMany({ where: { id: task.id, workerId: input.workerId, status: "running" }, data: {
          ...(meta.threadId ? { runtimeThreadId: meta.threadId } : {}),
          ...(meta.turnId ? { runtimeTurnId: meta.turnId } : {}),
          ...(meta.runtimeVersion ? { runtimeVersion: meta.runtimeVersion } : {}),
          ...(meta.model ? { model: meta.model } : {}),
        } });
      },
    });
    signal.throwIfAborted();
    if (!await publishProposal(task.id, input.workerId, result.proposal as TailoringProposal, result.metrics, db)) throw new Error("Task state changed before publication");
  } catch (error) {
    const current = await db.careerTask.findUnique({ where: { id: task.id } });
    if (current && current.workerId === input.workerId && ["running", "cancel_requested"].includes(current.status)) {
      const cancelled = current.status === "cancel_requested";
      const stale = error instanceof CareerError && error.status === 409;
      const status = cancelled ? "cancelled" : stale ? "stale" : "failed";
      const message = cancelled ? "任务已取消，没有保存简历。" : stale ? "依据材料已变化，请重新创建任务。" : "生成未完成。请检查 Codex 模型配置、服务连接或任务时限后重新创建。";
      await db.careerTask.updateMany({ where: { id: task.id, workerId: input.workerId, status: current.status }, data: { status, error: message, leaseUntil: null, finishedAt: new Date(), revision: { increment: 1 } } });
      await db.careerTaskEvent.create({ data: { taskId: task.id, kind: status, message } });
    }
  } finally { clearInterval(timer); }
  return true;
}

export async function startWorker(signal: AbortSignal, db: PrismaClient = prisma) {
  const workerId = randomUUID();
  try {
    while (!signal.aborted) {
      await db.careerWorker.upsert({ where: { id: workerId }, create: { id: workerId }, update: { heartbeatAt: new Date() } });
      await db.careerWorker.deleteMany({ where: { heartbeatAt: { lt: new Date(Date.now() - 120_000) } } });
      await recoverExpiredTasks(db);
      const config = runtimeConfig();
      if (config && await executeNextTask({ workerId, config, signal, db })) continue;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1000); signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally { await db.careerWorker.deleteMany({ where: { id: workerId } }); }
}

// Exposed for tools and tests without coupling application APIs to Codex events.
export { asJson };
