import { careerRoute, json, readInput } from "@/lib/career/http";
import { cloudRequest, loginCloud, logoutCloud } from "@/lib/connections/cloud";

export const dynamic = "force-dynamic";
export async function GET() {
  return careerRoute(async () => {
    const [me, catalog] = await Promise.all([
      cloudRequest("/v1/me"),
      cloudRequest("/v1/catalog"),
    ]);
    return json({ me: await me.json(), catalog: await catalog.json() });
  });
}
export async function POST(request: Request) {
  return careerRoute(async () =>
    json(await loginCloud(await readInput(request))),
  );
}
export async function DELETE(request: Request) {
  return careerRoute(async () => {
    await readInput(request);
    await logoutCloud();
    return json({ ok: true });
  });
}
