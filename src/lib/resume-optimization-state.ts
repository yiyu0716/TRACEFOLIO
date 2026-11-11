import {
  resumeDiagnosisSchema,
  resumeOptimizationPreferenceSchema,
  type ResumeDiagnosis,
  type ResumeOptimizationPreference,
} from "@/lib/ai/resume-diagnosis";
import { isResumeContentLike } from "@/lib/resume-upload";
import type { ResumeContent, ResumeOptimizationMeta } from "@/lib/types";

export type GeneralResumeOptimizationStages = {
  diagnosis?: ResumeDiagnosis;
  draft?: ResumeContent;
  selectedIssueIds?: string[];
  preferences?: ResumeOptimizationPreference[];
  additionalDirection?: string;
  acceptedChangeIds?: string[];
  editedValues?: Record<string, string>;
};

export function attachGeneralResumeOptimizationState(
  content: ResumeContent,
  baseResume: ResumeContent,
  optimization: ResumeOptimizationMeta,
  stages: GeneralResumeOptimizationStages,
): ResumeContent {
  return {
    ...content,
    _tailoringBaseResume: baseResume,
    _optimizationMeta: optimization,
    _optimizationStages: stages,
  } as ResumeContent;
}

export function readGeneralResumeOptimizationStages(
  content: ResumeContent,
): GeneralResumeOptimizationStages | undefined {
  const value = (content as ResumeContent & { _optimizationStages?: unknown })._optimizationStages;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const diagnosis = resumeDiagnosisSchema.safeParse(record.diagnosis);
  const preferences = Array.isArray(record.preferences)
    ? record.preferences.flatMap((item) => {
        const parsed = resumeOptimizationPreferenceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : undefined;

  return {
    diagnosis: diagnosis.success ? diagnosis.data : undefined,
    draft: isResumeContentLike(record.draft) ? record.draft : undefined,
    selectedIssueIds: readStringArray(record.selectedIssueIds),
    preferences,
    additionalDirection: typeof record.additionalDirection === "string" ? record.additionalDirection : undefined,
    acceptedChangeIds: readStringArray(record.acceptedChangeIds),
    editedValues: readStringRecord(record.editedValues),
  };
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function readStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
