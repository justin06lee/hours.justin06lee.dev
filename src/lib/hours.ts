/**
 * Database-facing aggregation over `calendar_actuals`. The arithmetic lives in
 * hours-math.ts; this module only loads rows and applies it.
 */

import { db, initDb } from "@/lib/db";
import type { DbCalendarActual } from "@/lib/db";
import { listCategories } from "@/lib/calendar-categories";
import { getSiteConfig, resolveTimezone } from "@/lib/site-config";
import { type Interval, splitByDay, unionMs } from "@/lib/hours-math";

// Re-exported so callers have one import for "everything hours".
export * from "@/lib/hours-math";

export type HoursEntry = {
  id: string;
  categoryId: string | null;
  title: string | null;
  notes: string | null;
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
 * Loads every actual, newest first. This site is one person's log — tens of
 * thousands of rows at the very worst — so aggregating in JS keeps the
 * interval math readable and exact. Move the sums into SQL only if that stops
 * being true; the union step would still have to happen here.
 */
async function loadEntries(nowMs: number): Promise<HoursEntry[]> {
  await initDb();
  const result = await db.execute({
    sql: `SELECT id, date, category_id, title, notes, start_at, end_at, track
          FROM calendar_actuals
          ORDER BY start_at DESC`,
    args: [],
  });
  const rows = result.rows as unknown as Pick<
    DbCalendarActual,
    "id" | "date" | "category_id" | "title" | "notes" | "start_at" | "end_at" | "track"
  >[];

  return rows.map((r) => {
    const running = r.end_at === null;
    return {
      id: r.id,
      categoryId: r.category_id,
      title: r.title,
      notes: r.notes,
      startAt: Number(r.start_at),
      // A running row has no end yet; clamp to now so live time counts. Guard
      // against a start in the future (clock skew) collapsing to negative.
      endAt: running ? Math.max(Number(r.start_at), nowMs) : Number(r.end_at),
      running,
      track: Number(r.track ?? 0),
      date: r.date,
    };
  });
}

export async function getHoursOverview(nowMs: number = Date.now()): Promise<HoursOverview> {
  const timezone = resolveTimezone(await getSiteConfig());
  const [entries, categories] = await Promise.all([
    loadEntries(nowMs),
    listCategories(),
  ]);

  const byId = new Map(categories.map((c) => [c.id, c]));

  // Per-subject: overlap counted in full, so no subject is penalised for
  // having shared its hour with another.
  const buckets = new Map<string | null, Interval[]>();
  const meta = new Map<string | null, { first: number; last: number; count: number }>();
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
    firstAt: entries.length ? Math.min(...entries.map((e) => e.startAt)) : null,
    lastAt: entries.length ? Math.max(...entries.map((e) => e.endAt)) : null,
    runningCount: entries.filter((e) => e.running).length,
  };
}

