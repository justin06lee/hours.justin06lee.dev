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
  return intervals.reduce((sum, i) => {
    // Guard `start` the same way mergeIntervals does. `Math.max(0, NaN)` is
    // NaN, so an unguarded start let one corrupt row turn the whole sum — and
    // every figure derived from it — into NaN. A non-finite `end` still means
    // "no measurable duration" rather than "drop the row", which is what a
    // still-running entry looks like here.
    if (!Number.isFinite(i.start)) return sum;
    return sum + Math.max(0, (Number.isFinite(i.end) ? i.end : i.start) - i.start);
  }, 0);
}

/**
 * Upper bound on the segments one span may produce, ~27 years of days. Well
 * past any span a human could plausibly log, but high enough that a timer left
 * running for a year or two is still split in full rather than truncated. The
 * bound exists only so a corrupt row (an end far in the future, or a clock
 * skew) can't pin a request; hitting it is a bug, and says so out loud.
 */
const MAX_DAY_SEGMENTS = 10_000;

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
  let guard = 0;
  while (cursor < span.end && guard++ < MAX_DAY_SEGMENTS) {
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
    // The ladder used to stop here and round up a whole minute, which lands the
    // split at `start + n·60000` rather than at midnight: a span opened at
    // 23:00:37 local cut the day at 00:00:37, crediting 37 seconds of the new
    // day to the old one. Binary-search the residual minute instead of adding
    // 1s/1ms rungs — a 1ms rung would cost up to 1000 Intl lookups per segment,
    // this costs a fixed ~16 and still lands on the exact millisecond.
    let lo = edge; // known to still read `date`
    let hi = Math.min(span.end, edge + 60_000); // span.end, or the first instant that doesn't
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (epochToDateInTz(mid, timezone) === date) lo = mid;
      else hi = mid;
    }
    const segmentEnd = Math.min(span.end, lo + 1);
    if (segmentEnd > cursor) out.push({ date, start: cursor, end: segmentEnd });
    cursor = segmentEnd;
  }
  // Truncation silently loses time — the heatmap and the headline total (which
  // doesn't route through here) then disagree with nothing to explain why. Warn
  // rather than throw: one bad row must not take the whole page down.
  if (cursor < span.end) {
    console.warn(
      `splitByDay: span ${span.start}–${span.end} exceeds ${MAX_DAY_SEGMENTS} day segments; ` +
        `truncated at ${cursor} (${epochToDateInTz(cursor, timezone)}). ` +
        `Daily totals for this entry are incomplete.`,
    );
  }
  return out;
}

/**
 * Per-day union ms for a set of intervals, keyed "YYYY-MM-DD" in the given zone.
 *
 * Every heatmap on the site is produced by this one function — the site-wide
 * one and the per-subject one — so the two cannot disagree about what a day is
 * worth. Spans are split at local midnight first, then unioned *within* each
 * day, which is the pair of rules that makes a cell honest: a 23:00–01:00
 * session lands on both days rather than dumping its whole duration on the day
 * it started, and two parallel lanes on one afternoon don't paint that day
 * twice as dense as it was.
 */
export function dailyUnion(
  intervals: readonly Interval[],
  timezone: string,
): Record<string, number> {
  const perDay = new Map<string, Interval[]>();
  for (const interval of intervals) {
    for (const seg of splitByDay(interval, timezone)) {
      if (!perDay.has(seg.date)) perDay.set(seg.date, []);
      perDay.get(seg.date)!.push({ start: seg.start, end: seg.end });
    }
  }
  const daily: Record<string, number> = {};
  for (const [date, spans] of perDay) daily[date] = unionMs(spans);
  return daily;
}

/**
 * Every calendar year with time actually logged in it, newest first.
 *
 * Drives the heatmap's year switcher, so the rule it encodes is "offer a year
 * only if there is something to see there". Days present in the map but worth
 * zero don't qualify — `splitByDay` can emit a zero-length segment at a
 * boundary, and a year offered for one of those would open on an empty grid.
 */
export function activeYears(daily: Record<string, number>): number[] {
  const years = new Set<number>();
  for (const [date, ms] of Object.entries(daily)) {
    if (ms > 0) years.add(Number(date.slice(0, 4)));
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Which year a heatmap should show, given what the URL asked for.
 *
 * The rule is "the newest year with data, unless the reader asked for another
 * one that also has data". A `?year=` naming a year with nothing in it — a typo,
 * an old link, a hand-edit — falls back rather than rendering an empty grid the
 * reader has no way to interpret. `fallback` covers the site with no entries at
 * all, where there is no newest year to fall back to.
 */
export function resolveYear(
  requested: string | undefined,
  years: readonly number[],
  fallback: number,
): number {
  const newest = years.length > 0 ? years[0] : fallback;
  if (requested === undefined) return newest;
  // Deliberately strict: `Number("2026abc")` is NaN, but `parseInt` would
  // happily read 2026 out of it, and a URL that half-parses is a URL that
  // silently disagrees with the link that produced it.
  const asked = /^\d{4}$/.test(requested) ? Number(requested) : NaN;
  return years.includes(asked) ? asked : newest;
}

/**
 * The days of one calendar year, out of a map spanning all of them.
 *
 * Kept separate from the intensity ceiling on purpose. The heatmap scales its
 * shading against the busiest day it is given, so slicing the values without
 * pinning `max` would renormalize every year to its own maximum — a quiet year
 * would render exactly as dark as a relentless one, and the grid would stop
 * meaning anything across years. Callers pass this as `values` and the
 * all-years maximum as `max`.
 */
export function yearValues(
  daily: Record<string, number>,
  year: number,
): Record<string, number> {
  const prefix = `${year}-`;
  const out: Record<string, number> = {};
  for (const [date, value] of Object.entries(daily)) {
    if (date.startsWith(prefix)) out[date] = value;
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

/** Formats ms as a compact hours label: `384.8h`, `42m`. Negatives clamp to 0. */
export function formatHours(ms: number): string {
  // Clamp first: a negative duration is a data error, and "-30m" on the page
  // reads as a real measurement rather than as the bug it is.
  const safe = Math.max(0, ms);
  // Round to minutes *before* choosing the unit. Gating on `hours >= 1` first
  // meant 59.5–59.99 min failed the hour test, then rounded up to a label of
  // "60m" — a value the minutes format can never legitimately produce.
  const minutes = Math.round(safe / 60_000);
  if (minutes >= 60) return `${(safe / MS_PER_HOUR).toFixed(1)}h`;
  return `${minutes}m`;
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

/** Characters of id-derived hash appended when two names slug to the same thing. */
const SLUG_SUFFIX_LEN = 6;

/** Stands in for the base slug when a name has no ASCII alphanumerics at all. */
const SLUG_EMPTY_BASE = "subject";

/**
 * Deterministic, id-derived entropy for disambiguating slugs: two 32-bit FNV-1a
 * passes with different multipliers, each rendered base36 and zero-padded to a
 * fixed 7 characters so that taking the first N characters is stable regardless
 * of the numeric value. Hashing rather than slicing the id keeps this correct
 * for any id shape — UUIDs today, anything tomorrow — and gives ~2 billion
 * distinct 6-character suffixes, so a suffix clash between two real categories
 * is not something that happens.
 */
function slugHash(id: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return (a >>> 0).toString(36).padStart(7, "0") + (b >>> 0).toString(36).padStart(7, "0");
}

/**
 * One collision-free slug per entry, in input order.
 *
 * `slugify` alone is not injective — "C++" and "C#" both become "c", and
 * "Machine Learning" and "machine-learning" both become "machine-learning" —
 * so a page that resolves a subject by scanning for the first matching slug
 * serves one category's numbers under another category's name, and leaves the
 * loser permanently unreachable. The database's UNIQUE(LOWER(name)) index
 * cannot help: the names differ, it is the slugs that don't.
 *
 * The first entry to claim a base slug keeps it bare, so the overwhelmingly
 * common no-collision case produces exactly the URLs it always has and no
 * existing link breaks. Losers get a suffix derived from their own **id**, not
 * from a counter: a counter would make a subject's URL a function of which
 * *other* subjects exist and how they happen to sort, so renaming an unrelated
 * category — or merely logging enough hours against it to move it up the
 * ms-ordered list — would silently rewrite this subject's URL and 404 every
 * inbound link to it. Keyed on the id, a URL changes only when that subject's
 * own name changes, which is the one time a reader would expect it to.
 *
 * A suffixed slug can still collide with something else in the set — a real
 * category could legitimately be named "C c1a2b3", and two entries whose names
 * both slug to "" would otherwise both land on the same fallback. So suffixed
 * candidates are checked against everything already claimed and lengthened, one
 * hash character at a time, until one is free; the full 14-character hash is
 * the last rung and is unique per id for any input this site will ever hold.
 *
 * An entry with a null id is the uncategorized bucket. It is never linked and
 * must never be resolvable, so it gets "" and takes part in no claim — that
 * also stops it from stealing the base slug from a real category that happens
 * to be named "uncategorized".
 */
export function uniqueSlugs(entries: readonly { id: string | null; name: string }[]): string[] {
  const out: string[] = new Array(entries.length).fill("");
  const bases = entries.map((e) => (e.id === null ? "" : slugify(e.name)));
  const taken = new Set<string>();

  // First pass over the whole list before any suffixing, so a later entry's
  // collision can never displace an earlier entry's bare slug.
  for (let i = 0; i < entries.length; i++) {
    const base = bases[i];
    if (entries[i].id === null || base === "" || taken.has(base)) continue;
    taken.add(base);
    out[i] = base;
  }

  for (let i = 0; i < entries.length; i++) {
    const id = entries[i].id;
    if (id === null || out[i] !== "") continue;
    const base = bases[i] || SLUG_EMPTY_BASE;
    const hash = slugHash(id);
    let slug = "";
    for (let len = SLUG_SUFFIX_LEN; len <= hash.length; len++) {
      const candidate = `${base}-${hash.slice(0, len)}`;
      if (!taken.has(candidate)) {
        slug = candidate;
        break;
      }
    }
    // Unreachable short of two entries sharing an id: every rung above was
    // taken. Keep extending rather than throw — an ugly URL beats a dead page.
    while (slug === "" || taken.has(slug)) slug = `${slug || `${base}-${hash}`}-${hash}`;
    taken.add(slug);
    out[i] = slug;
  }

  return out;
}
