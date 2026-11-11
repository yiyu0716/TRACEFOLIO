import { randomUUID } from "node:crypto";
import { careerRoute, json } from "@/lib/career/http";
import { CareerError } from "@/lib/career/store";
import { cloudRequest } from "@/lib/connections/cloud";

export const dynamic = "force-dynamic";
export async function GET() {
  return careerRoute(async () =>
    json(await (await cloudRequest("/v1/documents")).json()),
  );
}
export async function POST(request: Request) {
  return careerRoute(async () => {
    const origin = request.headers.get("origin");
    if (
      origin &&
      new URL(origin).host !==
        (request.headers.get("host") ?? new URL(request.url).host)
    )
      throw new CareerError("不接受跨站上传。", 403);
    if (request.headers.get("x-upload-consent") !== "true")
      throw new CareerError("请先同意上传所选资料。");
    const max = 20 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > max)
      throw new CareerError("文件不能超过 20 MiB。", 413);
    if (!request.body) throw new CareerError("缺少文件。");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new CareerError("文件不能超过 20 MiB。", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const response = await cloudRequest("/v1/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": request.headers.get("x-file-name") ?? "",
        "X-File-Type": request.headers.get("x-file-type") ?? "",
        "X-Upload-Consent": "true",
        "Idempotency-Key":
          request.headers.get("idempotency-key") ?? randomUUID(),
      },
      body: Buffer.concat(chunks),
    });
    return json(await response.json(), 201);
  });
}
