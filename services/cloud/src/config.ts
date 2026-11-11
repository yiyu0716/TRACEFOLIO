import { z } from "zod";

export const productSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    name: z.string().min(1).max(100),
    kind: z.enum(["agent", "bundle"]),
    term: z.enum(["month", "year", "lifetime"]),
    allowanceUnits: z.number().int().nonnegative().max(1e12).default(0),
    // Model allowance expires independently of a permanent Agent license.
    modelDays: z.number().int().positive().max(366).default(31),
    storageBytes: z.number().int().nonnegative().max(1e13),
    models: z.array(z.string().max(120)).default([]),
    priceLabel: z.string().max(100).default("联系管理员开通"),
  })
  .strict()
  .refine(
    (p) =>
      p.kind === "bundle" || (p.allowanceUnits === 0 && p.models.length === 0),
    "Agent-only plans cannot include platform tokens",
  );

export type Product = z.infer<typeof productSchema>;
export const modelSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_./:-]{1,120}$/),
    label: z.string().max(100),
    upstreamModel: z.string().min(1).max(160),
    baseUrl: z.url(),
    apiKey: z.string().min(1),
    protocol: z.enum(["responses", "chat_completions"]),
    maxOutputTokens: z.number().int().min(128).max(65536).default(4096),
    maxRequestBytes: z.number().int().min(1024).max(2_000_000).default(256_000),
    inputUnitsPerMillion: z.number().int().min(1).max(1e9),
    outputUnitsPerMillion: z.number().int().min(1).max(1e9),
  })
  .strict();
export type PlatformModel = z.infer<typeof modelSchema>;

const MiB = 1024 * 1024;
export const defaultProducts: Product[] = [
  {
    id: "bundle-month",
    name: "Agent ＋平台模型 · 月费",
    kind: "bundle",
    term: "month",
    allowanceUnits: 0,
    modelDays: 31,
    storageBytes: 100 * MiB,
    models: [],
    priceLabel: "模型额度和价格待配置",
  },
  {
    id: "agent-month",
    name: "Agent 月费",
    kind: "agent",
    term: "month",
    allowanceUnits: 0,
    modelDays: 31,
    storageBytes: 100 * MiB,
    models: [],
    priceLabel: "价格待配置",
  },
  {
    id: "agent-year",
    name: "Agent 年费",
    kind: "agent",
    term: "year",
    allowanceUnits: 0,
    modelDays: 31,
    storageBytes: 100 * MiB,
    models: [],
    priceLabel: "价格待配置",
  },
  {
    id: "agent-lifetime",
    name: "Agent 永久",
    kind: "agent",
    term: "lifetime",
    allowanceUnits: 0,
    modelDays: 31,
    storageBytes: 100 * MiB,
    models: [],
    priceLabel: "价格待配置",
  },
];

export function catalog(env: NodeJS.ProcessEnv = process.env) {
  const products = env.TRACEFOLIO_PRODUCTS_JSON
    ? z.array(productSchema).parse(JSON.parse(env.TRACEFOLIO_PRODUCTS_JSON))
    : defaultProducts;
  const models = env.TRACEFOLIO_MODELS_JSON
    ? z.array(modelSchema).parse(JSON.parse(env.TRACEFOLIO_MODELS_JSON))
    : [];
  if (
    new Set(products.map((p) => p.id)).size !== products.length ||
    new Set(models.map((m) => m.id)).size !== models.length
  )
    throw new Error("Duplicate catalog identifiers");
  for (const p of products)
    for (const id of p.models)
      if (!models.some((m) => m.id === id))
        throw new Error("Product references unknown model");
  for (const m of models) {
    const u = new URL(m.baseUrl);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== "https:" &&
        !(
          env.NODE_ENV !== "production" &&
          u.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(u.hostname)
        ))
    )
      throw new Error("Invalid upstream model URL");
  }
  return { products, models };
}
