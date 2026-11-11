import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { activeModelConfig } from "@/lib/connections/store";
import { createHash } from "node:crypto";

export type RuntimeConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  protocol?: "responses" | "chat_completions";
  providerId?: string;
  source?: "byok" | "platform";
};

export async function runtimeConfig(
  db: PrismaClient = prisma,
): Promise<RuntimeConfig | null> {
  const selected = await activeModelConfig(db);
  if (selected) return selected;
  const apiKey = process.env.TRACEFOLIO_CODEX_API_KEY?.trim();
  const model = process.env.TRACEFOLIO_CODEX_MODEL?.trim();
  if (!apiKey || !model) return null;
  const baseUrl = process.env.TRACEFOLIO_CODEX_BASE_URL?.trim();
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid runtime URL");
  }
  return {
    apiKey,
    model,
    baseUrl,
    timeoutMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(900_000)
      .parse(process.env.TRACEFOLIO_CODEX_TIMEOUT_MS ?? 180_000),
  };
}

export function runtimeBinding(config: RuntimeConfig) {
  // Bind consent to the provider/endpoint/account without persisting the credential.
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: config.model,
        baseUrl: config.baseUrl ?? "",
        protocol: config.protocol ?? "responses",
        source: config.source ?? "byok",
        credential: createHash("sha256").update(config.apiKey).digest("hex"),
      }),
    )
    .digest("hex");
}
