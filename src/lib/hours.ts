/**
 * Database-facing aggregation over `calendar_actuals`. The arithmetic lives in
 * hours-math.ts; this module only loads rows and applies it.
 */

import { cache } from "react";
import { db, initDb } from "@/lib/db";
import type { DbCalendarActual, DbCalendarCategory } from "@/lib/db";
import { CATEGORY_LIST_SQL, rowToCategory } from "@/lib/calendar-categories";
import { SITE_CONFIG_SQL, parseSiteConfigRows, resolveTimezone } from "@/lib/site-config";
import { type Interval, splitByDay, unionMs } from "@/lib/hours-math";

// Re-exported so callers have one import for "everything hours".
export * from "@/lib/hours-math";

export type HoursEntry = {
  id: string;
  categoryId: string | null;
  title: string | null;
  startAt: number;
  /** Running entries are clamped to "now" so live time is reflected. */
  endAt: number;
  /** True when this entry is still running. */
  running: boolean;
  track: number;
  date: string;
};

export type Subject = {
  id: string | null;
  name: string;
  color: string;
  archived: boolean;
  /** Full time, overlap included. */
  ms: number;
  entries: number;
  firstAt: number | null;
  lastAt: number | null;
};

export type HoursOverview = {
  /** Overlap counted once — never exceeds elapsed wall-clock time. */
  totalMs: number;
  /** Sum of every subject; exceeds totalMs by however much was done in parallel. */
  totalRawMs: number;
  /** totalRawMs - totalMs: time that was genuinely doubled up. */
  parallelMs: number;
  subjects: Subject[];
  /** Per-day union ms, keyed "YYYY-MM-DD", for the heatmap. */
  daily: Record<string, number>;
  entries: HoursEntry[];
  timezone: string;
  firstAt: number | null;
  lastAt: number | null;
  runningCount: number;
};

/**
 * Every actual, newest first. This site is one person's log — tens of
 * thousands of rows at the very worst — so aggregating in JS keeps the
 * interval math readable and exact. Move the sums into SQL only if that stops
 * being true; the union step would still have to happen here.
 *
 * `notes` is deliberately absent. Everything this query returns flows into the
 * unauthenticated `/` and `/s/[subject]`, and notes are the one private field
 * on an entry — the log is public, the diary attached to it is not. Nothing
 * rendered there reads them, and leaving them selected meant the only thing
 * standing between a private note and the wire was `entry-list.tsx` happening
 * to be a Server Component: adding `"use client"` to it would have serialized
 * every note into the page with no error and nothing visibly different. If a
 * signed-in surface ever needs notes, give it its own query.
 */
const ENTRY_LIST_SQL = `SELECT id, date, category_id, title, start_at, end_at, track
          FROM calendar_actuals
          ORDER BY start_at DESC`;

type DbEntryRow = Pick<
  DbCalendarActual,
  "id" | "date" | "category_id" | "title" | "start_at" | "end_at" | "track"
>;

function rowToEntry(r: DbEntryRow, nowMs: number): HoursEntry {
  const running = r.end_at === null;
  return {
    id: r.id,
    categoryId: r.category_id,
    title: r.title,
    startAt: Number(r.start_at),
    // A running row has no end yet; clamp to now so live time counts. Guard
    // against a start in the future (clock skew) collapsing to negative.
    endAt: running ? Math.max(Number(r.start_at), nowMs) : Number(r.end_at),
    running,
    track: Number(r.track ?? 0),
    date: r.date,
  };
}

/**
 * The hottest path in the app: the homepage and every subject page are
 * force-dynamic, so this runs uncached on literally every page view.
 *
 * Wrapped in React `cache()` because the subject page calls it twice per
 * request — once in `generateMetadata()` and once in the component — and Next
 * runs both. React keys the cache on the argument list, and both call sites
 * pass zero arguments, so they hit the same entry and the log is loaded and
 * aggregated once instead of twice. Keeping the `Date.now()` default *inside*
 * the function (rather than resolving it at each call site) is what makes that
 * work, and it fixes a real inconsistency too: metadata and body used to
 * compute running-entry durations against two different "now" values a few
 * milliseconds apart. The cache is per-request — React discards it at the end
 * of the render — so pages never serve a stale "now" from an earlier request.
 */
export const getHoursOverview = cache(async (nowMs: number = Date.now()): Promise<HoursOverview> => {
  // All three reads go out as one batch: a single network round trip to Turso
  // instead of three. Ordering used to force two serial waves — the timezone
  // was awaited before the rows — but nothing actually needs it first; it is
  // only consumed by splitByDay far below, after the rows are already in hand.
  // "read" is a read-only transaction: the statements see one consistent
  // snapshot, which also means categories can't shift out from under the
  // entries that reference them.
  await initDb();
  const [configRes, entriesRes, categoriesRes] = await db.batch(
    [
      { sql: SITE_CONFIG_SQL, args: [] },
      { sql: ENTRY_LIST_SQL, args: [] },
      { sql: CATEGORY_LIST_SQL, args: [] },
    ],
    "read",
  );

  const timezone = resolveTimezone(
    parseSiteConfigRows(configRes.rows as unknown as { key: string; value: string }[]),
  );
  const entries = (entriesRes.rows as unknown as DbEntryRow[]).map((r) => rowToEntry(r, nowMs));
  const categories = (categoriesRes.rows as unknown as DbCalendarCategory[]).map(rowToCategory);

  const byId = new Map(categories.map((c) => [c.id, c]));

  // Per-subject: overlap counted in full, so no subject is penalised for
  // having shared its hour with another.
  const buckets = new Map<string | null, Interval[]>();
  const meta = new Map<string | null, { first: number; last: number; count: number }>();
  // Accumulated here rather than derived later with `Math.min(...entries.map())`:
  // spreading one argument per row blows the call stack somewhere past ~125k
  // entries, and the pass over every entry is already happening.
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const e of entries) {
    const key = e.categoryId;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push({ start: e.startAt, end: e.endAt });
    const m = meta.get(key);
    if (!m) meta.set(key, { first: e.startAt, last: e.endAt, count: 1 });
    else {
      m.first = Math.min(m.first, e.startAt);
      m.last = Math.max(m.last, e.endAt);
      m.count++;
    }
    if (firstAt === null || e.startAt < firstAt) firstAt = e.startAt;
    if (lastAt === null || e.endAt > lastAt) lastAt = e.endAt;
  }

  const subjects: Subject[] = [...buckets.entries()]
    .map(([id, intervals]) => {
      const cat = id === null ? null : byId.get(id);
      const m = meta.get(id)!;
      return {
        id,
        name: cat?.name ?? "uncategorized",
        color: cat?.color ?? "#7a8085",
        archived: cat?.archived ?? false,
        // Union within a subject too: logging the same subject on two lanes at
        // once is a bookkeeping artefact, not two hours of that subject.
        ms: unionMs(intervals),
        entries: m.count,
        firstAt: m.first,
        lastAt: m.last,
      };
    })
    .sort((a, b) => b.ms - a.ms);

  const allIntervals = entries.map((e) => ({ start: e.startAt, end: e.endAt }));
  const totalMs = unionMs(allIntervals);
  const totalRawMs = subjects.reduce((s, x) => s + x.ms, 0);

  // Per-day density, split at midnight so a 23:00-01:00 session lands on both
  // days, and unioned within each day so parallel lanes don't inflate it.
  const daily: Record<string, number> = {};
  const perDay = new Map<string, Interval[]>();
  for (const e of entries) {
    for (const seg of splitByDay({ start: e.startAt, end: e.endAt }, timezone)) {
      if (!perDay.has(seg.date)) perDay.set(seg.date, []);
      perDay.get(seg.date)!.push({ start: seg.start, end: seg.end });
    }
  }
  for (const [date, intervals] of perDay) daily[date] = unionMs(intervals);

  return {
    totalMs,
    totalRawMs,
    parallelMs: Math.max(0, totalRawMs - totalMs),
    subjects,
    daily,
    entries,
    timezone,
    firstAt,
    lastAt,
    runningCount: entries.filter((e) => e.running).length,
  };
});

