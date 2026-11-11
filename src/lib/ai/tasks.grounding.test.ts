import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { runAiObjectTask, type AiObjectExecutor } from "./tasks";
import type { EffectiveAiSettings } from "./settings";
import { getCareerGrounding } from "@/lib/career/store";

vi.mock("@/lib/career/store", () => ({ getCareerGrounding: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("career context at the model boundary", () => {
  it("adds opted-in career background to resume/interview tasks without changing the task", async () => {
    vi.mocked(getCareerGrounding).mockResolvedValue(
      "<career_data_json>confirmed career context</career_data_json>",
    );
    let received: { system: string; prompt: string } | undefined;
    const executor: AiObjectExecutor = async (input) => {
      received = input;
      return { object: { ok: true } as never };
    };
    const result = await runAiObjectTask(
      {
        settings: {
          enabled: true,
          requiresApiKey: false,
          provider: { label: "Test" },
          model: "test",
        } as EffectiveAiSettings,
        schema: z.object({ ok: z.boolean() }),
        system: "Review this resume",
        prompt: "Original resume",
        fallback: { ok: false },
        taskLabel: "Test",
        includeCareerContext: true,
      },
      { model: new MockLanguageModelV3(), generateObject: executor },
    );
    expect(result.source).toBe("ai");
    expect(getCareerGrounding).toHaveBeenCalledWith("Original resume");
    expect(received?.prompt).toContain("Original resume");
    expect(received?.prompt).toContain("confirmed career context");
    expect(received?.system).toContain(
      "不得自动给简历添加原文不存在的任职或项目",
    );
  });

  it("does not load personal career data for extraction or connection tests", async () => {
    await runAiObjectTask(
      {
        settings: {
          enabled: true,
          requiresApiKey: false,
          provider: { label: "Test" },
          model: "test",
        } as EffectiveAiSettings,
        schema: z.object({ ok: z.boolean() }),
        system: "Connection test",
        prompt: "Ping",
        fallback: { ok: false },
        taskLabel: "Connection",
      },
      {
        model: new MockLanguageModelV3(),
        generateObject: async () => ({ object: { ok: true } as never }),
      },
    );
    expect(getCareerGrounding).not.toHaveBeenCalled();
  });
});
