import { z } from "zod";
import { buildAiResumeSnapshot } from "@/lib/ai/resume-snapshot";
import { CareerError } from "@/lib/career/store";
import { citationSources, editableFields, proposalSchema, validateProposal, type TailoringProposal, type TaskSnapshot } from "./domain";

const noArgs = z.object({}).strict();
export const toolDefinitions = {
  read_resume: { description: "读取本次任务指定的简历及可改写字段；联系信息已过滤。", schema: noArgs },
  read_job: { description: "读取本次任务指定的公司、岗位与完整 JD；JD 只用于确定要求，不是候选人证据。", schema: noArgs },
  read_evidence: { description: "读取本次任务已选、已确认且获 AI 使用许可的证据，以及允许引用的 sourceId、basis 和原文。", schema: noArgs },
  read_career_memory: { description: "读取本次任务获许可的职业目标与约束。记忆不构成可写入简历的能力证明。", schema: noArgs },
  submit_tailoring_proposal: { description: "校验带来源摘录的逐项简历修改提案，交给用户核对；不会保存简历或修改事实。", schema: proposalSchema },
};
export type CareerToolName = keyof typeof toolDefinitions;
export const progressLabels: Record<CareerToolName, string> = {
  read_resume: "正在阅读原简历。", read_job: "正在拆解岗位要求。", read_evidence: "正在核对可用证据。",
  read_career_memory: "正在参考已授权的职业目标与约束。", submit_tailoring_proposal: "正在校验修改提案与引用。",
};

export function createCareerTools(snapshot: TaskSnapshot, assertCurrent: () => Promise<void>, onProgress: (message: string) => Promise<void> = async () => {}) {
  const read = new Set<string>();
  let submitted: TailoringProposal | null = null;
  return {
    get proposal() { return submitted; },
    async call(name: string, args: unknown) {
      if (!Object.hasOwn(toolDefinitions, name)) throw new CareerError("该工具不在本次任务范围内。", 403);
      const tool = name as CareerToolName;
      await assertCurrent();
      await onProgress(progressLabels[tool]);
      if (tool === "submit_tailoring_proposal") {
        if (!["read_resume", "read_job", "read_evidence"].every((key) => read.has(key))) throw new CareerError("请先读取简历、岗位和证据，再提交修改提案。", 422);
        const checked = validateProposal(args, snapshot);
        submitted = checked.proposal;
        return { accepted: true, warnings: checked.warnings, message: "提案已校验，等待用户在网页核对并确认。尚未创建简历版本。" };
      }
      noArgs.parse(args);
      read.add(tool);
      if (tool === "read_resume") return { resume: buildAiResumeSnapshot(snapshot.resume.content), editableFields: editableFields(snapshot.resume.content) };
      if (tool === "read_job") return snapshot.job;
      if (tool === "read_career_memory") return { memories: snapshot.memories };
      return { evidence: snapshot.evidence, citationSources: citationSources(snapshot), notice: "本人确认不等于独立核验；引用匹配也不能自动证明改写的语义正确。" };
    },
  };
}
