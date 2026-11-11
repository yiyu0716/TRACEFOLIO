import { careerRoute, json } from "@/lib/career/http";
import { taskDetail } from "@/lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return careerRoute(async () => json({ task: await taskDetail((await params).id) }));
}
