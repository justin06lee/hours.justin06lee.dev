/**
 * Shared input-validation helpers for the calendar API routes. Bounds and
 * length caps are deliberately generous — these protect against pathological
 * payloads (NaN/Infinity, megabyte strings, century-spanning ranges), not
 * against the user.
 */

import { addDays, isValidHhmm } from "@/lib/calendar-dates";
import type { PlanFallback } from "./calendar";

export const MAX_TITLE_LEN = 200;
export const MAX_NOTES_LEN = 10_000;
export const MAX_NAME_LEN = 80;
/** Max span for a `from..to` date-range query, inclusive. ~13 months. */
export const MAX_RANGE_DAYS = 400;
/** Bound for epoch ms inputs: years 2001..2100 (rejects negative, NaN, Infinity, year 30k). */
export const MIN_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z
export const MAX_EPOCH_MS = 4102444800000; // 2100-01-01T00:00:00Z

export function isFiniteEpochMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_EPOCH_MS && v <= MAX_EPOCH_MS;
}

export function isFiniteInt32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
}

/** Returns null if `from..to` is in-range (and from <= to), else a reason string. */
export function checkDateRangeSpan(from: string, to: string): string | null {
  if (from > to) return "from must be <= to";
  // Cheap span check without Date math: compute addDays(from, MAX_RANGE_DAYS)
  // and compare strings lexicographically. YYYY-MM-DD sorts correctly.
  if (to > addDays(from, MAX_RANGE_DAYS)) return `range exceeds ${MAX_RANGE_DAYS} days`;
  return null;
}

export function isStringWithin(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}

/**
 * Largest page a list query will serve. Bounds `?per=`-style input so a crafted
 * query string can't ask for the whole table back through a paginated surface.
 */
export const MAX_PAGE_SIZE = 200;

/**
 * Clamps a page size to [1, MAX_PAGE_SIZE], falling back to `fallback` for
 * anything that isn't a usable number. Total by construction: NaN, Infinity,
 * negatives, zero and fractions all resolve rather than reaching SQL, because
 * `LIMIT -1` in SQLite means *no limit* — the one value that would silently
 * undo the bound this exists to enforce.
 */
export function clampPageLimit(limit: unknown, fallback = 20): number {
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.floor(n));
}

/** Clamps a row offset to a non-negative integer. Junk resolves to 0. */
export function clampPageOffset(offset: unknown): number {
  const n = typeof offset === "number" ? offset : Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Turns a 1-based `?page=` parameter into a row offset, given a page size.
 * Anything unparseable is page 1.
 */
export function pageToOffset(page: unknown, pageSize: number): number {
  const n = typeof page === "number" ? page : Number(page);
  if (!Number.isFinite(n) || n < 1) return 0;
  return (Math.floor(n) - 1) * pageSize;
}

/** Per-plan max — generous enough for "I planned X but might do any of {a,b,c,d,…}",
 *  tight enough that a runaway client can't blow up the JSON column. */
export const MAX_FALLBACKS = 16;

/** Returns the parsed list if `v` is a valid PlanFallback[], else a reason string. */
export function parseFallbacksInput(v: unknown): PlanFallback[] | string {
  if (!Array.isArray(v)) return "fallbacks must be an array";
  if (v.length > MAX_FALLBACKS) return `fallbacks must be <= ${MAX_FALLBACKS} entries`;
  const out: PlanFallback[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return "each fallback must be an object";
    const o = raw as Record<string, unknown>;
    if (!isStringWithin(o.categoryId, MAX_TITLE_LEN) || o.categoryId.length === 0) {
      return "fallback.categoryId must be a non-empty string";
    }
    if (!isStringWithin(o.title, MAX_TITLE_LEN) || o.title.trim().length === 0) {
      return `fallback.title must be a non-empty string (<= ${MAX_TITLE_LEN} chars)`;
    }
    if (typeof o.startTime !== "string" || !isValidHhmm(o.startTime)) {
      return "fallback.startTime must be HH:MM";
    }
    if (typeof o.endTime !== "string" || !isValidHhmm(o.endTime)) {
      return "fallback.endTime must be HH:MM";
    }
    if (o.startTime >= o.endTime) {
      return "fallback.endTime must be after fallback.startTime";
    }
    out.push({
      categoryId: o.categoryId,
      title: o.title.trim(),
      startTime: o.startTime,
      endTime: o.endTime,
    });
  }
  return out;
}
