import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveAiRuntimeSettings: vi.fn(),
  runAiObjectTask: vi.fn(),
}));

vi.mock("./repository", () => ({
  getEffectiveAiRuntimeSettings: mocks.getEffectiveAiRuntimeSettings,
}));
vi.mock("./ai/tasks", () => ({
  runAiObjectTask: mocks.runAiObjectTask,
}));

import { analyzeResumeWithAI, optimizeResumeWithAI, tailorResumeWithAI } from "./ai-service";
import type { ResumeContent } from "./types";

const originalResume: ResumeContent = {
  basics: {
    name: "陈同学",
    email: "chen@example.com",
    phone: "13800000000",
    city: "上海",
    links: ["https://example.com"],
  },
  profile: { title: "AI 产品经理", summary: "关注 AI 产品。" },
  education: [],
  experiences: [],
  internships: [],
  projects: [
    {
      name: "AI 简历工具",
      role: "产品负责人",
      highlights: ["完成从 0 到 1 的产品设计。"],
    },
  ],
  skills: ["AI 产品", "Prompt"],
  awards: ["校赛一等奖"],
  customSections: [{ title: "主要优势与技能认证", content: "AIGC 全栈创作者。" }],
  selfReview: "",
};

describe("resume AI optimization", () => {
  it("preserves identity fields while accepting AI wording improvements", async () => {
    const aiResume: ResumeContent = {
      ...originalResume,
      basics: {
        ...originalResume.basics,
        name: "张三",
        email: "wrong@example.com",
      },
      profile: { title: "增长产品经理", summary: "具备 AI 产品规划与 Prompt 迭代经验。" },
      projects: [
        {
          ...originalResume.projects[0],
          name: "不存在的新项目",
          highlights: ["主导 AI 简历工具的信息架构与优化闭环。"],
        },
      ],
    };
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历优化完成",
      data: aiResume,
    });

    const result = await optimizeResumeWithAI({ resume: originalResume });

    expect(result.source).toBe("ai");
    expect(result.data.basics).toEqual(originalResume.basics);
    expect(result.data.profile).toEqual({
      title: originalResume.profile.title,
      summary: "具备 AI 产品规划与 Prompt 迭代经验。",
    });
    expect(result.data.projects[0]).toMatchObject({
      name: originalResume.projects[0].name,
      highlights: ["主导 AI 简历工具的信息架构与优化闭环。"],
    });
    expect(mocks.runAiObjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskLabel: "AI 简历优化",
        prompt: expect.stringContaining("不要新增原简历不存在的事实"),
      }),
    );
    expect(mocks.runAiObjectTask.mock.calls[0]?.[0].schema.safeParse(aiResume).success).toBe(true);
  });

  it("keeps original bullets when the model returns fewer highlights", async () => {
    const resumeWithTwoBullets: ResumeContent = {
      ...originalResume,
      projects: [
        {
          ...originalResume.projects[0],
          highlights: ["完成从 0 到 1 的产品设计。", "推动 3 轮用户访谈并整理需求。"],
        },
      ],
    };
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历优化完成",
      data: {
        ...resumeWithTwoBullets,
        projects: [
          {
            ...resumeWithTwoBullets.projects[0],
            highlights: ["主导 AI 简历工具的信息架构与优化闭环。"],
          },
        ],
      },
    });

    const result = await optimizeResumeWithAI({ resume: resumeWithTwoBullets });

    expect(result.data.projects[0]?.highlights).toEqual([
      "主导 AI 简历工具的信息架构与优化闭环。",
      "推动 3 轮用户访谈并整理需求。",
    ]);
  });

  it("does not create a personal summary when self-review already provides that content", async () => {
    const resumeWithoutPersonalSummary: ResumeContent = {
      ...originalResume,
      profile: { ...originalResume.profile, summary: "" },
      selfReview: "熟悉 AI 产品设计与 Prompt 迭代。",
    };
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历优化完成",
      data: {
        ...resumeWithoutPersonalSummary,
        profile: { ...resumeWithoutPersonalSummary.profile, summary: "AI 新增的个人简介。" },
        selfReview: "熟悉 AI 产品设计、Prompt 迭代与落地验证。",
      },
    });

    const result = await optimizeResumeWithAI({ resume: resumeWithoutPersonalSummary });

    expect(result.data.profile.summary).toBe("");
    expect(result.data.selfReview).toBe("熟悉 AI 产品设计、Prompt 迭代与落地验证。");
  });

  it("limits general optimization to selected diagnosis issues and additional direction", async () => {
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历优化完成",
      data: originalResume,
    });
    const diagnosis = {
      summary: "项目表达需要加强。",
      strengths: [],
      issues: [
        {
          id: "issue-1",
          section: "projects" as const,
          location: "AI 简历工具",
          severity: "high" as const,
          category: "action-result" as const,
          title: "缺少结果证据",
          evidence: "完成从 0 到 1 的产品设计。",
          explanation: "没有说明设计带来的结果。",
          suggestion: "使用已有事实补充结果。",
        },
        {
          id: "issue-2",
          section: "summary" as const,
          location: "求职摘要",
          severity: "low" as const,
          category: "clarity" as const,
          title: "摘要较短",
          evidence: "关注 AI 产品。",
          explanation: "能力重点不够清楚。",
          suggestion: "补充核心能力。",
        },
        {
          id: "issue-3",
          section: "education" as const,
          location: "教育背景",
          severity: "high" as const,
          action: "user-confirm" as const,
          category: "clarity" as const,
          title: "GPA 格式有误",
          evidence: "GPA 8/4.0",
          explanation: "分子大于满分。",
          suggestion: "请确认实际 GPA 和满分制式。",
        },
      ],
    };

    await optimizeResumeWithAI({
      resume: originalResume,
      diagnosis,
      selectedIssueIds: ["issue-1", "issue-3"],
      additionalDirection: "保留 GPA 原格式，优先优化项目经历。",
    });

    const prompt = mocks.runAiObjectTask.mock.calls.at(-1)?.[0].prompt as string;
    expect(prompt).toContain("缺少结果证据");
    expect(prompt).not.toContain("摘要较短");
    expect(prompt).not.toContain("GPA 8/4.0");
    expect(prompt).not.toContain("用户选择的优化方向");
    expect(prompt).toContain("保留 GPA 原格式，优先优化项目经历。");
    expect(prompt).toContain("不得覆盖上述事实边界");
  });

  it("analyzes the resume without requesting a score", async () => {
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历诊断完成",
      data: { summary: "项目经历较完整。", strengths: ["项目目标明确"], issues: [] },
    });

    await analyzeResumeWithAI({ resume: originalResume, locale: "zh-CN" });

    expect(mocks.runAiObjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: expect.anything(),
        taskLabel: "简历诊断",
        prompt: expect.stringMatching(/不输出总分[\s\S]+evidence 为空且必须由用户提供时才使用 user-input[\s\S]+不得诊断 profile\.summary 缺失[\s\S]+当前日期为 \d{4}-\d{2}-\d{2}[\s\S]+联系方式会在分析前因隐私保护被主动移除/),
      }),
    );

    await analyzeResumeWithAI({ resume: originalResume, locale: "en" });
    expect(mocks.runAiObjectTask.mock.calls.at(-1)?.[0].prompt).toMatch(
      /The current date is \d{4}-\d{2}-\d{2}[\s\S]+contact details are intentionally removed before analysis for privacy/,
    );
  });

  it("lets AI rewrite custom section content while preserving custom titles", async () => {
    const aiResume: ResumeContent = {
      ...originalResume,
      customSections: [{ title: "主要优势与技能认证", content: "具备 AIGC 全链路创作与落地经验。" }],
    };
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历优化完成",
      data: aiResume,
    });

    const result = await tailorResumeWithAI({
      resume: originalResume,
      jd: "需要 AIGC 产品经验",
      job: { id: "job-1", company: "字节跳动", title: "AI 产品实习生" },
      analysis: {
        company: "字节跳动",
        title: "AI 产品实习生",
        deadline: null,
        requirements: ["AIGC"],
        keywords: ["AIGC"],
        bonusPoints: [],
        risks: [],
        suggestions: [],
      },
    });

    expect(result.data.customSections).toEqual([
      { title: "主要优势与技能认证", content: "具备 AIGC 全链路创作与落地经验。" },
    ]);
    expect(mocks.runAiObjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("主要优势与技能认证"),
      }),
    );
  });

  it("returns AI-provided optimization metadata", async () => {
    const aiResume: ResumeContent = {
      ...originalResume,
      profile: { ...originalResume.profile, summary: "突出 AI 产品规划与项目落地能力。" },
    };
    mocks.getEffectiveAiRuntimeSettings.mockResolvedValue({ enabled: true });
    mocks.runAiObjectTask.mockResolvedValue({
      source: "ai",
      message: "简历匹配优化完成",
      data: {
        resume: aiResume,
        meta: {
          company: "腾讯",
          title: "产品经理实习生",
          keywords: ["AI 产品", "用户研究"],
          summary: "已围绕腾讯产品经理实习生岗位强化 AI 产品规划和用户研究证据。",
          changes: ["自我评价", "项目经历"],
          versionName: "JD匹配优化-陈同学-腾讯产品经理实习生",
        },
      },
    });

    const result = await tailorResumeWithAI({
      resume: originalResume,
      jd: "腾讯 - 产品经理实习生\n需要 AI 产品和用户研究经验",
      job: { id: "job-1", company: "目标公司", title: "目标岗位" },
      analysis: {
        company: "待填写公司",
        title: "待分析岗位",
        deadline: null,
        requirements: ["AI 产品"],
        keywords: [],
        bonusPoints: [],
        risks: [],
        suggestions: [],
      },
    });

    expect(result.meta).toMatchObject({
      company: "腾讯",
      title: "产品经理实习生",
      keywords: ["AI 产品", "用户研究"],
      versionName: "JD匹配优化-陈同学-腾讯产品经理实习生",
    });
  });
});
