import { spawn } from "node:child_process";

const mode = process.argv[2];
if (!["dev", "start"].includes(mode)) throw new Error("Expected dev or start");
const worker = spawn(process.execPath, ["scripts/task-worker.mjs"], { stdio: "inherit" });
const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", mode, ...(mode === "dev" ? ["--webpack"] : []), "--hostname", process.env.TRACEFOLIO_LISTEN_HOST || "127.0.0.1", ...process.argv.slice(3)], { stdio: "inherit" });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  worker.kill("SIGTERM"); web.kill("SIGTERM");
  const timer = setTimeout(() => { worker.kill("SIGKILL"); web.kill("SIGKILL"); process.exit(code); }, 4000);
  timer.unref();
  process.exitCode = code;
}
for (const child of [worker, web]) {
  child.once("exit", (code) => stop(code ?? 0));
  child.once("error", () => stop(1));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop());
