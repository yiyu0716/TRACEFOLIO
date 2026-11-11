import { z } from "zod";
import { CareerError } from "./store";

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function careerRoute(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CareerError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json(
        { error: "请检查必填字段、长度和数据格式。", fields: error.flatten() },
        400,
      );
    console.error(
      "Career operation failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return json({ error: "操作未完成，请检查本地数据库迁移并重试。" }, 500);
  }
}

export async function readInput(request: Request): Promise<unknown> {
  const origin = request.headers.get("origin");
  if (origin) {
    // Next can normalize request.url to the listener hostname (localhost),
    // while Host preserves the browser's actual authority (127.0.0.1).
    const requestUrl = new URL(request.url);
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new CareerError("不接受跨站写入。", 403);
    }
    const authority = request.headers.get("host") ?? requestUrl.host;
    if (
      originUrl.host !== authority ||
      originUrl.protocol !== requestUrl.protocol
    )
      throw new CareerError("不接受跨站写入。", 403);
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CareerError("请使用 JSON 请求。", 415);
  // Limit the bytes actually read, including chunked requests.
  const reader = request.body?.getReader();
  if (!reader) throw new CareerError("缺少请求内容。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new CareerError("内容过长，请缩短材料后重试。", 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof CareerError) throw error;
    throw new CareerError("JSON 格式无效。");
  } finally {
    reader.releaseLock();
  }
}

export const revisionSchema = z.object({
  revision: z.number().int().positive(),
});
