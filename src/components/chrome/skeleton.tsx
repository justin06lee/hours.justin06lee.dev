import * as React from "react";
import { cn } from "@/lib/utils";

export type SkeletonVariant = "block" | "text" | "circle";

export type SkeletonProps = {
  variant?: SkeletonVariant;
  /** Number of bars for `variant="text"`. The last one is shortened. */
  lines?: number;
  /** CSS width. Defaults to full width (or a square side for `circle`). */
  width?: string | number;
  /** CSS height. Defaults per variant. */
  height?: string | number;
  /** Turn off the shimmer for very large grids where the sweep gets noisy. */
  animate?: boolean;
  /**
   * Accessible label announced while loading. Defaults to "loading". Pass null
   * when a parent already owns the live region, so it isn't announced twice.
   */
  label?: string | null;
  className?: string;
};

const DEFAULT_HEIGHT: Record<SkeletonVariant, string> = {
  block: "1.5rem",
  text: "0.75rem",
  circle: "2.5rem",
};

/**
 * Loading placeholder.
 *
 * The shimmer ships as a hoisted <style> tag (React dedupes by href) rather
 * than a keyframe in globals.css, so the component stays self-contained the
 * way `progress` and `toast` do.
 *
 * Under reduced motion the sweep stops but the block stays visible — removing
 * the placeholder entirely would collapse the layout it exists to reserve.
 */
export function Skeleton({
  variant = "block",
  lines = 3,
  width,
  height,
  animate = true,
  label = "loading",
  className,
}: SkeletonProps) {
  const style: React.CSSProperties = {
    width: width ?? (variant === "circle" ? DEFAULT_HEIGHT.circle : "100%"),
    height: height ?? DEFAULT_HEIGHT[variant],
  };

  const bar = (extra?: string, overrides?: React.CSSProperties) => (
    <span
      className={cn(
        "block bg-white/[0.08]",
        animate && "chrome-skeleton-shimmer",
        variant === "circle" && "rounded-full",
        extra,
      )}
      style={{ ...style, ...overrides }}
    />
  );

  return (
    <span
      // aria-busy plus a single label: screen readers get one "loading" rather
      // than one per bar in a stack of them.
      role={label === null ? undefined : "status"}
      aria-busy
      aria-label={label ?? undefined}
      className={cn("block", variant === "text" && "flex flex-col gap-2", className)}
    >
      <style precedence="default" href="chrome-skeleton-keyframes">{`
        @keyframes chrome-skeleton-shimmer {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }
        .chrome-skeleton-shimmer {
          background-image: linear-gradient(
            90deg,
            rgba(255,255,255,0.04) 0%,
            rgba(255,255,255,0.12) 50%,
            rgba(255,255,255,0.04) 100%
          );
          background-size: 200% 100%;
          animation: chrome-skeleton-shimmer 1.6s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .chrome-skeleton-shimmer {
            animation: none;
            background-image: none;
          }
        }
      `}</style>

      {variant === "text"
        ? Array.from({ length: Math.max(1, lines) }, (_, i) =>
            // A ragged last line reads as prose rather than as a table cell.
            <React.Fragment key={i}>
              {bar(undefined, i === lines - 1 && lines > 1 ? { width: "62%" } : undefined)}
            </React.Fragment>,
          )
        : bar()}
    </span>
  );
}
