/**
 * Database-facing aggregation over `calendar_actuals`. The arithmetic lives in
 * hours-math.ts; this module only loads rows and applies it.
 *
 * The module is split into two kinds of query, and the distinction is the whole
 * point of its shape:
 *
 *   - **the aggregate** (`getHoursOverview`) reads every row, because a union is
 *     exact or it is nothing — there is no way to push interval merging into
 *     SQLite and still answer "how many hours have actually elapsed". What it
 *     does *not* do is read every *column*: three narrow ones, never the text.
 *   - **the display queries** (`getEntryPage`, `getJournalPage`,
 *     `getSubjectBreakdown`) are bounded. Nothing rendered as a list is
 *     unbounded, and nothing unbounded is rendered as a list.
 *
 * This costs one extra round trip per page against the previous single batch.
 * That is a deliberate trade: the old batch was one hop but streamed the whole
 * table — every title, every note, every id — on every view of a public page,
 * and grew without limit. Two hops that each stay small beat one that doesn't.
 */

import { cache } from "react";
import { db, initDb } from "@/lib/db";
import type { DbCalendarActual, DbCalendarCategory } from "@/lib/db";
import { CATEGORY_LIST_SQL, rowToCategory } from "@/lib/calendar-categories";
import { SITE_CONFIG_SQL, parseSiteConfigRows, resolveTimezone } from "@/lib/site-config";
import { activeYears, dailyUnion, type Interval, unionMs, uniqueSlugs } from "@/lib/hours-math";
import { clampPageLimit, clampPageOffset } from "@/lib/calendar-validate";

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

/**
 * An entry with the private half attached. Only ever produced by
 * {@link getJournalPage}, which admin surfaces call and public ones do not —
 * see the note on `notes` at {@link ENTRY_COLUMNS}.
 */
export type JournalEntry = HoursEntry & { notes: string | null };

export type Subject = {
  id: string | null;
  name: string;
  /**
   * URL segment for /s/[subject], unique across the whole subject list — see
   * uniqueSlugs. Carried on the subject rather than recomputed per call site so
   * the link the homepage renders and the lookup the subject page performs are
   * literally the same string and cannot drift. Empty for the uncategorized
   * bucket, which has no id and is deliberately not addressable.
   */
  slug: string;
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
  /** Every calendar year with time logged in it, newest first. */
  years: number[];
  timezone: string;
  firstAt: number | null;
  lastAt: number | null;
  runningCount: number;
};

/**
 * The aggregate read: three columns, every row.
 *
 * Every row is not negotiable — `unionMs` has to see all of them to know how
 * much wall-clock time was actually covered, and no `LIMIT` can be applied to a
 * figure that claims to be a total. Three columns is what changed: this used to
 * select `id`, `date`, `title` and `track` as well, none of which the math
 * touches, and all of which are dead weight multiplied by the whole table on
 * every render of every public page.
 *
 * No `ORDER BY` either. `mergeIntervals` sorts what it needs, and the per-subject
 * bookkeeping accumulates with min/max, so the result is identical whatever
 * order the rows arrive in — and the database no longer sorts the table to
 * produce it.
 */
const AGGREGATE_SQL = `SELECT category_id, start_at, end_at
          FROM calendar_actuals`;

type DbAggregateRow = Pick<DbCalendarActual, "category_id" | "start_at" | "end_at">;

/**
 * The columns a rendered entry needs.
 *
 * `notes` is deliberately absent, and this is the load-bearing reason the
 * journal has a query of its own. Everything these columns feed flows into the
 * unauthenticated `/` and `/s/[subject]`; notes are the one private field on an
 * entry — the log is public, the diary attached to it is not. Leaving `notes`
 * selected here would mean the only thing between a private note and the wire
 * is which components happen to render it today.
 */
const ENTRY_COLUMNS = `id, date, category_id, title, start_at, end_at, track`;

const ENTRY_PAGE_SQL = `SELECT ${ENTRY_COLUMNS}
          FROM calendar_actuals
          ORDER BY start_at DESC
          LIMIT ? OFFSET ?`;

const ENTRY_PAGE_BY_CATEGORY_SQL = `SELECT ${ENTRY_COLUMNS}
          FROM calendar_actuals
          WHERE category_id = ?
          ORDER BY start_at DESC
          LIMIT ? OFFSET ?`;

const ENTRY_COUNT_SQL = `SELECT COUNT(*) AS n FROM calendar_actuals`;

const ENTRY_COUNT_BY_CATEGORY_SQL =
  `SELECT COUNT(*) AS n FROM calendar_actuals WHERE category_id = ?`;

/** The same page, plus the private column. Admin surfaces only. */
const JOURNAL_PAGE_SQL = `SELECT ${ENTRY_COLUMNS}, notes
          FROM calendar_actuals
          ORDER BY start_at DESC
          LIMIT ? OFFSET ?`;

/**
 * Only the entries carrying a written reflection.
 *
 * `TRIM(notes) <> ''` rather than a bare NULL check because the describe path
 * writes `null` for an empty box but nothing stops a whitespace-only note
 * reaching the column from the sibling site, and a journal filtered to
 * "reflections" that lists blank ones is not filtered.
 */
const JOURNAL_NOTED_PAGE_SQL = `SELECT ${ENTRY_COLUMNS}, notes
          FROM calendar_actuals
          WHERE notes IS NOT NULL AND TRIM(notes) <> ''
          ORDER BY start_at DESC
          LIMIT ? OFFSET ?`;

const JOURNAL_COUNT_SQL = ENTRY_COUNT_SQL;

const JOURNAL_NOTED_COUNT_SQL = `SELECT COUNT(*) AS n
          FROM calendar_actuals
          WHERE notes IS NOT NULL AND TRIM(notes) <> ''`;

/** One subject's whole history, narrow: what the per-title union needs. */
const SUBJECT_ROWS_SQL = `SELECT title, start_at, end_at
          FROM calendar_actuals
          WHERE category_id = ?`;

type DbEntryRow = Pick<
  DbCalendarActual,
  "id" | "date" | "category_id" | "title" | "start_at" | "end_at" | "track"
>;

type DbJournalRow = DbEntryRow & Pick<DbCalendarActual, "notes">;

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

/** The same clamp the display path applies, for rows read without their id. */
function rowInterval(start: unknown, end: unknown, nowMs: number): Interval {
  const startAt = Number(start);
  return {
    start: startAt,
    end: end === null ? Math.max(startAt, nowMs) : Number(end),
  };
}

/**
 * One "now" for the whole request, shared by every query in this module.
 *
 * These functions each used to default to their own `Date.now()`, which was
 * fine while a page made a single call and stopped being fine the moment the
 * aggregate and the display list became separate round trips: a running entry
 * would be clamped to one instant for the headline total and a few milliseconds
 * later for the breakdown beneath it. `cache()` on a zero-argument function is
 * exactly a request-scoped memo, so every caller that takes the default sees
 * the same instant without anyone having to thread it through.
 */
export const requestNow = cache((): number => Date.now());

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
  const [configRes, rowsRes, categoriesRes] = await db.batch(
    [
      { sql: SITE_CONFIG_SQL, args: [] },
      { sql: AGGREGATE_SQL, args: [] },
      { sql: CATEGORY_LIST_SQL, args: [] },
    ],
    "read",
  );

  const timezone = resolveTimezone(
    parseSiteConfigRows(configRes.rows as unknown as { key: string; value: string }[]),
  );
  const rows = rowsRes.rows as unknown as DbAggregateRow[];
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
  let runningCount = 0;
  const allIntervals: Interval[] = [];
  for (const r of rows) {
    if (r.end_at === null) runningCount++;
    const interval = rowInterval(r.start_at, r.end_at, nowMs);
    allIntervals.push(interval);
    const key = r.category_id;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(interval);
    const m = meta.get(key);
    if (!m) meta.set(key, { first: interval.start, last: interval.end, count: 1 });
    else {
      m.first = Math.min(m.first, interval.start);
      m.last = Math.max(m.last, interval.end);
      m.count++;
    }
    if (firstAt === null || interval.start < firstAt) firstAt = interval.start;
    if (lastAt === null || interval.end > lastAt) lastAt = interval.end;
  }

  const ranked: Omit<Subject, "slug">[] = [...buckets.entries()]
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

  // Assigned once, over the full list and in final display order, so that the
  // busiest of two colliding subjects is the one that keeps the bare slug and
  // every consumer reads the same answer. Sorting first is what makes the
  // choice depend on the data rather than on Map insertion order.
  const slugs = uniqueSlugs(ranked);
  const subjects: Subject[] = ranked.map((s, i) => ({ ...s, slug: slugs[i] }));

  const totalMs = unionMs(allIntervals);
  const totalRawMs = subjects.reduce((s, x) => s + x.ms, 0);

  // Per-day density, split at midnight so a 23:00-01:00 session lands on both
  // days, and unioned within each day so parallel lanes don't inflate it.
  const daily = dailyUnion(allIntervals, timezone);

  return {
    totalMs,
    totalRawMs,
    parallelMs: Math.max(0, totalRawMs - totalMs),
    subjects,
    daily,
    years: activeYears(daily),
    timezone,
    firstAt,
    lastAt,
    runningCount,
  };
});

export type EntryPage = {
  entries: HoursEntry[];
  /** Total matching rows, for the pager. */
  total: number;
};

/**
 * One bounded page of entries, newest first, optionally scoped to a subject.
 *
 * The page and its count travel as one batch, so a paginated list costs one
 * round trip rather than two. `ORDER BY start_at DESC` rides
 * `idx_calendar_actuals_start_at`; the by-category form rides the composite
 * `idx_calendar_actuals_category_start` added for exactly this query.
 */
export async function getEntryPage(opts?: {
  limit?: number;
  offset?: number;
  categoryId?: string | null;
  nowMs?: number;
}): Promise<EntryPage> {
  await initDb();
  const limit = clampPageLimit(opts?.limit ?? 20);
  const offset = clampPageOffset(opts?.offset ?? 0);
  const nowMs = opts?.nowMs ?? requestNow();
  const categoryId = opts?.categoryId ?? null;

  const [pageRes, countRes] = await db.batch(
    categoryId === null
      ? [
          { sql: ENTRY_PAGE_SQL, args: [limit, offset] },
          { sql: ENTRY_COUNT_SQL, args: [] },
        ]
      : [
          { sql: ENTRY_PAGE_BY_CATEGORY_SQL, args: [categoryId, limit, offset] },
          { sql: ENTRY_COUNT_BY_CATEGORY_SQL, args: [categoryId] },
        ],
    "read",
  );

  return {
    entries: (pageRes.rows as unknown as DbEntryRow[]).map((r) => rowToEntry(r, nowMs)),
    total: Number((countRes.rows[0] as unknown as { n: number }).n ?? 0),
  };
}

export type JournalPage = {
  entries: JournalEntry[];
  total: number;
};

/**
 * One bounded page of entries **with their notes**.
 *
 * Kept separate from {@link getEntryPage} rather than added as a flag, because
 * the difference is not a column — it is who is allowed to call it. Every
 * caller of this must be behind the admin gate; the public pages have no way to
 * reach it by accident, which is the property the split exists to give.
 *
 * `notedOnly` filters to entries that actually carry a reflection, for reading
 * the journal as a journal rather than as a log.
 */
export async function getJournalPage(opts?: {
  limit?: number;
  offset?: number;
  notedOnly?: boolean;
  nowMs?: number;
}): Promise<JournalPage> {
  await initDb();
  const limit = clampPageLimit(opts?.limit ?? 25);
  const offset = clampPageOffset(opts?.offset ?? 0);
  const nowMs = opts?.nowMs ?? requestNow();
  const notedOnly = opts?.notedOnly ?? false;

  const [pageRes, countRes] = await db.batch(
    [
      {
        sql: notedOnly ? JOURNAL_NOTED_PAGE_SQL : JOURNAL_PAGE_SQL,
        args: [limit, offset],
      },
      { sql: notedOnly ? JOURNAL_NOTED_COUNT_SQL : JOURNAL_COUNT_SQL, args: [] },
    ],
    "read",
  );

  return {
    entries: (pageRes.rows as unknown as DbJournalRow[]).map((r) => ({
      ...rowToEntry(r, nowMs),
      notes: r.notes,
    })),
    total: Number((countRes.rows[0] as unknown as { n: number }).n ?? 0),
  };
}

export type TitleBreakdown = {
  /** Lowercased session title, or "(untitled)". */
  label: string;
  /** Union ms across every entry sharing this title. */
  ms: number;
  count: number;
};

export type SubjectBreakdown = {
  /** Per-day union ms for this subject alone, keyed "YYYY-MM-DD". */
  daily: Record<string, number>;
  years: number[];
  /** What was actually written in the title, heaviest first. */
  titles: TitleBreakdown[];
};

/**
 * One subject's own heatmap and title breakdown.
 *
 * Both figures **union** their intervals, which is the correction this function
 * exists to make. The title bars used to sum raw durations while the subject's
 * headline unioned them, so two lanes running the same subject under the same
 * title at once produced bars that added up to more than the number printed
 * directly above them — the precise confusion the site's counting rule exists
 * to prevent, reintroduced one section lower down the page.
 *
 * Reads only this subject's rows, and only three columns of them.
 */
export async function getSubjectBreakdown(
  categoryId: string,
  timezone: string,
  nowMs: number = requestNow(),
): Promise<SubjectBreakdown> {
  await initDb();
  const res = await db.execute({ sql: SUBJECT_ROWS_SQL, args: [categoryId] });
  const rows = res.rows as unknown as Pick<
    DbCalendarActual,
    "title" | "start_at" | "end_at"
  >[];

  const intervals: Interval[] = [];
  const byTitle = new Map<string, Interval[]>();
  for (const r of rows) {
    const interval = rowInterval(r.start_at, r.end_at, nowMs);
    intervals.push(interval);
    const key = (r.title ?? "").trim().toLowerCase() || "(untitled)";
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(interval);
  }

  const daily = dailyUnion(intervals, timezone);
  const titles = [...byTitle.entries()]
    .map(([label, spans]) => ({ label, ms: unionMs(spans), count: spans.length }))
    .sort((a, b) => b.ms - a.ms);

  return { daily, years: activeYears(daily), titles };
}
