import { describe, expect, it } from "vitest";
import { validateProposal } from "./domain";
import { createCareerTools } from "./career-tools";
import { testProposal, testSnapshot } from "./test-fixtures";

describe("evidence-bound resume proposals", () => {
  it("only applies enumerated text changes and preserves identities and source", () => {
    const result = validateProposal(testProposal, testSnapshot);
    expect(result.content.projects[0].highlights[0]).toBe(testProposal.changes[0].after);
    expect(result.content.basics).toEqual(testSnapshot.resume.content.basics);
    expect(result.content.projects[0].name).toBe(testSnapshot.resume.content.projects[0].name);
    expect(testSnapshot.resume.content.projects[0].highlights[0]).toBe(testProposal.changes[0].before);
  });

  it.each(["basics.name", "projects.0.name", "projects.0.role", "projects.1.highlights.0", "__proto__.polluted", "skills.0"])("refuses protected or nonexistent path %s", (path) => {
    expect(() => validateProposal({ ...testProposal, changes: [{ ...testProposal.changes[0], path }] }, testSnapshot)).toThrow();
  });

  it("rejects invented citations, fabricated quotations and unsupported quantities", () => {
    for (const citation of [
      { sourceId: "evidence:unknown", quote: "Python", basis: "artifact" },
      { sourceId: "evidence:proof-1", quote: "降低延迟 50%", basis: "artifact" },
      { sourceId: "evidence:proof-1", quote: "Python", basis: "self_report" },
    ]) expect(() => validateProposal({ ...testProposal, changes: [{ ...testProposal.changes[0], citations: [citation] }] }, testSnapshot)).toThrow();
    expect(() => validateProposal({ ...testProposal, changes: [{ ...testProposal.changes[0], after: "降低延迟 50%" }] }, testSnapshot)).toThrow(/数字/);
    expect(() => validateProposal({ ...testProposal, changes: [testProposal.changes[0], testProposal.changes[0]] }, testSnapshot)).toThrow(/重复/);
    expect(() => validateProposal({ ...testProposal, changes: [{ ...testProposal.changes[0], before: "different" }] }, testSnapshot)).toThrow();
  });

  it("preserves self-report status and warns without claiming independent verification", () => {
    const snapshot = structuredClone(testSnapshot); snapshot.evidence[0].sourceType = "self_report";
    expect(() => validateProposal(testProposal, snapshot)).toThrow();
    const proposal = structuredClone(testProposal); proposal.changes[0].citations[0].basis = "self_report";
    expect(validateProposal(proposal, snapshot).warnings).toContain("简历和本人自述未经独立核验，请核对个人贡献及措辞。");
  });

  it("requires scoped reads and current consent on every call, and never exposes saving tools", async () => {
    let current = true;
    const tools = createCareerTools(testSnapshot, async () => { if (!current) throw new Error("consent revoked"); });
    await expect(tools.call("submit_tailoring_proposal", testProposal)).rejects.toThrow(/先读取/);
    const resume = await tools.call("read_resume", {});
    expect(JSON.stringify(resume)).not.toContain("synthetic@example.test");
    await tools.call("read_job", {}); await tools.call("read_evidence", {});
    await expect(tools.call("submit_tailoring_proposal", testProposal)).resolves.toMatchObject({ accepted: true });
    expect(tools.proposal).toEqual(testProposal);
    await expect(tools.call("save_resume", {})).rejects.toThrow(/范围/);
    current = false;
    await expect(tools.call("read_evidence", {})).rejects.toThrow("consent revoked");
  });
});
