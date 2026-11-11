import type { Prisma } from "@prisma/client";

export async function invalidateSourceTasks(tx: Prisma.TransactionClient, kind: string, sourceId: string) {
  return tx.careerTask.updateMany({
    where: {
      sources: { some: { kind, sourceId } },
      status: { in: ["queued", "running", "cancel_requested", "awaiting_approval", "needs_input", "succeeded"] },
    },
    data: { status: "stale", revision: { increment: 1 }, error: "依据材料已修正、删除或撤销许可，请使用最新材料重新生成。" },
  });
}
