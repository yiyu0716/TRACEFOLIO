import { z } from "zod";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { cloudRequest } from "@/lib/connections/cloud";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  return careerRoute(async () => {
    const id = z.uuid().parse((await context.params).id);
    const response = await cloudRequest(`/v1/documents/${id}/content`);
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          response.headers.get("content-disposition") ?? "attachment",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
export async function DELETE(request: Request, context: Context) {
  return careerRoute(async () => {
    const id = z.uuid().parse((await context.params).id);
    const body = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(await readInput(request));
    return json(
      await (
        await cloudRequest(`/v1/documents/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json(),
    );
  });
}
