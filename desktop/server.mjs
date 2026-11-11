import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { authorized } from "./security.cjs";

const token = process.env.TRACEFOLIO_DESKTOP_TOKEN;
if (!token || !/^[a-f0-9]{64}$/.test(token))
  throw new Error("Desktop token required");
const require = createRequire(import.meta.url),
  root = process.cwd();
const profile = require(join(root, "desktop-config.json"));
// Build-time commercial configuration cannot be disabled through renderer settings.
process.env.TRACEFOLIO_REQUIRE_LICENSE = profile.requireLicense ? "1" : "0";
if (profile.cloudUrl) process.env.TRACEFOLIO_CLOUD_URL = profile.cloudUrl;
const migrate = spawnSync(
  process.execPath,
  [join(root, "scripts/migrate.mjs")],
  { cwd: root, env: process.env, stdio: "pipe" },
);
if (migrate.status !== 0) throw new Error("Database migration failed");
// The server's random port is not its access credential; every HTTP request is authenticated.
const next = require("next");
const nextConfig = require(
  join(root, ".next/required-server-files.json"),
).config;
const nextApp = next({ dev: false, dir: root, conf: nextConfig });
await nextApp.prepare();
const handle = nextApp.getRequestHandler();
const server = createServer((req, res) => {
  if (!authorized(req, token)) {
    res.writeHead(401, { "Cache-Control": "no-store" }).end();
    return;
  }
  if (
    req.headers.origin &&
    req.headers.origin !== `http://${req.headers.host}`
  ) {
    res.writeHead(403).end();
    return;
  }
  void handle(req, res);
});
server.on("upgrade", (_req, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const worker = spawn(
  process.execPath,
  [join(root, "runtime/task-worker.mjs")],
  { cwd: root, env: process.env, stdio: "ignore" },
);
const shutdown = () => {
  worker.kill("SIGTERM");
  server.close();
  void nextApp.close().finally(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
worker.once("exit", () => {
  server.close();
  process.exit(1);
});
// Prevent the orphaned local backend from surviving a killed desktop parent.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    shutdown();
  }
}, 2000).unref();
process.stdout.write(`TRACEFOLIO_READY:${server.address().port}\n`);
