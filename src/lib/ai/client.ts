// Modified for TRACEFOLIO (2026): shared provider profiles and private platform gateway.
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type { EffectiveAiSettings } from "./settings";
import { modelRequestFetch } from "@/lib/connections/cloud";

export function createAiModel(config: EffectiveAiSettings) {
  const fetch = modelRequestFetch(config.source);
  if (config.protocol === "responses") {
    return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch })(config.model);
  }
  if (config.providerId === "openai") {
    const provider = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch });
    return config.protocol === "chat_completions" ? provider.chat(config.model) : provider(config.model);
  }
  // The official adapter preserves signed/encrypted reasoning across tool calls.
  if (["openrouter", "anthropic-via-openrouter", "gemini-via-openrouter"].includes(config.providerId)) {
    return createOpenRouter({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch })(config.model);
  }
  const provider = createOpenAICompatible({
    name: config.providerId,
    apiKey: config.apiKey || undefined,
    baseURL: config.baseUrl,
    fetch,
    // Keep reasoning separate from the JSON/text consumed by application tasks.
    transformRequestBody: config.providerId === "minimax"
      ? (body) => ({ ...body, reasoning_split: true })
      : undefined,
  });

  return provider(config.model);
}

export function getAiTemperature(config: EffectiveAiSettings) {
  // Fixed-sampling models also appear behind gateways; use the model ID there.
  const model = config.model.split("/").at(-1) ?? config.model;
  return /^(?:gpt-[56](?:\.|-|$)|kimi-k3\.1(?:-|$)|minimax-m3(?:\.|-|$)|claude-(?:fable-5|(?:opus|sonnet|haiku)-5[.-]5)(?:\.|-|$))/i.test(model)
    ? undefined : config.temperature;
}
