"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { GAP, paginationRange } from "./pagination-range";

export { GAP, paginationRange } from "./pagination-range";
export type { PageItem } from "./pagination-range";

export type PaginationProps = {
  /** Current page, 1-based. */
  page: number;
  /** Total number of pages. Values below 1 render nothing. */
  pageCount: number;
  onChange: (page: number) => void;
  /** Pages shown either side of the current one. */
  siblings?: number;
  /** Pages pinned at each end. */
  boundaries?: number;
  /** Hide the numbers and show only prev / next with a "3 / 12" readout. */
  compact?: boolean;
  ariaLabel?: string;
  className?: string;
};

/**
 * Page navigation.
 *
 * Renders as a `<nav>` wrapping a list, with the current page carrying
 * `aria-current="page"` — so a screen reader announces position without having
 * to infer it from styling, which is the whole difference between this and a
 * row of styled buttons.
 */
export function Pagination({
  page,
  pageCount,
  onChange,
  siblings = 1,
  boundaries = 1,
  compact = false,
  ariaLabel = "pagination",
  className,
}: PaginationProps) {
  const total = Math.max(0, Math.floor(pageCount));
  if (total <= 1) return null;

  const current = Math.min(Math.max(1, page), total);
  const items = compact ? [] : paginationRange(current, total, siblings, boundaries);

  const step = (
    direction: -1 | 1,
    Icon: typeof ChevronLeft,
    label: string,
  ) => {
    const target = current + direction;
    const disabled = target < 1 || target > total;
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={() => onChange(target)}
        className={cn(
          "flex size-8 items-center justify-center border border-white/15 transition-colors",
          disabled
            ? "cursor-not-allowed text-white/20"
            : "text-white/60 hover:border-white/35 hover:bg-white/5 hover:text-white",
        )}
      >
        <Icon aria-hidden className="size-4" strokeWidth={1.5} />
      </button>
    );
  };

  return (
    <nav aria-label={ariaLabel} className={cn("flex items-center gap-1", className)}>
      {step(-1, ChevronLeft, "previous page")}

      {compact ? (
        <span className="px-3 font-mono text-[11px] tabular-nums text-white/50">
          {current} / {total}
        </span>
      ) : (
        <ul className="flex items-center gap-1">
          {items.map((item, index) =>
            item === GAP ? (
              <li
                key={`gap-${index}`}
                aria-hidden
                className="flex size-8 items-center justify-center font-mono text-[11px] text-white/25"
              >
                …
              </li>
            ) : (
              <li key={item}>
                <button
                  type="button"
                  aria-current={item === current ? "page" : undefined}
                  aria-label={`page ${item}`}
                  onClick={() => onChange(item)}
                  className={cn(
                    "flex size-8 items-center justify-center border font-mono text-[11px] tabular-nums transition-colors",
                    item === current
                      ? "border-white bg-white text-black"
                      : "border-white/15 text-white/60 hover:border-white/35 hover:bg-white/5 hover:text-white",
                  )}
                >
                  {item}
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {step(1, ChevronRight, "next page")}
    </nav>
  );
}
