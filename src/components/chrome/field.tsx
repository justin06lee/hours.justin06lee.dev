"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type FieldControlProps = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: boolean | undefined;
};

export type FieldProps = {
  /** Label text. Pair with `labelHidden` when the control is self-describing. */
  label: React.ReactNode;
  /**
   * The control. Pass a function to receive the wiring — id, describedby,
   * invalid and required — already computed, so the label, hint and error are
   * announced without hand-matching ids at the call site.
   */
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
  /** Explicit id for the control; one is generated when omitted. */
  htmlFor?: string;
  /** Muted line under the control. Hidden while an error is showing. */
  hint?: React.ReactNode;
  /** Error text. Its presence is what marks the field invalid. */
  error?: React.ReactNode;
  /** Adds a marker to the label and sets `required` on the control. */
  required?: boolean;
  /** Renders a muted "optional" tag instead. Ignored when `required`. */
  optional?: boolean;
  /** Keeps the label for screen readers only. */
  labelHidden?: boolean;
  /** Trailing slot on the label row — a character counter, a "forgot?" link. */
  action?: React.ReactNode;
  className?: string;
};

/**
 * Label, control, hint and error as one accessible unit.
 *
 * The registry had inputs but nothing to wire them to their own description:
 * every call site was rebuilding `aria-describedby` by hand, and most of them
 * were quietly getting it wrong. The render-prop form makes the correct wiring
 * the path of least resistance.
 *
 * Hint and error never show together — an error replaces the hint rather than
 * stacking under it, so the message that needs acting on is the only one in
 * the slot.
 */
export function Field({
  label,
  children,
  htmlFor,
  hint,
  error,
  required,
  optional,
  labelHidden = false,
  action,
  className,
}: FieldProps) {
  const generatedId = React.useId();
  const id = htmlFor ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const showError = Boolean(error);
  const showHint = Boolean(hint) && !showError;

  const describedBy =
    [showError ? errorId : null, showHint ? hintId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const controlProps: FieldControlProps = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": showError ? true : undefined,
    required: required || undefined,
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-3",
          labelHidden && "sr-only",
        )}
      >
        <label htmlFor={id} className="text-sm text-white/70">
          {label}
          {required ? (
            <span aria-hidden className="ml-1 text-white/40">
              *
            </span>
          ) : optional ? (
            <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/30">
              optional
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </label>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      {typeof children === "function" ? children(controlProps) : children}

      {showError ? (
        // Errors arrive after a submit the user is watching, so they announce
        // themselves; hints are static and must not.
        <p id={errorId} role="alert" className="text-[13px] text-red-300">
          {error}
        </p>
      ) : showHint ? (
        <p id={hintId} className="text-[13px] leading-relaxed text-white/40">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
