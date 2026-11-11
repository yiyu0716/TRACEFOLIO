import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import type { Database } from "./db";
import type { PlatformModel, Product } from "./config";
import {
  authenticate,
  CloudError,
  entitlement,
  hash,
  opaqueToken,
  passwordHash,
  passwordMatches,
} from "./domain";
import type { ObjectStorage } from "./storage";
import { MAX_DOCUMENT_BYTES } from "./storage";
import {
  deleteDocument,
  documentView,
  downloadDocument,
  uploadDocument,
} from "./documents";
import {
  readTrustedUsage,
  reserveUsage,
  settleUsage,
  UsageStream,
} from "./usage";

type Options = {
  db: Database;
  storage: ObjectStorage;
  products: Product[];
  models: PlatformModel[];
  registrationCode?: string;
  fetch?: typeof fetch;
  rateLimit?: boolean;
};
const credentials = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
    registrationCode: z.string().max(200).optional(),
  })
  .strict();
const idSchema = z.uuid();
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,120}$/);
const mediaSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/markdown",
  "application/json",
  "image/png",
  "image/jpeg",
]);
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((v) => !/[\x00-\x1f\x7f\\/]/.test(v));

export async function createCloudServer(options: Options) {
  const app = Fastify({
    logger: false,
    bodyLimit: 512 * 1024,
    trustProxy: false,
    requestTimeout: 200_000,
  });
  if (options.rateLimit !== false)
    await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_DOCUMENT_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof CloudError)
      return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.status(400).send({ error: "请求字段或格式无效。" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && [400, 413, 415, 429].includes(status))
      return reply.status(status).send({
        error:
          status === 429
            ? "请求过于频繁，请稍后重试。"
            : "请求格式或大小无效。",
      });
    return reply.status(500).send({ error: "服务暂时不可用，请稍后重试。" });
  });
  app.get("/health", async () => ({
    ok: true,
    service: "tracefolio-cloud",
    version: "0.2.0",
  }));
  app.get("/v1/catalog", async () => ({
    products: options.products,
    models: options.models.map(({ id, label, protocol }) => ({
      id,
      label,
      protocol,
    })),
    paymentMode: "manual",
    storageDriver: "private",
  }));

  const dummyHash = await passwordHash("dummy-password-not-an-account");
  for (const action of ["register", "login"] as const) {
    app.post(
      `/v1/auth/${action}`,
      { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
      async (request) => {
        const input = credentials.parse(request.body);
        let account: { id: string; email: string };
        if (action === "register") {
          if (
            options.registrationCode &&
            hash(input.registrationCode ?? "") !==
              hash(options.registrationCode)
          )
            throw new CloudError("需要有效的注册邀请码。", 403);
          const id = randomUUID();
          try {
            const result = await options.db.query(
              `INSERT INTO cloud_accounts (id,email,password_hash) VALUES ($1,$2,$3) RETURNING id,email`,
              [id, input.email, await passwordHash(input.password)],
            );
            account = result.rows[0] as typeof account;
          } catch (error) {
            if ((error as { code?: string }).code === "23505")
              throw new CloudError("无法创建此账号，请尝试登录。", 409);
            throw error;
          }
        } else {
          const { rows } = await options.db.query(
            "SELECT id,email,password_hash FROM cloud_accounts WHERE email=$1",
            [input.email],
          );
          const valid = await passwordMatches(
            input.password,
            rows[0]?.password_hash ?? dummyHash,
          );
          if (!valid || !rows[0])
            throw new CloudError("邮箱或密码不正确。", 401);
          account = { id: rows[0].id, email: rows[0].email };
        }
        const token = opaqueToken(),
          expiresAt = new Date(Date.now() + 30 * 86400_000);
        await options.db.query(
          "INSERT INTO cloud_sessions (token_hash,account_id,expires_at) VALUES ($1,$2,$3)",
          [hash(token), account.id, expiresAt],
        );
        return { account, token, expiresAt };
      },
    );
  }
  app.post("/v1/auth/logout", async (request) => {
    await authenticate(options.db, request.headers.authorization);
    await options.db.query("DELETE FROM cloud_sessions WHERE token_hash=$1", [
      hash(request.headers.authorization!.slice(7)),
    ]);
    return { ok: true };
  });
  app.get("/v1/me", async (request) =>
    entitlement(
      options.db,
      await authenticate(options.db, request.headers.authorization),
    ),
  );
  app.get("/v1/usage", async (request) => {
    const account = await authenticate(
      options.db,
      request.headers.authorization,
    );
    const { rows } = await options.db.query(
      "SELECT id,model_id,status,reserved_units,charged_units,input_tokens,output_tokens,created_at,finished_at FROM cloud_usage WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100",
      [account.id],
    );
    return { usage: rows };
  });
  app.get("/v1/documents", async (request) => {
    const account = await authenticate(
      options.db,
      request.headers.authorization,
    );
    return {
      documents: (
        await options.db.query(
          "SELECT * FROM cloud_documents WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200",
          [account.id],
        )
      ).rows.map(documentView),
    };
  });
  app.post(
    "/v1/documents",
    {
      bodyLimit: MAX_DOCUMENT_BYTES,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const account = await authenticate(
        options.db,
        request.headers.authorization,
      );
      if (request.headers["x-upload-consent"] !== "true")
        throw new CloudError("请明确同意上传这份资料。", 400);
      if (!Buffer.isBuffer(request.body))
        throw new CloudError("请以文件字节上传。", 415);
      const encoded = String(request.headers["x-file-name"] ?? "");
      if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw new CloudError("缺少文件名。", 400);
      const name = nameSchema.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      const mediaType = mediaSchema.parse(request.headers["x-file-type"]);
      const requestKey = keySchema.parse(request.headers["idempotency-key"]);
      const document = await uploadDocument(
        options.db,
        options.storage,
        account,
        { name, mediaType, requestKey, data: request.body },
      );
      return reply.status(201).send({ document });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/documents/:id/content",
    async (request, reply) => {
      const account = await authenticate(
          options.db,
          request.headers.authorization,
        ),
        id = idSchema.parse(request.params.id);
      const { data, document } = await downloadDocument(
        options.db,
        options.storage,
        account,
        id,
      );
      reply.header(
        "Content-Disposition",
        `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(document.name).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      );
      return reply.type("application/octet-stream").send(data);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/documents/:id",
    async (request) => {
      const account = await authenticate(
          options.db,
          request.headers.authorization,
        ),
        id = idSchema.parse(request.params.id);
      const { revision } = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      await deleteDocument(options.db, options.storage, account, id, revision);
      return { ok: true };
    },
  );

  for (const protocol of ["responses", "chat_completions"] as const) {
    app.post(
      `/v1/ai/${protocol === "responses" ? "responses" : "chat/completions"}`,
      async (request, reply) => {
        const account = await authenticate(
          options.db,
          request.headers.authorization,
        );
        const body = z.record(z.string(), z.unknown()).parse(request.body);
        const model = options.models.find((m) => m.id === body.model);
        if (!model || model.protocol !== protocol)
          throw new CloudError("当前模型不支持此协议。", 400);
        const permitted =
          protocol === "responses"
            ? [
                "model",
                "input",
                "instructions",
                "tools",
                "tool_choice",
                "parallel_tool_calls",
                "reasoning",
                "text",
                "include",
                "stream",
                "max_output_tokens",
                "temperature",
                "top_p",
                "store",
                "prompt_cache_key",
              ]
            : [
                "model",
                "messages",
                "tools",
                "tool_choice",
                "parallel_tool_calls",
                "reasoning_effort",
                "response_format",
                "stream",
                "stream_options",
                "max_tokens",
                "max_completion_tokens",
                "temperature",
                "top_p",
              ];
        if (Object.keys(body).some((key) => !permitted.includes(key)))
          throw new CloudError("模型请求包含未开放字段。", 400);
        const checkTools = (tools: unknown, depth = 0): boolean =>
          tools === undefined ||
          (depth < 3 &&
            Array.isArray(tools) &&
            tools.length <= 100 &&
            tools.every((value) => {
              if (!value || typeof value !== "object") return false;
              const t = value as Record<string, unknown>;
              return (
                t.type === "function" ||
                (t.type === "namespace" && checkTools(t.tools, depth + 1))
              );
            }));
        if (!checkTools(body.tools))
          throw new CloudError("平台模型只开放客户端函数工具。", 400);
        const textParts = (content: unknown) =>
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.every(
              (v) =>
                v &&
                typeof v === "object" &&
                ["text", "input_text", "output_text"].includes(
                  String(v.type),
                ) &&
                typeof v.text === "string",
            ));
        const checkInput = (value: unknown) => {
          if (typeof value === "string") return protocol === "responses";
          if (!Array.isArray(value) || value.length > 1000) return false;
          return value.every((v) => {
            if (!v || typeof v !== "object") return false;
            const item = v as Record<string, unknown>;
            if (protocol === "chat_completions")
              return (
                ["system", "developer", "user", "assistant", "tool"].includes(
                  String(item.role),
                ) &&
                (item.content === null ||
                  item.content === undefined ||
                  textParts(item.content)) &&
                !item.audio &&
                !item.refusal
              );
            if (item.type === "function_call")
              return (
                typeof item.name === "string" &&
                typeof item.arguments === "string"
              );
            if (item.type === "function_call_output")
              return typeof item.output === "string" || textParts(item.output);
            if (item.type === "reasoning")
              return !item.content || textParts(item.content);
            return (
              (item.type === "message" || !item.type) &&
              ["user", "assistant", "system", "developer"].includes(
                String(item.role),
              ) &&
              textParts(item.content)
            );
          });
        };
        if (!checkInput(protocol === "responses" ? body.input : body.messages))
          throw new CloudError(
            "当前平台模型只接收完整文字上下文与函数工具结果。",
            400,
          );
        if (protocol === "responses" && body.previous_response_id)
          throw new CloudError("请使用完整上下文。", 400);
        const outputKey =
          protocol === "responses" ? "max_output_tokens" : "max_tokens";
        const requested =
          body[outputKey] ??
          body.max_completion_tokens ??
          model.maxOutputTokens;
        const maxOutput = z
          .number()
          .int()
          .positive()
          .max(model.maxOutputTokens)
          .parse(requested);
        const upstreamBody = {
          ...body,
          model: model.upstreamModel,
          [outputKey]: maxOutput,
          ...(protocol === "responses"
            ? { store: false }
            : {
                stream_options:
                  body.stream === true ? { include_usage: true } : undefined,
              }),
        };
        delete (upstreamBody as Record<string, unknown>).max_completion_tokens;
        const serialized = JSON.stringify(upstreamBody);
        if (Buffer.byteLength(serialized) > model.maxRequestBytes)
          throw new CloudError("模型请求过长，请缩短材料。", 413);
        const key = keySchema.parse(request.headers["idempotency-key"]);
        const usage = await reserveUsage(
          options.db,
          account,
          model,
          key,
          serialized,
          maxOutput,
        );
        const controller = new AbortController();
        let settled = false;
        try {
          const response = await (options.fetch ?? fetch)(
            `${model.baseUrl.replace(/\/$/, "")}/${protocol === "responses" ? "responses" : "chat/completions"}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${model.apiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": usage.id,
              },
              body: serialized,
              redirect: "error",
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(180_000),
              ]),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            await settleUsage(
              options.db,
              account.id,
              usage.id,
              model,
              [400, 401, 403, 404, 422, 429].includes(response.status)
                ? "released"
                : "uncertain",
            );
            settled = true;
            throw new CloudError(
              "平台模型暂不可用，请查看用量记录后再试。",
              502,
            );
          }
          if (body.stream === true) {
            if (
              !response.headers
                .get("content-type")
                ?.includes("text/event-stream") ||
              !response.body
            )
              throw new Error("Expected provider event stream");
            const tracker = new UsageStream(protocol);
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "X-Tracefolio-Usage-Id": usage.id,
            });
            const onClose = () => controller.abort();
            reply.raw.once("close", onClose);
            try {
              for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                tracker.push(chunk);
                if (reply.raw.destroyed) throw new Error("Client disconnected");
                if (!reply.raw.write(chunk))
                  await Promise.race([
                    once(reply.raw, "drain"),
                    once(reply.raw, "close").then(() => {
                      throw new Error("Client disconnected");
                    }),
                  ]);
              }
              await settleUsage(
                options.db,
                account.id,
                usage.id,
                model,
                tracker.result() ?? "uncertain",
              );
              settled = true;
              reply.raw.end();
            } catch {
              await settleUsage(
                options.db,
                account.id,
                usage.id,
                model,
                "uncertain",
              );
              settled = true;
              if (!reply.raw.destroyed) reply.raw.destroy();
            } finally {
              reply.raw.off("close", onClose);
            }
            return reply;
          }
          // Bound provider JSON responses instead of buffering an untrusted response indefinitely.
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (!response.body) throw new Error("Missing model response");
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length;
            if (size > 4_000_000) throw new Error("Model response too large");
            chunks.push(chunk);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const counts = readTrustedUsage(data.usage, protocol);
          await settleUsage(
            options.db,
            account.id,
            usage.id,
            model,
            counts ?? "uncertain",
          );
          settled = true;
          return reply.header("X-Tracefolio-Usage-Id", usage.id).send(data);
        } catch (error) {
          if (!settled)
            await settleUsage(
              options.db,
              account.id,
              usage.id,
              model,
              "uncertain",
            );
          if (error instanceof CloudError) throw error;
          throw new CloudError(
            "模型请求结果未确认，预留额度待核对；请勿重复提交。",
            502,
          );
        } finally {
          controller.abort();
        }
      },
    );
  }
  return app;
}
