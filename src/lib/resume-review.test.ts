import { describe, expect, it } from "vitest";

import {
  applyResumeReviewChanges,
  buildResumeReviewChanges,
  resumeReviewChangeAddressesIssue,
} from "./resume-review";
import type { ResumeContent } from "./types";

const original: ResumeContent = {
  basics: { name: "陈同学", email: "chen@example.com", phone: "13800000000", city: "北京", links: [] },
  profile: { title: "AI 产品经理", summary: "关注 AI 产品。" },
  education: [],
  experiences: [],
  internships: [],
  projects: [{
    name: "课程推荐系统",
    role: "产品负责人",
    highlights: ["参与需求分析。", "整理复盘材料。"],
  }],
  skills: ["Python", "产品设计"],
  awards: ["一等奖学金"],
  customSections: [{ title: "主要优势", content: "学习能力强。" }],
  selfReview: "希望参与真实业务。",
};

describe("resume review changes", () => {
  it("builds granular changes only for editable resume copy", () => {
    const optimized: ResumeContent = {
      ...original,
      basics: { ...original.basics, name: "不应出现的姓名" },
      profile: { ...original.profile, summary: "具备 AI 产品规划与落地经验。" },
      projects: [{
        ...original.projects[0],
        highlights: ["完成需求拆解并推进方案验证。", original.projects[0].highlights[1]],
      }],
      skills: ["产品设计", "Python"],
      customSections: [{ title: "主要优势", content: "能够快速学习并完成业务验证。" }],
    };

    const changes = buildResumeReviewChanges(original, optimized);

    expect(changes.map((change) => change.id)).toEqual([
      "summary:profile",
      "projects:0:highlight:0",
      "skills:list",
      "customSections:0",
    ]);
    expect(changes.some((change) => change.before.includes("陈同学"))).toBe(false);
  });

  it("applies only accepted changes and preserves identity fields", () => {
    const optimized: ResumeContent = {
      ...original,
      profile: { ...original.profile, summary: "具备 AI 产品规划与落地经验。" },
      projects: [{
        ...original.projects[0],
        highlights: ["完成需求拆解并推进方案验证。", original.projects[0].highlights[1]],
      }],
    };
    const changes = buildResumeReviewChanges(original, optimized);
    const reviewed = applyResumeReviewChanges(
      original,
      changes,
      new Set(["projects:0:highlight:0"]),
      { "projects:0:highlight:0": "拆解需求并推动 2 轮已有方案验证。" },
    );

    expect(reviewed.profile.summary).toBe(original.profile.summary);
    expect(reviewed.projects[0].highlights[0]).toBe("拆解需求并推动 2 轮已有方案验证。");
    expect(reviewed.basics).toEqual(original.basics);
  });

  it("keeps the original value when an accepted edit is blank", () => {
    const optimized = {
      ...original,
      skills: ["产品设计", "Python"],
    };
    const changes = buildResumeReviewChanges(original, optimized);
    const reviewed = applyResumeReviewChanges(
      original,
      changes,
      new Set(["skills:list"]),
      { "skills:list": " \n " },
    );

    expect(reviewed.skills).toEqual(original.skills);
  });

  it("matches diagnosis evidence to the actual changed text instead of only the section", () => {
    const optimized: ResumeContent = {
      ...original,
      projects: [{
        ...original.projects[0],
        highlights: ["完成需求拆解并推进方案验证。", original.projects[0].highlights[1]],
      }],
    };
    const changes = buildResumeReviewChanges(original, optimized);
    const addressedIssue = {
      id: "issue-1",
      section: "projects" as const,
      location: "课程推荐系统",
      severity: "high" as const,
      category: "clarity" as const,
      title: "行动不清楚",
      evidence: "参与需求分析。",
      explanation: "没有写明行动。",
      suggestion: "明确具体行动。",
    };
    const untouchedIssue = {
      ...addressedIssue,
      id: "issue-2",
      title: "复盘结果不清楚",
      evidence: "整理复盘材料。",
    };

    expect(resumeReviewChangeAddressesIssue(changes[0], addressedIssue)).toBe(true);
    expect(resumeReviewChangeAddressesIssue(changes[0], untouchedIssue)).toBe(false);
  });

  it("matches quoted evidence after harmless punctuation normalization", () => {
    const optimized: ResumeContent = {
      ...original,
      projects: [{
        ...original.projects[0],
        highlights: ["独立完成需求分析。", original.projects[0].highlights[1]],
      }],
    };
    const [change] = buildResumeReviewChanges(original, optimized);
    const issue = {
      id: "issue-quoted",
      section: "projects" as const,
      location: "课程推荐系统",
      severity: "medium" as const,
      category: "clarity" as const,
      title: "“参与”弱化个人角色",
      evidence: "“参与需求分析”",
      explanation: "个人行动不清楚。",
      suggestion: "明确个人行动。",
    };

    expect(resumeReviewChangeAddressesIssue(change, issue)).toBe(true);
  });

  it("does not report punctuation and spacing cleanup as a substantive change", () => {
    const optimized: ResumeContent = {
      ...original,
      projects: [{
        ...original.projects[0],
        highlights: ["参与需求分析：", "整理复盘材料。"],
      }],
    };

    expect(buildResumeReviewChanges(original, optimized)).toEqual([]);
  });

  it("uses the named resume item when quoted evidence is not exact", () => {
    const optimized: ResumeContent = {
      ...original,
      projects: [{
        ...original.projects[0],
        highlights: ["独立完成需求分析并推进验证。", original.projects[0].highlights[1]],
      }],
    };
    const [change] = buildResumeReviewChanges(original, optimized);
    const issue = {
      id: "issue-location",
      section: "projects" as const,
      location: "项目经历 > 课程推荐系统 > 第 1 条",
      severity: "high" as const,
      category: "clarity" as const,
      title: "个人行动不清楚",
      evidence: "参与需求分析与方案规划",
      explanation: "引用内容与实际原文略有差异。",
      suggestion: "明确个人行动。",
    };

    expect(resumeReviewChangeAddressesIssue(change, issue)).toBe(true);
  });
});
