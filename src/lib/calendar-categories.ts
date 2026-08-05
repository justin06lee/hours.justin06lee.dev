import { db, initDb, type DbCalendarCategory } from "./db";
import { isPaletteColor } from "./colors";

// Web Crypto global — works in Node 19+, Bun, and edge runtimes.
const randomUUID = () => globalThis.crypto.randomUUID();

export type CalendarCategory = {
  id: string;
  name: string;
  color: string;
  isSystem: boolean;
  archived: boolean;
  position: number;
};

export type NewCategory = { name: string; color: string };
export type CategoryPatch = Partial<{ name: string; color: string; archived: boolean; position: number }>;

export function rowToCategory(row: DbCalendarCategory): CalendarCategory {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isSystem: row.is_system === 1,
    archived: row.archived === 1,
    position: row.position,
  };
}

/**
 * The canonical "every category, in UI order" query. Exported because
 * hours.ts folds it into a single batched read alongside its own selects, and
 * two copies of this SQL would eventually drift. The ORDER BY is load-bearing:
 * live before archived, the system Sleep row first, then manual position, with
 * a case-insensitive name as the stable tiebreak. Change it here or nowhere.
 */
export const CATEGORY_LIST_SQL = `SELECT * FROM calendar_categories
          ORDER BY archived ASC, is_system DESC, position ASC, LOWER(name) ASC`;

export async function listCategories(): Promise<CalendarCategory[]> {
  await initDb();
  const result = await db.execute({ sql: CATEGORY_LIST_SQL, args: [] });
  return (result.rows as unknown as DbCalendarCategory[]).map(rowToCategory);
}

export async function getCategoryById(id: string): Promise<CalendarCategory | null> {
  await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM calendar_categories WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0] as unknown as DbCalendarCategory | undefined;
  return row ? rowToCategory(row) : null;
}

export async function findCategoryByNameCI(name: string): Promise<CalendarCategory | null> {
  await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM calendar_categories WHERE LOWER(name) = LOWER(?)",
    args: [name],
  });
  const row = result.rows[0] as unknown as DbCalendarCategory | undefined;
  return row ? rowToCategory(row) : null;
}

/** Detects a violation of `idx_calendar_categories_name_lower`. Same shape as
 *  calendar.ts's running-row detector: the remote driver reports the extended
 *  code as `code`, the local sqlite3 driver reports it as `extendedCode` and
 *  puts the base `SQLITE_CONSTRAINT` in `code`, so the message check is what
 *  covers the rest. The bare base code is deliberately NOT matched — a NOT NULL
 *  failure is a bug, and reporting it as "duplicate" would hide it forever. */
function isNameUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; extendedCode?: string; message?: string };
  if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.extendedCode === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  const msg = err.message ?? "";
  return /UNIQUE constraint failed.*calendar_categories/i.test(msg) ||
         msg.includes("idx_calendar_categories_name_lower");
}

export async function createCategory(input: NewCategory): Promise<{ ok: true; category: CalendarCategory } | { ok: false; reason: "duplicate" | "invalid-color" | "empty-name" }> {
  await initDb();
  if (!isPaletteColor(input.color)) return { ok: false, reason: "invalid-color" };
  const trimmed = input.name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty-name" };
  const dup = await findCategoryByNameCI(trimmed);
  if (dup) return { ok: false, reason: "duplicate" };
  const id = randomUUID();
  const now = Date.now();
  try {
    // position is a small orderable integer (ORDER BY position ASC), not a
    // timestamp — append after the current max so new categories sort last.
    // Computed as a subquery rather than a preceding SELECT because two
    // concurrent creates that both read the max would both write it, landing on
    // the same position; inside the INSERT the read and the write are one
    // statement and cannot interleave.
    await db.execute({
      sql: `INSERT INTO calendar_categories (id, name, color, is_system, archived, position, created_at, updated_at)
            VALUES (?, ?, ?, 0, 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM calendar_categories), ?, ?)`,
      args: [id, trimmed, input.color, now, now],
    });
  } catch (e) {
    // The duplicate check above is check-then-act against a live UNIQUE index,
    // so a concurrent create can slip in between the two. Without this the
    // loser raised a 500 instead of the `duplicate` this function is designed
    // to return. The pre-check stays because it still gives the clean answer in
    // the uncontested case; this only covers the race.
    if (isNameUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
  const created = await getCategoryById(id);
  if (!created) throw new Error("Failed to create category");
  return { ok: true, category: created };
}

export async function updateCategory(
  id: string,
  patch: CategoryPatch,
): Promise<{ ok: true; category: CalendarCategory } | { ok: false; reason: "not-found" | "duplicate" | "invalid-color" | "system-name-locked" | "empty-name" }> {
  await initDb();
  const existing = await getCategoryById(id);
  if (!existing) return { ok: false, reason: "not-found" };

  if (patch.name !== undefined) {
    if (existing.isSystem) return { ok: false, reason: "system-name-locked" };
    const trimmed = patch.name.trim();
    if (trimmed.length === 0) return { ok: false, reason: "empty-name" };
    const dup = await findCategoryByNameCI(trimmed);
    if (dup && dup.id !== id) return { ok: false, reason: "duplicate" };
  }
  if (patch.color !== undefined && !isPaletteColor(patch.color)) {
    return { ok: false, reason: "invalid-color" };
  }

  const merged = {
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    color: patch.color ?? existing.color,
    archived: patch.archived !== undefined ? patch.archived : existing.archived,
    position: patch.position !== undefined ? patch.position : existing.position,
  };

  await db.execute({
    sql: `UPDATE calendar_categories
          SET name=?, color=?, archived=?, position=?, updated_at=?
          WHERE id=?`,
    args: [merged.name, merged.color, merged.archived ? 1 : 0, merged.position, Date.now(), id],
  });
  const updated = await getCategoryById(id);
  if (!updated) throw new Error("Failed to load updated category");
  return { ok: true, category: updated };
}

export async function categoryUsage(id: string): Promise<{ planCount: number; actualCount: number }> {
  await initDb();
  const planRes = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM calendar_tasks WHERE category_id = ?",
    args: [id],
  });
  const actualRes = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM calendar_actuals WHERE category_id = ?",
    args: [id],
  });
  const planCount = Number((planRes.rows[0] as unknown as { n: number }).n ?? 0);
  const actualCount = Number((actualRes.rows[0] as unknown as { n: number }).n ?? 0);
  return { planCount, actualCount };
}

export async function deleteCategory(
  id: string,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "system-locked" | "in-use"; planCount?: number; actualCount?: number }> {
  await initDb();
  const existing = await getCategoryById(id);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.isSystem) return { ok: false, reason: "system-locked" };
  const usage = await categoryUsage(id);
  if (usage.planCount > 0 || usage.actualCount > 0) {
    return { ok: false, reason: "in-use", planCount: usage.planCount, actualCount: usage.actualCount };
  }
  await db.execute({ sql: "DELETE FROM calendar_categories WHERE id = ?", args: [id] });
  return { ok: true };
}
