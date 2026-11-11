"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, RefreshCw, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ResumeDiagnosis, ResumeDiagnosisIssue } from "@/lib/ai/resume-diagnosis";
import { isAiEditableResumeIssue } from "@/lib/ai/resume-diagnosis";
import type { ResumeContent } from "@/lib/types";
import { cn } from "@/lib/utils";

const severityKeys: ResumeDiagnosisIssue["severity"][] = ["high", "medium", "low"];

export type ResumeDiagnosisSelection = {
  diagnosis: ResumeDiagnosis;
  selectedIssueIds: string[];
  additionalDirection: string;
};

export function ResumeDiagnosisDialog({
  open,
  resume,
  initialSelection,
  onOpenChange,
  onOptimize,
}: {
  open: boolean;
  resume: ResumeContent;
  initialSelection?: ResumeDiagnosisSelection;
  onOpenChange: (open: boolean) => void;
  onOptimize: (input: ResumeDiagnosisSelection) => Promise<void>;
}) {
  const t = useTranslations("resumeWorkbench.diagnosisDialog");
  const locale = useLocale() === "en" ? "en" : "zh-CN";
  const [diagnosis, setDiagnosis] = useState<ResumeDiagnosis | null>(initialSelection?.diagnosis ?? null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>(
    initialSelection?.selectedIssueIds.filter((id) =>
      initialSelection.diagnosis.issues.some((issue) => issue.id === id && isAiEditableResumeIssue(issue)),
    ) ?? [],
  );
  const [additionalDirection, setAdditionalDirection] = useState(initialSelection?.additionalDirection ?? "");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [status, setStatus] = useState("");

  async function analyze() {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    setDiagnosis(null);
    setStatus(t("analyzing"));
    try {
      const response = await fetch("/api/ai/resume-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, locale }),
      });
      const payload = (await response.json()) as {
        diagnosis?: ResumeDiagnosis;
        message?: string;
        error?: string;
      };
      if (!response.ok || !payload.diagnosis) {
        throw new Error(payload.message || payload.error || t("analysisFailed"));
      }
      const recommendedIds = payload.diagnosis.issues
        .filter((issue) => issue.severity !== "low" && isAiEditableResumeIssue(issue))
        .map((issue) => issue.id);
      setDiagnosis(payload.diagnosis);
      setSelectedIssueIds(recommendedIds);
      setStatus(payload.message ?? t("analysisDone"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("analysisFailed"));
    } finally {
      setIsAnalyzing(false);
    }
  }

  function toggleIssue(issueId: string, checked: boolean) {
    setSelectedIssueIds((current) =>
      checked ? Array.from(new Set([...current, issueId])) : current.filter((id) => id !== issueId),
    );
  }

  async function optimize() {
    if (!diagnosis || selectedIssueIds.length === 0 || isOptimizing) return;
    setIsOptimizing(true);
    setStatus(t("optimizing"));
    try {
      await onOptimize({
        diagnosis,
        selectedIssueIds,
        additionalDirection: additionalDirection.trim(),
      });
      onOpenChange(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("optimizationFailed"));
      setIsOptimizing(false);
    }
  }

  const selectedCount = selectedIssueIds.length;
  const editableIssueCount = diagnosis?.issues.filter(isAiEditableResumeIssue).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!isOptimizing) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {isAnalyzing ? (
          <div className="grid min-h-56 place-items-center rounded-lg border border-line bg-surface-low px-6 text-center">
            <div>
              <Sparkles className="mx-auto size-7 animate-pulse text-primary" />
              <p className="mt-3 font-medium">{t("analyzing")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("analyzingHint")}</p>
            </div>
          </div>
        ) : diagnosis ? (
          <fieldset disabled={isOptimizing} className="min-w-0 space-y-5 border-0 p-0">
            <section className="rounded-lg border border-line bg-surface-low p-4">
              <p className="text-sm font-semibold">{t("summary")}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{diagnosis.summary}</p>
              {diagnosis.strengths.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {diagnosis.strengths.map((strength) => (
                    <span
                      key={strength}
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800"
                    >
                      <CheckCircle2 className="size-3.5" />
                      {strength}
                    </span>
                  ))}
                </div>
              ) : null}
            </section>

            <section>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">{t("issuesTitle")}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t("issuesHint")}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("selectedCount", { count: selectedCount })}
                </span>
              </div>

              {diagnosis.issues.length ? (
                <div className="mt-3 space-y-3">
                  {severityKeys.map((severity) => {
                    const issues = diagnosis.issues.filter((issue) => issue.severity === severity);
                    return issues.length ? (
                      <DiagnosisIssueGroup
                        key={severity}
                        severity={severity}
                        issues={issues}
                        selectedIssueIds={selectedIssueIds}
                        onCheckedChange={toggleIssue}
                      />
                    ) : null;
                  })}
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                  {t("noIssues")}
                </div>
              )}
            </section>

            {editableIssueCount ? (
              <section>
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <Label htmlFor="resume-additional-direction">{t("additionalDirection.label")}</Label>
                    <span className="text-xs text-muted-foreground">{t("additionalDirection.optional")}</span>
                  </div>
                  <Textarea
                    id="resume-additional-direction"
                    value={additionalDirection}
                    onChange={(event) => setAdditionalDirection(event.target.value)}
                    placeholder={t("additionalDirection.placeholder")}
                    className="min-h-24 resize-y"
                    maxLength={1_000}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("additionalDirection.hint")}
                  </p>
                </div>
              </section>
            ) : null}
          </fieldset>
        ) : (
          <div
            className={cn(
              "rounded-lg border p-4 text-sm",
              status
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-line bg-surface-low text-foreground",
            )}
          >
            <div className="flex gap-2">
              {status ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              ) : (
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
              )}
              <span>{status || t("startHint")}</span>
            </div>
          </div>
        )}

        {status && diagnosis ? (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {status}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={isOptimizing} />}>{t("close")}</DialogClose>
          {!isAnalyzing ? (
            <Button variant="outline" disabled={isOptimizing} onClick={() => void analyze()}>
              <RefreshCw data-icon="inline-start" />
              {diagnosis || status ? t("reanalyze") : t("startAnalysis")}
            </Button>
          ) : null}
          {editableIssueCount ? (
            <Button
              disabled={isOptimizing || selectedCount === 0}
              onClick={() => void optimize()}
            >
              <Sparkles data-icon="inline-start" />
              {isOptimizing ? t("optimizingButton") : t("optimizeSelected", { count: selectedCount })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiagnosisIssueGroup({
  severity,
  issues,
  selectedIssueIds,
  onCheckedChange,
}: {
  severity: ResumeDiagnosisIssue["severity"];
  issues: ResumeDiagnosisIssue[];
  selectedIssueIds: string[];
  onCheckedChange: (issueId: string, checked: boolean) => void;
}) {
  const t = useTranslations("resumeWorkbench.diagnosisDialog");
  const [open, setOpen] = useState(severity !== "low");
  const selectedCount = issues.filter((issue) => selectedIssueIds.includes(issue.id)).length;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group overflow-hidden rounded-lg border border-line bg-background"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium",
            severity === "high"
              ? "bg-red-50 text-red-700"
              : severity === "medium"
                ? "bg-amber-50 text-amber-700"
                : "bg-slate-100 text-slate-700",
          )}
        >
          {t(`severity.${severity}`)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("groupCount", { count: issues.length, selected: selectedCount })}
        </span>
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="divide-y divide-line border-t border-line">
        {issues.map((issue) => (
          <DiagnosisIssue
            key={issue.id}
            issue={issue}
            checked={selectedIssueIds.includes(issue.id)}
            onCheckedChange={(checked) => onCheckedChange(issue.id, checked)}
          />
        ))}
      </div>
    </details>
  );
}

function DiagnosisIssue({
  issue,
  checked,
  onCheckedChange,
}: {
  issue: ResumeDiagnosisIssue;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const t = useTranslations("resumeWorkbench.diagnosisDialog");
  const checkboxId = `resume-diagnosis-${issue.id}`;
  const editable = isAiEditableResumeIssue(issue);

  return (
    <label
      htmlFor={checkboxId}
      className={cn(
        "flex gap-3 px-4 py-3 transition-colors",
        editable ? "cursor-pointer" : "cursor-default bg-amber-50/60",
        checked ? "bg-primary-soft/40" : editable ? "bg-background hover:bg-surface-low" : "",
      )}
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        disabled={!editable}
        onCheckedChange={(next) => {
          if (editable) onCheckedChange(next === true);
        }}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{issue.title}</span>
          <span className="text-xs text-muted-foreground">{issue.location}</span>
          {!editable ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {t(issue.action === "user-input" ? "userSupplement" : "userConfirmation")}
            </span>
          ) : null}
        </span>
        {issue.evidence ? (
          <span className="mt-2 block rounded-md bg-white/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("evidence", { evidence: issue.evidence })}
          </span>
        ) : null}
        <span className="mt-2 block text-xs leading-5 text-muted-foreground">{issue.explanation}</span>
        <span className="mt-1 block text-xs leading-5 text-foreground">
          {t("suggestion", { suggestion: issue.suggestion })}
        </span>
      </span>
    </label>
  );
}
