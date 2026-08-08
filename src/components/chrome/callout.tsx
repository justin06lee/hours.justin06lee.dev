"use client";

import * as React from "react";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type CalloutVariant = "note" | "success" | "warn" | "danger";

export type CalloutProps = {
  variant?: CalloutVariant;
  /** Bold first line. Omit for a single-line callout. */
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Replaces the variant's default icon; pass null to drop it entirely. */
  icon?: LucideIcon | null;
  /** Adds a close button. Purely presentational — you own the visibility. */
  onDismiss?: () => void;
  /** Trailing slot under the copy, e.g. a retry button. */
  action?: React.ReactNode;
  className?: string;
};

const VARIANT: Record<
  CalloutVariant,
  { icon: LucideIcon; box: string; mark: string; role: "status" | "alert" | undefined }
> = {
  // Only danger and warn spend colour; the rest stay on the opacity ladder, so
  // a page full of notes doesn't turn into a traffic light.
  note: { icon: Info, box: "border-white/15 bg-white/[0.03]", mark: "text-white/40", role: undefined },
  success: { icon: CircleCheck, box: "border-white/20 bg-white/5", mark: "text-white/70", role: "status" },
  warn: {
    icon: TriangleAlert,
    box: "border-amber-400/40 bg-amber-400/[0.07]",
    mark: "text-amber-300/80",
    role: "status",
  },
  danger: {
    icon: CircleAlert,
    box: "border-red-400/60 bg-red-400/10",
    mark: "text-red-300",
    role: "alert",
  },
};

/**
 * Inline notice attached to the thing it's about — the counterpart to `toast`,
 * which interrupts from a corner and leaves. A callout stays put, so it suits
 * the standing caveats a form or a page needs to carry.
 *
 * `role` follows severity rather than being fixed: danger asserts, warn and
 * success announce politely, and a plain note says nothing at all, because a
 * page of decorative notes shouldn't flood the buffer.
 */
export function Callout({
  variant = "note",
  title,
  children,
  icon,
  onDismiss,
  action,
  className,
}: CalloutProps) {
  const config = VARIANT[variant];
  const Icon = icon === null ? null : (icon ?? config.icon);

  return (
    <div
      role={config.role}
      className={cn("flex items-start gap-3 border p-4", config.box, className)}
    >
      {Icon ? (
        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", config.mark)} strokeWidth={1.5} />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {title ? <p className="text-sm text-white">{title}</p> : null}
        {children ? (
          <div className="text-[13px] leading-relaxed text-white/60">{children}</div>
        ) : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>

      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="dismiss"
          className={cn(
            "-m-1 shrink-0 p-1 text-white/40 transition-colors hover:text-white",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
          )}
        >
          <X aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
      ) : null}
    </div>
  );
}
