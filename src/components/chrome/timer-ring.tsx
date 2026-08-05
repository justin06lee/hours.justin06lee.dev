"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type TimerRingProps = {
  /** Determinate value. Ignored when `endsAt` puts the ring in countdown mode. */
  value?: number;
  /** Upper bound for `value`. Defaults to 100. */
  max?: number;
  /** Countdown target. Setting it makes the ring tick itself once a second. */
  endsAt?: number | Date;
  /**
   * The 0% anchor for a countdown. Defaults to mount time, so a ring given only
   * `endsAt` starts empty and fills toward the deadline.
   */
  startedAt?: number | Date;
  /** Outer edge in px. Defaults to 128. */
  size?: number;
  /** Stroke width in px. Defaults to 2. */
  thickness?: number;
  /** CSS color for the progress arc. Defaults to white. */
  accent?: string;
  /**
   * Center slot. Defaults to the remaining time (countdown) or a percentage.
   * Pass `null` for a bare ring.
   */
  label?: React.ReactNode;
  /** Fired once when a countdown reaches `endsAt`. Re-arms if `endsAt` changes. */
  onComplete?: () => void;
  /** "drain" empties the arc as time runs out instead of filling it. */
  direction?: "fill" | "drain";
  ariaLabel?: string;
  className?: string;
};

const toMs = (v: number | Date | undefined) =>
  v === undefined ? undefined : v instanceof Date ? v.getTime() : v;

/** `mm:ss` under an hour, `h:mm:ss` above it. Clamped at zero. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Circular progress ring. Drives a single stroked circle with
 * stroke-dasharray/offset, either from a `value`/`max` pair or — in countdown
 * mode — from its own one-second clock running toward `endsAt`.
 */
export function TimerRing({
  value = 0,
  max = 100,
  endsAt,
  startedAt,
  size = 128,
  thickness = 2,
  accent = "#fff",
  label,
  onComplete,
  direction = "fill",
  ariaLabel,
  className,
}: TimerRingProps) {
  const endMs = toMs(endsAt);
  const explicitStart = toMs(startedAt);
  const countdown = endMs !== undefined;

  // Both null until mounted, so the server and the first client render agree
  // on the arc. Reads fall back to the start anchor, i.e. a ring that hasn't
  // moved yet.
  //
  // The anchor is state rather than a ref on purpose: it is read during render
  // to size the arc, and a ref read during render makes the output depend on
  // mutable data React isn't tracking — which tears under concurrent
  // rendering. `doneRef` below stays a ref because it is only ever touched
  // inside effects.
  const [now, setNow] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | undefined>(explicitStart);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!countdown) return;
    const t = Date.now();
    // The clock has to be seeded here rather than in the initializer: a
    // Date.now() read during render happens once on the server and again at
    // hydration, and the two never agree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnchor(explicitStart ?? t);
    doneRef.current = false;
    setNow(t);
    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      // Hosts commonly leave `endsAt` in place after the deadline fires, so
      // nothing else would ever tear this down — it would keep re-rendering an
      // unchanged 00:00 once a second for the life of the page.
      if (tick >= endMs) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [countdown, explicitStart, endMs]);

  const start = anchor ?? endMs ?? 0;
  const clock = now ?? start;

  useEffect(() => {
    if (!countdown || now === null || doneRef.current) return;
    if (now >= endMs) {
      doneRef.current = true;
      onComplete?.();
    }
  }, [countdown, now, endMs, onComplete]);

  const span = countdown ? endMs - start : 0;
  const remaining = countdown ? Math.max(0, endMs - clock) : 0;

  const fraction = countdown
    ? span > 0
      ? Math.min(1, Math.max(0, (clock - start) / span))
      : 1
    : max > 0
      ? Math.min(1, Math.max(0, value / max))
      : 0;

  const shown = direction === "drain" ? 1 - fraction : fraction;

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  // A countdown steps once a second, so the arc is interpolated across almost
  // the whole second to read as continuous motion; a controlled value gets a
  // short settle instead.
  //
  // Expressed as classes rather than an inline style so the reduced-motion
  // opt-out is `motion-reduce:transition-none` — a media query the browser
  // resolves. Reading matchMedia during render instead would make the server
  // (which always sees "no preference") disagree with a reduced-motion client
  // at hydration.
  const transitionClass = countdown
    ? "transition-[stroke-dashoffset] duration-[900ms] ease-linear motion-reduce:transition-none"
    : "transition-[stroke-dashoffset] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";

  const percent = Math.round(fraction * 100);
  const center =
    label !== undefined
      ? label
      : countdown
        ? formatRemaining(remaining)
        : `${percent}%`;

  // Hosts rarely pass a name, and an unnamed progressbar is announced as a
  // bare "progress bar" with no hint of what it is measuring.
  const name = ariaLabel ?? (countdown ? "countdown" : "progress");

  return (
    <div
      role="progressbar"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={countdown ? 100 : max}
      aria-valuenow={countdown ? percent : value}
      aria-valuetext={countdown ? `${formatRemaining(remaining)} remaining` : undefined}
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg aria-hidden width={size} height={size} className="block">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-white/10"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={accent}
          strokeWidth={thickness}
          strokeLinecap="butt"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - shown)}
          // Dash offsets start at 3 o'clock; rotate the arc's origin to 12.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className={transitionClass}
        />
      </svg>
      {center !== null && center !== undefined && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-mono text-sm tabular-nums text-white">{center}</span>
        </div>
      )}
    </div>
  );
}
