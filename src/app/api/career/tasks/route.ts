import { prisma } from "@/lib/db";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { CareerError } from "@/lib/career/store";
import { runtimeConfig } from "@/lib/runtime/config";
import { createTailoringTask, revalidateTask, taskSummary } from "@/lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return careerRoute(async () => {
    const [resumes, jobs, evidence, tasks, worker] = await Promise.all([
      prisma.resumeVersion.findMany({ select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      prisma.job.findMany({ select: { id: true, company: true, title: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      prisma.capabilityEvidence.findMany({ where: { status: "accepted", useInAI: true }, select: { id: true, title: true, sourceType: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      prisma.careerTask.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.careerWorker.findFirst({ where: { heartbeatAt: { gt: new Date(Date.now() - 20_000) } } }),
    ]);
    const current = await Promise.all(tasks.map((task) => revalidateTask(task.id)));
    return json({ resumes, jobs, evidence, tasks: current.map(taskSummary), runtimeAvailable: Boolean(runtimeConfig()), workerOnline: Boolean(worker) });
  });
}

export async function POST(request: Request) {
  return careerRoute(async () => {
    const input = await readInput(request);
    if (!runtimeConfig()) throw new CareerError("尚未连接 Codex 任务模型，请先完成运行配置。", 503);
    const task = await createTailoringTask(input);
    return json({ task: taskSummary(task) }, 202);
  });
}
