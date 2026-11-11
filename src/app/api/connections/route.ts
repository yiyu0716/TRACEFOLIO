import { z } from "zod";
import { careerRoute, json, readInput } from "@/lib/career/http";
import {
  createProfile,
  deleteProfile,
  listConnections,
  selectProfile,
} from "@/lib/connections/store";
import { platformProfile } from "@/lib/connections/cloud";

export const dynamic = "force-dynamic";
export async function GET() {
  return careerRoute(async () => json(await listConnections()));
}
export async function POST(request: Request) {
  return careerRoute(async () => {
    const input = await readInput(request);
    const action = z
      .object({
        action: z.enum(["create", "select", "delete", "platform"]),
        id: z.string().max(160).nullable().optional(),
        profile: z.unknown().optional(),
        model: z.string().max(160).optional(),
      })
      .strict()
      .parse(input);
    if (action.action === "create") await createProfile(action.profile);
    else if (action.action === "select") await selectProfile(action.id ?? null);
    else if (action.action === "delete")
      await deleteProfile(z.string().min(1).parse(action.id));
    else await platformProfile(z.string().min(1).parse(action.model));
    return json(await listConnections());
  });
}
