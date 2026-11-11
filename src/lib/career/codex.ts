import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import {
  buildCareerGroundingPacket,
  GROUNDING_POLICY,
  type CareerState,
} from "./domain";
import { CareerError } from "./store";

export const reviewSchema = z
  .object({
    summary: z.string().min(1).max(3000),
    findings: z
      .array(
        z
          .object({
            claim: z.string().min(1).max(1500),
            evidenceIds: z.array(z.string()).min(1).max(10),
            basis: z.enum(["artifact", "self_report"]),
          })
          .strict(),
      )
      .max(15),
    questions: z.array(z.string().max(1000)).max(10),
    nextSteps: z.array(z.string().max(1000)).max(10),
  })
  .strict();
export type CareerReview = z.infer<typeof reviewSchema>;

export function codexReviewAvailable() {
  return Boolean(
    process.env.TRACEFOLIO_CODEX_API_KEY?.trim() &&
      process.env.TRACEFOLIO_CODEX_MODEL?.trim(),
  );
}

export function validateReviewCitations(
  review: CareerReview,
  evidence: CareerState["evidence"],
  suppliedIds?: string[],
) {
  const allowed = new Map(
    evidence
      .filter(
        (item) =>
          item.status === "accepted" &&
          item.useInAI &&
          (!suppliedIds || suppliedIds.includes(`evidence:${item.id}`)),
      )
      .map((item) => [`evidence:${item.id}`, item]),
  );
  for (const finding of review.findings) {
    if (finding.evidenceIds.some((id) => !allowed.has(id)))
      throw new CareerError("模型引用了不可用的证据，结果未被采纳。", 502);
    if (
      finding.basis === "artifact" &&
      !finding.evidenceIds.some(
        (id) => allowed.get(id)?.sourceType !== "self_report",
      )
    ) {
      throw new CareerError("模型把自述当作作品证据，结果未被采纳。", 502);
    }
  }
  return review;
}

export async function reviewWithCodex(
  state: CareerState,
  requiredSkills: string[],
  signal?: AbortSignal,
) {
  if (!codexReviewAvailable())
    throw new CareerError(
      "尚未配置 Codex 复盘引擎；本地记忆、证据匹配与成长计划仍可使用。",
      503,
    );
  const shared = state.evidence.filter(
    (item) => item.status === "accepted" && item.useInAI,
  );
  if (!shared.length)
    throw new CareerError("请先确认至少一份证据，并允许它用于 AI 分析。");
  const packet = buildCareerGroundingPacket(state, requiredSkills.join(" "));
  if (!packet.evidenceIds.length)
    throw new CareerError("可用证据超出上下文预算，请缩短材料摘录后再复盘。");
  const temporary = await mkdtemp(join(tmpdir(), "tracefolio-review-"));
  try {
    const codexHome = join(temporary, "runtime");
    const workspace = join(temporary, "workspace");
    await mkdir(codexHome);
    await mkdir(workspace);
    // A separate child environment prevents reuse of the developer's signed-in
    // Codex account, GitHub PAT, MCP configuration, and repository instructions.
    const codex = new Codex({
      apiKey: process.env.TRACEFOLIO_CODEX_API_KEY,
      env: { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome },
      config: {
        features: {
          shell_tool: false,
          view_image: false,
          apps: false,
          skill_mcp_dependency_install: false,
        },
        cli_auth_credentials_store: "file",
      },
    });
    const thread = codex.startThread({
      model: process.env.TRACEFOLIO_CODEX_MODEL,
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    const result = await thread.run(
      [
        "你是 TRACEFOLIO 的职业证据分析师。用简体中文给出审慎的能力复盘和项目深挖问题。",
        GROUNDING_POLICY,
        "只分析下列材料。不要运行命令、读取文件、浏览链接或调用工具。",
        "findings 必须逐条引用 evidence:ID，只引用输入中实际出现的证据；basis 区分作品与自述。",
        "作品材料未经独立核验。不要预测录用概率。summary 只概括覆盖范围；无依据的能力写为 questions，不得补造。",
        `岗位必需技能（用户确认的标签）：${JSON.stringify(requiredSkills)}`,
        packet.text,
      ].join("\n\n"),
      {
        outputSchema: z.toJSONSchema(reviewSchema),
        signal: AbortSignal.any([
          AbortSignal.timeout(90_000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    const review = validateReviewCitations(
      reviewSchema.parse(JSON.parse(result.finalResponse)),
      shared,
      packet.evidenceIds,
    );
    return {
      review,
      usage: result.usage,
      model: process.env.TRACEFOLIO_CODEX_MODEL,
    };
  } catch (error) {
    if (error instanceof CareerError) throw error;
    // Never return raw provider/CLI errors that might contain local paths or credentials.
    throw new CareerError(
      "Codex 复盘未完成，请检查模型配置、服务可用性或稍后重试。",
      502,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
