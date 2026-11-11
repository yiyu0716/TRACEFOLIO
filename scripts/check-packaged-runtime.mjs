import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const out = resolve("outputs/desktop");
const contents =
  process.platform === "darwin"
    ? join(
        out,
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "TRACEFOLIO.app",
        "Contents",
      )
    : join(out, "win-unpacked");
const executable =
  process.platform === "darwin"
    ? join(contents, "MacOS", "TRACEFOLIO")
    : join(contents, "TRACEFOLIO.exe");
const backend = join(
  contents,
  process.platform === "darwin" ? "Resources" : "resources",
  "backend",
);
if (!existsSync(executable) || !existsSync(backend))
  throw new Error("Build the current platform's desktop package first");
const check = spawnSync(process.execPath, ["scripts/smoke-desktop.mjs"], {
  env: {
    ...process.env,
    TRACEFOLIO_SMOKE_NODE: executable,
    TRACEFOLIO_SMOKE_BACKEND: backend,
  },
  stdio: "inherit",
});
if (check.error) throw check.error;
process.exitCode = check.status ?? 1;
