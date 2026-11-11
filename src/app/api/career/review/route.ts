import { matchSchema } from "@/lib/career/domain";
import { reviewWithCodex } from "@/lib/career/codex";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { getCareerState } from "@/lib/career/store";
import { requireAgentAccess } from "@/lib/connections/cloud";

export const runtime = "nodejs";
export const maxDuration = 120;
let reviewInFlight = false;

export async function POST(request: Request) {
  return careerRoute(async () => {
    const { requiredSkills } = matchSchema.parse(await readInput(request));
    await requireAgentAccess();
    if (reviewInFlight)
      return json(
        { error: "已有一项 Codex 复盘正在执行，请完成后再试。" },
        429,
      );
    reviewInFlight = true;
    try {
      return json(
        await reviewWithCodex(
          await getCareerState(),
          requiredSkills,
          request.signal,
        ),
      );
    } finally {
      reviewInFlight = false;
    }
  });
}
