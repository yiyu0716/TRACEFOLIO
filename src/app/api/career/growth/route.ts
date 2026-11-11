import { careerRoute, json, readInput } from "@/lib/career/http";
import { addGrowthAction } from "@/lib/career/store";

export async function POST(request: Request) {
  return careerRoute(async () =>
    json(await addGrowthAction(await readInput(request)), 201),
  );
}
