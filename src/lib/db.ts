import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { SLEEP_CATEGORY_ID } from "./calendar-constants";

export { SLEEP_CATEGORY_ID };

/** A missing connection variable used to reach the driver as `undefined` and
 *  surface as whatever opaque parse error it produced — at module evaluation,
 *  so the stack pointed at `createClient` rather than at the deployment that
 *  forgot to set the variable. Name it instead. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; the app cannot reach its database.`);
  }
  return value;
}

export const db = createClient({
  url: requireEnv("TURSO_DATABASE_URL"),
  authToken: requireEnv("TURSO_AUTH_TOKEN"),
});

// ---------------------------------------------------------------------------
// Migration data
//
// The migration is expressed as data rather than a sequence of awaits so that
// (a) it can be batched into a handful of round trips and (b) it can be hashed
// into a fingerprint — see SCHEMA_FINGERPRINT below.
// ---------------------------------------------------------------------------

const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      year INTEGER NOT NULL,
      tech TEXT NOT NULL,
      link TEXT,
      repo TEXT,
      live TEXT,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  `CREATE TABLE IF NOT EXISTS site_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  `CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      data TEXT NOT NULL,
      article_slug TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      first_attempt INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS api_mutation_rate (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      first_attempt INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS pat_counter (
      id INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )`,
  `INSERT OR IGNORE INTO pat_counter (id, count) VALUES (1, 0)`,
  `CREATE TABLE IF NOT EXISTS pat_rate (
      ip TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      pats INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS calendar_tasks (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      start_time TEXT,
      end_time TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      category_id TEXT,
      is_uncertain INTEGER NOT NULL DEFAULT 0,
      fallbacks TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_tasks_date ON calendar_tasks(date)`,
  `CREATE TABLE IF NOT EXISTS calendar_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_categories_name_lower ON calendar_categories(LOWER(name))`,
  // FK clauses below are declarative; libsql does not enable
  // PRAGMA foreign_keys per-connection, so SET NULL is enforced
  // at the app level (see calendar-categories.ts deleteCategory).
  `CREATE TABLE IF NOT EXISTS calendar_actuals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      plan_id TEXT,
      category_id TEXT,
      title TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      track INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES calendar_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES calendar_categories(id) ON DELETE SET NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_actuals_date ON calendar_actuals(date)`,
  // categoryUsage() scans by category_id before every category delete, and the
  // entry list orders the whole table by start_at on every homepage render.
  // Both were full table scans.
  `CREATE INDEX IF NOT EXISTS idx_calendar_actuals_category ON calendar_actuals(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_actuals_start_at ON calendar_actuals(start_at)`,
  // The subject page pages entries with `WHERE category_id = ? ORDER BY
  // start_at DESC LIMIT ?`. On the single-column category index above, SQLite
  // can seek the subject but must then sort every one of its rows to find the
  // newest handful — the sort grows with the subject while the page stays 20
  // rows. Leading with the same equality column and carrying `start_at` as the
  // second lets the index satisfy the ordering too, so the LIMIT stops the scan
  // early. The single-column index stays: categoryUsage() counts by category
  // alone and is better served by the narrower one.
  `CREATE INDEX IF NOT EXISTS idx_calendar_actuals_category_start ON calendar_actuals(category_id, start_at)`,
  // NOTE: the partial UNIQUE index guarding the running-row invariant lives in
  // POST_STEPS, not here, because it is built on `track` — a column older
  // installations only acquire via COLUMN_SPECS a step later.
  `CREATE TABLE IF NOT EXISTS prayer_times_cache (
      cache_key TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      method INTEGER NOT NULL,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )`,
];

type ColumnSpec = { table: string; column: string; type: string };

// Idempotent column migrations for installations that predate these columns.
// The CREATE TABLE statements above already include them for fresh schemas;
// these add them to older deployments without dropping data.
const COLUMN_SPECS: ColumnSpec[] = [
  { table: "calendar_tasks", column: "category_id", type: "TEXT" },
  { table: "calendar_tasks", column: "is_uncertain", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "calendar_tasks", column: "fallbacks", type: "TEXT" },
  { table: "items", column: "pinned", type: "INTEGER NOT NULL DEFAULT 0" },
  // Parallel tracks. `track` lanes concurrent activity — working out while a
  // build runs, studying while socialising — so two things happening at once
  // are two rows, not a lie about one of them. Pre-existing rows default to
  // lane 0, which is exactly where the old single-timer behaviour lived, so
  // this is a pure widening: nothing that worked before changes meaning.
  { table: "calendar_actuals", column: "track", type: "INTEGER NOT NULL DEFAULT 0" },
];

// Runs on EVERY cold start, including the fingerprint fast path — it rides
// along in the probe batch below, so it costs no extra round trip.
//
// It has to be unconditional because this database is shared with
// justin06lee.dev. The old global index forbids exactly the second concurrent
// lane that this app's per-lane index exists to allow, so if the sibling app
// ever re-creates it, a fingerprint-gated drop would never run again and
// starting lane 1 while lane 0 runs would fail forever — reported to the user
// as "that lane was just started somewhere else", with no recovery short of a
// code edit. Dropping every time is a cheap no-op and closes that hole.
//
// Safe on a fresh database too: `DROP INDEX IF EXISTS` resolves the index by
// name and no-ops when it is absent, whether or not the table exists yet.
const DROP_LEGACY_RUNNING_INDEX = `DROP INDEX IF EXISTS idx_calendar_actuals_running`;

const POST_STEPS: string[] = [
  // Make the index below creatable. `CREATE UNIQUE INDEX` does not skip
  // offending rows — it fails outright if the table already holds two open rows
  // on one track, which a crashed migration or the sibling app can leave
  // behind. That failure rejects initDb(), so EVERY page 500s on EVERY cold
  // start with no recovery short of a code edit. Closing the duplicates first
  // turns an unrecoverable state into a repaired one.
  //
  // The EXISTS names one strictly-newer open row on the SAME track under the
  // total order (start_at, id), so per track exactly the maximum survives and
  // every other open row on that track is closed. Consequences worth being
  // explicit about, because this runs against a shared production database:
  //   - a track whose only open row is that row matches nothing (the
  //     comparison is strict and cannot find the row itself), so a legitimately
  //     running lane is never touched;
  //   - `=` rather than `IS` mirrors the index exactly, which treats NULLs as
  //     distinct, so it closes precisely the rows the index would reject;
  //   - re-running finds one open row per track and updates nothing, which is
  //     also why the normal case — at most one open row per track — is a no-op;
  //   - it only ever sets `end_at`; no row is deleted and no other column moves.
  // MAX() rather than a bare `updated_at` because a row whose updated_at
  // predates its start_at would otherwise be closed before it began, and a
  // negative duration would corrupt every total that reads it.
  `UPDATE calendar_actuals
          SET end_at = MAX(start_at, updated_at)
          WHERE end_at IS NULL
            AND EXISTS (
              SELECT 1 FROM calendar_actuals o
               WHERE o.end_at IS NULL
                 AND o.track = calendar_actuals.track
                 AND (o.start_at > calendar_actuals.start_at
                      OR (o.start_at = calendar_actuals.start_at
                          AND o.id > calendar_actuals.id))
            )`,
  // The running-row invariant is per-lane: at most one open row PER track
  // rather than one globally. This must run after the `calendar_actuals.track`
  // migration so the indexed column is guaranteed to exist — hence a separate
  // batch, issued after the ALTERs — and after DROP_LEGACY_RUNNING_INDEX,
  // which the probe batch has already applied by this point. The repair above
  // and this creation share a batch, so no writer can slip a second open row
  // in between them.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_actuals_running_track
          ON calendar_actuals(track) WHERE end_at IS NULL`,
  // One-time cleanup of pre-2026-05 fallback rows. The old shape was
  // `[{"type":"category"|"title", ...}]`; the new shape has no `"type"` key.
  // The runtime parser already discards old rows silently, but clearing the
  // column here means re-edits don't show ghost-uncertain tasks with no alts.
  // Idempotent: subsequent runs find no `"type":` substrings and no-op.
  `UPDATE calendar_tasks SET fallbacks = NULL WHERE fallbacks LIKE '%"type":%'`,
];

// Seed the built-in Sleep category if not present. Kept out of POST_STEPS
// because it takes arguments; its timestamps are per-run, so only the SQL and
// the stable arguments feed the fingerprint.
const SLEEP_SEED_SQL = `INSERT INTO calendar_categories (id, name, color, is_system, archived, position, created_at, updated_at)
          SELECT ?, 'Sleep', ?, 1, 0, 0, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM calendar_categories WHERE LOWER(name) = 'sleep')`;
const SLEEP_COLOR = "#5b5b8a";

// Derived from the migration content itself — the DDL, the column specs, the
// post-steps, and the seed. That is the whole point: ANY future edit to that
// data changes this hash, which makes the next cold start re-run the full
// migration. Nobody has to remember to bump a version number, and nobody can
// ship a schema edit that silently never runs.
const SCHEMA_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify([
      SCHEMA_DDL,
      COLUMN_SPECS,
      DROP_LEGACY_RUNNING_INDEX,
      POST_STEPS,
      SLEEP_SEED_SQL,
      SLEEP_CATEGORY_ID,
      SLEEP_COLOR,
    ]),
  )
  .digest("hex")
  .slice(0, 16);

// Memoize so initDb() costs ~0 after the first call in a worker process.
// Without this, every lib function call (7+ per request) re-runs the full
// schema batch — adding hundreds of ms to each page load.
let initPromise: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!initPromise) {
    // Clear the memo on failure. A rejected promise cached here would poison
    // the worker forever: one transient network blip on a cold start and every
    // later request in that process fails permanently. The rejection is still
    // re-thrown so the caller that triggered it sees the error; only the next
    // caller gets a fresh attempt. (The reset runs in a microtask, after this
    // assignment, so it can never null out the promise being installed.)
    initPromise = doInit().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  // Fast path: one round trip to learn whether the schema is already current.
  // Creating the bookkeeping table and reading the fingerprint travel together
  // as a single batch, so a warm schema costs exactly one hop instead of the
  // ten the full migration below needs.
  //
  // The 'fingerprint' key is scoped to this app's migration set. The database
  // is shared with justin06lee.dev, which runs its own schema code; if that
  // site ever adopts this pattern it must use a different key.
  const probe = await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      DROP_LEGACY_RUNNING_INDEX,
      `SELECT value FROM schema_state WHERE key = 'fingerprint'`,
    ],
    "write",
  );
  if (probe[2].rows[0]?.value === SCHEMA_FINGERPRINT) return;

  // Slow path. Two cold workers can reach here at once and both migrate; that
  // is safe because every statement below is idempotent (CREATE/DROP ... IF
  // [NOT] EXISTS, ALTER only for genuinely missing columns, guarded INSERTs),
  // so the loser of the race simply redoes work that changes nothing.
  await db.batch(SCHEMA_DDL, "write");

  // One batch for all the column checks: three distinct PRAGMA reads cover
  // five column specs, so dedupe by table rather than paying a hop per column
  // the way the old ensureColumn() did.
  //
  // Deliberately "deferred" (the driver's default) rather than "read". These
  // are pure metadata reads, but "read" opens a READONLY transaction and it is
  // not worth betting a cold start on how sqld classifies a PRAGMA inside one:
  // this runs on the migration path, so a wrong guess here fails the very
  // first request after a deploy. A read-only transaction would buy nothing —
  // there is no snapshot consistency to protect across a single metadata probe.
  for (const spec of COLUMN_SPECS) assertSafeColumnSpec(spec);
  const tables = [...new Set(COLUMN_SPECS.map((s) => s.table))];
  const infos = await db.batch(
    tables.map((t) => `PRAGMA table_info(${t})`),
    "deferred",
  );
  const existing = new Map<string, Set<string>>(
    tables.map((t, i) => [
      t,
      new Set((infos[i].rows as unknown as { name: string }[]).map((r) => r.name)),
    ]),
  );

  // Issued one at a time rather than as a batch, and this is the one place we
  // deliberately spend round trips instead of saving them.
  //
  // `ALTER TABLE ... ADD COLUMN` is the only non-idempotent statement in this
  // migration: there is no `IF NOT EXISTS` form, and the PRAGMA read above is
  // a separate round trip, so two cold workers can both observe a column
  // missing and both try to add it. In a batch the loser's `duplicate column
  // name` aborts and rolls back the whole transaction, doInit rejects, the
  // request 500s, and — because the fingerprint is never written — it repeats
  // on the next cold start too. Individually, the loser swallows the error for
  // the column that already exists and the rest still apply.
  //
  // The cost is bounded and paid at most once per database: this loop is empty
  // whenever the columns are already present, which is every run after the
  // first.
  const alters = COLUMN_SPECS.filter((s) => !existing.get(s.table)!.has(s.column));
  for (const s of alters) {
    try {
      await db.execute({
        sql: `ALTER TABLE ${s.table} ADD COLUMN ${s.column} ${s.type}`,
        args: [],
      });
    } catch (e) {
      // Lost the race to a concurrent worker — the column is there, which is
      // all we wanted. Anything else is a real failure and must propagate.
      if (!/duplicate column name/i.test((e as { message?: string })?.message ?? "")) throw e;
    }
  }

  // Everything that has to happen after the columns exist, in one hop. Order
  // is preserved within a batch, so the index rebuild still lands before the
  // data repairs, and the fingerprint is written last — only a batch that
  // fully succeeded records itself as done.
  await db.batch(
    [
      ...POST_STEPS,
      { sql: SLEEP_SEED_SQL, args: [SLEEP_CATEGORY_ID, SLEEP_COLOR, Date.now(), Date.now()] },
      {
        sql: `INSERT OR REPLACE INTO schema_state (key, value) VALUES ('fingerprint', ?)`,
        args: [SCHEMA_FINGERPRINT],
      },
    ],
    "write",
  );

  // Consequence of the fingerprint gate worth naming: the one-time `fallbacks`
  // cleanup and the Sleep seed now only re-run when the fingerprint changes,
  // not on every cold start. Both are one-time repairs, so that is correct —
  // and the Sleep row cannot disappear behind our backs, because deleteCategory
  // refuses to delete `is_system` rows.
}

// SQLite cannot parameterize identifiers, so table/column/type strings are
// interpolated directly into the PRAGMA and ALTER statements above. Allowlist
// them so a non-literal spec could never smuggle SQL in.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_TYPE = /^[A-Za-z0-9_ ()]+$/;

function assertSafeColumnSpec({ table, column, type }: ColumnSpec): void {
  if (!SAFE_IDENT.test(table) || !SAFE_IDENT.test(column) || !SAFE_TYPE.test(type)) {
    throw new Error(`ensureColumn: unsafe identifier(s): ${table}.${column} ${type}`);
  }
}

export type DbItem = {
  id: string;
  category: string;
  title: string;
  description: string;
  year: number;
  tech: string;
  link: string | null;
  repo: string | null;
  live: string | null;
  notes: string | null;
  sort_order: number;
  pinned: number;
};

export type DbCalendarTask = {
  id: string;
  date: string;
  title: string;
  notes: string | null;
  start_time: string | null;
  end_time: string | null;
  done: number;
  position: number;
  category_id: string | null;
  is_uncertain: number;
  /** JSON-encoded PlanFallback[]; null when not uncertain or empty. */
  fallbacks: string | null;
  created_at: number;
  updated_at: number;
};

export type DbPrayerTimesCache = {
  cache_key: string;
  year: number;
  month: number;
  city: string;
  country: string;
  method: number;
  data: string;
  fetched_at: number;
};

export type DbCalendarCategory = {
  id: string;
  name: string;
  color: string;
  is_system: number;
  archived: number;
  position: number;
  created_at: number;
  updated_at: number;
};

export type DbCalendarActual = {
  id: string;
  date: string;
  plan_id: string | null;
  category_id: string | null;
  title: string | null;
  start_at: number;
  end_at: number | null;
  /** Concurrency lane. 0 is the primary lane; >0 are parallel activities. */
  track: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};
