import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BarListItem = {
  /** Stable key. Falls back to `label` when omitted. */
  id?: string;
  label: ReactNode;
  value: number;
  /**
   * CSS color for this row's bar. Rendered at low opacity so the label stays
   * legible — the bar is a background, not a swatch. Omit for the default white.
   */
  color?: string;
  /** When set, the whole row becomes a link. */
  href?: string;
};

export type BarListProps = {
  /**
   * Rows in render order — sort before passing to get a true ranking, since
   * `limit` keeps the first N rather than the largest N.
   */
  items: BarListItem[];
  /** Bar scale ceiling. Defaults to the largest value present. */
  max?: number;
  /** Value formatter for the right column. Defaults to `String(value)`. */
  formatValue?: (value: number) => string;
  /** Show the value column. When false it stays available to screen readers. Default true. */
  showValue?: boolean;
  /** Render at most this many rows. */
  limit?: number;
  /** Makes rows buttons. Ignored on rows that carry an `href`. */
  onItemClick?: (item: BarListItem) => void;
  /** Anchor element/component for rows with an `href` — pass your router's Link. Default "a". */
  linkComponent?: React.ElementType;
  className?: string;
};

/**
 * Ranked horizontal bar list — the bar is the row's own background rather than
 * a separate track, so a long list reads as a block of text with weight behind
 * it instead of a chart with rows bolted on.
 */
export function BarList({
  items,
  max,
  formatValue = (value) => String(value),
  showValue = true,
  limit,
  onItemClick,
  linkComponent: LinkComponent = "a",
  className,
}: BarListProps) {
  const rows = limit === undefined ? items : items.slice(0, limit);
  // Guard the divisor: an all-zero list should render empty bars, not NaN.
  const ceiling = max ?? rows.reduce((m, item) => (item.value > m ? item.value : m), 0);

  return (
    <ol className={cn("flex w-full flex-col", className)}>
      {rows.map((item, index) => {
        const pct = ceiling > 0 ? Math.max(0, Math.min(1, item.value / ceiling)) * 100 : 0;
        const formatted = formatValue(item.value);
        const interactive = Boolean(item.href) || Boolean(onItemClick);

        const inner = (
          <>
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-0 transition-[width] duration-500",
                item.color ? "opacity-40" : undefined,
              )}
              style={{
                width: `${pct}%`,
                backgroundColor: item.color ?? "rgba(255,255,255,0.10)",
              }}
            />
            <span className="relative min-w-0 truncate text-sm text-white/70 transition-colors group-hover:text-white">
              {item.label}
            </span>
            <span
              className={cn(
                "relative shrink-0 font-mono text-xs tabular-nums text-white/55",
                showValue ? undefined : "sr-only",
              )}
            >
              {formatted}
            </span>
          </>
        );

        const rowClass = cn(
          "group relative flex w-full items-center justify-between gap-4 px-2 py-2.5 text-left",
          interactive && "transition-colors hover:bg-white/[0.04]",
        );

        return (
          <li key={item.id ?? index} className="border-b border-white/10 last:border-b-0">
            {item.href ? (
              <LinkComponent href={item.href} className={rowClass}>
                {inner}
              </LinkComponent>
            ) : onItemClick ? (
              <button type="button" onClick={() => onItemClick(item)} className={rowClass}>
                {inner}
              </button>
            ) : (
              <div className={rowClass}>{inner}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
