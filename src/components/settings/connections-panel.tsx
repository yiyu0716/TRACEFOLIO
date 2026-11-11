"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Cloud,
  Cpu,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_PROVIDERS, getAiProvider } from "@/lib/ai/provider-registry";
import type { listConnections } from "@/lib/connections/store";

type Connections = Awaited<ReturnType<typeof listConnections>>;
type Product = {
  id: string;
  name: string;
  kind: "agent" | "bundle";
  term: "month" | "year" | "lifetime";
  priceLabel: string;
  allowanceUnits: number;
};
type CloudState = {
  me: {
    account: { id: string; email: string };
    agent: { active: boolean; lifetime: boolean; until: string | null };
    storage: { usedBytes: number; limitBytes: number };
    balances: { remainingUnits: number; until: string }[];
  };
  catalog: {
    products: Product[];
    models: { id: string; label: string; protocol: string }[];
  };
};
type Document = {
  id: string;
  name: string;
  size: number;
  status: string;
  revision: number;
  createdAt: string;
};
type Usage = {
  id: string;
  model_id: string;
  status: string;
  charged_units: number;
  reserved_units: number;
  created_at: string;
};
const inputClass =
  "h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-primary/25";
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "—");
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? data.message ?? "请求未完成。");
  return data;
}
const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<Connections | null>(null),
    [cloud, setCloud] = useState<CloudState | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]),
    [usage, setUsage] = useState<Usage[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [label, setLabel] = useState(""),
    [providerId, setProviderId] = useState("openai"),
    [model, setModel] = useState(""),
    [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1"),
    [protocol, setProtocol] = useState("responses"),
    [apiKey, setApiKey] = useState("");
  const [cloudUrl, setCloudUrl] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [invite, setInvite] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [consent, setConsent] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const refreshCloud = useCallback(async () => {
    const [state, docs, ledger] = await Promise.all([
      api<CloudState>("/api/cloud/session"),
      api<{ documents: Document[] }>("/api/cloud/documents"),
      api<{ usage: Usage[] }>("/api/cloud/usage"),
    ]);
    setCloud(state);
    setDocuments(docs.documents);
    setUsage(ledger.usage);
  }, []);
  const refresh = useCallback(async () => {
    const data = await api<Connections>("/api/connections");
    setConnections(data);
    setCloudUrl(data.cloudBaseUrl);
    if (data.cloudConnected) await refreshCloud();
    else {
      setCloud(null);
      setDocuments([]);
      setUsage([]);
    }
  }, [refreshCloud]);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (active) return refresh();
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作未完成。");
    } finally {
      setBusy(false);
    }
  }
  async function connectionAction(body: unknown) {
    setConnections(await api<Connections>("/api/connections", jsonPost(body)));
  }
  async function login(mode: "login" | "register") {
    await api(
      "/api/cloud/session",
      jsonPost({
        baseUrl: cloudUrl,
        email,
        password,
        action: mode,
        ...(invite ? { registrationCode: invite } : {}),
      }),
    );
    setPassword("");
    await refresh();
    setMessage(
      mode === "login"
        ? "账号已登录。"
        : "账号已创建，开通套餐后即可使用 Agent。",
    );
  }
  async function upload() {
    if (!file || !consent) return;
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(file.name)),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await api("/api/cloud/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encoded,
        "X-File-Type":
          file.type ||
          (file.name.endsWith(".md") ? "text/markdown" : "text/plain"),
        "X-Upload-Consent": "true",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: file,
    });
    setConsent(false);
    setFile(null);
    await refreshCloud();
    setMessage("资料已加密上传至云端存储。");
  }
  return (
    <section className="rounded-lg border border-line bg-surface p-5 shadow-[0_18px_50px_rgba(49,48,48,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Cpu size={19} />
            模型连接与平台账号
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            为 Codex 任务和职业助手选择模型，管理 Agent 使用权与云端资料。
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void action(refresh)}
        >
          <RefreshCw size={15} />
          刷新
        </Button>
      </div>
      {message && (
        <p
          role="status"
          className="mt-4 rounded-lg bg-surface-low p-3 text-sm leading-6"
        >
          {message}
        </p>
      )}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound size={16} />
              模型连接
            </h4>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowForm(!showForm)}
            >
              <Plus size={14} />
              添加自带密钥
            </Button>
          </div>
          <label className="block space-y-2 text-sm">
            <span>当前使用</span>
            <select
              className={inputClass}
              value={connections?.activeProfileId ?? ""}
              disabled={busy}
              onChange={(event) =>
                void action(async () => {
                  await connectionAction({
                    action: "select",
                    id: event.target.value || null,
                  });
                  window.location.reload();
                })
              }
            >
              <option value="">使用下方原有模型设置 / 环境配置</option>
              {connections?.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
          </label>
          {connections?.profiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
            >
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{p.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.kind === "platform" ? "平台模型" : "自带 API Key"} ·{" "}
                  {p.model}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`删除 ${p.label}`}
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    connectionAction({ action: "delete", id: p.id }),
                  )
                }
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
          {showForm && (
            <form
              className="space-y-3 rounded-xl border border-line bg-surface-low p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  await connectionAction({
                    action: "create",
                    profile: {
                      label,
                      providerId,
                      model,
                      baseUrl,
                      protocol,
                      apiKey,
                      kind: "byok",
                    },
                  });
                  setApiKey("");
                  setShowForm(false);
                  setMessage("模型连接已保存，请在“当前使用”中选择。");
                });
              }}
            >
              <label className="block space-y-1 text-sm">
                连接名称
                <input
                  required
                  className={inputClass}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="我的工作模型"
                />
              </label>
              <label className="block space-y-1 text-sm">
                服务商
                <select
                  className={inputClass}
                  value={providerId}
                  onChange={(e) => {
                    const p = getAiProvider(e.target.value);
                    setProviderId(p.id);
                    setBaseUrl(p.baseUrl);
                    setModel(p.defaultModel);
                    setProtocol(
                      p.id === "openai" ? "responses" : "chat_completions",
                    );
                  }}
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                模型名称
                <input
                  required
                  className={inputClass}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={getAiProvider(providerId).defaultModel}
                />
              </label>
              <label className="block space-y-1 text-sm">
                服务地址
                <input
                  required
                  type="url"
                  className={inputClass}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm">
                连接协议
                <select
                  className={inputClass}
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value)}
                >
                  <option value="responses">Responses</option>
                  <option value="chat_completions">Chat Completions</option>
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                API Key
                <input
                  type="password"
                  autoComplete="off"
                  className={inputClass}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="加密保存在本机"
                />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                模型需要支持工具调用。选择连接本身不会发起模型请求。
              </p>
              <Button disabled={busy} type="submit">
                保存连接
              </Button>
            </form>
          )}
          <div className="rounded-xl border border-line p-4">
            <p className="text-sm font-medium">使用 ChatGPT 订阅</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              商业版需取得 OpenAI 的 Sign in with ChatGPT
              接入资格。接入后可由用户授权使用符合条件的订阅额度。
            </p>
            <a
              className="mt-2 inline-block text-xs text-primary underline"
              href="https://developers.openai.com/siwc"
              target="_blank"
              rel="noreferrer"
            >
              查看官方说明
            </a>
          </div>
        </div>
        <div className="space-y-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Cloud size={16} />
            TRACEFOLIO 账号
          </h4>
          {!cloud ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void action(() => login("login"));
              }}
            >
              <label className="block space-y-1 text-sm">
                平台地址
                <input
                  className={inputClass}
                  required
                  type="url"
                  value={cloudUrl}
                  onChange={(e) => setCloudUrl(e.target.value)}
                  placeholder="https://cloud.example.com"
                />
              </label>
              <label className="block space-y-1 text-sm">
                邮箱
                <input
                  className={inputClass}
                  required
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm">
                密码
                <input
                  className={inputClass}
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm">
                注册邀请码（如需要）
                <input
                  className={inputClass}
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button disabled={busy} type="submit">
                  登录
                </Button>
                <Button
                  disabled={busy}
                  type="button"
                  variant="outline"
                  onClick={() => void action(() => login("register"))}
                >
                  注册账号
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="rounded-xl bg-surface-low p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">
                    {cloud.me.account.email}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api("/api/cloud/session", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: "{}",
                        });
                        await refresh();
                      })
                    }
                  >
                    <LogOut size={14} />
                    退出
                  </Button>
                </div>
                <p className="mt-3 text-sm">
                  Agent：
                  {cloud.me.agent.active
                    ? cloud.me.agent.lifetime
                      ? "永久使用权"
                      : `有效至 ${date(cloud.me.agent.until)}`
                    : "尚未开通"}
                </p>
                <p className="mt-1 text-sm">
                  平台模型可用额度：
                  {cloud.me.balances
                    .reduce((s, b) => s + b.remainingUnits, 0)
                    .toLocaleString()}{" "}
                  单位
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  自带密钥的模型费用由对应服务商收取。
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {cloud.catalog.products.map((p) => (
                  <div key={p.id} className="rounded-lg border border-line p-3">
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.kind === "agent"
                        ? "仅 Agent 使用权"
                        : "Agent 使用权＋平台模型额度"}
                    </p>
                    <p className="mt-2 text-xs">{p.priceLabel}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                当前通过管理员开通套餐。永久档适用于 Agent
                使用权；模型额度按套餐约定的有效期使用。
              </p>
              {cloud.catalog.models.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">平台模型</p>
                  {cloud.catalog.models.map((m) => (
                    <Button
                      key={m.id}
                      variant="outline"
                      size="sm"
                      className="mr-2"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          connectionAction({ action: "platform", model: m.id }),
                        )
                      }
                    >
                      <Plus size={13} />
                      {m.label}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {cloud && (
        <div className="mt-6 border-t border-line pt-5">
          <div className="flex flex-wrap justify-between gap-2">
            <h4 className="text-sm font-semibold">云端资料</h4>
            <p className="text-xs text-muted-foreground">
              {bytes(cloud.me.storage.usedBytes)} /{" "}
              {bytes(cloud.me.storage.limitBytes)}
            </p>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            所选文件会发送至平台服务器，加密后存入平台配置的夸克网盘桥接。单份不超过
            20 MiB。云端资料不会自动成为职业事实。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".pdf,.docx,.doc,.txt,.md,.json,.png,.jpg,.jpeg"
              disabled={busy}
              className="max-w-full text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setConsent(false);
              }}
            />
            <Button
              size="sm"
              disabled={busy || !file || !consent}
              onClick={() => void action(upload)}
            >
              <Upload size={14} />
              上传资料
            </Button>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs leading-5">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我同意将所选资料上传至平台的云端存储
          </label>
          <div className="mt-4 space-y-2">
            {documents.map((d) => (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
              >
                <div className="min-w-0 text-sm">
                  <span className="break-all">{d.name}</span>
                  <p className="text-xs text-muted-foreground">
                    {bytes(d.size)} · {date(d.createdAt)} ·{" "}
                    {(
                      {
                        ready: "已保存",
                        pending: "上传待核对",
                        deleting: "删除待重试",
                        failed: "上传失败",
                      } as Record<string, string>
                    )[d.status] ?? d.status}
                  </p>
                </div>
                <div className="flex gap-3">
                  {d.status === "ready" && (
                    <a
                      className="text-xs text-primary underline"
                      href={`/api/cloud/documents/${d.id}`}
                      download
                    >
                      下载
                    </a>
                  )}
                  <button
                    className="text-xs text-muted-foreground"
                    disabled={busy || d.status === "pending"}
                    onClick={() => {
                      if (window.confirm(`删除云端资料“${d.name}”？`))
                        void action(async () => {
                          await api(`/api/cloud/documents/${d.id}`, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ revision: d.revision }),
                          });
                          await refreshCloud();
                        });
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
            {!documents.length && (
              <p className="text-sm text-muted-foreground">还没有云端资料。</p>
            )}
          </div>
          {usage.length > 0 && (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-medium">
                最近模型用量
              </summary>
              <div className="mt-2 space-y-1 text-xs">
                {usage.slice(0, 12).map((u) => (
                  <p key={u.id}>
                    {date(u.created_at)} · {u.model_id} ·{" "}
                    {(
                      {
                        settled: "已结算",
                        reserved: "已预留",
                        released: "已释放",
                        uncertain: "结果待核对，保留预留",
                      } as Record<string, string>
                    )[u.status] ?? u.status}{" "}
                    · {Number(u.charged_units).toLocaleString()} 单位
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
