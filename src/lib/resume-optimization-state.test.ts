import { describe, expect, it } from "vitest";

import type { ResumeContent, ResumeOptimizationMeta } from "./types";
import {
  attachGeneralResumeOptimizationState,
  readGeneralResumeOptimizationStages,
} from "./resume-optimization-state";

const resume: ResumeContent = {
  basics: { name: "陈同学", email: "", phone: "", city: "", links: [] },
  profile: { title: "", summary: "" },
  education: [],
  experiences: [],
  internships: [],
  projects: [],
  skills: [],
  awards: [],
  selfReview: "",
};

const optimization: ResumeOptimizationMeta = {
  company: "",
  title: "",
  keywords: [],
  summary: "通用优化",
  changes: [],
  versionName: "AI优化-陈同学",
};

describe("general resume optimization stages", () => {
  it("round-trips the analysis, draft, and review decisions", () => {
    const diagnosis = {
      summary: "整体结构清晰。",
      strengths: ["项目证据完整"],
      issues: [{
        id: "issue-1",
        section: "projects" as const,
        location: "项目经历",
        severity: "medium" as const,
        action: "ai-edit" as const,
        category: "clarity" as const,
        title: "表达可以更清晰",
        evidence: "负责项目开发",
        explanation: "职责描述较泛。",
        suggestion: "补充方法与结果。",
      }],
    };
    const content = attachGeneralResumeOptimizationState(resume, resume, optimization, {
      diagnosis,
      draft: { ...resume, selfReview: "AI 草稿" },
      selectedIssueIds: ["issue-1"],
      preferences: ["clarity"],
      additionalDirection: "保持简洁",
      acceptedChangeIds: ["selfReview"],
      editedValues: { selfReview: "人工修改" },
    });

    expect(readGeneralResumeOptimizationStages(content)).toEqual({
      diagnosis,
      draft: { ...resume, selfReview: "AI 草稿" },
      selectedIssueIds: ["issue-1"],
      preferences: ["clarity"],
      additionalDirection: "保持简洁",
      acceptedChangeIds: ["selfReview"],
      editedValues: { selfReview: "人工修改" },
    });
  });
});
