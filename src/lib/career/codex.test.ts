import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import type { CareerState } from "./domain";
import {
  reviewWithCodex,
  validateReviewCitations,
  type CareerReview,
} from "./codex";

const fake = vi.hoisted(() => ({
  run: vi.fn(),
  options: null as CodexOptions | null,
  thread: null as ThreadOptions | null,
}));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: CodexOptions) {
      fake.options = options;
    }
    startThread(options: ThreadOptions) {
      fake.thread = options;
      return { run: fake.run };
    }
  },
}));
const state: CareerState = {
  memories: [],
  actions: [],
  evidence: [
    {
      id: "proof-1",
      title: "API",
      sourceType: "artifact",
      sourceRef: "README:1",
      excerpt: "Python API",
      contribution: "Implemented the endpoint",
      skills: ["python"],
      status: "accepted",
      useInAI: true,
      revision: 1,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    },
  ],
};
const review: CareerReview = {
  summary: "有 Python 项目材料，需核对。",
  findings: [
    {
      claim: "材料描述了一个 API 实现。",
      evidenceIds: ["evidence:proof-1"],
      basis: "artifact",
    },
  ],
  questions: ["你如何处理超时？"],
  nextSteps: ["补充测试结果。"],
};

beforeEach(() => {
  vi.resetAllMocks();
  fake.options = null;
  fake.thread = null;
  vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", "test-provider-key");
  vi.stubEnv("TRACEFOLIO_CODEX_MODEL", "test-model");
});
afterEach(() => vi.unstubAllEnvs());

describe("bounded Codex evidence review", () => {
  it("refuses missing credentials or consent before starting the runtime", async () => {
    vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", "");
    await expect(reviewWithCodex(state, ["python"])).rejects.toMatchObject({
      status: 503,
    });
    vi.stubEnv("TRACEFOLIO_CODEX_API_KEY", "test-provider-key");
    await expect(
      reviewWithCodex(
        { ...state, evidence: [{ ...state.evidence[0], useInAI: false }] },
        ["python"],
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fake.options).toBeNull();
  });

  it("isolates the child environment, disables command tools, validates sources and cleans up", async () => {
    fake.run.mockResolvedValue({
      finalResponse: JSON.stringify(review),
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = await reviewWithCodex(state, ["python"]);
    expect(result.review).toEqual(review);
    expect(fake.options?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(fake.options?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(Object.keys(fake.options?.env ?? {}).sort()).toEqual([
      "CODEX_HOME",
      "PATH",
    ]);
    expect(fake.options?.config?.features).toMatchObject({
      shell_tool: false,
      view_image: false,
      apps: false,
    });
    expect(fake.thread).toMatchObject({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      networkAccessEnabled: false,
    });
    expect(existsSync(fake.thread!.workingDirectory!)).toBe(false);
    expect(existsSync(fake.options!.env!.CODEX_HOME)).toBe(false);
  });

  it("rejects invented citations, unavailable sources and upgrades from self report", () => {
    expect(() =>
      validateReviewCitations(
        {
          ...review,
          findings: [
            { ...review.findings[0], evidenceIds: ["evidence:invented"] },
          ],
        },
        state.evidence,
      ),
    ).toThrow();
    expect(() => validateReviewCitations(review, state.evidence, [])).toThrow();
    expect(() =>
      validateReviewCitations(review, [
        { ...state.evidence[0], sourceType: "self_report" },
      ]),
    ).toThrow();
    expect(() =>
      validateReviewCitations(review, [
        { ...state.evidence[0], useInAI: false },
      ]),
    ).toThrow();
  });

  it("cleans up failed runs and returns a sanitized error", async () => {
    fake.run.mockRejectedValue(new Error("provider echoed a sensitive token"));
    await expect(reviewWithCodex(state, ["python"])).rejects.toMatchObject({
      status: 502,
    });
    expect(existsSync(fake.thread!.workingDirectory!)).toBe(false);
  });
});
