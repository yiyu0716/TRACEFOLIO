import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const data = await mkdtemp(join(tmpdir(), "tracefolio-desktop-smoke-"));
const root = resolve(".desktop/backend"),
  token = randomBytes(32).toString("hex");
const executable = process.env.TRACEFOLIO_SMOKE_NODE ?? process.execPath;
const child = spawn(executable, [join(root, "runtime/desktop-server.mjs")], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    ...Object.fromEntries(
      ["SystemRoot", "WINDIR", "TEMP", "TMP"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    TRACEFOLIO_DESKTOP_NODE: "1",
    DATABASE_URL: `file:${join(data, "career.db").replace(/\\/g, "/")}`,
    LUJIE_SETTINGS_SECRET: randomBytes(32).toString("hex"),
    TRACEFOLIO_DESKTOP_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => {
  stderr += String(c);
});
try {
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Desktop startup timeout")),
      45000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Desktop backend exited: ${stderr.slice(-2500)}`));
    });
    child.stdout.on("data", (c) => {
      output += String(c);
      const m = output.match(/TRACEFOLIO_READY:(\d+)\n/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${port}`,
    headers = { "X-Tracefolio-Desktop": token };
  assert.equal((await fetch(`${base}/api/connections`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/connections`, {
        headers: { ...headers, Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  const page = await fetch(`${base}/settings`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TRACEFOLIO/);
  const profiles = await fetch(`${base}/api/connections`, { headers });
  assert.equal(profiles.status, 200);
  assert.deepEqual((await profiles.json()).profiles, []);
  const tasks = await fetch(`${base}/api/career/tasks`, { headers });
  assert.equal(tasks.status, 200);
  const state = await tasks.json();
  assert.equal(state.runtimeAvailable, false);
  assert.equal(state.workerOnline, true);
  assert.equal(
    (
      await fetch(`${base}/api/connections`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          profile: {
            label: "smoke",
            providerId: "openai",
            model: "synthetic",
            baseUrl: "https://fake.invalid/v1",
            protocol: "responses",
            apiKey: "synthetic-private-key",
          },
        }),
      })
    ).status,
    200,
  );
  const check = await (
    await fetch(`${base}/api/connections`, { headers })
  ).text();
  assert(!check.includes("synthetic-private-key"));
  console.log(
    "Desktop smoke passed: isolated DB, migrated backend, rendered UI, authenticated loopback, encrypted model profile.",
  );
} finally {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  await exited;
  clearTimeout(timer);
  await rm(data, { recursive: true, force: true });
}
