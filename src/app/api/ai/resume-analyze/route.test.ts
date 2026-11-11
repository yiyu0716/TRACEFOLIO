import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeResumeWithAI: vi.fn(),
}));

vi.mock("@/lib/ai-service", () => ({
  analyzeResumeWithAI: mocks.analyzeResumeWithAI,
}));

import { GET, POST } from "./route";

const resume = {
  basics: { name: "陈同学", email: "", phone: "", city: "", links: [] },
  profile: { title: "产品经理", summary: "关注 AI 产品。" },
  education: [],
  experiences: [],
  internships: [],
  projects: [],
  skills: ["AI 产品", "Prompt"],
  awards: [],
  selfReview: "",
};

describe("resume analysis route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns structured AI diagnosis without creating a version", async () => {
    const diagnosis = {
      summary: "项目表达需要补充行动与结果。",
      strengths: ["技能方向明确"],
      issues: [{
        id: "issue-1",
        section: "projects",
        location: "项目经历",
        severity: "high",
        category: "action-result",
        title: "缺少个人行动",
        evidence: "参与项目开发",
        explanation: "没有说明具体负责的工作。",
        suggestion: "补充本人采取的行动和可验证结果。",
      }],
    };
    mocks.analyzeResumeWithAI.mockResolvedValue({
      source: "ai",
      message: "简历诊断完成",
      data: diagnosis,
    });

    const response = await POST(jsonRequest({ resume, locale: "zh-CN" }));

    expect(response.status).toBe(200);
    expect(mocks.analyzeResumeWithAI).toHaveBeenCalledWith({
      resume: expect.objectContaining(resume),
      locale: "zh-CN",
    });
    await expect(response.json()).resolves.toEqual({
      diagnosis,
      message: "简历诊断完成",
    });
  });

  it("returns 503 when AI analysis is unavailable", async () => {
    mocks.analyzeResumeWithAI.mockResolvedValue({
      source: "fallback",
      message: "缺少 API Key",
      data: { summary: "", strengths: [], issues: [] },
    });

    const response = await POST(jsonRequest({ resume }));

    expect(response.status).toBe(503);
  });

  it("warms the route without calling the model", async () => {
    const response = await GET();

    expect(response.status).toBe(204);
    expect(mocks.analyzeResumeWithAI).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/ai/resume-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
