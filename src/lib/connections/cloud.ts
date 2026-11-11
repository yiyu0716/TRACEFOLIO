import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CareerError } from "@/lib/career/store";
import { decryptLocalSecret, encryptLocalSecret } from "@/lib/ai/secrets";
import { endpointSchema } from "./store";

export const cloudLoginSchema = z
  .object({
    baseUrl: endpointSchema,
    email: z.email().max(254),
    password: z.string().min(12).max(128),
    action: z.enum(["register", "login"]),
    registrationCode: z.string().max(200).optional(),
  })
  .strict();
function cloudEndpoint(value: string) {
  const url = new URL(endpointSchema.parse(value));
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new CareerError("平台服务请使用 HTTPS 地址。");
  if (
    process.env.TRACEFOLIO_REQUIRE_LICENSE === "1" &&
    process.env.TRACEFOLIO_CLOUD_URL &&
    url.toString().replace(/\/$/, "") !==
      process.env.TRACEFOLIO_CLOUD_URL.replace(/\/$/, "")
  )
    throw new CareerError("此安装包使用指定的 TRACEFOLIO 平台服务。");
  return url.toString().replace(/\/$/, "");
}
async function requestCloud(
  baseUrl: string,
  path: string,
  token: string | undefined,
  init: RequestInit = {},
) {
  // No caller-controlled absolute URLs, redirects or credential-bearing remote errors.
  const response = await fetch(`${cloudEndpoint(baseUrl)}${path}`, {
    ...init,
    redirect: "error",
    cache: "no-store",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {
    throw new CareerError("无法连接平台服务，请检查服务地址和网络。", 503);
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new CareerError(
      typeof data?.error === "string"
        ? data.error.slice(0, 300)
        : "平台请求未完成。",
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  return response;
}
export async function cloudSession() {
  const connection = await prisma.localConnection.findUnique({
    where: { id: "singleton" },
  });
  const token = decryptLocalSecret(connection?.cloudSession);
  if (!connection?.cloudBaseUrl || !token)
    throw new CareerError("请先登录 TRACEFOLIO 平台账号。", 401);
  return { baseUrl: cloudEndpoint(connection.cloudBaseUrl), token };
}
export async function cloudRequest(path: string, init: RequestInit = {}) {
  const session = await cloudSession();
  return requestCloud(session.baseUrl, path, session.token, init);
}
export async function loginCloud(input: unknown) {
  const { baseUrl, action, ...credentials } = cloudLoginSchema.parse(input);
  const endpoint = cloudEndpoint(baseUrl);
  const response = await requestCloud(
    endpoint,
    `/v1/auth/${action}`,
    undefined,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    },
  );
  const data = z
    .object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      account: z.object({ id: z.uuid(), email: z.email() }),
    })
    .parse(await response.json());
  // Switching accounts disconnects platform model selection. Local BYOK stays local.
  await prisma.$transaction(async (tx) => {
    const current = await tx.localConnection.findUnique({
      where: { id: "singleton" },
    });
    const active = current?.activeProfileId
      ? await tx.modelProfile.findUnique({
          where: { id: current.activeProfileId },
        })
      : null;
    const patch = {
      cloudBaseUrl: endpoint,
      cloudSession: encryptLocalSecret(data.token),
      ...(active?.kind === "platform" ? { activeProfileId: null } : {}),
    };
    await tx.localConnection.upsert({
      where: { id: "singleton" },
      create: patch,
      update: patch,
    });
  });
  return { account: data.account };
}
export async function logoutCloud() {
  await cloudRequest("/v1/auth/logout", { method: "POST" }).catch(() => {});
  await prisma.$transaction(async (tx) => {
    const connection = await tx.localConnection.findUnique({
      where: { id: "singleton" },
    });
    const active = connection?.activeProfileId
      ? await tx.modelProfile.findUnique({
          where: { id: connection.activeProfileId },
        })
      : null;
    await tx.localConnection.updateMany({
      data: {
        cloudSession: "",
        ...(active?.kind === "platform" ? { activeProfileId: null } : {}),
      },
    });
  });
}
export const meSchema = z.object({
  account: z.object({ id: z.uuid(), email: z.email() }),
  agent: z.object({
    active: z.boolean(),
    lifetime: z.boolean(),
    until: z.string().nullable(),
    productId: z.string().nullable(),
  }),
  storage: z.object({
    usedBytes: z.number(),
    reservedBytes: z.number(),
    limitBytes: z.number(),
  }),
  balances: z.array(
    z.object({
      productId: z.string(),
      until: z.string(),
      remainingUnits: z.number(),
      models: z.array(z.string()),
    }),
  ),
});
export async function requireAgentAccess() {
  if (process.env.TRACEFOLIO_REQUIRE_LICENSE !== "1") return;
  const data = meSchema.parse(await (await cloudRequest("/v1/me")).json());
  if (!data.agent.active)
    throw new CareerError("请登录并开通 Agent 使用权。", 403);
}
export async function platformProfile(modelId: string) {
  const session = await cloudSession();
  const catalog = z
    .object({
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          protocol: z.enum(["responses", "chat_completions"]),
        }),
      ),
    })
    .parse(await (await cloudRequest("/v1/catalog")).json());
  const model = catalog.models.find((m) => m.id === modelId);
  if (!model) throw new CareerError("平台模型不存在。", 404);
  const profile = await prisma.modelProfile.create({
    data: {
      label: `平台 · ${model.label}`,
      kind: "platform",
      providerId: "tracefolio-platform",
      model: model.id,
      baseUrl: `${session.baseUrl}/v1/ai`,
      protocol: model.protocol,
    },
  });
  return profile.id;
}
export function modelRequestFetch(source?: string): typeof fetch | undefined {
  if (source !== "platform") return undefined;
  const keys = new Map<string, string>();
  return (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const key = keys.get(body) ?? randomUUID();
    keys.set(body, key);
    const headers = new Headers(init?.headers);
    headers.set("Idempotency-Key", key);
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}
