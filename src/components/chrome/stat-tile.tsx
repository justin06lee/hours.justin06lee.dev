import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { CountUp } from "@/components/chrome/count-up";
import { cn } from "@/lib/utils";

export type StatTileProps = {
  /** Mono uppercase kicker above the number, e.g. "machine learning". */
  label: ReactNode;
  /** The headline figure. Strings render as-is (already formatted, "—", etc.). */
  value: number | string;
  /** Small trailing qualifier next to the number, e.g. "h" or "sessions". */
  unit?: string;
  /**
   * Formatter for numeric `value` and `delta`. Overrides `decimals`.
   * Note: a function prop can't cross the server/client boundary, so pairing
   * `format` with `animate` requires the tile to render inside a client component.
   */
  format?: (n: number) => string;
  /** Fixed decimal places for numeric `value`/`delta`. Default 0. */
  decimals?: number;
  /** Tween the number up from 0 when it scrolls into view (uses `CountUp`). */
  animate?: boolean;
  /** Tween length in seconds when `animate` is set. Default 1. */
  duration?: number;
  /** Signed change since the comparison period. Sign picks the direction icon. */
  delta?: number;
  /** Trailing context for the delta chip, e.g. "vs last month". */
  deltaLabel?: ReactNode;
  /**
   * Flip which sign is "bad" — for figures where less is better (distractions,
   * time to first commit) a rise is the red one.
   */
  invertDelta?: boolean;
  /** Muted line under the tile — provenance, caveats, sample size. */
  footnote?: ReactNode;
  /** Decorative slot pinned to the top-right, typically a 14px lucide icon. */
  icon?: ReactNode;
  /** Rendered between the number and the footnote — a `Sparkline` fits here. */
  children?: ReactNode;
  className?: string;
};

/**
 * Big-number KPI tile: one figure, one label, optional delta and footnote.
 *
 * Server-renderable by default — the tile itself is static markup and only the
 * opt-in `animate` path pulls in the `CountUp` client component, so a grid of
 * tiles costs nothing on the client until you ask it to move.
 */
export function StatTile({
  label,
  value,
  unit,
  format,
  decimals = 0,
  animate = false,
  duration = 1,
  delta,
  deltaLabel,
  invertDelta = false,
  footnote,
  icon,
  children,
  className,
}: StatTileProps) {
  const fmt = (n: number) => (format ? format(n) : n.toFixed(decimals));

  // Direction is the sign; tone is whether that direction is welcome. Keeping
  // them separate is what lets `invertDelta` recolor without flipping the icon.
  const direction = delta === undefined || delta === 0 ? 0 : delta > 0 ? 1 : -1;
  const bad = delta !== undefined && (invertDelta ? delta > 0 : delta < 0);
  const DeltaIcon = direction === 0 ? Minus : direction > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border border-white/10 bg-[#0a0a0a] p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
          {label}
        </span>
        {icon ? (
          <span aria-hidden className="shrink-0 text-white/30">
            {icon}
          </span>
        ) : null}
      </div>

      <div className="flex items-baseline gap-1.5">
        {typeof value === "number" && animate ? (
          <CountUp
            value={value}
            duration={duration}
            decimals={decimals}
            format={format}
            className="text-4xl leading-none tracking-tight text-white"
          />
        ) : (
          <span className="text-4xl leading-none tracking-tight text-white tabular-nums">
            {typeof value === "number" ? fmt(value) : value}
          </span>
        )}
        {unit ? (
          <span className="font-mono text-xs lowercase text-white/40">{unit}</span>
        ) : null}
      </div>

      {delta !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
              bad
                ? "border-red-400/60 bg-red-400/10 text-red-300"
                : "border-white/15 text-white/70",
            )}
          >
            <DeltaIcon aria-hidden className="size-3" strokeWidth={1.5} />
            <span className="sr-only">
              {direction === 0 ? "no change" : direction > 0 ? "up" : "down"}{" "}
            </span>
            {fmt(Math.abs(delta))}
          </span>
          {deltaLabel ? (
            <span className="text-[11px] text-white/40">{deltaLabel}</span>
          ) : null}
        </div>
      ) : null}

      {children}

      {footnote ? (
        <p className="text-[11px] leading-relaxed text-white/40">{footnote}</p>
      ) : null}
    </div>
  );
}
