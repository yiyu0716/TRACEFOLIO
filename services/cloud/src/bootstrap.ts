import { resolve } from "node:path";
import { catalog } from "./config";
import { encryptedStorage, localStorage, quarkWebdavStorage } from "./storage";

export function cloudConfig(env: NodeJS.ProcessEnv = process.env) {
  const { products, models } = catalog(env);
  const databaseUrl = env.TRACEFOLIO_CLOUD_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Configure TRACEFOLIO_CLOUD_DATABASE_URL (PostgreSQL)");
  const raw = env.TRACEFOLIO_STORAGE_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(raw))
    throw new Error(
      "Set TRACEFOLIO_STORAGE_KEY to 32 random bytes encoded as hex",
    );
  const driver = env.TRACEFOLIO_STORAGE_DRIVER ?? "local";
  if (env.NODE_ENV === "production" && driver === "local")
    throw new Error("Production storage must be explicitly configured");
  const underlying =
    driver === "quark-webdav"
      ? quarkWebdavStorage({
          url: env.TRACEFOLIO_QUARK_WEBDAV_URL ?? "",
          username: env.TRACEFOLIO_QUARK_WEBDAV_USER ?? "",
          password: env.TRACEFOLIO_QUARK_WEBDAV_PASSWORD ?? "",
        })
      : driver === "local"
        ? localStorage(
            resolve(env.TRACEFOLIO_STORAGE_DIR ?? ".cloud-data/objects"),
          )
        : (() => {
            throw new Error("Unknown storage driver");
          })();
  return {
    products,
    models,
    databaseUrl,
    storage: encryptedStorage(underlying, Buffer.from(raw, "hex")),
  };
}
