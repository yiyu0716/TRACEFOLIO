import { existsSync } from "node:fs";
import { tsImport } from "tsx/esm/api";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DATABASE_URL ||= "file:./dev.db";
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
try {
  const { startWorker } = await tsImport("../src/lib/tasks/worker.ts", import.meta.url);
  await startWorker(controller.signal);
} catch {
  console.error("TRACEFOLIO task worker stopped. Check migrations and runtime configuration.");
  process.exitCode = 1;
}
