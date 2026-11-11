import { z } from "zod";

import { parseJsonRequest } from "@/lib/api-request";
import { analyzeResumeWithAI } from "@/lib/ai-service";
import { resumeContentInputSchema } from "@/lib/resume-content";

const schema = z.object({
  resume: resumeContentInputSchema,
  locale: z.enum(["zh-CN", "en"]).optional(),
});

export function GET() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const parsed = await parseJsonRequest(request, schema);
  if (!parsed.success) return parsed.response;

  const result = await analyzeResumeWithAI(parsed.data);
  if (result.source !== "ai") {
    return Response.json({ message: result.message }, { status: 503 });
  }

  return Response.json({
    diagnosis: result.data,
    message: result.message,
  });
}
