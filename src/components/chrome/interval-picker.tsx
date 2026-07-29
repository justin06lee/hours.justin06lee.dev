"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export type IntervalPickerProps = {
  /** Current interval, in minutes. */
  value: number;
  /** Fired with the new interval in minutes, already clamped to min/max. */
  onChange: (minutes: number) => void;
  /** Quick-pick values in minutes. Defaults to [15, 25, 50, 90]. */
  presets?: number[];
  /** Lower bound in minutes. Defaults to 1. */
  min?: number;
  /** Upper bound in minutes. Defaults to 240. */
  max?: number;
  /** Amount the steppers and arrow keys move by. Defaults to 5. */
  step?: number;
  /** Unit shown after the custom value. Defaults to "min". */
  unit?: string;
  /** Group caption. Defaults to "interval". Pass null to drop it. */
  label?: React.ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
};

const DEFAULT_PRESETS = [15, 25, 50, 90];

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/**
 * Duration picker for "every N minutes" settings: a row of quick presets plus a
 * stepper for anything in between. Always emits a plain minute count so callers
 * never have to parse a unit back out.
 */
export function IntervalPicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  min = 1,
  max = 240,
  step = 5,
  unit = "min",
  label = "interval",
  disabled = false,
  ariaLabel,
  className,
}: IntervalPickerProps) {
  // While typing, the field holds a raw draft so a half-entered "1" isn't
  // snapped up to `min` mid-keystroke. Committed on blur or Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const selected = presets.indexOf(value);
  const shown = draft ?? String(value);

  const commit = (n: number) => {
    if (disabled) return;
    onChange(clamp(Math.round(n), min, max));
  };

  const move = (dir: 1 | -1) => {
    if (presets.length === 0) return;
    const from = selected === -1 ? (dir === 1 ? -1 : presets.length) : selected;
    const next = (from + dir + presets.length) % presets.length;
    const target = presets[next];
    if (target !== undefined) {
      commit(target);
      refs.current[next]?.focus();
    }
  };

  const onPresetKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setDraft(null);
      commit(value + (e.key === "ArrowUp" ? step : -step));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const parsed = Number(shown);
      setDraft(null);
      if (Number.isFinite(parsed)) commit(parsed);
    }
  };

  return (
    <div className={cn("inline-flex flex-col gap-2", className)}>
      {label !== null && label !== undefined && (
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
          {label}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Roving tabindex: the group is one tab stop and arrows move between
            presets, so the stepper stays two keystrokes away. */}
        <div
          role="radiogroup"
          aria-label={ariaLabel ?? "interval presets"}
          onKeyDown={onPresetKeyDown}
          className="flex flex-wrap items-center gap-1"
        >
          {presets.map((preset, i) => {
            const active = preset === value;
            return (
              <button
                key={preset}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active || (selected === -1 && i === 0) ? 0 : -1}
                disabled={disabled}
                onClick={() => commit(preset)}
                className={cn(
                  "border px-2.5 py-1 text-xs tabular-nums transition-colors",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer",
                  active
                    ? "border-white/40 text-white"
                    : "border-white/10 text-white/50 hover:text-white/80",
                )}
              >
                {preset}
              </button>
            );
          })}
        </div>

        <div
          className={cn(
            "inline-flex items-stretch border border-white/20",
            disabled && "opacity-50",
          )}
        >
          <button
            type="button"
            aria-label={`decrease by ${step} ${unit}`}
            disabled={disabled || value <= min}
            onClick={() => commit(value - step)}
            className="flex w-7 items-center justify-center border-r border-white/20 text-white/60 transition-colors hover:bg-white/5 hover:text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <Minus size={13} aria-hidden />
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={shown}
            disabled={disabled}
            aria-label={`custom interval in ${unit}`}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^\d]/g, "");
              setDraft(raw);
              const parsed = Number(raw);
              // Live-commit only once the draft is already in range; otherwise
              // wait for blur so clamping never fights the typist.
              if (raw !== "" && parsed >= min && parsed <= max) onChange(parsed);
            }}
            onKeyDown={onInputKeyDown}
            onBlur={() => {
              const parsed = Number(shown);
              setDraft(null);
              if (shown !== "" && Number.isFinite(parsed)) commit(parsed);
            }}
            className="w-10 bg-transparent py-1 text-center text-sm tabular-nums text-white focus:outline-none"
          />
          <span className="flex items-center pr-2 text-xs text-white/40">{unit}</span>
          <button
            type="button"
            aria-label={`increase by ${step} ${unit}`}
            disabled={disabled || value >= max}
            onClick={() => commit(value + step)}
            className="flex w-7 items-center justify-center border-l border-white/20 text-white/60 transition-colors hover:bg-white/5 hover:text-white disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus size={13} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
