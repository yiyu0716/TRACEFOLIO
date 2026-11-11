import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { CloudError } from "./domain";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}
function safeKey(key: string) {
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid object key");
  return key;
}

/** Development only. Never serves a static/public directory. */
export function localStorage(root: string): ObjectStorage {
  const base = resolve(root);
  const path = (key: string) => {
    const p = resolve(base, safeKey(key));
    if (!p.startsWith(base + sep)) throw new Error("Invalid storage path");
    return p;
  };
  return {
    put: async (key, data) => {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      await writeFile(p, data, { mode: 0o600 });
    },
    get: async (key) => {
      try {
        return await readFile(path(key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    delete: (key) => rm(path(key), { force: true }),
  };
}

/** A private, operator-managed WebDAV mount backed by Quark (for example OpenList).
 * This is not a Quark official API; no Quark cookie is received by this service.
 */
export function quarkWebdavStorage(options: {
  url: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
}): ObjectStorage {
  const root = new URL(
    options.url.endsWith("/") ? options.url : options.url + "/",
  );
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    (root.protocol !== "https:" &&
      !(
        root.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(root.hostname)
      ))
  )
    throw new Error("WebDAV requires HTTPS or loopback");
  const headers = {
    Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`,
  };
  const request = async (url: URL, method: string, body?: Buffer) => {
    const response = await (options.fetch ?? fetch)(url, {
      method,
      headers,
      body: body as unknown as BodyInit,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    return response;
  };
  const url = (key: string) =>
    new URL(safeKey(key).split("/").map(encodeURIComponent).join("/"), root);
  return {
    put: async (key, data) => {
      const parts = safeKey(key).split("/");
      // The configured root must already exist; create only opaque owner/object directories.
      for (let i = 1; i < parts.length; i++) {
        const r = await request(
          new URL(parts.slice(0, i).join("/") + "/", root),
          "MKCOL",
        );
        if (![201, 204, 405].includes(r.status))
          throw new CloudError("夸克存储桥接未就绪。", 503);
        await r.body?.cancel();
      }
      const r = await request(url(key), "PUT", data);
      await r.body?.cancel();
      if (!r.ok) throw new CloudError("资料上传至夸克存储桥接失败。", 503);
    },
    get: async (key) => {
      const r = await request(url(key), "GET");
      if (r.status === 404) {
        await r.body?.cancel();
        return null;
      }
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw new CloudError("资料存储暂不可用。", 503);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > MAX_DOCUMENT_BYTES + 128)
          throw new CloudError("存储对象超过上限。", 502);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    delete: async (key) => {
      const r = await request(url(key), "DELETE");
      await r.body?.cancel();
      if (!r.ok && r.status !== 404)
        throw new CloudError("存储删除尚未完成，请重试。", 503);
    },
  };
}

// Encrypt documents before they leave the application server. Keep and back up the
// independent storage key: losing it makes every uploaded object unrecoverable.
export function encryptedStorage(
  storage: ObjectStorage,
  key: Buffer,
): ObjectStorage {
  if (key.length !== 32)
    throw new Error("Storage key must contain 32 random bytes");
  return {
    put: async (objectKey, data) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(objectKey));
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      await storage.put(
        objectKey,
        Buffer.concat([
          Buffer.from("TF01"),
          iv,
          cipher.getAuthTag(),
          ciphertext,
        ]),
      );
    },
    get: async (objectKey) => {
      const data = await storage.get(objectKey);
      if (!data) return null;
      if (data.length < 33 || data.subarray(0, 4).toString() !== "TF01")
        throw new CloudError("存储资料格式无效。", 502);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          data.subarray(4, 16),
        );
        decipher.setAAD(Buffer.from(objectKey));
        decipher.setAuthTag(data.subarray(16, 32));
        return Buffer.concat([
          decipher.update(data.subarray(32)),
          decipher.final(),
        ]);
      } catch {
        throw new CloudError("资料完整性校验失败。", 502);
      }
    },
    delete: (objectKey) => storage.delete(objectKey),
  };
}
