import { existsSync } from "node:fs";
import { postgres, schema } from "./db";
import { cloudConfig } from "./bootstrap";
import { createCloudServer } from "./server";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = cloudConfig(),
  { db, close } = postgres(config.databaseUrl);
await db.query(schema);
const app = await createCloudServer({
  ...config,
  db,
  registrationCode: process.env.TRACEFOLIO_REGISTRATION_CODE,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close().then(close);
  });
await app.listen({
  host: process.env.TRACEFOLIO_CLOUD_HOST ?? "127.0.0.1",
  port: Number(process.env.TRACEFOLIO_CLOUD_PORT ?? 4310),
});
console.log("TRACEFOLIO cloud service ready. No local career API is exposed.");
