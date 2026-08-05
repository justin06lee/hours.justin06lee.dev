"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};
type AlertOptions = { title: string; message?: string; okText?: string };

type DialogState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; options: AlertOptions; resolve: () => void }
  | null;

type DialogContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  alert: (options: AlertOptions) => Promise<void>;
};

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}

// Subtle entrance — just enough to avoid a hard flicker, not a showy animation.
const DIALOG_KEYFRAMES = `@keyframes chrome-dialog-overlay {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes chrome-dialog-panel {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}`;

// Opening a dialog over a pending one replaces its state — settle the stranded
// promise first (a superseded confirm resolves false) so callers never hang.
function settleStranded(prev: DialogState) {
  if (!prev) return;
  if (prev.kind === "confirm") prev.resolve(false);
  else prev.resolve();
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  // The live entry mirrored outside React state. Settling a promise is an
  // observable side effect, and React re-runs or discards setState updaters
  // (StrictMode, an interrupted concurrent render) — so the stranded confirm
  // is settled here, from the caller, where it happens exactly once.
  const pendingRef = useRef<DialogState>(null);
  const openDialog = useCallback((next: NonNullable<DialogState>) => {
    settleStranded(pendingRef.current);
    pendingRef.current = next;
    setState(next);
  }, []);
  // A provider unmounting mid-dialog would otherwise leave the caller awaiting
  // a promise nobody can resolve.
  useEffect(
    () => () => {
      settleStranded(pendingRef.current);
      pendingRef.current = null;
    },
    [],
  );
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        openDialog({ kind: "confirm", options, resolve }),
      ),
    [openDialog],
  );
  const alert = useCallback(
    (options: AlertOptions) =>
      new Promise<void>((resolve) => openDialog({ kind: "alert", options, resolve })),
    [openDialog],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // Element focused before the dialog opened, restored on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const close = useCallback((resolved: boolean) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    if (pending.kind === "confirm") pending.resolve(resolved);
    else pending.resolve();
    setState(null);
  }, []);

  const isDanger = state?.kind === "confirm" && state.options.danger === true;
  const titleId = useId();

  // Capture the previously focused element and move focus into the dialog.
  // Danger confirms default to Cancel so Enter can't instantly confirm a
  // destructive action; everything else defaults to the confirm/OK button.
  useEffect(() => {
    if (!state) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = isDanger ? cancelBtnRef.current : confirmBtnRef.current;
    target?.focus();
    return () => {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [state, isDanger]);

  // Lock body scroll while a dialog is open.
  useEffect(() => {
    if (!state) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state]);

  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Stop the press from also reaching a dropdown/select listening beneath
        // the modal, which would otherwise close both at once.
        e.preventDefault();
        close(false);
        return;
      }
      // Focus trap: keep Tab/Shift+Tab cycling within the dialog's focusables.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
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
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, close]);

  return (
    <DialogContext.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <>
          <style precedence="default" href="chrome-dialog-keyframes">
            {DIALOG_KEYFRAMES}
          </style>
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
            style={{ animation: "chrome-dialog-overlay 120ms ease-out" }}
            // Dismiss on a press that starts on the backdrop itself. Closing on
            // click instead let a drag that began inside the panel — selecting
            // the message text — dismiss the dialog when the pointer came up
            // out here. Escape (below) is the keyboard path.
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close(false);
            }}
          >
            <div
              ref={panelRef}
              className="w-full max-w-sm border border-white/20 bg-black p-5 space-y-4"
              style={{ animation: "chrome-dialog-panel 150ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
            <div className="space-y-2">
              <div className="text-xs font-mono uppercase tracking-widest text-white/50">
                {state.kind === "confirm" ? "Confirm" : "Notice"}
              </div>
              <div id={titleId} className="text-sm text-white">{state.options.title}</div>
              {state.options.message && (
                <div className="text-xs text-white/60 whitespace-pre-line">{state.options.message}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              {state.kind === "confirm" && (
                <button ref={cancelBtnRef} type="button" onClick={() => close(false)} className="text-xs text-white/60 hover:text-white px-3 py-1">
                  {state.options.cancelText ?? "Cancel"}
                </button>
              )}
              <button
                ref={confirmBtnRef}
                type="button"
                onClick={() => close(true)}
                className={`text-xs border px-3 py-1 transition ${
                  state.kind === "confirm" && state.options.danger
                    ? "border-red-400/60 text-red-300 hover:bg-red-400/10"
                    : "border-white/40 hover:bg-white hover:text-black"
                }`}
              >
                {state.kind === "confirm" ? state.options.confirmText ?? "OK" : state.options.okText ?? "OK"}
              </button>
            </div>
          </div>
          </div>
        </>
      )}
    </DialogContext.Provider>
  );
}
