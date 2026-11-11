// Entirely synthetic career materials for tests. No personal candidate data.
import type { ResumeContent } from "@/lib/types";
import type { TaskSnapshot, TailoringProposal } from "./domain";

export const testResume: ResumeContent = {
  basics: { name: "测试候选人", email: "synthetic@example.test", phone: "000000", city: "测试城市", links: [] },
  profile: { title: "后端工程师", summary: "使用 Python 开发接口。" },
  education: [], experiences: [], internships: [],
  projects: [{ name: "合成检索项目", role: "接口开发", highlights: ["使用 Python 编写检索接口并添加超时处理。"] }],
  skills: ["Python"], awards: [], selfReview: "重视接口稳定性。",
};
export const testSnapshot: TaskSnapshot = {
  request: { resumeVersionId: "resume-1", jobId: "job-1", evidenceIds: ["proof-1"], includeMemories: false },
  resume: { id: "resume-1", resumeId: "group-1", name: "测试基础简历", updatedAt: "2026-11-11T00:00:00.000Z", content: testResume },
  job: { id: "job-1", company: "合成公司", title: "Python 后端开发", jd: "使用 Python 开发接口，重视超时处理。", updatedAt: "2026-11-11T00:00:00.000Z" },
  evidence: [{
    id: "proof-1", title: "合成接口材料", sourceType: "artifact", sourceRef: "synthetic:README:10",
    excerpt: "使用 Python 编写检索接口并添加超时处理。", contribution: "负责接口开发与超时处理。", skills: ["python"],
    status: "accepted", useInAI: true, revision: 1, createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
  }], memories: [],
};
export const testProposal: TailoringProposal = {
  summary: "突出 Python 检索接口与超时处理实践。",
  changes: [{ path: "projects.0.highlights.0", before: testResume.projects[0].highlights[0],
    after: "为 Python 检索接口添加超时处理，明确请求异常的处理路径。", reason: "对齐岗位对接口稳定性的要求。",
    citations: [{ sourceId: "evidence:proof-1", quote: "使用 Python 编写检索接口并添加超时处理。", basis: "artifact" }],
  }], questions: ["能否补充超时处理的测试记录？"],
};
