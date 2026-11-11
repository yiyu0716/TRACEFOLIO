import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

// Offline upgrade check. This never starts a turn or contacts a model service.
const require = createRequire(import.meta.url);
const packagePath = require.resolve("@openai/codex/package.json");
const { version } = require(packagePath);
const root = await mkdtemp(join(tmpdir(), "tracefolio-protocol-"));
try {
  execFileSync(process.execPath, [join(dirname(packagePath), "bin/codex.js"), "app-server", "generate-json-schema", "--out", root], { stdio: "pipe" });
  const checks = {
    "v2/ThreadStartParams.json": ["model", "cwd", "approvalPolicy", "sandbox", "baseInstructions"],
    "v2/TurnStartParams.json": ["threadId", "input", "outputSchema"],
    "v2/TurnCompletedNotification.json": ["threadId", "turn"],
    "v2/ThreadTokenUsageUpdatedNotification.json": ["threadId", "tokenUsage"],
  };
  for (const [file, fields] of Object.entries(checks)) {
    const schema = JSON.parse(await readFile(join(root, file), "utf8"));
    for (const field of fields) assert.ok(schema.properties[field], `${file} missing ${field}`);
  }
  console.log(`Codex ${version}: required app-server protocol fields are present. No model calls made.`);
} finally { await rm(root, { recursive: true, force: true }); }
