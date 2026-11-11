import { describe, expect, it } from "vitest";
import {
  buildCareerGroundingPacket,
  canCompleteAction,
  matchEvidence,
  normalizeSkill,
  skillsSchema,
  type Evidence,
  type Memory,
} from "./domain";

export const artifact: Evidence = {
  id: "proof-1",
  title: "Retrieval API",
  sourceType: "artifact",
  sourceRef: "README:20",
  excerpt: "Implemented a retrieval endpoint",
  contribution: "Implemented the API",
  skills: ["Python", "RAG"],
  status: "accepted",
  useInAI: true,
  revision: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};
const memory: Memory = {
  id: "goal-1",
  key: "Target role",
  category: "goal",
  content: "AI backend in Shanghai",
  source: "user",
  confirmed: true,
  useInAI: true,
  expiresAt: null,
  revision: 1,
  createdAt: artifact.createdAt,
  updatedAt: artifact.updatedAt,
};

describe("evidence-based career decisions", () => {
  it("normalizes aliases without matching different languages or token substrings", () => {
    expect(skillsSchema.parse(["Node.js", "nodejs", " TS "])).toEqual([
      "nodejs",
      "typescript",
    ]);
    expect(normalizeSkill("C++")).toBe("c++");
    const match = matchEvidence(
      ["Java", "C", "TypeScript"],
      [{ ...artifact, skills: ["JavaScript", "C++", "TS"] }],
    );
    expect(match.rows.map((row) => row.support)).toEqual([
      "missing",
      "missing",
      "artifact",
    ]);
  });

  it("excludes pending and rejected evidence and separates self reports from artifacts", () => {
    const result = matchEvidence(
      ["Python", "RAG", "SQL", "Go", "Python"],
      [
        { ...artifact, skills: ["Python"] },
        {
          ...artifact,
          id: "claim",
          sourceType: "self_report",
          skills: ["RAG"],
        },
        { ...artifact, id: "pending", skills: ["SQL"], status: "pending" },
        { ...artifact, id: "rejected", skills: ["Go"], status: "rejected" },
      ],
    );
    expect(result.coveragePercent).toBe(50);
    expect(result.artifactCoveragePercent).toBe(25);
    expect(result.rows[1]).toMatchObject({
      support: "self_report",
      evidenceIds: ["claim"],
    });
    expect(result.rows[2].evidenceIds).toEqual([]);
    expect(matchEvidence([], [artifact]).coveragePercent).toBe(0);
  });

  it("requires confirmed, consented and unexpired memory; consent is separate from local matching", () => {
    const packet = buildCareerGroundingPacket(
      {
        memories: [
          memory,
          { ...memory, id: "expired", expiresAt: "2026-11-10T00:00:00Z" },
          { ...memory, id: "unconfirmed", confirmed: false },
          { ...memory, id: "private", useInAI: false },
        ],
        evidence: [
          artifact,
          { ...artifact, id: "private-proof", useInAI: false },
          { ...artifact, id: "rejected-proof", status: "rejected" },
        ],
      },
      "Python",
      new Date("2026-11-11T00:00:00Z"),
    );
    expect(packet.text).toContain("memory:goal-1");
    expect(packet.evidenceIds).toEqual(["evidence:proof-1"]);
    for (const excluded of [
      "memory:expired",
      "memory:unconfirmed",
      "memory:private",
      "evidence:private-proof",
      "evidence:rejected-proof",
    ])
      expect(packet.text).not.toContain(excluded);
    expect(
      matchEvidence(["Python"], [{ ...artifact, useInAI: false }])
        .coveragePercent,
    ).toBe(100);
  });

  it("keeps complete sources within a fixed context budget", () => {
    const packet = buildCareerGroundingPacket(
      {
        memories: [],
        evidence: [
          artifact,
          { ...artifact, id: "too-large", excerpt: "x".repeat(10000) },
        ],
      },
      "Python",
      new Date(),
      1000,
    );
    expect(packet.evidenceIds).toEqual(["evidence:proof-1"]);
    const serialized = packet.text
      .split("<career_data_json>\n")[1]
      .split("\n</career_data_json>")[0];
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized.length).toBeLessThanOrEqual(1000);
  });

  it("does not allow completing growth tasks from self reports, unrelated skills, or rejected records", () => {
    expect(canCompleteAction({ skill: "py" }, artifact)).toBe(true);
    expect(canCompleteAction({ skill: "Java" }, artifact)).toBe(false);
    expect(
      canCompleteAction(
        { skill: "Python" },
        { ...artifact, sourceType: "self_report" },
      ),
    ).toBe(false);
    expect(
      canCompleteAction(
        { skill: "Python" },
        { ...artifact, status: "rejected" },
      ),
    ).toBe(false);
    expect(canCompleteAction({ skill: "Python" }, undefined)).toBe(false);
  });
});
