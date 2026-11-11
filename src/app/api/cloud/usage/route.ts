import { careerRoute, json } from "@/lib/career/http";
import { cloudRequest } from "@/lib/connections/cloud";
export const dynamic = "force-dynamic";
export async function GET() {
  return careerRoute(async () =>
    json(await (await cloudRequest("/v1/usage")).json()),
  );
}
