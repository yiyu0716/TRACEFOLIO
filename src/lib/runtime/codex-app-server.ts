import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { TAILORING_INSTRUCTIONS, proposalSchema, type TailoringProposal } from "@/lib/tasks/domain";
import type { RuntimeConfig } from "./config";

export type RuntimeMeta = { threadId?: string; turnId?: string; runtimeVersion?: string; model?: string };
export type RuntimeResult = { proposal: TailoringProposal; metrics: { elapsedMs: number; usage: Record<string, number> | null; cost: null; costBasis: string } };
type Command = { executable: string; args: string[]; version: string };
type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

export function codexCommand(): Command {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@openai/codex/package.json");
  const { version } = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
  return { executable: process.execPath, args: [join(dirname(packagePath), "bin/codex.js"), "app-server", "--listen", "stdio://"], version };
}

class JsonRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stopped = false;
  constructor(command: Command, cwd: string, env: NodeJS.ProcessEnv, private receive: (message: Message) => void, private failed: (error: Error) => void) {
    this.child = spawn(command.executable, command.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume(); // Provider output may contain sensitive values; never forward it.
    this.child.stdin.on("error", () => this.fail(new Error("Codex input closed")));
    this.child.on("error", () => this.fail(new Error("Codex process unavailable")));
    this.child.on("exit", () => this.fail(new Error("Codex process exited")));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 2 * 1024 * 1024) { this.fail(new Error("Codex message too large")); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.handle(JSON.parse(line) as Message); }
        catch { this.fail(new Error("Invalid Codex protocol message")); }
      }
    });
  }
  private handle(message: Message) {
    if (message.method) {
      if (message.id !== undefined) {
        // No native approvals or unexpected server requests are automatically accepted.
        this.write({ id: message.id, error: { code: -32601, message: "This client only permits the scoped career workflow." } });
      } else this.receive(message);
      return;
    }
    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("Codex protocol request rejected")); else pending.resolve(message.result);
  }
  private write(message: unknown) { if (!this.stopped) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  notify(method: string) { this.write({ method, params: {} }); }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Codex connection closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex protocol timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); if (!this.stopped) this.failed(error);
  }
  async close() {
    this.stopped = true;
    this.fail(new Error("Codex connection closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 1500); })]);
    if (timer) clearTimeout(timer);
  }
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function runCodexTailoring(input: {
  config: RuntimeConfig;
  tools: { url: string; token: string; getProposal: () => TailoringProposal | null };
  signal: AbortSignal;
  onMeta?: (meta: RuntimeMeta) => Promise<void>;
  command?: Command;
}): Promise<RuntimeResult> {
  const started = Date.now();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.config.timeoutMs)]);
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "tracefolio-agent-"));
  let rpc: JsonRpcProcess | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let usage: Record<string, number> | null = null;
  let eventQueue = Promise.resolve();
  let resolveCompleted!: (value: Record<string, unknown>) => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<Record<string, unknown>>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  void completed.catch(() => {});
  let rejectAborted!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  void aborted.catch(() => {});
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const race = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
  try {
    const workspace = join(root, "workspace"); const home = join(root, "runtime");
    await mkdir(workspace); await mkdir(home);
    const quote = (text: string) => JSON.stringify(text);
    const provider = input.config.baseUrl ? [
      'model_provider = "tracefolio"', '[model_providers.tracefolio]', 'name = "TRACEFOLIO Responses"',
      `base_url = ${quote(input.config.baseUrl)}`, 'wire_api = "responses"', 'env_key = "CODEX_API_KEY"',
      'request_max_retries = 0', 'stream_max_retries = 0',
    ] : [];
    const config = [
      `model = ${quote(input.config.model)}`, 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"', 'cli_auth_credentials_store = "file"',
      '[features]', 'shell_tool = false', 'view_image = false', 'apps = false', 'skill_mcp_dependency_install = false',
      'multi_agent = false', 'goals = false', 'browser_use = false', 'computer_use = false', 'workspace_dependencies = false',
      '[mcp_servers.career]', `url = ${quote(input.tools.url)}`, 'bearer_token_env_var = "TRACEFOLIO_TOOLS_TOKEN"', 'required = true',
    ];
    // Provider selection is a root key, so write it before any TOML table.
    const text = input.config.baseUrl ? [...provider.slice(0, 1), ...config, ...provider.slice(1)] : config;
    await writeFile(join(home, "config.toml"), `${text.join("\n")}\n`, { mode: 0o600 });
    const command = input.command ?? codexCommand();
    await input.onMeta?.({ runtimeVersion: command.version, model: input.config.model });
    rpc = new JsonRpcProcess(command, workspace, {
      PATH: process.env.PATH ?? "", NODE_ENV: "production", CODEX_HOME: home, CODEX_API_KEY: input.config.apiKey, TRACEFOLIO_TOOLS_TOKEN: input.tools.token,
      ...(process.env.TRACEFOLIO_DESKTOP_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1", TRACEFOLIO_DESKTOP_NODE: "1" } : {}),
      ...(process.platform === "win32" ? Object.fromEntries(["SystemRoot","WINDIR","TEMP","TMP"].filter((key)=>process.env[key]).map((key)=>[key,process.env[key]])) : {}),
    }, (message) => {
      const params = record(message.params);
      if (threadId && params.threadId !== threadId) return;
      if (message.method === "thread/tokenUsage/updated") {
        const total = record(record(params.tokenUsage).total);
        usage = Object.fromEntries(Object.entries(total).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0));
      }
      if (message.method === "turn/started") {
        const id = record(params.turn).id;
        if (typeof id === "string") {
          turnId = id;
          eventQueue = eventQueue.then(() => input.onMeta?.({ turnId: id }));
          void eventQueue.catch(rejectCompleted);
        }
      }
      if (message.method === "turn/completed") resolveCompleted(record(params.turn));
    }, rejectCompleted);
    await race(rpc.request("initialize", { clientInfo: { name: "tracefolio", title: "TRACEFOLIO", version: "0.2.0" }, capabilities: { experimentalApi: false } }));
    rpc.notify("initialized");
    await race(rpc.request("account/login/start", { type: "apiKey", apiKey: input.config.apiKey }));
    const response = record(await race(rpc.request("thread/start", {
      model: input.config.model, cwd: workspace, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: TAILORING_INSTRUCTIONS,
    })));
    threadId = z.string().min(1).parse(record(response.thread).id);
    await input.onMeta?.({ threadId });
    const turn = record(await race(rpc.request("turn/start", {
      threadId, input: [{ type: "text", text: "请使用职业工具，为当前任务的岗位定制简历。先阅读简历、JD 与证据，生成有据可循的修改提案，提交校验，并返回相同的提案 JSON。" }],
      outputSchema: z.toJSONSchema(proposalSchema),
    })));
    turnId = z.string().min(1).parse(record(turn.turn).id);
    await input.onMeta?.({ turnId });
    const finished = await race(completed);
    await eventQueue;
    if (finished.id !== turnId || finished.status !== "completed") throw new Error("Codex turn did not complete");
    const proposal = input.tools.getProposal();
    if (!proposal) throw new Error("Codex did not submit a validated proposal");
    return { proposal, metrics: { elapsedMs: Date.now() - started, usage, cost: null, costBasis: "未配置计价规则；token 用量不等于账单费用。" } };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted && rpc && threadId && turnId) {
      await rpc.request("turn/interrupt", { threadId, turnId }, 700).catch(() => {});
    }
    await rpc?.close();
    await rm(root, { recursive: true, force: true });
  }
}
