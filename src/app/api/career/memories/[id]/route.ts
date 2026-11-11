import { memorySchema } from "@/lib/career/domain";
import {
  careerRoute,
  json,
  readInput,
  revisionSchema,
} from "@/lib/career/http";
import { deleteCareerRecord, saveMemory } from "@/lib/career/store";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  return careerRoute(async () => {
    const { revision, ...input } = memorySchema
      .extend(revisionSchema.shape)
      .parse(await readInput(request));
    return json(await saveMemory(input, (await context.params).id, revision));
  });
}
export async function DELETE(request: Request, context: Context) {
  return careerRoute(async () => {
    const { revision } = revisionSchema
      .strict()
      .parse(await readInput(request));
    await deleteCareerRecord("memory", (await context.params).id, revision);
    return json({ deleted: true });
  });
}
