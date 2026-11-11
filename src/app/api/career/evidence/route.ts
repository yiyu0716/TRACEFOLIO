import { careerRoute, json, readInput } from "@/lib/career/http";
import { saveEvidence } from "@/lib/career/store";

export async function POST(request: Request) {
  return careerRoute(async () =>
    json(await saveEvidence(await readInput(request)), 201),
  );
}
