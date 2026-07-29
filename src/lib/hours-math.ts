/**
 * Pure time arithmetic for the hours site. Deliberately free of any database
 * or environment coupling so the interval math — the part that decides whether
 * the numbers on the site are honest — can be tested on its own.
 *
 * The rule these functions encode: **per-subject totals count overlapping time
 * in full, but the site-wide total counts it once.** An hour spent coding while
 * a chess game runs is a real hour of each subject, so neither is docked for
 * the other; but summing those subject totals would claim more hours than have
 * actually elapsed, so the headline figure unions the intervals first.
 *
 * Both numbers are honest, they answer different questions. Label them wherever
 * they appear together.
 */

import { addDays, epochToDateInTz } from "@/lib/calendar-dates";

export const MS_PER_HOUR = 3_600_000;

export type Interval = { start: number; end: number };

/**
 * Merge overlapping/touching intervals into a disjoint, ascending set.
 * Pure and total: safe on empty input, unsorted input, and zero-length spans.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const valid = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  if (valid.length === 0) return [];

  const merged: Interval[] = [{ ...valid[0] }];
  for (let i = 1; i < valid.length; i++) {
    const cur = valid[i];
    const last = merged[merged.length - 1];
    // `<=` so back-to-back segments (one ends exactly where the next starts,
    // which is what the break-alarm produces) collapse into one span instead
    // of being counted as two abutting blocks.
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Total covered time of a set of intervals, counting overlap once. */
export function unionMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Total time of a set of intervals, counting overlap in full. */
export function rawMs(intervals: readonly Interval[]): number {
  return intervals.reduce(
    (sum, i) => sum + Math.max(0, (Number.isFinite(i.end) ? i.end : i.start) - i.start),
    0,
  );
}

/**
 * Splits a span across day boundaries in the given timezone, so a session
 * running 23:00–01:00 contributes to both days rather than dumping its whole
 * duration onto the day it started.
 */
export function splitByDay(
  span: Interval,
  timezone: string,
): { date: string; start: number; end: number }[] {
  const out: { date: string; start: number; end: number }[] = [];
  let cursor = span.start;
  // Bounded so a corrupt row with an absurd span can't spin here. 400 segments
  // is far past any real session.
  let guard = 0;
  while (cursor < span.end && guard++ < 400) {
    const date = epochToDateInTz(cursor, timezone);
    // Walk to the instant the date string flips: coarse hour steps first, then
    // minute steps to land on the boundary. Stepping beats computing midnight
    // arithmetically because it inherits DST handling from epochToDateInTz.
    let edge = cursor;
    for (const step of [3_600_000, 60_000]) {
      while (edge + step < span.end && epochToDateInTz(edge + step, timezone) === date) {
        edge += step;
      }
    }
    const segmentEnd = Math.min(span.end, edge + 60_000);
    if (segmentEnd > cursor) out.push({ date, start: cursor, end: segmentEnd });
    cursor = segmentEnd;
  }
  return out;
}

export type StreakSummary = {
  current: number;
  best: number;
  /** One boolean per day over the trailing window, most recent LAST. */
  days: boolean[];
};

/**
 * Current and best runs of consecutive active days.
 *
 * A day with no activity yet does not break the current streak while it is
 * still that day — the day isn't over. So the walk starts at today when today
 * is active and at yesterday otherwise; a streak only truly breaks once a full
 * day has passed with nothing logged.
 */
export function computeStreak(
  activeDates: ReadonlySet<string>,
  today: string,
  window = 14,
): StreakSummary {
  let cursor = activeDates.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (activeDates.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  // Best run over all history: walk the sorted dates and count consecutive
  // neighbours. Sorting lexicographically is correct for YYYY-MM-DD.
  const sorted = [...activeDates].sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && sorted[i] === addDays(sorted[i - 1], 1) ? run + 1 : 1;
    if (run > best) best = run;
  }

  const days: boolean[] = [];
  for (let i = window - 1; i >= 0; i--) days.push(activeDates.has(addDays(today, -i)));

  return { current, best: Math.max(best, current), days };
}

/** Formats ms as a compact hours label: `384.8h`, `42m`. */
export function formatHours(ms: number): string {
  const hours = ms / MS_PER_HOUR;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/** Formats ms as `1h 2m` / `2m 3s` / `4s`, matching now-playing-bar. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** URL-safe slug for a category name, used for /s/[subject]. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
