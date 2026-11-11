"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Brain,
  Check,
  Download,
  FileCheck2,
  Fingerprint,
  Leaf,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  buildCareerGrounding,
  canCompleteAction,
  matchEvidence,
  type CareerState,
  type Evidence,
  type Memory,
  type MatchRow,
} from "@/lib/career/domain";
import type { CareerReview } from "@/lib/career/codex";
import type { NavKey } from "@/lib/navigation";
import { EvidenceTailoring } from "./evidence-tailoring";

type Tab = "overview" | "memory" | "evidence" | "tailoring" | "growth";
type WorkspaceData = CareerState & { codexAvailable: boolean };
type Save = (url: string, body: unknown, method?: string) => Promise<boolean>;
const tabs: Array<[Tab, string]> = [
  ["overview", "能力地图"],
  ["memory", "职业记忆"],
  ["evidence", "能力证据"],
  ["tailoring", "证据定制"],
  ["growth", "成长计划"],
];
const categories = {
  profile: "职业背景",
  goal: "求职目标",
  preference: "工作偏好",
  constraint: "现实约束",
  feedback: "复盘反馈",
};
const sources = {
  self_report: "本人自述",
  artifact: "作品 / 项目材料",
  interview: "面试记录",
};
const fieldClass =
  "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/10";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50";
const quietButton =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm transition hover:bg-surface-low disabled:opacity-50";

async function requestJson(url: string, body?: unknown, method = "GET") {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求未完成，请重试。");
  return result;
}

export function CareerWorkspace({
  onNavigate,
}: {
  onNavigate: (key: NavKey) => void;
}) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requirements, setRequirements] = useState("");
  const [requiredSkills, setRequiredSkills] = useState<string[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | undefined>();
  const [editingEvidence, setEditingEvidence] = useState<
    Evidence | undefined
  >();
  const [review, setReview] = useState<CareerReview | null>(null);
  const refresh = useCallback(
    async () => setData(await requestJson("/api/career")),
    [],
  );

  useEffect(() => {
    let active = true;
    requestJson("/api/career")
      .then((value) => {
        if (active) {
          setData(value);
          const query = new URLSearchParams(window.location.search);
          if (query.has("task") || query.get("tab") === "tailoring") setTab("tailoring");
        }
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const match = useMemo(
    () =>
      data && requiredSkills.length
        ? matchEvidence(requiredSkills, data.evidence)
        : null,
    [data, requiredSkills],
  );
  const sharedCount = useMemo(
    () =>
      data
        ? data.memories.filter(
            (item) =>
              item.confirmed &&
              item.useInAI &&
              (!item.expiresAt || new Date(item.expiresAt) > new Date()),
          ).length +
          data.evidence.filter(
            (item) => item.status === "accepted" && item.useInAI,
          ).length
        : 0,
    [data],
  );

  const save: Save = async (url, body, method = "POST") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await requestJson(url, body, method);
      setReview(null);
      await refresh();
      setMessage("已保存。之后的分析会读取最新记录。");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  async function remove(
    kind: "memories" | "evidence",
    item: Memory | Evidence,
  ) {
    if (
      !window.confirm(
        `从${kind === "memories" ? "职业记忆库" : "能力证据库"}删除“${"key" in item ? item.key : item.title}”？`,
      )
    )
      return;
    if (
      await save(
        `/api/career/${kind}/${item.id}`,
        { revision: item.revision },
        "DELETE",
      )
    ) {
      setEditingMemory(undefined);
      setEditingEvidence(undefined);
    }
  }

  async function runReview() {
    setReviewBusy(true);
    setReview(null);
    setError("");
    setMessage("");
    try {
      setReview(
        (await requestJson("/api/career/review", { requiredSkills }, "POST"))
          .review,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复盘未完成。");
    } finally {
      setReviewBusy(false);
    }
  }

  function exportProfile() {
    if (!data) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: "tracefolio-career-v1",
            exportedAt: new Date().toISOString(),
            memories: data.memories,
            evidence: data.evidence,
            actions: data.actions,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tracefolio-career-profile.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function addGap(row: MatchRow) {
    return save("/api/career/growth", {
      skill: row.skill,
      title: `补齐 ${row.skill} 的能力证据`,
      evidenceTarget: row.nextAction,
    });
  }

  return (
    <div className="space-y-6 pb-16">
      <section className="relative overflow-hidden rounded-3xl bg-hero p-6 text-hero-foreground lg:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-28 h-80 w-80 rounded-full border-[36px] border-hero-ring"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-xl">
            <p className="mb-4 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-hero-detail">
              <Fingerprint size={16} /> YOUR CAREER, WITH EVIDENCE
            </p>
            <h2 className="text-2xl font-semibold leading-snug lg:text-3xl">
              让每一份能力，都有迹可循。
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-7 text-hero-muted">
              记住你的目标和选择，把做过的事变成能讲清、可追溯的证据。让下一份简历、下一场面试，都建立在真实积累之上。
            </p>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-hero-muted">
              <span>01 记住你</span>
              <span>02 找到证据</span>
              <span>03 对齐岗位</span>
              <span>04 持续成长</span>
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-xl border border-hero-border px-4 py-2.5 text-sm hover:bg-primary-soft disabled:opacity-40"
            disabled={!data}
            onClick={exportProfile}
          >
            <Download size={15} />
            导出职业档案
          </button>
        </div>
      </section>

      <div
        className="flex gap-1 overflow-x-auto border-b border-line"
        role="tablist"
        aria-label="职业智能工作区"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`career-tab-${key}`}
            aria-controls={`career-panel-${key}`}
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setError("");
              setMessage("");
            }}
            className={`shrink-0 border-b-2 px-5 py-3 text-sm font-medium ${tab === key ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
          {!data && (
            <button
              className={quietButton}
              onClick={() =>
                refresh()
                  .then(() => setError(""))
                  .catch((cause) => setError(cause.message))
              }
            >
              重试加载
            </button>
          )}
        </div>
      )}
      {message && (
        <p
          role="status"
          className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {message}
        </p>
      )}
      {!data ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 size={18} className="animate-spin" />
          读取职业档案…
        </div>
      ) : (
        <div
          id={`career-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`career-tab-${tab}`}
        >
          {tab === "tailoring" && <EvidenceTailoring />}
          {tab === "overview" && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <Metric
                  icon={<Brain size={20} />}
                  label="已确认的职业记忆"
                  value={
                    data.memories.filter(
                      (item) =>
                        item.confirmed &&
                        (!item.expiresAt ||
                          new Date(item.expiresAt) > new Date()),
                    ).length
                  }
                  detail="目标、偏好与真实约束"
                  onClick={() => setTab("memory")}
                />
                <Metric
                  icon={<FileCheck2 size={20} />}
                  label="已确认的能力证据"
                  value={
                    data.evidence.filter((item) => item.status === "accepted")
                      .length
                  }
                  detail="保留材料来源与个人贡献"
                  onClick={() => setTab("evidence")}
                />
                <Metric
                  icon={<Leaf size={20} />}
                  label="正在推进的成长任务"
                  value={
                    data.actions.filter((item) => item.status === "open").length
                  }
                  detail="用新证据验证每一次进步"
                  onClick={() => setTab("growth")}
                />
              </div>
              <div className="grid items-start gap-5 xl:grid-cols-[1.5fr_1fr]">
                <Panel
                  title="对照目标岗位，找到证据与缺口"
                  description="从 JD 中挑选必需技能后填入。首版按你确认的技能标签逐项对照，作品内容仍需复核。"
                >
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      setReview(null);
                      const skills = [
                        ...new Set(
                          requirements
                            .split(/[,，、;；\n]+/)
                            .map((item) => item.trim())
                            .filter(Boolean),
                        ),
                      ];
                      if (
                        !skills.length ||
                        skills.length > 30 ||
                        skills.some((skill) => skill.length > 80)
                      ) {
                        setError(
                          "请填写 1–30 项技能，每项不超过 80 个字符。需要时请分批分析。",
                        );
                        return;
                      }
                      setError("");
                      setRequiredSkills(skills);
                    }}
                    className="space-y-3"
                  >
                    <Field label="岗位必需技能（用逗号分隔）">
                      <textarea
                        required
                        maxLength={2400}
                        className={fieldClass}
                        rows={3}
                        placeholder="例如：Python, RAG, FastAPI, PostgreSQL"
                        value={requirements}
                        onChange={(event) =>
                          setRequirements(event.target.value)
                        }
                      />
                    </Field>
                    <button className={buttonClass} type="submit">
                      分析证据覆盖
                      <ArrowRight size={15} />
                    </button>
                  </form>
                  {match && (
                    <div className="mt-5 space-y-4" aria-live="polite">
                      <div className="flex flex-wrap gap-4 rounded-xl bg-brand-muted p-4">
                        <div>
                          <strong className="text-2xl text-brand-foreground">
                            {match.coveragePercent}%
                          </strong>
                          <p className="mt-1 text-xs text-muted-foreground">
                            有已确认材料的技能标签
                          </p>
                        </div>
                        <div className="border-l border-hero-border pl-4">
                          <strong className="text-2xl text-brand-foreground">
                            {match.artifactCoveragePercent}%
                          </strong>
                          <p className="mt-1 text-xs text-muted-foreground">
                            有作品或面试材料的标签
                          </p>
                        </div>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        覆盖度只统计技能标签与材料的关联，不代表能力评级或录用概率。“已确认”指你已核对材料，尚未独立核验。
                      </p>
                      {match.rows.map((row) => (
                        <div
                          key={row.skill}
                          className="rounded-xl border border-line p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong className="text-sm">{row.skill}</strong>
                            <Badge>
                              {row.support === "artifact"
                                ? "有作品 / 面试材料"
                                : row.support === "self_report"
                                  ? "目前只有自述"
                                  : "待补充证据"}
                            </Badge>
                          </div>
                          {row.evidenceIds.map((id) => {
                            const item = data.evidence.find(
                              (candidate) => candidate.id === id,
                            );
                            return (
                              item && (
                                <button
                                  key={id}
                                  onClick={() => {
                                    setEditingEvidence(item);
                                    setTab("evidence");
                                  }}
                                  className="mt-2 block text-left text-xs leading-5 text-brand underline underline-offset-4"
                                >
                                  {item.title} · 查看来源与个人贡献
                                </button>
                              )
                            );
                          })}
                          {row.support !== "artifact" && (
                            <>
                              <p className="mt-3 text-xs leading-6 text-muted-foreground">
                                {row.nextAction}
                              </p>
                              <button
                                className={`${quietButton} mt-2`}
                                disabled={busy || reviewBusy}
                                onClick={() => addGap(row)}
                              >
                                <Plus size={14} />
                                加入成长计划
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                      <button
                        className={quietButton}
                        disabled={
                          !data.codexAvailable ||
                          !data.evidence.some(
                            (item) =>
                              item.status === "accepted" && item.useInAI,
                          ) ||
                          busy ||
                          reviewBusy
                        }
                        onClick={runReview}
                      >
                        {reviewBusy ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <Sparkles size={15} />
                        )}
                        用 Codex 深度复盘
                      </button>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {data.codexAvailable
                          ? "复盘会将你允许用于 AI 的记忆和证据发送至所配置的模型服务。"
                          : "Codex 深度复盘需要配置引擎；上面的证据覆盖分析可直接使用。"}
                      </p>
                    </div>
                  )}
                </Panel>
                <div className="space-y-5">
                  <Panel
                    title="把积累带进下一次机会"
                    description="先沉淀事实，再决定如何表达。"
                  >
                    <div className="space-y-3">
                      <button
                        className={`${quietButton} w-full justify-between`}
                        onClick={() => setTab("memory")}
                      >
                        记录求职目标与偏好
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className={`${quietButton} w-full justify-between`}
                        onClick={() => setTab("evidence")}
                      >
                        整理一个真实项目
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className={`${quietButton} w-full justify-between`}
                        onClick={() => setTab("tailoring")}
                      >
                        用证据定制简历
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className={`${quietButton} w-full justify-between`}
                        onClick={() => onNavigate("interview")}
                      >
                        进入模拟面试
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </Panel>
                  <Panel
                    title="由你决定，Agent 记住什么"
                    description="新记录默认仅保存在本机。只有已确认、未过期且允许用于 AI 的记录，才会进入后续 Agent 分析。"
                  >
                    <p className="text-sm text-brand-foreground">
                      当前有 {sharedCount} 条记录可用于 AI
                    </p>
                    <button
                      className="mt-4 text-xs text-muted-foreground underline underline-offset-4"
                      onClick={() => {
                        const context = buildCareerGrounding(
                          data,
                          requiredSkills.join(" "),
                        );
                        window.alert(context || "当前没有可供 AI 读取的记录。");
                      }}
                    >
                      查看本次可用的记忆与证据
                    </button>
                  </Panel>
                </div>
              </div>
              {review && (
                <Panel
                  title="Codex 证据复盘"
                  description="模型建议供你复核，不会自动写入职业事实。"
                >
                  <p className="text-sm leading-7">{review.summary}</p>
                  <div className="mt-4 space-y-3">
                    {review.findings.map((item, index) => (
                      <div
                        className="rounded-xl border border-line p-4"
                        key={index}
                      >
                        <Badge>
                          {item.basis === "artifact"
                            ? "作品 / 面试材料"
                            : "用户自述"}
                        </Badge>
                        <p className="mt-2 text-sm leading-7">{item.claim}</p>
                        {item.evidenceIds.map((id) => {
                          const source = data.evidence.find(
                            (candidate) => `evidence:${candidate.id}` === id,
                          );
                          return (
                            source && (
                              <p
                                key={id}
                                className="mt-1 text-xs text-muted-foreground"
                              >
                                依据：{source.title} · {source.sourceRef}
                              </p>
                            )
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <h4 className="mt-5 text-sm font-semibold">
                    项目深挖与待澄清问题
                  </h4>
                  <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6">
                    {review.questions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                  <h4 className="mt-5 text-sm font-semibold">建议下一步</h4>
                  <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6">
                    {review.nextSteps.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>
          )}

          {tab === "memory" && (
            <div className="grid items-start gap-5 xl:grid-cols-2">
              <Panel
                title={editingMemory ? "修正职业记忆" : "新增职业记忆"}
                description="记录稳定的职业背景、目标、偏好与约束。相同主题请编辑已有记忆，避免冲突。"
              >
                <MemoryForm
                  key={editingMemory?.id ?? "new"}
                  item={editingMemory}
                  save={save}
                  busy={busy || reviewBusy}
                  done={() => setEditingMemory(undefined)}
                />
              </Panel>
              <div className="space-y-3">
                {data.memories.length === 0 && (
                  <Empty
                    title="从一个真实目标开始"
                    description="例如：希望在上海从事 AI 应用开发，优先考虑有工程实践空间的团队。"
                  />
                )}
                {data.memories.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-2xl border border-line bg-surface p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{categories[item.category]}</Badge>
                      <Badge>{item.confirmed ? "本人已确认" : "待确认"}</Badge>
                      {item.expiresAt &&
                        new Date(item.expiresAt) <= new Date() && (
                          <Badge>已过期</Badge>
                        )}
                    </div>
                    <h3 className="mt-3 font-semibold">{item.key}</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
                      {item.content}
                    </p>
                    <p className="mt-3 break-words text-xs text-muted-foreground">
                      来源：{item.source} ·{" "}
                      {item.useInAI ? "允许用于 AI" : "仅本机保存"}
                      {item.expiresAt
                        ? ` · 有效至 ${new Date(item.expiresAt).toLocaleDateString("zh-CN")}`
                        : ""}
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        disabled={busy || reviewBusy}
                        className={quietButton}
                        onClick={() => setEditingMemory(item)}
                      >
                        编辑
                      </button>
                      <button
                        aria-label={`删除记忆 ${item.key}`}
                        disabled={busy || reviewBusy}
                        className={quietButton}
                        onClick={() => remove("memories", item)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {tab === "evidence" && (
            <div className="grid items-start gap-5 xl:grid-cols-2">
              <Panel
                title={editingEvidence ? "复核能力证据" : "新增能力证据"}
                description="保留原始材料的摘录、定位和你的个人贡献。提交链接不会自动读取或验证内容。"
              >
                <EvidenceForm
                  key={editingEvidence?.id ?? "new"}
                  item={editingEvidence}
                  save={save}
                  busy={busy || reviewBusy}
                  done={() => setEditingEvidence(undefined)}
                />
              </Panel>
              <div className="space-y-3">
                {data.evidence.length === 0 && (
                  <Empty
                    title="能力，从做过的事情中找到"
                    description="添加一个项目 README、PR、技术方案或面试复盘，说明自己具体负责了什么。"
                  />
                )}
                {data.evidence.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-2xl border border-line bg-surface p-5"
                  >
                    <div className="flex flex-wrap gap-2">
                      <Badge>{sources[item.sourceType]}</Badge>
                      <Badge>
                        {item.status === "accepted"
                          ? "本人已确认"
                          : item.status === "rejected"
                            ? "已排除"
                            : "待确认"}
                      </Badge>
                    </div>
                    <h3 className="mt-3 font-semibold">{item.title}</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
                      {item.contribution}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {item.skills.map((skill) => (
                        <Badge key={skill}>{skill}</Badge>
                      ))}
                    </div>
                    <p className="mt-3 break-all text-xs leading-6 text-muted-foreground">
                      来源：{item.sourceRef}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.useInAI ? "允许用于 AI" : "仅本机保存"} ·
                      尚未独立核验
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        disabled={busy || reviewBusy}
                        className={quietButton}
                        onClick={() => setEditingEvidence(item)}
                      >
                        查看 / 编辑
                      </button>
                      <button
                        aria-label={`删除证据 ${item.title}`}
                        disabled={busy || reviewBusy}
                        className={quietButton}
                        onClick={() => remove("evidence", item)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {tab === "growth" && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-brand-muted p-5">
                <h3 className="font-semibold text-brand-foreground">
                  从“还不会”走向“拿得出证据”
                </h3>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">
                  在能力地图中，把缺口加入成长计划。完成作品或面试练习后，先保存对应证据，再关联任务；复核或删除证据时，任务会重新打开。
                </p>
              </div>
              {data.actions.length === 0 && (
                <Empty
                  title="让目标变成下一步行动"
                  description="先分析目标岗位的技能要求，再把需要补充证据的技能加入计划。"
                />
              )}
              {data.actions.map((action) => (
                <Panel
                  key={action.id}
                  title={action.title}
                  description={action.evidenceTarget}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge>
                      {action.status === "done" ? "已用新证据完成" : "进行中"}
                    </Badge>
                    {action.status === "done" ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          完成依据：
                          {
                            data.evidence.find(
                              (item) => item.id === action.completionEvidenceId,
                            )?.title
                          }
                        </p>
                        <button
                          disabled={busy || reviewBusy}
                          className={quietButton}
                          onClick={() =>
                            save(
                              `/api/career/growth/${action.id}`,
                              { completionEvidenceId: null },
                              "PATCH",
                            )
                          }
                        >
                          重新打开
                        </button>
                      </>
                    ) : (
                      <form
                        className="flex flex-wrap gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const id = new FormData(event.currentTarget).get(
                            "evidenceId",
                          );
                          if (id)
                            void save(
                              `/api/career/growth/${action.id}`,
                              { completionEvidenceId: id },
                              "PATCH",
                            );
                        }}
                      >
                        <select
                          name="evidenceId"
                          required
                          aria-label={`为 ${action.skill} 选择完成证据`}
                          className={fieldClass + " sm:w-64"}
                          defaultValue=""
                        >
                          <option value="" disabled>
                            选择对应技能的作品 / 面试证据
                          </option>
                          {data.evidence
                            .filter((item) => canCompleteAction(action, item))
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.title}
                              </option>
                            ))}
                        </select>
                        <button
                          disabled={busy || reviewBusy}
                          className={buttonClass}
                        >
                          <Check size={15} />
                          关联证据并完成
                        </button>
                      </form>
                    )}
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 lg:p-6">
      <h3 className="font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-2 text-sm leading-7 text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-5">{children}</div>
    </section>
  );
}
function Metric({
  icon,
  label,
  value,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-2xl border border-line bg-surface p-5 text-left transition hover:border-brand/30"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-brand">{icon}</span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight">
        {value}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          条
        </span>
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </button>
  );
}
function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-md bg-brand-muted px-2 py-1 text-[11px] font-medium text-brand-foreground">
      {children}
    </span>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-10">
      <Fingerprint size={25} className="mb-4 text-brand" />
      <h3 className="font-medium">{title}</h3>
      <p className="mt-2 max-w-lg text-sm leading-7 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
    </label>
  );
}
function Checkbox({
  name,
  children,
  checked,
}: {
  name: string;
  children: ReactNode;
  checked?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5 text-xs leading-6 text-muted-foreground">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        className="mt-1.5 accent-emerald-800"
      />
      {children}
    </label>
  );
}

function MemoryForm({
  item,
  save,
  busy,
  done,
}: {
  item?: Memory;
  save: Save;
  busy: boolean;
  done: () => void;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const expires = String(fields.get("expiresAt") || "");
    const body = {
      key: fields.get("key"),
      category: fields.get("category"),
      content: fields.get("content"),
      source: fields.get("source"),
      confirmed: fields.has("confirmed"),
      useInAI: fields.has("useInAI"),
      expiresAt: expires
        ? new Date(expires + "T23:59:59+08:00").toISOString()
        : null,
      ...(item ? { revision: item.revision } : {}),
    };
    if (
      await save(
        `/api/career/memories${item ? `/${item.id}` : ""}`,
        body,
        item ? "PATCH" : "POST",
      )
    ) {
      form.reset();
      done();
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <Field label="记忆主题">
          <input
            name="key"
            required
            maxLength={100}
            defaultValue={item?.key}
            placeholder="例如：目标岗位"
            className={fieldClass}
          />
        </Field>
        <Field label="分类">
          <select
            name="category"
            defaultValue={item?.category ?? "goal"}
            className={fieldClass}
          >
            {Object.entries(categories).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="内容">
          <textarea
            name="content"
            required
            maxLength={4000}
            rows={4}
            defaultValue={item?.content}
            placeholder="用自己的话描述一个稳定、具体的事实或偏好。"
            className={fieldClass}
          />
        </Field>
        <Field label="来源说明">
          <input
            name="source"
            required
            maxLength={500}
            defaultValue={item?.source ?? "本人填写"}
            className={fieldClass}
          />
        </Field>
        <Field label="有效期（可选，按北京时间）">
          <input
            type="date"
            name="expiresAt"
            defaultValue={
              item?.expiresAt
                ? new Intl.DateTimeFormat("en-CA", {
                    timeZone: "Asia/Shanghai",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  }).format(new Date(item.expiresAt))
                : ""
            }
            className={fieldClass}
          />
        </Field>
        <Checkbox name="confirmed" checked={item?.confirmed}>
          我确认这条记忆准确，愿意在未来求职中继续使用。
        </Checkbox>
        <Checkbox name="useInAI" checked={item?.useInAI}>
          允许将这条记忆发送至我配置的模型服务，用于个性化分析。
        </Checkbox>
        <div className="flex gap-2">
          <button className={buttonClass}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Plus size={15} />
            )}
            {item ? "保存修正" : "保存记忆"}
          </button>
          {item && (
            <button className={quietButton} type="button" onClick={done}>
              取消编辑
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function EvidenceForm({
  item,
  save,
  busy,
  done,
}: {
  item?: Evidence;
  save: Save;
  busy: boolean;
  done: () => void;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const body = {
      title: fields.get("title"),
      sourceType: fields.get("sourceType"),
      sourceRef: fields.get("sourceRef"),
      excerpt: fields.get("excerpt"),
      contribution: fields.get("contribution"),
      skills: String(fields.get("skills"))
        .split(/[,，、;；\n]+/)
        .map((skill) => skill.trim())
        .filter(Boolean),
      status: fields.get("status"),
      useInAI: fields.has("useInAI"),
      ...(item ? { revision: item.revision } : {}),
    };
    if (
      await save(
        `/api/career/evidence${item ? `/${item.id}` : ""}`,
        body,
        item ? "PATCH" : "POST",
      )
    ) {
      form.reset();
      done();
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <Field label="证据标题">
          <input
            name="title"
            required
            maxLength={160}
            defaultValue={item?.title}
            placeholder="例如：知识库检索服务的后端实现"
            className={fieldClass}
          />
        </Field>
        <Field label="材料类型">
          <select
            name="sourceType"
            defaultValue={item?.sourceType ?? "self_report"}
            className={fieldClass}
          >
            {Object.entries(sources).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="链接或材料定位">
          <input
            name="sourceRef"
            required
            maxLength={1000}
            defaultValue={item?.sourceRef}
            placeholder="例如：仓库链接、PR #12、方案文档第 3 页"
            className={fieldClass}
          />
        </Field>
        <Field label="原始材料摘录">
          <textarea
            name="excerpt"
            required
            maxLength={6000}
            rows={4}
            defaultValue={item?.excerpt}
            placeholder="粘贴能够支持这项能力的原文，保留必要上下文。"
            className={fieldClass}
          />
        </Field>
        <Field label="我具体做了什么">
          <textarea
            name="contribution"
            required
            maxLength={2000}
            rows={3}
            defaultValue={item?.contribution}
            placeholder="说明你负责的部分、做过的取舍和可核查的结果。"
            className={fieldClass}
          />
        </Field>
        <Field label="这份材料支持的技能（用逗号分隔）">
          <input
            name="skills"
            required
            maxLength={2400}
            defaultValue={item?.skills.join(", ")}
            placeholder="例如：Python, RAG, FastAPI"
            className={fieldClass}
          />
        </Field>
        <Field label="复核状态">
          <select
            name="status"
            defaultValue={item?.status ?? "pending"}
            className={fieldClass}
          >
            <option value="pending">待我复核</option>
            <option value="accepted">我已核对材料与个人贡献</option>
            <option value="rejected">排除这份材料</option>
          </select>
        </Field>
        <Checkbox name="useInAI" checked={item?.useInAI}>
          允许将这份材料发送至我配置的模型服务，用于能力分析和面试准备。
        </Checkbox>
        <div className="flex gap-2">
          <button className={buttonClass}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Plus size={15} />
            )}
            {item ? "保存复核" : "保存证据"}
          </button>
          {item && (
            <button className={quietButton} type="button" onClick={done}>
              取消编辑
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
