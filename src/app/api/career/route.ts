import { careerRoute, json } from "@/lib/career/http";
import { getCareerState } from "@/lib/career/store";
import { codexReviewAvailable } from "@/lib/career/codex";

export const dynamic = "force-dynamic";
export async function GET() {
  return careerRoute(async () =>
    json({
      ...(await getCareerState()),
      codexAvailable: codexReviewAvailable(),
    }),
  );
}
