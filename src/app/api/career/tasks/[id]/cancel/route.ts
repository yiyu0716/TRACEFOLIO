import { z } from "zod";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { cancelTask } from "@/lib/tasks/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return careerRoute(async () => {
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(await readInput(request));
    await cancelTask((await params).id, revision);
    return json({ ok: true });
  });
}
