import * as React from "react";
import { cn } from "@/lib/utils";

export type ProgressSize = "sm" | "md" | "lg";

export type ProgressProps = {
  /** Current amount. Ignored when `indeterminate`. */
  value?: number;
  /** Upper bound for `value`. Defaults to 100. */
  max?: number;
  /** Unknown-duration state: a sliver sweeps the track and no value is reported. */
  indeterminate?: boolean;
  /** Track height. Defaults to "md". */
  size?: ProgressSize;
  /** CSS color for the filled bar. Defaults to white. */
  accent?: string;
  /** Caption above the track, set in the mono group-label style. */
  label?: React.ReactNode;
  /** Show the percentage opposite the label. Defaults to false. */
  showValue?: boolean;
  /** Outline the track instead of tinting it. Only sensible at size "lg". */
  bordered?: boolean;
  /** Custom value text, e.g. "3 of 8". Overrides the percentage. */
  valueText?: string;
  ariaLabel?: string;
  className?: string;
};

const trackHeight: Record<ProgressSize, string> = {
  sm: "h-0.5",
  md: "h-1",
  lg: "h-2",
};

/**
 * Linear progress bar, determinate or indeterminate. The sweep keyframes ship
 * inline via a hoisted <style> tag (React dedupes by href) so the component
 * stays self-contained — no css file to wire up, no motion dependency.
 */
export function Progress({
  value = 0,
  max = 100,
  indeterminate = false,
  size = "md",
  accent = "#fff",
  label,
  showValue = false,
  bordered = false,
  valueText,
  ariaLabel,
  className,
}: ProgressProps) {
  const clamped = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const percent = Math.round(clamped * 100);
  const showHeader = label !== undefined || showValue;

  return (
    <div className={cn("w-full", className)}>
      {showHeader && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            {label}
          </span>
          {showValue && (
            <span className="font-mono text-[11px] tabular-nums text-white/55">
              {indeterminate ? "—" : (valueText ?? `${percent}%`)}
            </span>
          )}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : max}
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuetext={indeterminate ? undefined : valueText}
        className={cn(
          "relative w-full overflow-hidden",
          trackHeight[size],
          bordered ? "border border-white/20" : "bg-white/10",
        )}
      >
        {indeterminate ? (
          <>
            {/* A third-width sliver crossing the track: the conventional
                "working, duration unknown" signal. Reduced motion parks it as
                a static half-bar rather than removing the affordance. */}
            <style precedence="default" href="chrome-progress-keyframes">{`
              @keyframes chrome-progress-sweep {
                from { transform: translateX(-100%); }
                to { transform: translateX(300%); }
              }
              .chrome-progress-sweep {
                animation: chrome-progress-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
              }
              @media (prefers-reduced-motion: reduce) {
                .chrome-progress-sweep {
                  animation: none;
                  width: 50%;
                  opacity: 0.5;
                }
              }
            `}</style>
            <div
              className="chrome-progress-sweep absolute inset-y-0 left-0 w-1/3"
              style={{ background: accent }}
            />
          </>
        ) : (
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${clamped * 100}%`, background: accent }}
          />
        )}
      </div>
    </div>
  );
}
