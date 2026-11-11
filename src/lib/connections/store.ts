import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CareerError } from "@/lib/career/store";
import { decryptLocalSecret, encryptLocalSecret } from "@/lib/ai/secrets";
import { getAiProvider } from "@/lib/ai/provider-registry";
import type {
  EffectiveAiSettings,
  RedactedAiSettings,
} from "@/lib/ai/settings";

export const endpointSchema = z
  .string()
  .trim()
  .max(500)
  .transform((s) => s.replace(/\/+$/, ""))
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        ["https:", "http:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }, "请填写不含账号密码和查询参数的服务地址。");
export const profileSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    kind: z.enum(["byok", "platform"]).default("byok"),
    providerId: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(160),
    baseUrl: endpointSchema,
    protocol: z.enum(["responses", "chat_completions"]),
    apiKey: z.string().trim().max(8192).default(""),
  })
  .strict();

export async function listConnections(db: PrismaClient = prisma) {
  const [profiles, connection] = await Promise.all([
    db.modelProfile.findMany({ orderBy: { createdAt: "asc" } }),
    db.localConnection.findUnique({ where: { id: "singleton" } }),
  ]);
  return {
    profiles: profiles.map(({ secret, ...profile }) => ({
      ...profile,
      hasKey: Boolean(secret),
    })),
    activeProfileId: connection?.activeProfileId ?? null,
    cloudBaseUrl:
      connection?.cloudBaseUrl ?? process.env.TRACEFOLIO_CLOUD_URL ?? "",
    cloudConnected: Boolean(connection?.cloudSession),
    licenseRequired: process.env.TRACEFOLIO_REQUIRE_LICENSE === "1",
    chatgpt: {
      available: false,
      message: "商业版需取得 OpenAI Sign in with ChatGPT 接入资格后启用。",
    },
  };
}
export async function createProfile(input: unknown, db: PrismaClient = prisma) {
  const p = profileSchema.parse(input);
  if (p.kind !== "byok")
    throw new CareerError("平台连接请从账号套餐中的模型列表创建。");
  if (!p.apiKey && !getAiProvider(p.providerId).apiKeyOptional)
    throw new CareerError("请填写此连接的 API Key。");
  const { apiKey, ...data } = p;
  const profile = await db.modelProfile.create({
    data: { ...data, secret: encryptLocalSecret(apiKey) },
  });
  return profile.id;
}
export async function selectProfile(
  id: string | null,
  db: PrismaClient = prisma,
) {
  if (id && !(await db.modelProfile.findUnique({ where: { id } })))
    throw new CareerError("连接不存在。", 404);
  await db.localConnection.upsert({
    where: { id: "singleton" },
    create: { activeProfileId: id },
    update: { activeProfileId: id },
  });
}
export async function deleteProfile(id: string, db: PrismaClient = prisma) {
  await db.$transaction(async (tx) => {
    await tx.localConnection.updateMany({
      where: { activeProfileId: id },
      data: { activeProfileId: null },
    });
    await tx.modelProfile.deleteMany({ where: { id } });
  });
}
export async function activeModelConfig(db: PrismaClient = prisma) {
  const connection = await db.localConnection.findUnique({
    where: { id: "singleton" },
  });
  if (!connection?.activeProfileId) return null;
  const profile = await db.modelProfile.findUnique({
    where: { id: connection.activeProfileId },
  });
  if (!profile)
    throw new CareerError("当前模型连接已被删除，请重新选择。", 409);
  const platform = profile.kind === "platform";
  const apiKey = decryptLocalSecret(
    platform ? connection.cloudSession : profile.secret,
  );
  if (platform && !apiKey)
    throw new CareerError("请先登录 TRACEFOLIO 平台账号。", 401);
  const baseUrl = platform
    ? `${connection.cloudBaseUrl}/v1/ai`
    : profile.baseUrl;
  endpointSchema.parse(baseUrl);
  return {
    apiKey: apiKey || "local-no-key",
    model: profile.model,
    baseUrl,
    protocol: z.enum(["responses", "chat_completions"]).parse(profile.protocol),
    providerId: profile.providerId,
    source: platform ? ("platform" as const) : ("byok" as const),
    timeoutMs: 180_000,
  };
}
export async function activeAiConfig(
  db: PrismaClient = prisma,
): Promise<EffectiveAiSettings | null> {
  const config = await activeModelConfig(db);
  if (!config) return null;
  return {
    provider: getAiProvider(config.providerId),
    providerId: config.providerId,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    enabled: true,
    temperature: 0.3,
    requiresApiKey: true,
    protocol: config.protocol,
    source: config.source,
  };
}
export function redactedEffective(
  config: EffectiveAiSettings,
): RedactedAiSettings {
  return {
    aiProvider: config.providerId,
    aiModel: config.model,
    aiBaseUrl: config.baseUrl,
    aiEnabled: config.enabled,
    aiTemperature: config.temperature,
    aiLastTestedAt: null,
    aiLastTestStatus: "untested",
    hasApiKey: Boolean(config.apiKey),
    apiKeyPreview: config.source === "platform" ? "平台账号凭证" : "已保存",
    requiresApiKey: config.requiresApiKey,
  };
}
