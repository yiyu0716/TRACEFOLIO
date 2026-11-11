import { z } from "zod";

export type RuntimeConfig = { apiKey: string; model: string; baseUrl?: string; timeoutMs: number };

export function runtimeConfig(): RuntimeConfig | null {
  const apiKey = process.env.TRACEFOLIO_CODEX_API_KEY?.trim();
  const model = process.env.TRACEFOLIO_CODEX_MODEL?.trim();
  if (!apiKey || !model) return null;
  const baseUrl = process.env.TRACEFOLIO_CODEX_BASE_URL?.trim();
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid runtime URL");
  }
  return { apiKey, model, baseUrl, timeoutMs: z.coerce.number().int().min(1000).max(900_000).parse(process.env.TRACEFOLIO_CODEX_TIMEOUT_MS ?? 180_000) };
}
