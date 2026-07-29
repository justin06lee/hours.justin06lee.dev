"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as motion from "motion/react-client";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { Plus, SkipForward, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export type BreakOverlayProps = {
  /** Whether the rest screen is showing. */
  open: boolean;
  /**
   * Absolute end of the break. Wins over `seconds` — pass this when the break
   * is persisted somewhere and must survive a remount at the right offset.
   */
  endsAt?: number | Date;
  /** Break length in seconds, counted from the moment it opens. */
  seconds?: number;
  /** Heading above the countdown. Defaults to "break time". */
  title?: string;
  /** Optional line under the countdown — what to actually do with the break. */
  message?: React.ReactNode;
  /** Small mono label above the heading. Defaults to "break". */
  label?: string;
  /** Called when the user ends the break early. Also fires on escape when dismissible. */
  onResume?: () => void;
  /** Called when the user skips the break outright. */
  onSkip?: () => void;
  /** Called with the added seconds when the user extends the break. */
  onExtend?: (seconds: number) => void;
  /** How much `extend` adds, in seconds. Defaults to 300 (5 minutes). */
  extendBy?: number;
  /** Called once, when the countdown reaches zero on its own. */
  onComplete?: () => void;
  /** Allow escape to close the overlay (resolving as resume). Defaults to false. */
  dismissible?: boolean;
  /**
   * "viewport" covers the window (default). "container" covers the nearest
   * positioned ancestor instead, for embedding the rest screen in a panel.
   */
  anchor?: "viewport" | "container";
  /** Extra classes for the overlay. */
  className?: string;
};

/** `12:34`, widening to `1:02:03` once a break runs past the hour. */
function formatCountdown(totalSec: number): string {
  const safe = Math.max(0, totalSec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, "0")}`
    : `${mm}:${String(s).padStart(2, "0")}`;
}

/** Label for the extend button — minutes once it's worth a minute, else seconds. */
function formatExtend(sec: number): string {
  return sec >= 60 ? `${Math.round(sec / 60)}m more` : `${sec}s more`;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen rest overlay: a large live countdown of the remaining break with
 * resume / skip / extend actions. Unlike a splash, this one recurs and keeps
 * counting, so the deadline is state rather than a fixed timeline.
 *
 * By default it is *not* escapable — the whole point of a forced break is that
 * it is mildly inconvenient to dismiss. Set `dismissible` when the break is
 * advisory and the user should be able to wave it away.
 */
export function BreakOverlay({
  open,
  endsAt,
  seconds,
  title = "break time",
  message,
  label = "break",
  onResume,
  onSkip,
  onExtend,
  extendBy = 300,
  onComplete,
  dismissible = false,
  anchor = "viewport",
  className,
}: BreakOverlayProps) {
  const endsAtMs =
    endsAt === undefined
      ? undefined
      : endsAt instanceof Date
        ? endsAt.getTime()
        : endsAt;

  // The deadline is state, not a prop derivative, because `extend` moves it and
  // a `seconds` break has no anchor until the overlay actually opens.
  const [deadline, setDeadline] = useState<number | null>(null);
  // Null until mounted — seeding with Date.now() would disagree between the
  // server render and hydration. Until then the countdown shows a stable form.
  const [now, setNow] = useState<number | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  // Element focused before the overlay opened, restored on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const titleId = useId();

  const reduceMotion = useReducedMotion();

  // Anchor the break when it opens; clear it on close so the next break starts
  // from a clean slate rather than resuming a stale deadline.
  useEffect(() => {
    if (!open) {
      setDeadline(null);
      completedRef.current = false;
      return;
    }
    if (endsAtMs !== undefined) {
      setDeadline(endsAtMs);
      return;
    }
    if (seconds !== undefined) setDeadline(Date.now() + seconds * 1000);
  }, [open, endsAtMs, seconds]);

  // One second tick, alive only while the overlay is.
  useEffect(() => {
    if (!open) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const remaining =
    deadline === null || now === null
      ? seconds !== undefined
        ? seconds
        : null
      : Math.max(0, Math.ceil((deadline - now) / 1000));

  // Fire onComplete exactly once per break, from an effect rather than during
  // render so the parent can unmount us in the handler.
  useEffect(() => {
    if (!open || deadline === null || now === null) return;
    if (now < deadline || completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current?.();
  }, [open, deadline, now]);

  const extend = useCallback(() => {
    setDeadline((prev) => (prev ?? Date.now()) + extendBy * 1000);
    // Extending un-finishes the break, so the next zero-crossing counts again.
    completedRef.current = false;
    onExtend?.(extendBy);
  }, [extendBy, onExtend]);

  // Capture focus on open, hand it back on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables && focusables.length > 0 ? focusables[0] : panel)?.focus();
    return () => {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [open]);

  // Tab focus trap, plus escape when the break is advisory.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissible) {
        e.preventDefault();
        onResume?.();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last?.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissible, onResume]);

  // Body scroll lock — restore the previous value rather than clearing it, so
  // an outer overlay's lock survives ours.
  useEffect(() => {
    if (!open || anchor !== "viewport") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, anchor]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.01 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.01 }}
          transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          className={cn(
            "inset-0 z-[95] flex items-center justify-center bg-black px-6",
            anchor === "viewport" ? "fixed" : "absolute",
            className,
          )}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="flex w-full max-w-md flex-col items-center gap-6 border border-white/10 bg-[#0a0a0a] px-8 py-10 text-center"
          >
            <div className="space-y-3">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
                {label}
              </div>
              <div id={titleId} className="text-sm text-white/70">
                {title}
              </div>
            </div>

            {/* role="timer" with the live region off: announcing a new value
                every second would bury everything else a screen reader says. */}
            <div
              role="timer"
              aria-live="off"
              className="font-mono text-6xl leading-none tracking-tight text-white tabular-nums sm:text-7xl"
            >
              {remaining === null ? "--:--" : formatCountdown(remaining)}
            </div>

            {message && (
              <div className="max-w-xs text-xs leading-relaxed text-white/55">{message}</div>
            )}

            {(onResume || onSkip || onExtend) && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {onResume && (
                  <button
                    type="button"
                    onClick={onResume}
                    className="inline-flex items-center gap-2 border border-white/40 px-3 py-1.5 text-xs text-white transition hover:bg-white hover:text-black"
                  >
                    <Play aria-hidden className="size-3.5" />
                    resume now
                  </button>
                )}
                {onExtend && (
                  <button
                    type="button"
                    onClick={extend}
                    className="inline-flex items-center gap-2 border border-white/20 px-3 py-1.5 text-xs text-white/70 transition hover:border-white/40 hover:text-white"
                  >
                    <Plus aria-hidden className="size-3.5" />
                    {formatExtend(extendBy)}
                  </button>
                )}
                {onSkip && (
                  <button
                    type="button"
                    onClick={onSkip}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-xs text-white/40 transition hover:text-white"
                  >
                    <SkipForward aria-hidden className="size-3.5" />
                    skip
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
