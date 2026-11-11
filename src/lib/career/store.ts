import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateSourceTasks } from "@/lib/tasks/invalidation";
import {
  buildCareerGrounding,
  canCompleteAction,
  evidenceSchema,
  growthSchema,
  memorySchema,
  type CareerState,
  type Evidence,
  type GrowthAction,
  type Memory,
} from "./domain";

export class CareerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const toMemory = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Memory;
const toEvidence = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Evidence;
const toAction = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as GrowthAction;

export async function getCareerState(): Promise<CareerState> {
  // One snapshot keeps export and matching internally consistent.
  const [memories, evidence, actions] = await prisma.$transaction([
    prisma.careerMemory.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.capabilityEvidence.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.growthAction.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);
  return {
    memories: memories.map(toMemory),
    evidence: evidence.map(toEvidence),
    actions: actions.map(toAction),
  };
}

export async function getCareerGrounding(query: string) {
  return buildCareerGrounding(await getCareerState(), query);
}

export async function saveMemory(
  input: unknown,
  id?: string,
  revision?: number,
) {
  const parsed = memorySchema.parse(input);
  const data = {
    ...parsed,
    expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
  };
  try {
    if (!id) return toMemory(await prisma.careerMemory.create({ data }));
    return await prisma.$transaction(async (tx) => {
      const changed = await tx.careerMemory.updateMany({
        where: { id, revision },
        data: { ...data, revision: { increment: 1 } },
      });
      if (!changed.count)
        throw new CareerError("记忆已被修改或删除，请刷新后重试。", 409);
      await invalidateSourceTasks(tx, "memory", id);
      return toMemory(
        await tx.careerMemory.findUniqueOrThrow({ where: { id } }),
      );
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new CareerError("已有同名记忆，请编辑原记忆以避免互相矛盾。", 409);
    }
    throw error;
  }
}

export async function saveEvidence(
  input: unknown,
  id?: string,
  revision?: number,
) {
  const data = evidenceSchema.parse(input);
  if (!id) return toEvidence(await prisma.capabilityEvidence.create({ data }));
  return prisma.$transaction(async (tx) => {
    const changed = await tx.capabilityEvidence.updateMany({
      where: { id, revision },
      data: { ...data, revision: { increment: 1 } },
    });
    if (!changed.count)
      throw new CareerError("证据已被修改或删除，请刷新后重试。", 409);
    await invalidateSourceTasks(tx, "evidence", id);
    // Editing the basis of a completed action invalidates its old completion.
    await tx.growthAction.updateMany({
      where: { completionEvidenceId: id },
      data: { status: "open", completionEvidenceId: null },
    });
    return toEvidence(
      await tx.capabilityEvidence.findUniqueOrThrow({ where: { id } }),
    );
  });
}

export async function deleteCareerRecord(
  kind: "memory" | "evidence",
  id: string,
  revision: number,
) {
  return prisma.$transaction(async (tx) => {
    if (kind === "evidence") {
      const current = await tx.capabilityEvidence.findFirst({
        where: { id, revision },
      });
      if (!current)
        throw new CareerError("证据已被修改或删除，请刷新后重试。", 409);
      await invalidateSourceTasks(tx, "evidence", id);
      await tx.growthAction.updateMany({
        where: { completionEvidenceId: id },
        data: { status: "open", completionEvidenceId: null },
      });
      await tx.capabilityEvidence.delete({ where: { id } });
    } else {
      const removed = await tx.careerMemory.deleteMany({
        where: { id, revision },
      });
      if (!removed.count)
        throw new CareerError("记忆已被修改或删除，请刷新后重试。", 409);
      await invalidateSourceTasks(tx, "memory", id);
    }
  });
}

export async function addGrowthAction(input: unknown) {
  const data = growthSchema.parse(input);
  return toAction(
    await prisma.growthAction.upsert({
      where: { skill_title: { skill: data.skill, title: data.title } },
      create: data,
      update: {},
    }),
  );
}

export async function updateGrowthAction(
  id: string,
  evidenceId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const action = await tx.growthAction.findUnique({ where: { id } });
    if (!action) throw new CareerError("成长任务不存在。", 404);
    if (evidenceId) {
      const raw = await tx.capabilityEvidence.findUnique({
        where: { id: evidenceId },
      });
      if (!canCompleteAction(action, raw ? toEvidence(raw) : undefined)) {
        throw new CareerError(
          "完成任务需要已确认、技能匹配的作品或面试证据；自述不能作为完成依据。",
        );
      }
    }
    return toAction(
      await tx.growthAction.update({
        where: { id },
        data: {
          status: evidenceId ? "done" : "open",
          completionEvidenceId: evidenceId,
        },
      }),
    );
  });
}
