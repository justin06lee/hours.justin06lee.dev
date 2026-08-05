import { db, initDb, type DbCalendarTask, type DbCalendarActual, type DbCalendarCategory } from "./db";
import {
  epochToDateInTz,
  hhmmToMinutes,
  clampActualToDay,
  addDays,
  intervalIntersectionMinutes,
} from "@/lib/calendar-dates";
import { rowToCategory, type CalendarCategory } from "./calendar-categories";

// Web Crypto global — works in Node 19+, Bun, and edge runtimes.
const randomUUID = () => globalThis.crypto.randomUUID();

export type CategorySummary = { id: string; name: string; color: string };

/**
 * An alternative concrete task that can also fulfill an "uncertain" plan's
 * slot. Each alternative is a full mini-task (category + title + interval).
 *
 * Match rule for heatmap scoring: an actual fulfills an alternative when its
 * `category_id` equals the alternative's `categoryId` AND its `title`
 * (trimmed, lowercased) equals the alternative's `title` (same normalization).
 * Both fields must match — alternatives are deliberately specific.
 *
 * The plan's own (parent) category still scores by category-only, as before.
 * That asymmetry is intentional: parent says "anything in this category," each
 * alternative says "this exact other thing."
 */
export type PlanFallback = {
  categoryId: string;
  title: string;
  /** HH:MM — must be present; alternatives without a time slot can't be scored. */
  startTime: string;
  /** HH:MM — must be > startTime. */
  endTime: string;
};

export type CalendarTask = {
  id: string;
  date: string;
  title: string;
  notes: string | null;
  startTime: string | null;
  endTime: string | null;
  done: boolean;
  position: number;
  categoryId: string | null;
  category: CategorySummary | null;
  isUncertain: boolean;
  fallbacks: PlanFallback[];
};

type NewCalendarTask = {
  date: string;
  title: string;
  notes?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  position?: number;
  categoryId?: string | null;
  isUncertain?: boolean;
  fallbacks?: PlanFallback[];
};

export type CalendarTaskPatch = Partial<{
  title: string;
  notes: string | null;
  startTime: string | null;
  endTime: string | null;
  done: boolean;
  position: number;
  date: string;
  categoryId: string | null;
  isUncertain: boolean;
  fallbacks: PlanFallback[];
}>;

/** Parses the JSON-encoded `fallbacks` column. Always returns a valid array;
 *  malformed rows degrade silently to []. We don't surface a parse error
 *  because (a) writes go through the API which validates and (b) a failed
 *  fallback list shouldn't break the rest of the task data. */
function parseFallbacks(raw: string | null): PlanFallback[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFallback);
  } catch {
    return [];
  }
}

function isValidFallback(v: unknown): v is PlanFallback {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.categoryId === "string" && o.categoryId.length > 0 &&
    typeof o.title === "string" && o.title.trim().length > 0 &&
    typeof o.startTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.startTime) &&
    typeof o.endTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.endTime) &&
    o.startTime < o.endTime
  );
}

function serializeFallbacks(fbs: PlanFallback[] | undefined | null): string | null {
  if (!fbs || fbs.length === 0) return null;
  // Trim titles on write so the heatmap doesn't have to per-row at read time.
  // Lowercasing happens at scoring time (display still shows the original case).
  const normalized = fbs
    .filter(isValidFallback)
    .map((f) => ({
      categoryId: f.categoryId,
      title: f.title.trim(),
      startTime: f.startTime,
      endTime: f.endTime,
    }));
  if (normalized.length === 0) return null;
  return JSON.stringify(normalized);
}

/**
 * A statement in the shape `db.batch` wants, but with `args` typed loosely so
 * the builders below can assemble lists generically. libsql declares `args` as
 * its own `InValue` union; every value we put in one is a string, number or
 * null, so the cast in {@link batchStmts} is the same one the pre-existing
 * batch call sites already used.
 */
type Stmt = { sql: string; args: unknown[] };

function batchStmts(stmts: Stmt[], mode: "read" | "write") {
  return db.batch(stmts as never, mode);
}

const CATEGORY_EXISTS_SQL = "SELECT 1 FROM calendar_categories WHERE id = ? LIMIT 1";
const PLAN_EXISTS_SQL = "SELECT 1 FROM calendar_tasks WHERE id = ? LIMIT 1";

/** Returns true iff the given non-null id matches a row. We use this from
 *  write paths so callers see a clear "invalid-category"/"invalid-plan"
 *  error instead of silently storing a dangling FK.
 *
 *  The SQL is shared with the batched pre-check paths (see
 *  {@link pushStartReads}) so the two can never disagree about what "exists"
 *  means. */
async function categoryExists(id: string): Promise<boolean> {
  const r = await db.execute({ sql: CATEGORY_EXISTS_SQL, args: [id] });
  return r.rows.length > 0;
}

async function planExists(id: string): Promise<boolean> {
  const r = await db.execute({ sql: PLAN_EXISTS_SQL, args: [id] });
  return r.rows.length > 0;
}

type DbCalendarTaskJoined = DbCalendarTask & {
  cat_id: string | null;
  cat_name: string | null;
  cat_color: string | null;
};

function rowToTask(row: DbCalendarTaskJoined): CalendarTask {
  // Always surface the raw FK in `categoryId` even if the joined category
  // row is gone. Hard-deleting a category should not silently rewrite the
  // task's stored FK to null in the API surface — only `category` (the
  // joined summary) is null in that orphan case.
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    notes: row.notes,
    startTime: row.start_time,
    endTime: row.end_time,
    done: row.done === 1,
    position: row.position,
    categoryId: row.category_id,
    category:
      row.cat_id != null
        ? { id: row.cat_id, name: row.cat_name ?? "", color: row.cat_color ?? "" }
        : null,
    isUncertain: row.is_uncertain === 1,
    fallbacks: parseFallbacks(row.fallbacks),
  };
}

export async function getTasksInRange(from: string, to: string): Promise<CalendarTask[]> {
  await initDb();
  const result = await db.execute({
    sql: `SELECT t.*, c.id AS cat_id, c.name AS cat_name, c.color AS cat_color
          FROM calendar_tasks t
          LEFT JOIN calendar_categories c ON c.id = t.category_id
          WHERE t.date BETWEEN ? AND ?
          ORDER BY t.date ASC, t.position ASC, t.created_at ASC`,
    args: [from, to],
  });
  return (result.rows as unknown as DbCalendarTaskJoined[]).map(rowToTask);
}

export type CreateTaskResult =
  | { ok: true; task: CalendarTask }
  | { ok: false; reason: "invalid-category" };

export async function createTask(input: NewCalendarTask): Promise<CreateTaskResult> {
  await initDb();
  if (input.categoryId && !(await categoryExists(input.categoryId))) {
    return { ok: false, reason: "invalid-category" };
  }
  const id = randomUUID();
  const now = Date.now();
  const isUncertain = input.isUncertain ? 1 : 0;
  // Drop fallbacks entirely when not uncertain — keeps the column clean and
  // makes the "off" state unambiguous on read.
  const fallbacksJson = isUncertain ? serializeFallbacks(input.fallbacks) : null;
  await db.execute({
    sql: `INSERT INTO calendar_tasks
          (id, date, title, notes, start_time, end_time, done, position, category_id, is_uncertain, fallbacks, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.date,
      input.title,
      input.notes ?? null,
      input.startTime ?? null,
      input.endTime ?? null,
      input.position ?? 0,
      input.categoryId ?? null,
      isUncertain,
      fallbacksJson,
      now,
      now,
    ],
  });
  const task = await getTaskById(id);
  if (!task) throw new Error("Failed to create task");
  return { ok: true, task };
}

async function getTaskById(id: string): Promise<CalendarTask | null> {
  await initDb();
  const result = await db.execute({
    sql: `SELECT t.*, c.id AS cat_id, c.name AS cat_name, c.color AS cat_color
          FROM calendar_tasks t
          LEFT JOIN calendar_categories c ON c.id = t.category_id
          WHERE t.id = ?`,
    args: [id],
  });
  const row = result.rows[0] as unknown as DbCalendarTaskJoined | undefined;
  return row ? rowToTask(row) : null;
}

export type UpdateTaskResult =
  | { ok: true; task: CalendarTask }
  | { ok: false; reason: "not-found" | "invalid-category" };

export async function updateTask(id: string, patch: CalendarTaskPatch): Promise<UpdateTaskResult> {
  await initDb();
  const existing = await getTaskById(id);
  if (!existing) return { ok: false, reason: "not-found" };
  if (patch.categoryId && !(await categoryExists(patch.categoryId))) {
    return { ok: false, reason: "invalid-category" };
  }
  const merged = {
    date: patch.date ?? existing.date,
    title: patch.title ?? existing.title,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    startTime: patch.startTime !== undefined ? patch.startTime : existing.startTime,
    endTime: patch.endTime !== undefined ? patch.endTime : existing.endTime,
    done: patch.done !== undefined ? patch.done : existing.done,
    position: patch.position !== undefined ? patch.position : existing.position,
    categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
    isUncertain: patch.isUncertain !== undefined ? patch.isUncertain : existing.isUncertain,
    fallbacks: patch.fallbacks !== undefined ? patch.fallbacks : existing.fallbacks,
  };
  // Same invariant as createTask: when not uncertain, fallbacks are erased so
  // the off state is unambiguous and toggling back on doesn't surface stale data.
  const fallbacksJson = merged.isUncertain ? serializeFallbacks(merged.fallbacks) : null;
  await db.execute({
    sql: `UPDATE calendar_tasks
          SET date=?, title=?, notes=?, start_time=?, end_time=?, done=?, position=?, category_id=?, is_uncertain=?, fallbacks=?, updated_at=?
          WHERE id=?`,
    args: [
      merged.date,
      merged.title,
      merged.notes,
      merged.startTime,
      merged.endTime,
      merged.done ? 1 : 0,
      merged.position,
      merged.categoryId,
      merged.isUncertain ? 1 : 0,
      fallbacksJson,
      Date.now(),
      id,
    ],
  });
  const updated = await getTaskById(id);
  if (!updated) throw new Error("Failed to load updated task");
  return { ok: true, task: updated };
}

export async function deleteTask(id: string): Promise<{ ok: boolean }> {
  await initDb();
  const result = await db.execute({
    sql: "DELETE FROM calendar_tasks WHERE id = ?",
    args: [id],
  });
  return { ok: (result.rowsAffected ?? 0) > 0 };
}

export type PlanSummary = { id: string; title: string };

export type CalendarActual = {
  id: string;
  date: string;
  planId: string | null;
  plan: PlanSummary | null;
  categoryId: string | null;
  category: CategorySummary | null;
  title: string | null;
  startAt: number;
  endAt: number | null;
  /**
   * Concurrency lane. 0 is the primary lane; higher lanes are activities
   * running in parallel with it. Overlapping rows on DIFFERENT tracks are
   * legal and expected; overlapping rows on the SAME track are not.
   */
  track: number;
  notes: string | null;
};

type DbCalendarActualJoined = DbCalendarActual & {
  cat_id: string | null;
  cat_name: string | null;
  cat_color: string | null;
  plan_title: string | null;
};

function rowToActual(row: DbCalendarActualJoined): CalendarActual {
  // Always surface raw FKs (`planId`/`categoryId`) even if the joined row is
  // gone. The nested `plan`/`category` summaries are nullable so callers can
  // still tell "categorized but orphaned" from "uncategorized".
  return {
    id: row.id,
    date: row.date,
    planId: row.plan_id,
    plan: row.plan_id != null && row.plan_title != null
      ? { id: row.plan_id, title: row.plan_title }
      : null,
    categoryId: row.category_id,
    category: row.cat_id != null
      ? { id: row.cat_id, name: row.cat_name ?? "", color: row.cat_color ?? "" }
      : null,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    // Coalesced because rows written before the track migration predate the
    // column entirely; libsql hands them back as null rather than the
    // declared default.
    track: Number(row.track ?? 0),
    notes: row.notes,
  };
}

/**
 * The one SELECT/FROM/JOIN prefix every actual-reading query is built on, so
 * the join shape `rowToActual` depends on can only drift in one place.
 *
 * It lives at module scope rather than inside the helpers that used to own it
 * because `db.batch` takes SQL strings: folding a read-back or a
 * "what's running now?" lookup into the same transaction as the write means
 * the SQL has to be reachable from the batch builder, not locked inside an
 * `await`-per-call helper.
 */
const ACTUAL_SELECT = `SELECT a.*, c.id AS cat_id, c.name AS cat_name, c.color AS cat_color, p.title AS plan_title
          FROM calendar_actuals a
          LEFT JOIN calendar_categories c ON c.id = a.category_id
          LEFT JOIN calendar_tasks p ON p.id = a.plan_id`;

const ACTUAL_BY_ID_SQL = `${ACTUAL_SELECT}
          WHERE a.id = ?`;

const RUNNING_LANES_SQL = `${ACTUAL_SELECT}
          WHERE a.end_at IS NULL
          ORDER BY a.track ASC`;

const RUNNING_ON_TRACK_SQL = `${ACTUAL_SELECT}
          WHERE a.end_at IS NULL AND a.track = ?
          LIMIT 1`;

/**
 * "Who holds this lane right now?", addressed by the id of a row that sits on
 * it rather than by lane number. The correlated subquery exists so this can
 * ride in the SAME read batch as the fetch of that row — otherwise the lookup
 * would have to wait a whole round trip for `existing.track` to come back.
 *
 * COALESCE mirrors `rowToActual`'s `track ?? 0`: a pre-migration row with a
 * NULL track reads as lane 0 in JS, so it has to resolve to lane 0 here too.
 * The outer comparison is deliberately NOT coalesced — `getRunningActualOnTrack`
 * doesn't coalesce either, and matching its behaviour exactly is the point.
 */
const RUNNING_ON_LANE_OF_SQL = `${ACTUAL_SELECT}
          WHERE a.end_at IS NULL
            AND a.track = (SELECT COALESCE(track, 0) FROM calendar_actuals WHERE id = ?)
          LIMIT 1`;

/** Just the id of whatever holds a lane — all a stop statement needs. */
const RUNNING_ID_ON_TRACK_SQL =
  "SELECT id FROM calendar_actuals WHERE end_at IS NULL AND track = ? LIMIT 1";

/** The `end_at IS NULL` guard is what makes a stop idempotent and race-safe:
 *  rowsAffected === 0 means somebody else closed the row first. */
const STOP_ACTUAL_SQL =
  "UPDATE calendar_actuals SET end_at=?, updated_at=? WHERE id=? AND end_at IS NULL";

const STOP_ALL_ACTUALS_SQL =
  "UPDATE calendar_actuals SET end_at=?, updated_at=? WHERE end_at IS NULL";

const INSERT_ACTUAL_SQL = `INSERT INTO calendar_actuals
          (id, date, plan_id, category_id, title, start_at, end_at, track, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_ACTUAL_SQL = `UPDATE calendar_actuals
            SET category_id=?, title=?, start_at=?, end_at=?, notes=?, updated_at=?
            WHERE id=?`;

/** Only the two fields a start inherits from its plan. Doubles as the
 *  existence check, so "does this plan exist?" and "what does it say?" cost
 *  one statement between them instead of two. */
const PLAN_FIELDS_SQL = "SELECT category_id, title FROM calendar_tasks WHERE id = ? LIMIT 1";

/** libsql hands back `Row[]`; every actual query selects the same columns, so
 *  the decode is always these two lines. */
function toActuals(rs: { rows: unknown[] }): CalendarActual[] {
  return (rs.rows as unknown as DbCalendarActualJoined[]).map(rowToActual);
}

function firstActual(rs: { rows: unknown[] }): CalendarActual | null {
  const row = rs.rows[0] as DbCalendarActualJoined | undefined;
  return row ? rowToActual(row) : null;
}

export async function getActualsInRange(from: string, to: string): Promise<CalendarActual[]> {
  await initDb();
  // Returns rows anchored to [from, to] plus any currently-running row.
  // Callers wanting to render cross-midnight blocks on the day AFTER they start
  // should query with `from = addDays(date, -1)` so yesterday's anchored rows
  // are included; the component layer (clampActualToDay) filters them to the visible day.
  const result = await db.execute({
    // Include the running row only if it could plausibly intersect the range
    // (its anchor date is on or before `to`). Without that bound, historical
    // queries would always pick up "now" — surprising for callers.
    sql: `${ACTUAL_SELECT}
          WHERE (a.date BETWEEN ? AND ?)
             OR (a.end_at IS NULL AND a.date <= ?)
          ORDER BY a.start_at ASC`,
    args: [from, to, to],
  });
  return toActuals(result);
}

/**
 * The single "primary" running actual, for callers that can only render one:
 * the lowest occupied lane, so a solo timer on lane 3 still surfaces.
 *
 * Since parallel tracks landed this is a lossy view — use
 * {@link getRunningActuals} anywhere that can show more than one. Kept with
 * its original signature so existing single-timer callers keep working.
 */
export async function getRunningActual(): Promise<CalendarActual | null> {
  await initDb();
  // Lowest track wins, then newest, so the answer is stable when several
  // lanes run at once.
  const result = await db.execute({
    sql: `${ACTUAL_SELECT}
          WHERE a.end_at IS NULL
          ORDER BY a.track ASC, a.start_at DESC
          LIMIT 1`,
    args: [],
  });
  return firstActual(result);
}

/**
 * Every currently-running actual, one per occupied lane, ordered by track.
 * The partial UNIQUE index guarantees no two rows share a track here.
 */
export async function getRunningActuals(): Promise<CalendarActual[]> {
  await initDb();
  const result = await db.execute({ sql: RUNNING_LANES_SQL, args: [] });
  return toActuals(result);
}

/** The running actual occupying a specific lane, if any. */
export async function getRunningActualOnTrack(
  track: number,
): Promise<CalendarActual | null> {
  await initDb();
  const result = await db.execute({ sql: RUNNING_ON_TRACK_SQL, args: [track] });
  return firstActual(result);
}

async function getActualById(id: string): Promise<CalendarActual | null> {
  await initDb();
  const result = await db.execute({ sql: ACTUAL_BY_ID_SQL, args: [id] });
  return firstActual(result);
}

export type StartActualInput = {
  planId?: string | null;
  categoryId?: string | null;
  title?: string | null;
  timezone: string; // for computing the actuals row's `date` field
  nowMs?: number; // overrideable for tests; defaults to Date.now()
  /**
   * Lane to start on. Defaults to 0 (the primary lane), which reproduces the
   * pre-parallel behaviour exactly. Starting on a lane only ever displaces
   * what was already running on THAT lane — other lanes keep running.
   */
  track?: number;
};

/**
 * Opt-out for the read-back that turns a freshly written row into a full
 * {@link CalendarActual}.
 *
 * Defaults to `true`, so every caller written before this existed keeps the
 * rich result it was written against. Server Actions that only ever ask "what
 * is running now?" pass `false`: the read-back statements are dropped from the
 * write batch entirely. That costs no extra round trip either way — the
 * read-back rides in the same transaction as the write — but it does drop two
 * joins and a row's worth of wire traffic per call, and it lets the result
 * type say plainly that nothing was read.
 */
export type HydrateOptions = {
  hydrate?: boolean;
};

/**
 * Every lane still running once the write has committed. Present on the
 * mutation results because the SELECT that produces it is the last statement
 * of the same `db.batch` — a trailing read in a `"write"` batch observes the
 * writes ahead of it, so the caller gets post-mutation truth without a second
 * round trip.
 */
export type StartActualResult =
  | { ok: true; started: CalendarActual; autoStopped: CalendarActual | null; lanes: CalendarActual[] }
  | { ok: false; reason: "concurrent-start" | "invalid-category" | "invalid-plan" };

/**
 * {@link startActual}'s result under `hydrate: false`. The rows were written;
 * they just were not read back, and the type says so rather than handing back
 * a cast-shaped lie.
 */
export type StartActualResultLean =
  | { ok: true; started: null; autoStopped: null; lanes: CalendarActual[] }
  | { ok: false; reason: "concurrent-start" | "invalid-category" | "invalid-plan" };

/**
 * Result of starting several lanes in one transaction.
 *
 * `index` points at the offending input when the failure came from a
 * per-input pre-check. It is null only when a constraint race trips the shared
 * transaction and the error gives no way to say which insert did it.
 */
export type StartActualsResult =
  | { ok: true; lanes: CalendarActual[] }
  | {
      ok: false;
      index: number | null;
      reason: "concurrent-start" | "invalid-category" | "invalid-plan";
    };

/** Detect a violation of the partial UNIQUE index guarding one running row
 *  per track. libsql surfaces the SQLITE_CONSTRAINT_UNIQUE code on its error
 *  objects. The name check still matches the pre-parallel index name as a
 *  prefix, so it covers databases migrated in either direction. */
function isRunningUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT") {
    return true;
  }
  const msg = err.message ?? "";
  return /UNIQUE constraint failed.*calendar_actuals/i.test(msg) ||
         msg.includes("idx_calendar_actuals_running");
}

/** Where one input's pre-check reads landed in the shared read batch. -1 means
 *  the check was skipped because the input didn't ask for it. */
type StartReadSlots = { category: number; plan: number; running: number };

/**
 * Appends one start's pre-checks to a read batch under construction. Nothing
 * here depends on another statement's *result*, which is exactly why they can
 * all travel together: category existence, plan existence-and-fields, and
 * "who currently holds this lane?" are three independent questions.
 *
 * The plan lookup deliberately fetches the two fields a start inherits rather
 * than calling `planExists` and then `getTaskById` — one statement answers
 * both, and the old pair could only ever disagree by racing each other.
 */
function pushStartReads(reads: Stmt[], input: StartActualInput): StartReadSlots {
  const slots: StartReadSlots = { category: -1, plan: -1, running: -1 };
  if (input.categoryId) {
    slots.category = reads.push({ sql: CATEGORY_EXISTS_SQL, args: [input.categoryId] }) - 1;
  }
  if (input.planId) {
    slots.plan = reads.push({ sql: PLAN_FIELDS_SQL, args: [input.planId] }) - 1;
  }
  slots.running = reads.push({ sql: RUNNING_ID_ON_TRACK_SQL, args: [input.track ?? 0] }) - 1;
  return slots;
}

/** The write half of a start, held apart from the read half so callers can
 *  decide the surrounding transaction. `displacedId` is the snapshot of who
 *  held the lane at pre-check time; the caller emits `stop` unless it is
 *  already closing that row for another reason. */
type PreparedStart = {
  id: string;
  displacedId: string | null;
  stop: Stmt | null;
  insert: Stmt;
};

/**
 * Turns one input plus its pre-check rows into the statements that start it.
 *
 * The lane snapshot taken in `pushStartReads` is advisory only: between the
 * read batch and the write batch another client can take the lane. That is
 * what the partial UNIQUE index is for, and why every caller of this still
 * wraps its batch in the `isRunningUniqueViolation` catch. Batching narrows
 * the TOCTOU window; it does not close it.
 */
function consumeStartReads(
  results: { rows: unknown[] }[],
  slots: StartReadSlots,
  input: StartActualInput,
  fallbackNowMs: number,
): { ok: true; prepared: PreparedStart } | { ok: false; reason: "invalid-category" | "invalid-plan" } {
  if (slots.category >= 0 && results[slots.category].rows.length === 0) {
    return { ok: false, reason: "invalid-category" };
  }

  // Hydrate from plan if requested. We distinguish "not provided" (undefined)
  // from "explicit null" so callers can opt out of plan inheritance per-field
  // by sending null.
  let categoryId: string | null = input.categoryId !== undefined ? input.categoryId : null;
  let title: string | null = input.title !== undefined ? input.title : null;
  if (slots.plan >= 0) {
    const plan = results[slots.plan].rows[0] as
      | { category_id: string | null; title: string | null }
      | undefined;
    if (!plan) return { ok: false, reason: "invalid-plan" };
    if (input.categoryId === undefined) categoryId = plan.category_id;
    if (input.title === undefined) title = plan.title;
  }

  const now = input.nowMs ?? fallbackNowMs;
  const track = input.track ?? 0;
  const displaced = results[slots.running].rows[0] as { id: string } | undefined;
  const displacedId = displaced?.id ?? null;
  const id = randomUUID();
  const date = epochToDateInTz(now, input.timezone);

  return {
    ok: true,
    prepared: {
      id,
      displacedId,
      stop: displacedId
        ? { sql: STOP_ACTUAL_SQL, args: [now, now, displacedId] }
        : null,
      insert: {
        sql: INSERT_ACTUAL_SQL,
        args: [id, date, input.planId ?? null, categoryId, title, now, null, track, null, now, now],
      },
    },
  };
}

/**
 * Starts one lane. Only ever displaces what was already running on THAT lane —
 * other lanes are deliberately untouched, which is the whole point of tracks.
 *
 * Two round trips, always:
 *
 *   1. one `"read"` batch holding every independent pre-check (does the
 *      category exist, does the plan exist and what does it say, who holds
 *      this lane);
 *   2. one `"write"` batch that stops the displaced row, inserts the new one,
 *      optionally reads both back, and finishes with the running-lanes SELECT.
 *      A trailing read in a `"write"` batch sees the writes ahead of it, so
 *      `lanes` is post-mutation truth from inside the same transaction.
 *
 * The partial UNIQUE index on (track) WHERE end_at IS NULL catches concurrent
 * starts on the same lane that race past step 1's snapshot, surfaced as
 * `concurrent-start`. Batching shrinks that window; the catch is still what
 * closes it.
 */
export async function startActual(
  input: StartActualInput,
  opts?: { hydrate?: true },
): Promise<StartActualResult>;
export async function startActual(
  input: StartActualInput,
  opts: { hydrate: false },
): Promise<StartActualResultLean>;
export async function startActual(
  input: StartActualInput,
  opts?: HydrateOptions,
): Promise<StartActualResult | StartActualResultLean> {
  await initDb();
  const hydrate = opts?.hydrate !== false;

  const reads: Stmt[] = [];
  const slots = pushStartReads(reads, input);
  const readRs = await batchStmts(reads, "read");

  const step = consumeStartReads(readRs, slots, input, Date.now());
  if (!step.ok) return { ok: false, reason: step.reason };
  const { prepared } = step;

  const stmts: Stmt[] = [];
  if (prepared.stop) stmts.push(prepared.stop);
  stmts.push(prepared.insert);
  const startedIdx = hydrate
    ? stmts.push({ sql: ACTUAL_BY_ID_SQL, args: [prepared.id] }) - 1
    : -1;
  const stoppedIdx =
    hydrate && prepared.displacedId
      ? stmts.push({ sql: ACTUAL_BY_ID_SQL, args: [prepared.displacedId] }) - 1
      : -1;
  const lanesIdx = stmts.push({ sql: RUNNING_LANES_SQL, args: [] }) - 1;

  let writeRs;
  try {
    writeRs = await batchStmts(stmts, "write");
  } catch (e) {
    if (isRunningUniqueViolation(e)) {
      return { ok: false, reason: "concurrent-start" };
    }
    throw e;
  }

  const lanes = toActuals(writeRs[lanesIdx]);
  if (!hydrate) return { ok: true, started: null, autoStopped: null, lanes };

  const started = firstActual(writeRs[startedIdx]);
  if (!started) throw new Error("Failed to start actual");
  const autoStopped = stoppedIdx >= 0 ? firstActual(writeRs[stoppedIdx]) : null;
  return { ok: true, started, autoStopped, lanes };
}

/**
 * Starts several lanes as one transaction: one read batch for every lane's
 * pre-checks, one write batch for every stop+insert plus the trailing
 * running-lanes SELECT. Two round trips for N lanes rather than 2N.
 *
 * All-or-nothing, which is stricter than starting them one at a time: if any
 * insert trips the running-row index the whole transaction rolls back and no
 * lane starts. That is the right trade for the caller this exists for
 * (resuming every lane after a break) — a half-resumed session is worse than a
 * failed one the user can retry.
 *
 * Never hydrates the written rows; `lanes` is the answer callers actually want.
 */
export async function startActuals(inputs: StartActualInput[]): Promise<StartActualsResult> {
  await initDb();
  if (inputs.length === 0) return { ok: true, lanes: await getRunningActuals() };

  const reads: Stmt[] = [];
  const slots = inputs.map((input) => pushStartReads(reads, input));
  const readRs = await batchStmts(reads, "read");

  const now = Date.now();
  const writes: Stmt[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const step = consumeStartReads(readRs, slots[i], inputs[i], now);
    if (!step.ok) return { ok: false, index: i, reason: step.reason };
    if (step.prepared.stop) writes.push(step.prepared.stop);
    writes.push(step.prepared.insert);
  }
  const lanesIdx = writes.push({ sql: RUNNING_LANES_SQL, args: [] }) - 1;

  try {
    const writeRs = await batchStmts(writes, "write");
    return { ok: true, lanes: toActuals(writeRs[lanesIdx]) };
  } catch (e) {
    if (isRunningUniqueViolation(e)) {
      // libsql surfaces the constraint, not the statement that tripped it, so
      // a multi-lane batch can't attribute the race to one input. With a
      // single input there is nothing to attribute it to but input 0.
      return { ok: false, index: inputs.length === 1 ? 0 : null, reason: "concurrent-start" };
    }
    throw e;
  }
}

export type StopActualResult = {
  stopped: CalendarActual | null; // null if nothing was running (idempotent)
  /** True when this call is the one that closed the row. False means the
   *  `end_at IS NULL` guard matched nothing — somebody else got there first,
   *  which is a successful no-op, not an error. */
  closed: boolean;
  /** Lanes still running afterwards, read in the same transaction as the stop. */
  lanes: CalendarActual[];
};

/** {@link stopActualById}'s result under `hydrate: false`: the row was closed,
 *  it just wasn't read back. `closed` still carries the race outcome. */
export type StopActualResultLean = {
  stopped: null;
  closed: boolean;
  lanes: CalendarActual[];
};

/**
 * Stops one running actual. With `track`, stops that lane; without, stops the
 * primary lane as {@link getRunningActual} defines it, preserving the original
 * single-timer call signature.
 *
 * To stop everything at once use {@link stopAllActuals} — an omitted track
 * deliberately does NOT mean "all", so a caller that forgets the argument
 * can't silently wipe out the user's other lanes.
 */
export async function stopActual(
  nowMs: number = Date.now(),
  track?: number,
): Promise<StopActualResult> {
  await initDb();
  const running =
    track === undefined
      ? await getRunningActual()
      : await getRunningActualOnTrack(track);
  if (!running) return { stopped: null, closed: false, lanes: await getRunningActuals() };
  return stopActualById(running.id, nowMs);
}

/**
 * Stops a specific actual by id. This is the lane-safe entry point for UIs
 * that address running rows directly rather than by lane number.
 *
 * One round trip: the UPDATE, an optional read-back of the row, and the
 * running-lanes SELECT all travel as a single `"write"` batch. The trailing
 * SELECT observes the UPDATE ahead of it, so `lanes` reflects the stop.
 */
export async function stopActualById(
  id: string,
  nowMs?: number,
  opts?: { hydrate?: true },
): Promise<StopActualResult>;
export async function stopActualById(
  id: string,
  nowMs: number | undefined,
  opts: { hydrate: false },
): Promise<StopActualResultLean>;
export async function stopActualById(
  id: string,
  nowMs: number = Date.now(),
  opts?: HydrateOptions,
): Promise<StopActualResult | StopActualResultLean> {
  await initDb();
  const hydrate = opts?.hydrate !== false;
  // `WHERE end_at IS NULL` makes this a no-op if a concurrent stop already
  // closed the row; rowsAffected===0 means we lost the race and the row was
  // already stopped by someone else. Either way we return the current state.
  const stmts: Stmt[] = [{ sql: STOP_ACTUAL_SQL, args: [nowMs, nowMs, id] }];
  const rowIdx = hydrate ? stmts.push({ sql: ACTUAL_BY_ID_SQL, args: [id] }) - 1 : -1;
  const lanesIdx = stmts.push({ sql: RUNNING_LANES_SQL, args: [] }) - 1;

  const rs = await batchStmts(stmts, "write");
  const closed = (rs[0].rowsAffected ?? 0) > 0;
  const lanes = toActuals(rs[lanesIdx]);
  if (!hydrate) return { stopped: null, closed, lanes };
  // `stopped` stays null when we lost the race, exactly as before: the caller
  // asked what THIS call closed, and the answer is nothing.
  return { stopped: closed ? firstActual(rs[rowIdx]) : null, closed, lanes };
}

/**
 * Stops every running lane at once — the "I'm done for now" action, and the
 * correct way to end a parallel session without leaving orphan lanes ticking.
 *
 * `lanes` is hard-coded to `[]` rather than read back, and that is exact
 * rather than optimistic: the UPDATE's own predicate is `end_at IS NULL`, so
 * once it commits there is provably no open row left. A trailing SELECT in the
 * same transaction could only ever return the empty set, and a SELECT issued
 * afterwards would be answering a different question ("has anyone started a
 * lane since?") that the pre-batch version never asked either. So the read is
 * not merely cheap to skip, it carries no information.
 *
 * `stopped` is a different matter — naming the rows this call closed requires
 * knowing which rows were open, so `hydrate: true` still pays for a snapshot
 * read first. Pass `hydrate: false` (one round trip, one statement) when the
 * caller only needs the lanes cleared.
 */
export async function stopAllActuals(
  nowMs?: number,
  opts?: { hydrate?: true },
): Promise<{ stopped: CalendarActual[]; lanes: CalendarActual[] }>;
export async function stopAllActuals(
  nowMs: number | undefined,
  opts: { hydrate: false },
): Promise<{ stopped: never[]; lanes: never[] }>;
export async function stopAllActuals(
  nowMs: number = Date.now(),
  opts?: HydrateOptions,
): Promise<{ stopped: CalendarActual[]; lanes: CalendarActual[] }> {
  await initDb();
  if (opts?.hydrate === false) {
    await db.execute({ sql: STOP_ALL_ACTUALS_SQL, args: [nowMs, nowMs] });
    return { stopped: [], lanes: [] };
  }

  const running = await getRunningActuals();
  if (running.length === 0) return { stopped: [], lanes: [] };
  // Read the closed rows back inside the same transaction as the UPDATE, by
  // the ids we just snapshotted — one statement for all N instead of the N
  // parallel point reads this used to fan out.
  const placeholders = running.map(() => "?").join(", ");
  const rs = await batchStmts(
    [
      { sql: STOP_ALL_ACTUALS_SQL, args: [nowMs, nowMs] },
      {
        sql: `${ACTUAL_SELECT}
          WHERE a.id IN (${placeholders})
          ORDER BY a.track ASC`,
        args: running.map((r) => r.id),
      },
    ],
    "write",
  );
  return { stopped: toActuals(rs[1]), lanes: [] };
}

export type ActualPatch = Partial<{
  categoryId: string | null;
  title: string | null;
  startAt: number;
  endAt: number | null;
  notes: string | null;
}>;

export type UpdateActualResult =
  | { ok: true; actual: CalendarActual }
  | { ok: false; reason: "not-found" | "start-after-end" | "would-overlap-running" | "invalid-category" };

/** {@link updateActual}'s result under `hydrate: false` — written, not read back. */
export type UpdateActualResultLean =
  | { ok: true; actual: null }
  | { ok: false; reason: "not-found" | "start-after-end" | "would-overlap-running" | "invalid-category" };

type MergedActual = {
  categoryId: string | null;
  title: string | null;
  startAt: number;
  endAt: number | null;
  notes: string | null;
};

/**
 * Pure merge + invariant check, split out so `updateActual` and the fused
 * describe-then-close path in {@link segmentActuals} apply byte-identical
 * rules and return byte-identical reasons.
 *
 * `running` is whoever holds this row's lane, already fetched by the caller.
 */
function mergeAndValidateActual(
  id: string,
  existing: CalendarActual,
  patch: ActualPatch,
  running: CalendarActual | null,
): { ok: true; merged: MergedActual } | { ok: false; reason: "start-after-end" | "would-overlap-running" } {
  const merged: MergedActual = {
    categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
    title: patch.title !== undefined ? patch.title : existing.title,
    startAt: patch.startAt !== undefined ? patch.startAt : existing.startAt,
    endAt: patch.endAt !== undefined ? patch.endAt : existing.endAt,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
  };

  if (merged.endAt !== null && merged.startAt >= merged.endAt) {
    return { ok: false, reason: "start-after-end" };
  }

  // Single-active invariant, scoped to this row's own lane. Overlapping a
  // running row on a DIFFERENT track is the entire point of parallel tracks
  // (coding while a workout is timed), so only same-lane collisions are
  // rejected here.
  if (merged.endAt === null) {
    // Becoming/staying running: no OTHER row may hold this lane.
    if (running && running.id !== id) {
      return { ok: false, reason: "would-overlap-running" };
    }
  } else if (running && running.id !== id && merged.endAt > running.startAt) {
    // Now stopped: must not span the start of this lane's running row.
    return { ok: false, reason: "would-overlap-running" };
  }

  return { ok: true, merged };
}

function updateActualStmt(id: string, merged: MergedActual, nowMs: number): Stmt {
  return {
    sql: UPDATE_ACTUAL_SQL,
    args: [merged.categoryId, merged.title, merged.startAt, merged.endAt, merged.notes, nowMs, id],
  };
}

/**
 * Two round trips: one `"read"` batch for all three pre-checks, one `"write"`
 * batch for the UPDATE and (unless `hydrate: false`) the read-back.
 *
 * The pre-checks used to be issued serially because the lane lookup needed
 * `existing.track`, which only arrives with the first read. `RUNNING_ON_LANE_OF_SQL`
 * re-derives the lane with a correlated subquery instead, which frees all
 * three to travel together.
 */
export async function updateActual(
  id: string,
  patch: ActualPatch,
  opts?: { hydrate?: true },
): Promise<UpdateActualResult>;
export async function updateActual(
  id: string,
  patch: ActualPatch,
  opts: { hydrate: false },
): Promise<UpdateActualResultLean>;
export async function updateActual(
  id: string,
  patch: ActualPatch,
  opts?: HydrateOptions,
): Promise<UpdateActualResult | UpdateActualResultLean> {
  await initDb();
  const hydrate = opts?.hydrate !== false;

  const reads: Stmt[] = [{ sql: ACTUAL_BY_ID_SQL, args: [id] }];
  const catIdx = patch.categoryId
    ? reads.push({ sql: CATEGORY_EXISTS_SQL, args: [patch.categoryId] }) - 1
    : -1;
  const laneIdx = reads.push({ sql: RUNNING_ON_LANE_OF_SQL, args: [id] }) - 1;
  const readRs = await batchStmts(reads, "read");

  // Check order is load-bearing: callers surface `reason` verbatim, so
  // not-found must still win over invalid-category, and both over the
  // interval checks.
  const existing = firstActual(readRs[0]);
  if (!existing) return { ok: false, reason: "not-found" };
  if (catIdx >= 0 && readRs[catIdx].rows.length === 0) {
    return { ok: false, reason: "invalid-category" };
  }

  const checked = mergeAndValidateActual(id, existing, patch, firstActual(readRs[laneIdx]));
  if (!checked.ok) return { ok: false, reason: checked.reason };

  // Catch the partial UNIQUE violation as a fallback for the TOCTOU window
  // between the read batch above and the UPDATE below. App-level pre-check
  // gives a cleaner error in the uncontested case; the catch covers races.
  // Batching the pre-checks narrowed that window, it did not remove it.
  const stmts: Stmt[] = [updateActualStmt(id, checked.merged, Date.now())];
  const rowIdx = hydrate ? stmts.push({ sql: ACTUAL_BY_ID_SQL, args: [id] }) - 1 : -1;
  let writeRs;
  try {
    writeRs = await batchStmts(stmts, "write");
  } catch (e) {
    if (isRunningUniqueViolation(e)) {
      return { ok: false, reason: "would-overlap-running" };
    }
    throw e;
  }
  if (!hydrate) return { ok: true, actual: null };
  const updated = firstActual(writeRs[rowIdx]);
  if (!updated) throw new Error("Failed to load updated actual");
  return { ok: true, actual: updated };
}

/** What a segment reopens with. Same shape as a start, minus the two fields
 *  {@link segmentActuals} supplies for the whole batch. */
export type LaneResume = Omit<StartActualInput, "timezone" | "nowMs">;

export type LaneSegment = {
  /** The running row to describe and close. */
  id: string;
  /** Written onto the row BEFORE it is closed. Omit (or pass an empty object)
   *  to close without describing — which also skips the pre-checks a describe
   *  needs, exactly as the un-fused stop+describe pair did. */
  patch?: ActualPatch;
  /** Non-null to immediately reopen the lane with a fresh row. */
  resume: LaneResume | null;
};

export type SegmentActualsResult =
  | { ok: true; lanes: CalendarActual[] }
  | {
      ok: false;
      /** Which segment failed; null only when a constraint race in the shared
       *  transaction can't be pinned on one of several segments. */
      index: number | null;
      /** Which half failed. `invalid-category` can come from either, so
       *  callers need this to phrase the message the way they always have. */
      phase: "close" | "open";
      reason:
        | "not-found"
        | "start-after-end"
        | "would-overlap-running"
        | "invalid-category"
        | "invalid-plan"
        | "concurrent-start";
    };

/**
 * Closes a set of running rows — each optionally described first, each
 * optionally reopened — as ONE transaction, in two round trips regardless of
 * how many lanes are involved.
 *
 * The describe-then-close ordering is the whole reason this exists as a fused
 * operation rather than a loop over `updateActual` + `stopActualById`. Writing
 * the description while the row is still running keeps the note attached to
 * the right entry even if the close then loses a race to another client;
 * statements inside a `db.batch` execute in the order given, so the ordering
 * survives the fusing intact.
 *
 * The lane snapshot for a resume is taken in the read batch, i.e. BEFORE the
 * close — same as `startActual`, and normally it just names the row this
 * segment is about to close, which is why that stop is emitted once rather
 * than twice. If some other client has taken the lane in the meantime it gets
 * displaced, which is exactly what starting a lane has always meant.
 *
 * `opts.timezone` is only consulted by resuming segments (it anchors the new
 * row's `date`), so a pure close needs no site config read at all. Passing a
 * resuming segment without it is a programming error, not a runtime condition.
 */
export async function segmentActuals(
  segments: LaneSegment[],
  opts?: { nowMs?: number; timezone?: string },
): Promise<SegmentActualsResult> {
  await initDb();
  if (segments.length === 0) return { ok: true, lanes: await getRunningActuals() };

  const now = opts?.nowMs ?? Date.now();
  const timezone = opts?.timezone;

  type SegmentSlots = {
    existing: number;
    category: number;
    lane: number;
    start: StartReadSlots | null;
    startInput: StartActualInput | null;
  };

  const reads: Stmt[] = [];
  const slots: SegmentSlots[] = segments.map((seg) => {
    const s: SegmentSlots = { existing: -1, category: -1, lane: -1, start: null, startInput: null };
    const patch = seg.patch;
    if (patch && Object.keys(patch).length > 0) {
      s.existing = reads.push({ sql: ACTUAL_BY_ID_SQL, args: [seg.id] }) - 1;
      if (patch.categoryId) {
        s.category = reads.push({ sql: CATEGORY_EXISTS_SQL, args: [patch.categoryId] }) - 1;
      }
      s.lane = reads.push({ sql: RUNNING_ON_LANE_OF_SQL, args: [seg.id] }) - 1;
    }
    if (seg.resume) {
      if (!timezone) {
        throw new Error("segmentActuals: a resuming segment requires opts.timezone");
      }
      s.startInput = { ...seg.resume, timezone, nowMs: now };
      s.start = pushStartReads(reads, s.startInput);
    }
    return s;
  });

  const readRs = reads.length > 0 ? await batchStmts(reads, "read") : [];

  const writes: Stmt[] = [];
  let anyResume = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const s = slots[i];

    if (s.existing >= 0 && seg.patch) {
      const existing = firstActual(readRs[s.existing]);
      if (!existing) return { ok: false, index: i, phase: "close", reason: "not-found" };
      if (s.category >= 0 && readRs[s.category].rows.length === 0) {
        return { ok: false, index: i, phase: "close", reason: "invalid-category" };
      }
      const checked = mergeAndValidateActual(
        seg.id,
        existing,
        seg.patch,
        firstActual(readRs[s.lane]),
      );
      if (!checked.ok) return { ok: false, index: i, phase: "close", reason: checked.reason };
      writes.push(updateActualStmt(seg.id, checked.merged, now));
    }

    writes.push({ sql: STOP_ACTUAL_SQL, args: [now, now, seg.id] });

    if (s.start && s.startInput) {
      anyResume = true;
      const step = consumeStartReads(readRs, s.start, s.startInput, now);
      if (!step.ok) return { ok: false, index: i, phase: "open", reason: step.reason };
      // The row we just closed is normally the very row holding the lane, so
      // its stop is already queued above — don't queue it twice.
      if (step.prepared.stop && step.prepared.displacedId !== seg.id) {
        writes.push(step.prepared.stop);
      }
      writes.push(step.prepared.insert);
    }
  }

  const lanesIdx = writes.push({ sql: RUNNING_LANES_SQL, args: [] }) - 1;

  try {
    const writeRs = await batchStmts(writes, "write");
    return { ok: true, lanes: toActuals(writeRs[lanesIdx]) };
  } catch (e) {
    if (isRunningUniqueViolation(e)) {
      // libsql reports the constraint, not the statement, so attribute the
      // race to the only kind of statement in this batch that can plausibly
      // trip it: an INSERT of a new open row. With no resume in the batch the
      // only remaining candidate is a describe-UPDATE reopening a taken lane.
      const index = segments.length === 1 ? 0 : null;
      return anyResume
        ? { ok: false, index, phase: "open", reason: "concurrent-start" }
        : { ok: false, index, phase: "close", reason: "would-overlap-running" };
    }
    throw e;
  }
}

export async function deleteActual(id: string): Promise<{ ok: boolean }> {
  await initDb();
  const result = await db.execute({
    sql: "DELETE FROM calendar_actuals WHERE id = ?",
    args: [id],
  });
  return { ok: (result.rowsAffected ?? 0) > 0 };
}

export type CreateActualInput = {
  startAt: number;
  endAt: number;
  categoryId?: string | null;
  title?: string | null;
  planId?: string | null;
  notes?: string | null;
  timezone: string;
  /** Lane to file this entry under. Defaults to 0 (the primary lane). */
  track?: number;
};

export type CreateActualResult =
  | { ok: true; actual: CalendarActual }
  | { ok: false; reason: "start-after-end" | "invalid-category" | "invalid-plan" };

/**
 * Backfills a closed (non-running) actual with explicit start/end times. Does
 * NOT touch the partial UNIQUE running-row index because end_at is set.
 */
export async function createActual(input: CreateActualInput): Promise<CreateActualResult> {
  await initDb();
  if (input.startAt >= input.endAt) return { ok: false, reason: "start-after-end" };
  if (input.categoryId && !(await categoryExists(input.categoryId))) {
    return { ok: false, reason: "invalid-category" };
  }
  if (input.planId && !(await planExists(input.planId))) {
    return { ok: false, reason: "invalid-plan" };
  }
  const id = randomUUID();
  const now = Date.now();
  const date = epochToDateInTz(input.startAt, input.timezone);
  await db.execute({
    sql: `INSERT INTO calendar_actuals
          (id, date, plan_id, category_id, title, start_at, end_at, track, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      date,
      input.planId ?? null,
      input.categoryId ?? null,
      input.title ?? null,
      input.startAt,
      input.endAt,
      input.track ?? 0,
      input.notes ?? null,
      now,
      now,
    ],
  });
  const created = await getActualById(id);
  if (!created) throw new Error("Failed to create actual");
  return { ok: true, actual: created };
}

/**
 * Batched loader for the day-view page: tasks + actuals + categories in a
 * single libsql round trip. Any running actual is already included in
 * `actuals` via the `(end_at IS NULL AND date <= ?)` clause, so consumers
 * derive it via `actuals.find(a => a.endAt === null)`.
 */
export type DayPageData = {
  tasks: CalendarTask[];
  actuals: CalendarActual[];
  categories: CalendarCategory[];
};

export async function loadDayPageData(date: string, yesterday: string): Promise<DayPageData> {
  await initDb();
  const [tasksRs, actualsRs, categoriesRs] = await db.batch(
    [
      {
        sql: `SELECT t.*, c.id AS cat_id, c.name AS cat_name, c.color AS cat_color
              FROM calendar_tasks t
              LEFT JOIN calendar_categories c ON c.id = t.category_id
              WHERE t.date BETWEEN ? AND ?
              ORDER BY t.date ASC, t.position ASC, t.created_at ASC`,
        args: [date, date],
      },
      {
        sql: `${ACTUAL_SELECT}
              WHERE (a.date BETWEEN ? AND ?)
                 OR (a.end_at IS NULL AND a.date <= ?)
              ORDER BY a.start_at ASC`,
        args: [yesterday, date, date],
      },
      {
        sql: `SELECT * FROM calendar_categories
              ORDER BY archived ASC, is_system DESC, position ASC, LOWER(name) ASC`,
        args: [],
      },
    ],
    "read",
  );

  const tasks = (tasksRs.rows as unknown as DbCalendarTaskJoined[]).map(rowToTask);
  const actuals = toActuals(actualsRs);
  const categories = (categoriesRs.rows as unknown as DbCalendarCategory[]).map(rowToCategory);

  return { tasks, actuals, categories };
}

/**
 * Returns { "YYYY-MM-DD": fillRatio } across the given inclusive date range,
 * where fillRatio in (0, 1] is fulfilled overlap minutes divided by
 * min(8h, total planned minutes that day) — see the loop below.
 *
 * Each plan has one "parent" candidate (its own interval + category) and, if
 * it's uncertain, one extra candidate per alternative (alt's interval +
 * (categoryId, title)). Per-candidate match rules:
 *
 *   - parent:      actual.category_id === plan.category_id (title irrelevant)
 *   - alternative: actual.category_id === alt.categoryId AND
 *                  trim/lower(actual.title) === trim/lower(alt.title)
 *
 * For each candidate we collect the sub-intervals where matching actuals
 * overlap the candidate's own time slot. The plan's score is the union length
 * of those sub-intervals across parent + all alternatives — overlapping
 * candidates fulfilled by the same actual minute count once, not multiple
 * times. Per-day total is the sum across plans on that day.
 *
 * Cross-midnight actuals are clamped to each day they touch. Running actuals
 * (`end_at IS NULL`) clamp to "now".
 */
export async function getOverlapHeatmapForRange(
  from: string,
  to: string,
  timezone: string,
): Promise<Record<string, number>> {
  await initDb();
  const dayBefore = addDays(from, -1);

  const [tasksRs, actualsRs] = await db.batch(
    [
      {
        sql: `SELECT date, start_time, end_time, category_id, is_uncertain, fallbacks
              FROM calendar_tasks
              WHERE date BETWEEN ? AND ?
                AND start_time IS NOT NULL AND end_time IS NOT NULL`,
        args: [from, to],
      },
      {
        sql: `SELECT date, start_at, end_at, category_id, title FROM calendar_actuals
              WHERE date BETWEEN ? AND ?`,
        args: [dayBefore, to],
      },
    ],
    "read",
  );

  type PlanRow = {
    interval: readonly [number, number];
    categoryId: string | null;
    isUncertain: boolean;
    fallbacks: PlanFallback[];
  };
  type ActualSlice = {
    interval: readonly [number, number];
    categoryId: string | null;
    /** Pre-lowercased + trimmed at filter-time for case-insensitive title match. */
    titleLower: string | null;
  };

  const plansByDate = new Map<string, PlanRow[]>();
  for (const row of tasksRs.rows as unknown as {
    date: string;
    start_time: string;
    end_time: string;
    category_id: string | null;
    is_uncertain: number;
    fallbacks: string | null;
  }[]) {
    const start = hhmmToMinutes(row.start_time);
    const end = hhmmToMinutes(row.end_time);
    if (start === null || end === null || end <= start) continue;
    const isUncertain = row.is_uncertain === 1;
    const plan: PlanRow = {
      interval: [start, end],
      categoryId: row.category_id,
      isUncertain,
      // Strict plans don't need fallbacks at scoring time — skip the parse.
      fallbacks: isUncertain ? parseFallbacks(row.fallbacks) : [],
    };
    const arr = plansByDate.get(row.date) ?? [];
    arr.push(plan);
    plansByDate.set(row.date, arr);
  }

  const now = Date.now();
  const actualsByDate = new Map<string, ActualSlice[]>();
  for (const row of actualsRs.rows as unknown as {
    date: string;
    start_at: number;
    end_at: number | null;
    category_id: string | null;
    title: string | null;
  }[]) {
    const startsOn = row.date;
    const endsOn = epochToDateInTz(row.end_at ?? now, timezone);
    // Walk every day the actual touches, not just its endpoints: an actual
    // spanning 3+ days must populate intermediate days too, or plans on those
    // days never match and their heatmap fill is wrongly zero.
    const datesToCheck: string[] = [];
    for (let current = startsOn; current <= endsOn; current = addDays(current, 1)) {
      datesToCheck.push(current);
    }
    const titleLower = row.title ? row.title.trim().toLowerCase() : null;
    for (const d of datesToCheck) {
      if (d < from || d > to) continue;
      const w = clampActualToDay(d, row.start_at, row.end_at, timezone, now);
      if (!w) continue;
      const arr = actualsByDate.get(d) ?? [];
      arr.push({
        interval: [w.startMin, w.endMin],
        categoryId: row.category_id,
        titleLower,
      });
      actualsByDate.set(d, arr);
    }
  }

  const FULL_DAY: [number, number][] = [[0, 1440]];
  // Heatmap fills relative to the day's own plan, not an absolute clock: a fully
  // followed light day should still register more than an ignored heavy one.
  // Denominator = plannedMinutes clamped to [MIN_TARGET, FULL_TARGET]:
  //   - FULL_TARGET (8h) caps the "full" threshold so marathon plans don't
  //     require an unreachable amount of follow-through.
  //   - MIN_TARGET (4h) floors it so a trivially small plan (say 30 min) that's
  //     fully followed can't paint the whole day at max intensity. Without the
  //     floor the map saturates — most days hit 1.0 and everything reads white.
  //     With it, a cell only approaches white after a meaningful chunk of the
  //     day was actually spent on-plan.
  const FULL_TARGET_MIN = 8 * 60;
  const MIN_TARGET_MIN = 4 * 60;
  const out: Record<string, number> = {};
  for (const [date, plans] of plansByDate) {
    const dayActuals = actualsByDate.get(date);
    if (!dayActuals || dayActuals.length === 0) continue;
    let total = 0;
    let plannedMinutes = 0;
    for (const plan of plans) {
      plannedMinutes += plan.interval[1] - plan.interval[0];
      // Collect fulfilled sub-intervals across the parent + alternatives. Each
      // matching actual gets clipped to its candidate's interval before being
      // unioned, so a candidate at 18:00–19:00 fulfilled by an actual that
      // ran 17:30–18:30 contributes only [18:00, 18:30].
      const fulfilled: [number, number][] = [];

      // Parent candidate: category-only match.
      for (const a of dayActuals) {
        if (a.categoryId !== plan.categoryId) continue;
        const lo = Math.max(a.interval[0], plan.interval[0]);
        const hi = Math.min(a.interval[1], plan.interval[1]);
        if (hi > lo) fulfilled.push([lo, hi]);
      }

      // Alternative candidates: category AND title both must match.
      if (plan.isUncertain) {
        for (const alt of plan.fallbacks) {
          const altStart = hhmmToMinutes(alt.startTime);
          const altEnd = hhmmToMinutes(alt.endTime);
          if (altStart === null || altEnd === null || altEnd <= altStart) continue;
          const altTitleLower = alt.title.trim().toLowerCase();
          for (const a of dayActuals) {
            if (a.categoryId !== alt.categoryId) continue;
            if (a.titleLower !== altTitleLower) continue;
            const lo = Math.max(a.interval[0], altStart);
            const hi = Math.min(a.interval[1], altEnd);
            if (hi > lo) fulfilled.push([lo, hi]);
          }
        }
      }

      if (fulfilled.length === 0) continue;
      // Intersecting with the full day is a no-op after the helper's internal
      // normalize step — saves us exporting normalizeIntervals just for this.
      total += intervalIntersectionMinutes(fulfilled, FULL_DAY);
    }
    if (total > 0 && plannedMinutes > 0) {
      const denom = Math.min(FULL_TARGET_MIN, Math.max(MIN_TARGET_MIN, plannedMinutes));
      out[date] = Math.min(1, total / denom);
    }
  }
  return out;
}
