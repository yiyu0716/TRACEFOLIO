import { z } from "zod";
import { careerRoute, json, readInput } from "@/lib/career/http";
import { updateGrowthAction } from "@/lib/career/store";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return careerRoute(async () => {
    const input = z
      .object({ completionEvidenceId: z.string().min(1).nullable() })
      .strict()
      .parse(await readInput(request));
    return json(
      await updateGrowthAction(
        (await context.params).id,
        input.completionEvidenceId,
      ),
    );
  });
}
