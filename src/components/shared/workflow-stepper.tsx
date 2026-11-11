import { CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function WorkflowStepper({
  labels,
  current,
  onStepChange,
}: {
  labels: string[];
  current: number;
  onStepChange?: (index: number) => void;
}) {
  return (
    <ol
      className="grid overflow-hidden rounded-lg border border-line bg-surface"
      style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}
    >
      {labels.map((label, index) => (
        <li
          key={label}
          className={cn(
            "min-h-14 border-r border-line text-sm last:border-r-0",
            index === current ? "bg-brand-muted text-brand" : index < current ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <button
            type="button"
            disabled={!onStepChange}
            onClick={() => onStepChange?.(index)}
            className="flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left disabled:cursor-default sm:px-4"
          >
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border text-xs", index <= current && "border-brand bg-brand text-white")}>
              {index < current ? <CheckCircle2 className="size-4" /> : index + 1}
            </span>
            <span className="font-medium">{label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
