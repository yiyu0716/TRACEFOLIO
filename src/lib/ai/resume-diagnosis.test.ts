import { describe, expect, it } from "vitest";

import { isAiEditableResumeIssue, normalizeResumeDiagnosis } from "./resume-diagnosis";
import type { ResumeContent } from "../types";

const resume: ResumeContent = {
  basics: { name: "姜禾", email: "", phone: "", city: "", links: [] },
  profile: { title: "", summary: "" },
  education: [{
    school: "北京邮电大学",
    degree: "本科",
    major: "人工智能",
    start: "2023",
    end: "2027",
    highlights: ["GPA 8/4.0"],
  }],
  experiences: [],
  internships: [],
  projects: [],
  skills: [],
  awards: [],
  selfReview: "熟悉 Python、机器学习基础和推荐系统实验流程。",
};

describe("resume diagnosis normalization", () => {
  it("drops a false missing-summary issue when self-review already provides it", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "结构清晰。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "summary",
        location: "profile.summary",
        severity: "medium",
        category: "structure",
        title: "简历未提供个人总结",
        evidence: "",
        explanation: "缺少 profile summary。",
        suggestion: "增加个人总结。",
      }],
    }, resume);

    expect(diagnosis.issues).toEqual([]);
  });

  it("drops alternate wording that falsely requires a second summary module", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "结构清晰。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "summary",
        location: "开篇",
        severity: "medium",
        category: "structure",
        title: "缺少清晰的开篇个人简介",
        evidence: "",
        explanation: "建议增加个人简介。",
        suggestion: "补充开篇总结。",
      }],
    }, resume);

    expect(diagnosis.issues).toEqual([]);
  });

  it("marks an impossible GPA as requiring the candidate's confirmation", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "GPA 写法需要核实。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "education",
        location: "教育背景",
        severity: "high",
        category: "clarity",
        title: "GPA 格式有误",
        evidence: "GPA 8/4.0",
        explanation: "分子大于满分。",
        suggestion: "请确认实际 GPA 和满分制式。",
      }],
    }, resume);

    expect(diagnosis.issues[0]?.action).toBe("user-confirm");
  });

  it("keeps vague experience bullets AI-editable even if the model overclassifies them", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "实习描述需要加强。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "internships",
        location: "百度实习经历",
        severity: "medium",
        action: "user-confirm",
        category: "action-result",
        title: "实习描述偏重职责，个人贡献不突出",
        evidence: "参与真实业务项目，负责资料整理、功能验证和日报复盘",
        explanation: "没有明确个人承担的技术角色、工具或方法。",
        suggestion: "补充具体技术细节和实际用途；没有更多信息时先用现有事实明确行动。",
      }],
    }, resume);

    expect(diagnosis.issues[0]?.action).toBe("ai-edit");
  });

  it("keeps issues with quoted resume evidence AI-editable instead of requesting new facts", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "项目表达可以加强。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "projects",
        location: "课程推荐系统",
        severity: "medium",
        action: "user-input",
        category: "action-result",
        title: "缺少具体结果",
        evidence: "完成需求分析和方案设计",
        explanation: "现有文字没有突出个人行动。",
        suggestion: "使用现有信息明确个人贡献。",
      }],
    }, resume);

    expect(diagnosis.issues[0]?.action).toBe("ai-edit");
    expect(isAiEditableResumeIssue(diagnosis.issues[0]!)).toBe(true);
  });

  it("routes absent factual content to the editor instead of automatic rewriting", () => {
    const diagnosis = normalizeResumeDiagnosis({
      summary: "需要补充事实。",
      strengths: [],
      issues: [{
        id: "issue-1",
        section: "skills",
        location: "技能模块",
        severity: "medium",
        category: "evidence",
        title: "技能模块未填写",
        evidence: "",
        explanation: "缺少真实技能信息。",
        suggestion: "请补充实际掌握的技能。",
      }],
    }, resume);

    expect(diagnosis.issues[0]?.action).toBe("user-input");
    expect(isAiEditableResumeIssue(diagnosis.issues[0]!)).toBe(false);
  });

});
