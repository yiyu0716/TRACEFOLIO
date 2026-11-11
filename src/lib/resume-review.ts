import type { ResumeContent } from "./types";
import type { ResumeDiagnosisIssue } from "./ai/resume-diagnosis";

export type ResumeReviewSection =
  | "summary"
  | "education"
  | "experiences"
  | "internships"
  | "projects"
  | "skills"
  | "awards"
  | "customSections";

type ResumeReviewTarget =
  | { kind: "profileSummary" }
  | { kind: "selfReview" }
  | {
      kind: "highlight";
      collection: "education" | "experiences" | "internships" | "projects";
      itemIndex: number;
      highlightIndex: number;
    }
  | { kind: "skills" }
  | { kind: "awards" }
  | { kind: "customSection"; itemIndex: number };

export type ResumeReviewChange = {
  id: string;
  section: ResumeReviewSection;
  itemLabel: string;
  field: "summary" | "selfReview" | "highlight" | "skills" | "awards" | "customContent";
  before: string;
  after: string;
  target: ResumeReviewTarget;
};

export function buildResumeReviewChanges(before: ResumeContent, after: ResumeContent): ResumeReviewChange[] {
  const changes: ResumeReviewChange[] = [];

  addTextChange(changes, {
    id: "summary:profile",
    section: "summary",
    itemLabel: "",
    field: "summary",
    before: before.profile.summary,
    after: after.profile.summary,
    target: { kind: "profileSummary" },
  });
  addTextChange(changes, {
    id: "summary:self-review",
    section: "summary",
    itemLabel: "",
    field: "selfReview",
    before: before.selfReview,
    after: after.selfReview,
    target: { kind: "selfReview" },
  });

  addHighlightChanges(changes, "education", before.education, after.education, (item) =>
    [item.school, item.major || item.degree].filter(Boolean).join(" · "),
  );
  addHighlightChanges(changes, "experiences", before.experiences, after.experiences, (item) =>
    [item.company, item.role].filter(Boolean).join(" · "),
  );
  addHighlightChanges(changes, "internships", before.internships, after.internships, (item) =>
    [item.company, item.role].filter(Boolean).join(" · "),
  );
  addHighlightChanges(changes, "projects", before.projects, after.projects, (item) =>
    [item.name, item.role].filter(Boolean).join(" · "),
  );

  addListChange(changes, "skills", before.skills, after.skills);
  addListChange(changes, "awards", before.awards, after.awards);

  (before.customSections ?? []).forEach((section, itemIndex) => {
    addTextChange(changes, {
      id: `customSections:${itemIndex}`,
      section: "customSections",
      itemLabel: section.title,
      field: "customContent",
      before: section.content,
      after: after.customSections?.[itemIndex]?.content ?? section.content,
      target: { kind: "customSection", itemIndex },
    });
  });

  return changes;
}

export function applyResumeReviewChanges(
  before: ResumeContent,
  changes: ResumeReviewChange[],
  acceptedIds: ReadonlySet<string>,
  editedValues: Readonly<Record<string, string>>,
): ResumeContent {
  const result = structuredClone(before);

  for (const change of changes) {
    if (!acceptedIds.has(change.id)) continue;
    const value = editedValues[change.id] ?? change.after;
    if (!value.trim()) continue;

    switch (change.target.kind) {
      case "profileSummary":
        result.profile.summary = value.trim();
        break;
      case "selfReview":
        result.selfReview = value.trim();
        break;
      case "highlight": {
        const item = result[change.target.collection][change.target.itemIndex];
        if (item) item.highlights[change.target.highlightIndex] = value.trim();
        break;
      }
      case "skills":
        result.skills = parseLines(value, result.skills);
        break;
      case "awards":
        result.awards = parseLines(value, result.awards);
        break;
      case "customSection": {
        const section = result.customSections?.[change.target.itemIndex];
        if (section) section.content = value.trim();
        break;
      }
    }
  }

  return result;
}

export function resumeReviewChangeAddressesIssue(
  change: ResumeReviewChange,
  issue: ResumeDiagnosisIssue,
) {
  if (issue.section !== "overall" && issue.section !== change.section) return false;
  const evidence = normalizeText(issue.evidence);
  if (!evidence) return true;
  const original = normalizeText(change.before);
  if (!original) return false;
  return original.includes(evidence) || evidence.includes(original);
}

function addTextChange(changes: ResumeReviewChange[], change: ResumeReviewChange) {
  if (normalizeText(change.before) !== normalizeText(change.after)) changes.push(change);
}

function addHighlightChanges<
  T extends { highlights: string[] },
  K extends "education" | "experiences" | "internships" | "projects",
>(
  changes: ResumeReviewChange[],
  collection: K,
  before: T[],
  after: T[],
  label: (item: T) => string,
) {
  before.forEach((item, itemIndex) => {
    item.highlights.forEach((text, highlightIndex) => {
      addTextChange(changes, {
        id: `${collection}:${itemIndex}:highlight:${highlightIndex}`,
        section: collection,
        itemLabel: label(item),
        field: "highlight",
        before: text,
        after: after[itemIndex]?.highlights[highlightIndex] ?? text,
        target: { kind: "highlight", collection, itemIndex, highlightIndex },
      });
    });
  });
}

function addListChange(
  changes: ResumeReviewChange[],
  section: "skills" | "awards",
  before: string[],
  after: string[],
) {
  addTextChange(changes, {
    id: `${section}:list`,
    section,
    itemLabel: "",
    field: section,
    before: before.join("\n"),
    after: after.join("\n"),
    target: { kind: section },
  });
}

function parseLines(value: string, fallback: string[]) {
  const lines = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return lines.length ? lines : fallback;
}

function normalizeText(value: string) {
  return value
    .replace(/["'“”‘’《》「」『』【】（）()[\]{}，。.,:：;；!?！？、…—–-]/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}
