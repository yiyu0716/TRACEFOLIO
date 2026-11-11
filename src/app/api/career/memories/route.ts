import { careerRoute, json, readInput } from "@/lib/career/http";
import { saveMemory } from "@/lib/career/store";

export async function POST(request: Request) {
  return careerRoute(async () =>
    json(await saveMemory(await readInput(request)), 201),
  );
}
