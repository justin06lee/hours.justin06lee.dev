import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StreakProps = {
  /** Days (or whatever `unit` is) in the current unbroken run. */
  current: number;
  /** The all-time best run. Rendered as a quiet comparison when set. */
  best?: number;
  /** Recent history, most recent LAST — one cell per entry, true = hit. */
  days?: boolean[];
  /** Mono uppercase kicker. Default "streak". */
  label?: ReactNode;
  /** Singular noun for the run; an "s" is appended when `current` isn't 1. Default "day". */
  unit?: string;
  className?: string;
};

/** Naive English plural — enough for "day"/"week"; pass a pre-pluralized unit otherwise. */
function plural(unit: string, n: number): string {
  return n === 1 ? unit : `${unit}s`;
}

/**
 * Streak indicator: the current run, an optional best, and a compact strip of
 * recent day cells. The strip is the point — a number alone can't show that the
 * run nearly broke twice last week.
 */
export function Streak({
  current,
  best,
  days,
  label = "streak",
  unit = "day",
  className,
}: StreakProps) {
  const hits = days?.reduce((n, day) => (day ? n + 1 : n), 0) ?? 0;
  const summary = days
    ? `${current} ${plural(unit, current)} in a row${best === undefined ? "" : `, best ${best} ${plural(unit, best)}`}. last ${days.length} ${plural(unit, days.length)}: ${hits} hit, ${days.length - hits} missed.`
    : `${current} ${plural(unit, current)} in a row${best === undefined ? "" : `, best ${best} ${plural(unit, best)}`}.`;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border border-white/10 bg-[#0a0a0a] p-4",
        className,
      )}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
        {label}
      </span>

      <p className="sr-only">{summary}</p>

      <div aria-hidden className="flex items-baseline gap-2">
        <span className="text-3xl leading-none tracking-tight text-white tabular-nums">
          {current}
        </span>
        <span className="font-mono text-xs text-white/40">
          {plural(unit, current)} in a row
        </span>
      </div>

      {days && days.length > 0 ? (
        <div aria-hidden className="flex flex-wrap items-center gap-[3px]">
          {days.map((hit, i) => (
            <span
              key={i}
              className={cn("size-2.5", hit ? "bg-white/70" : "bg-white/[0.08]")}
            />
          ))}
        </div>
      ) : null}

      {best !== undefined ? (
        <span
          aria-hidden
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/30 tabular-nums"
        >
          best {best} {plural(unit, best)}
        </span>
      ) : null}
    </div>
  );
}
