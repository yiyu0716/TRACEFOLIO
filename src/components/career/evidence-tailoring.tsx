"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, FileCheck2, Loader2, RefreshCw, Square, X } from "lucide-react";
import type { taskDetail, taskSummary } from "@/lib/tasks/store";

type TaskSummary = ReturnType<typeof taskSummary>;
type TaskDetail = Awaited<ReturnType<typeof taskDetail>>;
type Options = {
  resumes: Array<{ id: string; name: string }>;
  jobs: Array<{ id: string; company: string; title: string }>;
  evidence: Array<{ id: string; title: string; sourceType: string }>;
  tasks: TaskSummary[]; runtimeAvailable: boolean; workerOnline: boolean;
};
const field = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/10";
const button = "inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50";
const quiet = "inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm hover:bg-surface-low disabled:opacity-50";
const labels: Record<string, string> = {
  queued: "等待生成", running: "正在生成", awaiting_approval: "待你确认", needs_input: "需要补充材料",
  succeeded: "已保存新版本", failed: "生成未完成", cancel_requested: "正在取消", cancelled: "已取消", stale: "依据已变化",
};
const sourceLabels: Record<string, string> = { resume: "原简历", artifact: "作品材料", interview: "面试记录", self_report: "本人自述" };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "操作未完成，请重试。");
  return value as T;
}

export function EvidenceTailoring() {
  const [options, setOptions] = useState<Options | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [resumeId, setResumeId] = useState("");
  const [jobId, setJobId] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [includeMemories, setIncludeMemories] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const selectedRef = useRef(selected);
  const refresh = useCallback(async () => {
    const data = await api<Options>("/api/career/tasks"); setOptions(data);
    const id = selectedRef.current;
    if (id) {
      const result = await api<{ task: TaskDetail }>(`/api/career/tasks/${encodeURIComponent(id)}`);
      if (selectedRef.current === id) setTask(result.task);
    }
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    api<Options>("/api/career/tasks").then((data) => {
      if (active) {
        setOptions(data);
        const query = new URLSearchParams(window.location.search).get("task");
        if (query) setSelected(query);
      }
    }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => { requestId.current = null; }, [resumeId, jobId, evidenceIds, includeMemories]);

  useEffect(() => {
    selectedRef.current = selected;
    if (!selected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { task: value } = await api<{ task: TaskDetail }>(`/api/career/tasks/${encodeURIComponent(selected)}`);
        if (!active) return;
        setTask(value);
        setOptions((previous) => previous ? { ...previous, tasks: previous.tasks.map((item) => item.id === value.id ? { ...item, status: value.status, revision: value.revision, resultVersionId: value.resultVersionId } : item) } : previous);
        if (["queued", "running", "cancel_requested", "awaiting_approval"].includes(value.status)) timer = setTimeout(poll, 1500);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "无法读取任务。"); }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [selected]);

  function select(id: string | null) {
    if (id === selected) return;
    setSelected(id); setTask(null); setConfirmed(false); setError("");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("task", id); else url.searchParams.delete("task");
    window.history.replaceState(null, "", url);
  }

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await api<{ task: TaskSummary }>("/api/career/tasks", { requestId: requestId.current, resumeVersionId: resumeId, jobId, evidenceIds, includeMemories });
      requestId.current = null; select(result.task.id); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建任务。"); }
    finally { setBusy(false); }
  }

  async function act(action: "approve" | "cancel") {
    if (!task) return;
    const id = task.id;
    setBusy(true); setError("");
    try {
      await api(`/api/career/tasks/${id}/${action}`, action === "approve" ? { revision: task.revision, digest: task.approvalDigest, confirmed: true } : { revision: task.revision });
      const result = await api<{ task: TaskDetail }>(`/api/career/tasks/${id}`);
      if (selectedRef.current === id) { setTask(result.task); setConfirmed(false); }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成。"); }
    finally { setBusy(false); }
  }

  return <section className="space-y-5" aria-label="证据支撑的 JD 简历定制">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="flex items-center gap-2 text-lg font-semibold"><FileCheck2 size={20} className="text-brand" />用证据，写出更贴合岗位的简历</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">选择原简历、目标岗位和真实材料，逐项核对修改及来源后，保存为独立版本。</p></div>
      <button className={quiet} onClick={() => { setError(""); void refresh().catch((cause: Error) => setError(cause.message)); }}><RefreshCw size={14} />刷新</button>
    </div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {!options ? <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />正在加载简历与岗位…</p> : <>
      {!options.runtimeAvailable && <p className="rounded-xl border border-line bg-surface-low p-4 text-sm leading-6">尚未连接 Codex 任务模型。完成运行说明中的模型配置后，即可开始生成。</p>}
      {options.runtimeAvailable && !options.workerOnline && <p className="rounded-xl border border-line bg-surface-low p-4 text-sm leading-6">任务执行服务暂未连接。已有提案仍可查看，排队任务会在服务恢复后继续。</p>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="space-y-5">
          <form onSubmit={create} className="space-y-4 rounded-2xl border border-line bg-surface p-5">
            <label className="block space-y-2 text-sm font-medium"><span>原简历</span><select aria-label="原简历" className={field} value={resumeId} onChange={(e) => setResumeId(e.target.value)} required><option value="">选择已保存的简历版本</option>{options.resumes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="block space-y-2 text-sm font-medium"><span>目标岗位</span><select aria-label="目标岗位" className={field} value={jobId} onChange={(e) => setJobId(e.target.value)} required><option value="">选择已有岗位与 JD</option>{options.jobs.map((item) => <option key={item.id} value={item.id}>{item.company} · {item.title}</option>)}</select></label>
            <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">能力证据 <span className="font-normal text-muted-foreground">最多 10 份</span></legend>
              {!options.evidence.length && <p className="text-sm leading-6 text-muted-foreground">先在“能力证据”添加材料，核对后确认，并允许用于 AI 分析。</p>}
              <div className="max-h-60 space-y-2 overflow-y-auto">{options.evidence.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm"><input type="checkbox" className="mt-1 accent-brand" checked={evidenceIds.includes(item.id)} disabled={!evidenceIds.includes(item.id) && evidenceIds.length >= 10} onChange={(e) => setEvidenceIds((ids) => e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} /><span>{item.title}<span className="mt-1 block text-xs text-muted-foreground">{sourceLabels[item.sourceType]}</span></span></label>)}</div>
            </fieldset>
            <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1.5 accent-brand" checked={includeMemories} onChange={(e) => setIncludeMemories(e.target.checked)} />参考已授权、未过期的职业记忆，理解目标与约束</label>
            <p className="text-xs leading-5 text-muted-foreground">生成会将所选材料发送给已配置的模型服务。完成后先展示提案，确认保存时才创建简历版本。</p>
            <button type="submit" className={button} disabled={busy || !options.runtimeAvailable || !resumeId || !jobId || !evidenceIds.length}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}生成修改提案</button>
          </form>
          <div className="rounded-2xl border border-line bg-surface p-5"><h4 className="mb-3 text-sm font-semibold">最近的定制任务</h4>
            {!options.tasks.length && <p className="text-sm text-muted-foreground">完成材料选择后，开始第一份定制。</p>}
            <div className="space-y-2">{options.tasks.map((item) => <button key={item.id} className={`w-full rounded-xl border p-3 text-left text-sm ${selected === item.id ? "border-brand bg-primary-soft" : "border-line hover:bg-surface-low"}`} onClick={() => select(item.id)}><span className="block font-medium">{item.jobLabel}</span><span className="mt-1 block text-xs text-muted-foreground">{item.resumeName} · {labels[item.status] ?? item.status}</span></button>)}</div>
          </div>
        </div>
        <div className="min-w-0 rounded-2xl border border-line bg-surface p-5">
          {!selected ? <div className="flex min-h-72 flex-col items-center justify-center text-center"><FileCheck2 size={36} className="mb-4 text-brand" /><h4 className="font-semibold">每处改写，都能看到依据</h4><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">这里将展示原文、改写、修改理由和证据摘录。可以关闭页面，之后从任务列表继续查看。</p></div> : !task ? <p className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" />正在读取任务…</p> : <div className="space-y-5">
            <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-medium text-brand">{labels[task.status] ?? task.status}</p><h4 className="mt-2 font-semibold">{task.jobLabel}</h4><p className="mt-1 text-xs text-muted-foreground">{task.resumeName}</p></div><button className={quiet} aria-label="关闭任务详情" onClick={() => select(null)}><X size={14} /></button></div>
            {["queued", "running", "cancel_requested"].includes(task.status) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />{task.events[0]?.message || "任务正在处理。"}</p>}
            {task.error && <p role="alert" className="rounded-xl bg-surface-low p-3 text-sm leading-6">{task.error}</p>}
            {task.proposal && <>
              <p className="text-sm leading-7">{task.proposal.summary}</p>
              {task.warnings.map((warning) => <p key={warning} className="rounded-xl bg-surface-low p-3 text-xs leading-6 text-muted-foreground">{warning}</p>)}
              <p className="text-xs leading-6 text-muted-foreground">程序已核对字段与引用摘录；语义、个人贡献和结果仍需你逐项确认。作品材料未经独立核验。</p>
              {task.proposal.changes.map((change) => <article key={change.path} className="space-y-3 rounded-xl border border-line p-4"><h5 className="text-sm font-semibold">{task.fields.find((item) => item.path === change.path)?.label || "简历内容"}</h5><div className="space-y-2 text-sm leading-7"><p className="text-xs text-muted-foreground">原文</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{change.before}</p><p className="pt-2 text-xs font-medium text-brand">建议改写</p><p className="whitespace-pre-wrap break-words">{change.after}</p></div><p className="text-xs leading-6 text-muted-foreground">{change.reason}</p>
                <details className="rounded-lg bg-surface-low p-3 text-xs"><summary className="cursor-pointer font-medium">查看 {change.citations.length} 条依据</summary><div className="mt-3 space-y-3">{change.citations.map((citation, index) => <blockquote key={`${citation.sourceId}-${index}`} className="border-l-2 border-brand/40 pl-3 leading-6"><p className="font-medium">{task.sources.find((source) => source.id === citation.sourceId)?.title || "原始材料"} · {sourceLabels[citation.basis]}</p><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{citation.quote}</p></blockquote>)}</div></details>
              </article>)}
              {!!task.proposal.questions.length && <div className="rounded-xl bg-surface-low p-4"><h5 className="text-sm font-semibold">建议补充核对</h5><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6">{task.proposal.questions.map((question) => <li key={question}>{question}</li>)}</ul></div>}
            </>}
            {task.status === "awaiting_approval" && <div className="space-y-3 border-t border-line pt-4"><label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1.5 accent-brand" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对全部改写和来源，确认没有夸大或编造，并同意保存为新版本。</label><button className={button} disabled={!confirmed || busy} onClick={() => void act("approve")}><Check size={15} />确认并保存新版本</button></div>}
            {["succeeded", "stale"].includes(task.status) && task.resultVersionId && <a className={button} href={`/resume/edit?version=${encodeURIComponent(task.resultVersionId)}`}>查看已保存的简历版本<ArrowRight size={15} /></a>}
            {["queued", "running", "awaiting_approval", "needs_input"].includes(task.status) && <button className={quiet} disabled={busy} onClick={() => void act("cancel")}><Square size={13} />{task.status === "awaiting_approval" ? "放弃本次提案" : "取消任务"}</button>}
            {!!task.events.length && <details className="border-t border-line pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">任务进度记录</summary><ol className="mt-3 space-y-2">{[...task.events].reverse().map((event) => <li key={event.id} className="leading-6">{event.message}</li>)}</ol></details>}
          </div>}
        </div>
      </div>
    </>}
  </section>;
}
