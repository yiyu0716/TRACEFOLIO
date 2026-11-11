import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  generateText,
  jsonSchema,
  tool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createAiModel } from "@/lib/ai/client";
import { getAiProvider } from "@/lib/ai/provider-registry";
import type { RuntimeConfig } from "./config";

type Item = Record<string, unknown>;
type FunctionDefinition = {
  alias: string;
  name: string;
  namespace?: string;
  definition: Item;
};
const object = (v: unknown): Item =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {};

export function bridgeTools(raw: unknown): FunctionDefinition[] {
  const result: FunctionDefinition[] = [];
  const visit = (items: unknown, namespace?: string, depth = 0) => {
    if (depth > 3 || !Array.isArray(items))
      throw new Error("Unsupported tool schema");
    for (const value of items) {
      const def = object(value);
      if (def.type === "namespace")
        visit(def.tools, String(def.name), depth + 1);
      else if (def.type === "function" && typeof def.name === "string")
        result.push({
          alias:
            `tf_${result.length}_${def.name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(
              0,
              64,
            ),
          name: def.name,
          namespace,
          definition: def,
        });
      else throw new Error("Only career function tools are supported");
    }
  };
  visit(raw ?? []);
  if (result.length > 100) throw new Error("Too many tools");
  return result;
}

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Unsupported content");
  return content
    .map((c) => {
      const part = object(c);
      if (
        !["input_text", "output_text", "text"].includes(String(part.type)) ||
        typeof part.text !== "string"
      )
        throw new Error("This model connection supports text materials only");
      return part.text;
    })
    .join("\n");
}

export function bridgeMessages(
  body: Item,
  definitions: FunctionDefinition[],
  history: Map<string, { id: string; message: ModelMessage }>,
) {
  const messages: ModelMessage[] = [];
  const groups = new Set<string>();
  if (typeof body.instructions === "string")
    messages.push({ role: "system", content: body.instructions });
  const input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : body.input;
  if (!Array.isArray(input)) throw new Error("Missing model input");
  for (const raw of input) {
    const item = object(raw),
      cached = history.get(String(item.id ?? item.call_id));
    if (cached && item.type !== "function_call_output") {
      if (!groups.has(cached.id)) {
        messages.push(cached.message);
        groups.add(cached.id);
      }
      continue;
    }
    if (item.type === "function_call") {
      const def = definitions.find(
        (d) => d.name === item.name && d.namespace === item.namespace,
      );
      if (!def) throw new Error("Unknown function in history");
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: String(item.call_id),
            toolName: def.alias,
            input: JSON.parse(String(item.arguments)),
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      const previous = input
        .map(object)
        .find((i) => i.type === "function_call" && i.call_id === item.call_id);
      const cachedCall = history.get(String(item.call_id));
      const toolPart =
        cachedCall && Array.isArray(cachedCall.message.content)
          ? cachedCall.message.content.find(
              (p) => p.type === "tool-call" && p.toolCallId === item.call_id,
            )
          : undefined;
      const name =
        toolPart?.type === "tool-call"
          ? toolPart.toolName
          : definitions.find(
              (d) =>
                d.name === previous?.name &&
                d.namespace === previous?.namespace,
            )?.alias;
      if (!name) throw new Error("Tool result has no matching call");
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: String(item.call_id),
            toolName: name,
            output: {
              type: "text",
              value:
                typeof item.output === "string"
                  ? item.output
                  : JSON.stringify(item.output),
            },
          },
        ],
      });
    } else if (item.type === "reasoning") {
      // Opaque reasoning is replayed from the same run's cached assistant message.
      if (item.encrypted_content)
        throw new Error("Reasoning history is unavailable; start a fresh task");
    } else if (item.type === "message" || (!item.type && item.role)) {
      const role = item.role === "developer" ? "system" : item.role;
      if (role !== "user" && role !== "assistant" && role !== "system")
        throw new Error("Unsupported role");
      messages.push({ role, content: textContent(item.content) });
    } else throw new Error("Unsupported Responses input item");
  }
  return messages;
}

async function readBody(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A single-request model protocol adapter, never an additional Agent loop. */
export async function startModelBridge(config: RuntimeConfig) {
  const token = randomBytes(32).toString("hex"),
    history = new Map<string, { id: string; message: ModelMessage }>(),
    requestKeys = new Map<string, string>();
  let inFlight = false;
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization ?? "",
      expected = `Bearer ${token}`;
    if (
      auth.length !== expected.length ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.url !== "/v1/responses" ||
      request.headers.origin ||
      inFlight
    ) {
      response.writeHead(400).end();
      return;
    }
    inFlight = true;
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    try {
      const raw = await readBody(request),
        body = object(JSON.parse(raw));
      if (config.protocol !== "chat_completions") {
        const digest = createHash("sha256").update(raw).digest("hex");
        const key = requestKeys.get(digest) ?? randomUUID();
        requestKeys.set(digest, key);
        const upstream = await fetch(
          `${(config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
              ...(config.source === "platform"
                ? { "Idempotency-Key": key }
                : {}),
            },
            body: raw,
            redirect: "error",
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(config.timeoutMs),
            ]),
          },
        );
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          response
            .writeHead(upstream.status >= 400 ? upstream.status : 502, {
              "Content-Type": "application/json",
            })
            .end(
              JSON.stringify({
                error: { message: "Model service rejected the request" },
              }),
            );
          return;
        }
        response.writeHead(200, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "text/event-stream",
          "Cache-Control": "no-store",
        });
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          if (response.destroyed) break;
          response.write(chunk);
        }
        response.end();
        return;
      }
      const definitions = bridgeTools(body.tools),
        tools: ToolSet = {};
      for (const def of definitions)
        tools[def.alias] = tool({
          description: String(def.definition.description ?? ""),
          inputSchema: jsonSchema(
            def.definition.parameters as Parameters<typeof jsonSchema>[0],
          ),
        });
      const messages = bridgeMessages(body, definitions, history);
      const format = object(object(body.text).format);
      if (format.type === "json_schema")
        messages.unshift({
          role: "system",
          content: `最终回答使用 JSON，符合以下 schema：${JSON.stringify(format.schema)}。工具调用仍使用函数接口。`,
        });
      const result = await generateText({
        model: createAiModel({
          provider: getAiProvider(config.providerId),
          providerId: config.providerId ?? "custom-openai-compatible",
          model: config.model,
          baseUrl: config.baseUrl!,
          apiKey: config.apiKey,
          enabled: true,
          temperature: 0.3,
          requiresApiKey: true,
          protocol: "chat_completions",
          source: config.source,
        }),
        system: messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n"),
        messages: messages.filter((m) => m.role !== "system"),
        tools,
        maxRetries: 0,
        maxOutputTokens:
          typeof body.max_output_tokens === "number"
            ? Math.min(body.max_output_tokens, 16384)
            : 4096,
        abortSignal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(config.timeoutMs),
        ]),
      });
      if (result.finishReason === "error" || result.finishReason === "length")
        throw new Error("Incomplete model response");
      const id = `resp_${randomUUID()}`,
        output: Item[] = [];
      // Retain provider-specific reasoning/signature metadata only in this task's RAM.
      for (const message of result.response.messages) {
        if (message.role !== "assistant") continue;
        const group = { id: randomUUID(), message };
        if (Array.isArray(message.content))
          for (const part of message.content) {
            const itemId = `item_${randomUUID()}`;
            if (part.type === "tool-call") {
              const def = definitions.find((d) => d.alias === part.toolName);
              if (!def) throw new Error("Unknown model tool");
              const item = {
                type: "function_call",
                id: itemId,
                call_id: part.toolCallId,
                namespace: def.namespace,
                name: def.name,
                arguments: JSON.stringify(part.input),
                status: "completed",
              };
              output.push(item);
              history.set(itemId, group);
              history.set(part.toolCallId, group);
            } else if (part.type === "text" && part.text) {
              output.push({
                type: "message",
                id: itemId,
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: part.text, annotations: [] },
                ],
              });
              history.set(itemId, group);
            }
          }
      }
      if (!output.length) throw new Error("Empty model response");
      const inputTokens = result.usage.inputTokens ?? 0,
        outputTokens = result.usage.outputTokens ?? 0;
      const payload = {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: config.model,
        status: "completed",
        output,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          input_tokens_details: {
            cached_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          },
          output_tokens_details: {
            reasoning_tokens:
              result.usage.outputTokenDetails?.reasoningTokens ?? 0,
          },
        },
      };
      if (body.stream !== true) {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(payload));
        return;
      }
      emitResponse(response, payload, output);
    } catch {
      if (!response.headersSent)
        response
          .writeHead(502, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              error: {
                message:
                  "The configured model could not complete this protocol request. Check model tool support and connection settings.",
              },
            }),
          );
      else response.destroy();
    } finally {
      inFlight = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing bridge port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          history.clear();
          requestKeys.clear();
          resolve();
        });
      }),
  };
}
function emitResponse(response: ServerResponse, payload: Item, output: Item[]) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
  });
  let sequence = 0;
  const event = (type: string, data: object) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
    );
  event("response.created", {
    response: { ...payload, status: "in_progress", output: [], usage: null },
  });
  output.forEach((item, index) => {
    event("response.output_item.added", {
      output_index: index,
      item:
        item.type === "function_call"
          ? { ...item, arguments: "", status: "in_progress" }
          : { ...item, status: "in_progress", content: [] },
    });
    if (item.type === "function_call")
      event("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
    else
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: object((item.content as Item[])[0]).text,
      });
    event("response.output_item.done", { output_index: index, item });
  });
  event("response.completed", { response: payload });
  response.end();
}
