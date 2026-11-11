import { careerRoute, json, readInput } from "@/lib/career/http";
import { approveTailoringTask } from "@/lib/tasks/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return careerRoute(async () => json(await approveTailoringTask((await params).id, await readInput(request))));
}
