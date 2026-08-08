"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Everything `aria-modal` claims and nothing implements for free: focus moves
 * in on open and back out on close, Tab is trapped, Escape dismisses, a press
 * that starts on the backdrop dismisses, and the page behind stops scrolling.
 *
 * This exists because the track console had all of it hand-rolled inline, and
 * the journal's editor needed the same thing. Two hand-rolled focus traps in
 * one codebase is one more than can be kept in agreement — the second copy is
 * where the `mousedown` subtlety below gets forgotten, and a forgotten focus
 * trap fails silently for exactly the users who depend on it.
 *
 * `chrome/dialog.tsx` is deliberately not what this is. That one is a
 * confirm/alert *provider* with its own fixed body; this is a container for an
 * arbitrary form. Both exist, and the delete confirmation on the journal uses
 * the other one.
 */
export function ModalPanel({
  open,
  onClose,
  labelledBy,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  /** id of the element naming this dialog, for aria-labelledby. */
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Element focused before the dialog opened, restored on close.
  const returnFocus = useRef<HTMLElement | null>(null);

  // Latest-callback ref so the key handler subscribes once per opening rather
  // than once per render — callers routinely pass a fresh closure. Synced in an
  // effect because a ref cannot be mutated during render, and the handler that
  // reads it only runs after commit.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables && focusables.length > 0 ? focusables[0] : panel)?.focus();
    return () => {
      returnFocus.current?.focus();
      returnFocus.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
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
  }, [open]);

  // Restore the previous value rather than clearing it, so a lock held by
  // something outer survives ours.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      // mousedown, not click: a drag that starts inside the panel and ends on
      // the backdrop (selecting text in a textarea) fires click here, and
      // losing what was typed to that is exactly the wrong outcome.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "max-h-[85dvh] w-full max-w-lg overflow-y-auto border border-white/20 bg-[#0a0a0a] p-6",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** What counts as focusable for the trap above. */
export const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
