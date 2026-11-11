import { startWorker } from "../src/lib/tasks/worker";
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());
await startWorker(controller.signal);
