"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type ClockVariant = "analog" | "digital" | "both";

export type ClockProps = {
  /** Face to render. "both" stacks the analog face over the digital readout. */
  variant?: ClockVariant;
  /** IANA zone, e.g. "Asia/Seoul". Omit for the viewer's local zone. */
  timeZone?: string;
  /** Second hand + `:ss` in the readout. Defaults to true. */
  showSeconds?: boolean;
  /** 12-hour readout with an am/pm suffix. Defaults to false (24h). */
  hour12?: boolean;
  /** Analog face edge in px. The digital readout is sized by className. */
  size?: number;
  /** Hour tick marks around the face. Defaults to true. */
  ticks?: boolean;
  /**
   * Sweep the second hand continuously instead of stepping once a second.
   * Costs a rAF loop, so it's opt-in; ignored under prefers-reduced-motion.
   */
  sweep?: boolean;
  /** Zone abbreviation under the readout, e.g. "KST". */
  showZone?: boolean;
  /** CSS color for the second hand. Defaults to the muted white step. */
  accent?: string;
  className?: string;
};

type Hms = { h: number; m: number; s: number };

const ZERO: Hms = { h: 0, m: 0, s: 0 };

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Wall-clock hours/minutes/seconds in `timeZone`. Intl is the only way to do
 * this without a tz database — Date's getters are local-only. The locale is
 * pinned so the server and the browser parse identical parts.
 */
function readClock(fmt: Intl.DateTimeFormat, ms: number): Hms {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some ICU builds emit "24" for midnight under h23; fold it back to 0.
  return { h: get("hour") % 24, m: get("minute"), s: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

function formatDigital({ h, m, s }: Hms, hour12: boolean, showSeconds: boolean) {
  const hh = hour12 ? (h % 12 === 0 ? 12 : h % 12) : pad(h);
  const core = showSeconds
    ? `${hh}:${pad(m)}:${pad(s)}`
    : `${hh}:${pad(m)}`;
  return hour12 ? `${core} ${h < 12 ? "am" : "pm"}` : core;
}

const digitalClass: Record<ClockVariant, string> = {
  analog: "",
  digital: "text-2xl text-white",
  both: "text-sm text-white/70",
};

export function Clock({
  variant = "analog",
  timeZone,
  showSeconds = true,
  hour12 = false,
  size = 160,
  ticks = true,
  sweep = false,
  showZone = false,
  accent,
  className,
}: ClockProps) {
  // Null until mounted — seeding this with Date.now() would render one time on
  // the server and a different one at hydration. Until the first tick lands,
  // every face renders the stable midnight form.
  const [now, setNow] = useState<number | null>(null);

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    [timeZone],
  );

  const zoneFmt = useMemo(
    () =>
      showZone
        ? new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "numeric",
            timeZoneName: "short",
          })
        : null,
    [timeZone, showZone],
  );

  const smooth = sweep && variant !== "digital" && showSeconds;

  useEffect(() => {
    setNow(Date.now());

    if (smooth && !prefersReducedMotion()) {
      let raf = 0;
      const loop = () => {
        setNow(Date.now());
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }

    // Align the first tick to the next whole second so the hand steps with the
    // wall clock rather than drifting by however long hydration took.
    let interval: number | undefined;
    const timeout = window.setTimeout(
      () => {
        setNow(Date.now());
        interval = window.setInterval(() => setNow(Date.now()), 1000);
      },
      1000 - (Date.now() % 1000),
    );
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [smooth]);

  const time = now === null ? ZERO : readClock(timeFmt, now);
  const readout = formatDigital(time, hour12, showSeconds);

  const zone =
    zoneFmt
      ?.formatToParts(new Date(now ?? 0))
      .find((p) => p.type === "timeZoneName")?.value ?? null;

  // Fractional minutes/hours keep the small hands off the tick marks between
  // steps, which is what makes an analog face read as continuous.
  const secondAngle = (now === null ? 0 : (now % 1000) / 1000 + time.s) * 6;
  const minuteAngle = (time.m + time.s / 60) * 6;
  const hourAngle = ((time.h % 12) + time.m / 60) * 30;

  const face = (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="block overflow-visible"
    >
      <circle cx="50" cy="50" r="47" fill="none" strokeWidth="0.75" className="stroke-white/15" />
      {ticks &&
        Array.from({ length: 12 }, (_, i) => {
          const quarter = i % 3 === 0;
          return (
            <line
              key={i}
              x1="50"
              y1={quarter ? 8 : 11}
              x2="50"
              y2="15"
              strokeWidth={quarter ? 1.25 : 0.75}
              strokeLinecap="butt"
              className={quarter ? "stroke-white/40" : "stroke-white/20"}
              transform={`rotate(${i * 30} 50 50)`}
            />
          );
        })}
      <line
        x1="50"
        y1="50"
        x2="50"
        y2="26"
        strokeWidth="2"
        strokeLinecap="butt"
        className="stroke-white/70"
        transform={`rotate(${hourAngle} 50 50)`}
      />
      <line
        x1="50"
        y1="50"
        x2="50"
        y2="16"
        strokeWidth="1.25"
        strokeLinecap="butt"
        className="stroke-white"
        transform={`rotate(${minuteAngle} 50 50)`}
      />
      {showSeconds && (
        <line
          x1="50"
          y1="58"
          x2="50"
          y2="12"
          strokeWidth="0.6"
          strokeLinecap="butt"
          stroke={accent}
          className={accent ? undefined : "stroke-white/40"}
          transform={`rotate(${secondAngle} 50 50)`}
        />
      )}
      <circle cx="50" cy="50" r="1.5" className="fill-white" />
    </svg>
  );

  const digital = (
    <span className={cn("font-mono tabular-nums", digitalClass[variant])}>
      {readout}
    </span>
  );

  return (
    <div
      className={cn("inline-flex flex-col items-center gap-2 text-white", className)}
    >
      {variant !== "digital" && face}
      {variant !== "analog" && digital}
      {/* The face is decorative to a screen reader; the readout carries the time. */}
      {variant === "analog" && <span className="sr-only">{readout}</span>}
      {zone && (
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
          {zone}
        </span>
      )}
    </div>
  );
}
