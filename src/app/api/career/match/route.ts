import { matchEvidence, matchSchema } from "@/lib/career/domain";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { getCareerState } from "@/lib/career/store";

export async function POST(request: Request) {
  return careerRoute(async () => {
    const { requiredSkills } = matchSchema.parse(await readInput(request));
    return json(
      matchEvidence(requiredSkills, (await getCareerState()).evidence),
    );
  });
}
