function formatDateInTz(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

export function todayInTz(timezone: string): string {
  return formatDateInTz(new Date(), timezone);
}

/** Validates a YYYY-MM-DD string. */
export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Validates YYYY-MM string. */
export function isValidYearMonthString(s: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const [, m] = s.split("-").map(Number);
  return m >= 1 && m <= 12;
}

/** Validates YYYY string. */
export function isValidYearString(s: string): boolean {
  return /^\d{4}$/.test(s);
}

/** Validates an HH:MM string (00:00–23:59). */
export function isValidHhmm(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Adds days to a YYYY-MM-DD string; returns YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Returns first and last YYYY-MM-DD of a given month ("2026-04"). */
export function monthRange(yyyymm: string): { from: string; to: string } {
  const [y, m] = yyyymm.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;

export const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Returns a Sunday-aligned grid of YYYY-MM-DD strings for the given month,
 * with nulls for leading and trailing padding cells. Length is always a
 * multiple of 7.
 */
export function buildMonthGrid(yyyymm: string): (string | null)[] {
  const [y, m] = yyyymm.split("-").map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) {
    cells.push(`${y}-${mm}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Parses HH:MM and returns minutes since midnight (0–1439), or null if invalid. */
export function hhmmToMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Intl.DateTimeFormat allocation is the costly part of these helpers; memoize
// per timezone so the year/month heatmap loops don't pay it 5×N times.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timezone, f);
  }
  return f;
}

function getTimeFormatter(timezone: string): Intl.DateTimeFormat {
  let f = timeFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    timeFormatters.set(timezone, f);
  }
  return f;
}

/** Returns YYYY-MM-DD for an epoch ms timestamp in the given timezone. */
export function epochToDateInTz(ms: number, timezone: string): string {
  return getDateFormatter(timezone).format(new Date(ms));
}

/** Returns minutes since midnight (0..1439) for an epoch ms timestamp in the given timezone. */
export function epochToMinutesOfDay(ms: number, timezone: string): number {
  const parts = getTimeFormatter(timezone).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** Formats a "minutes since midnight" value as HH:MM (zero-padded). */
export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Returns HH:MM for an epoch ms timestamp in the given timezone. */
export function epochToHHMMInTz(ms: number, timezone: string): string {
  return minutesToHHMM(epochToMinutesOfDay(ms, timezone));
}

/**
 * Formats an epoch as `YYYY-MM-DDTHH:MM` in the **configured timezone** for
 * use as an `<input type="datetime-local">` value. The browser's local tz is
 * NOT used — calendar code always operates in the site's configured tz.
 * Round-trip with `localInputToEpoch(s, timezone)`.
 */
export function epochToLocalInput(ms: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // `en-CA` `hour: "2-digit", hour12: false` can return "24" at midnight on
  // some runtimes; normalize to "00".
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
}

/**
 * Parses an `<input type="datetime-local">` value (`YYYY-MM-DDTHH:MM`) as a
 * wall-clock time in the given timezone, returning epoch ms. We avoid
 * `new Date(s)` because (a) it parses in the *browser* local tz, not the
 * configured one, and (b) historic Safari versions parsed the same string as
 * UTC. Strategy: pick a UTC epoch with the same wall-clock fields, then
 * correct by the offset between that UTC instant's tz wall-clock and the
 * intended one. Two passes handle DST cleanly (the offset depends on the
 * day, so we re-anchor after the first correction).
 *
 * **Returns `NaN`** — not `null`, not a throw — when `s` is not exactly
 * `YYYY-MM-DDTHH:MM`. The return type stays `number` on purpose: callers pass
 * the result straight into arithmetic and comparisons, and widening it to
 * `number | null` would be a breaking change across the calendar layer. Any
 * caller handling user-supplied input must therefore test the result with
 * `Number.isNaN` (or `Number.isFinite`) before storing or comparing it — NaN
 * compares false against everything and will silently drop rows otherwise.
 *
 * Ambiguous times (the hour repeated by a fall-back transition) resolve to the
 * first, pre-transition instant. Non-existent times (the hour skipped by a
 * spring-forward transition) snap forward by the gap: `02:30` inside a
 * `02:00 → 03:00` jump means `03:30`, never `01:30`.
 */
export function localInputToEpoch(s: string, timezone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  const [, yy, mm, dd, hh, mi] = m;
  const targetY = Number(yy);
  const targetMo = Number(mm);
  const targetD = Number(dd);
  const targetH = Number(hh);
  const targetMi = Number(mi);

  // Initial guess: treat the wall-clock fields as if they were UTC.
  let guess = Date.UTC(targetY, targetMo - 1, targetD, targetH, targetMi);
  // Two correction passes as before; the third iteration only *measures* the
  // leftover delta at the final guess, so the check below sees the residual at
  // the value actually being returned rather than a stale one. It costs a third
  // Intl lookup only when the first two haven't already converged.
  let delta = 0;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value ?? "0");
    const gotHour = get("hour") === 24 ? 0 : get("hour");
    const gotUtc = Date.UTC(get("year"), get("month") - 1, get("day"), gotHour, get("minute"));
    const wantUtc = Date.UTC(targetY, targetMo - 1, targetD, targetH, targetMi);
    delta = wantUtc - gotUtc;
    if (delta === 0) break;
    if (i < 2) guess += delta;
  }
  // A delta still outstanding after two passes means no instant carries the
  // requested wall-clock time: it sits inside a spring-forward gap. The passes
  // then oscillate between the two instants bracketing the gap, and can settle
  // on the earlier one — so "02:30" on a US spring-forward day came back as
  // 01:30 local, an hour BEFORE what was typed. A positive residual is exactly
  // that case (the zone's clock at `guess` still lags the request by the gap),
  // so add it once more to snap FORWARD, the conventional resolution: 02:30
  // inside a 02:00 → 03:00 jump means 03:30. A negative residual already sits
  // after the gap and is left alone. Non-gap inputs converge to delta 0 above,
  // including ambiguous fall-back times, where both candidate instants match
  // and the earlier (pre-transition) one is returned.
  if (delta > 0) guess += delta;
  return guess;
}

/** Heatmap intensity scale based on how fully a day's plan was followed.
 *  Input is a fill ratio in [0, 1] (fulfilled overlap / min(8h, planned)),
 *  not raw minutes, so light and heavy days are graded on the same curve.
 *  Exported so legends/swatches stay in sync with cell rendering. */
export const OVERLAP_INTENSITY_CLASSES = {
  // 0 / <25% / <50% / <85% / ≥85% of the day's plan followed
  year: ["bg-white/[0.04]", "bg-white/15", "bg-white/30", "bg-white/55", "bg-white/85"],
  month: ["", "bg-white/[0.06]", "bg-white/[0.10]", "bg-white/[0.14]", "bg-white/[0.18]"],
} as const;

export function overlapIntensityClass(ratio: number, scale: "year" | "month"): string {
  const buckets = OVERLAP_INTENSITY_CLASSES[scale];
  if (ratio <= 0) return buckets[0];
  if (ratio < 0.25) return buckets[1];
  if (ratio < 0.5) return buckets[2];
  if (ratio < 0.85) return buckets[3];
  return buckets[4];
}

/**
 * Returns the minutes-of-day window {startMin, endMin} for an actuals block on a given day,
 * or null if the block doesn't intersect the day at all.
 *
 * - `endAt = null` means "currently running"; we use `nowMs` (default Date.now()) as the right edge.
 * - Blocks that span across midnight are clamped to [0, 1440] for the visible day.
 *
 * **Known approximation: every day is treated as 1440 minutes long.** On the
 * two DST transition days a year that is wrong by exactly the transition size
 * (one hour in US/EU zones):
 * - Fall back (25-hour day): a block covering the whole day reports 1440
 *   minutes instead of 1500 — the last hour is not represented.
 * - Spring forward (23-hour day): the same block reports 1440 instead of 1380,
 *   overstating by an hour, and minute values in the skipped range map to
 *   wall-clock times that never occurred.
 * Worst case is therefore 60 minutes (4.2%) on 2 days of 365; every other day
 * is exact. This is deliberate, not an oversight: the value feeds a fixed
 * 0–1440 render axis (`components/chrome/timeline.tsx`) and is intersected
 * against a literal `[[0, 1440]]` full-day window in `lib/calendar.ts`, so a
 * 1500 returned here would overflow the axis and be clipped straight back to
 * 1440 by the intersection — the error would move, not disappear. Deriving the
 * true day length costs extra Intl work on a path that runs once per actual per
 * visible day across a year heatmap. Fix this at the axis, not here.
 */
export function clampActualToDay(
  date: string,
  startAtMs: number,
  endAtMs: number | null,
  timezone: string,
  nowMs: number = Date.now(),
): { startMin: number; endMin: number } | null {
  const effectiveEnd = endAtMs ?? nowMs;
  if (effectiveEnd <= startAtMs) return null;

  const startDate = epochToDateInTz(startAtMs, timezone);
  const endDate = epochToDateInTz(effectiveEnd, timezone);

  const startsToday = startDate === date;
  const startsAfter = startDate > date;
  const endsBefore = endDate < date;
  const endsToday = endDate === date;

  if (startsAfter || endsBefore) return null;

  const startMin = startsToday ? epochToMinutesOfDay(startAtMs, timezone) : 0;
  const endMin = endsToday ? epochToMinutesOfDay(effectiveEnd, timezone) : 1440;
  return { startMin, endMin };
}

/** Sorts and merges overlapping/adjacent intervals into a disjoint, ordered list. */
function normalizeIntervals(intervals: ReadonlyArray<readonly [number, number]>): [number, number][] {
  const valid = intervals.filter(([s, e]) => e > s);
  if (valid.length === 0) return [];
  const sorted = [...valid].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * Returns the total length of the intersection between two interval sets.
 * Each set is independently merged first, so duplicates and overlaps within a
 * single set don't double-count.
 */
export function intervalIntersectionMinutes(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): number {
  const A = normalizeIntervals(a);
  const B = normalizeIntervals(b);
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < A.length && j < B.length) {
    const lo = Math.max(A[i][0], B[j][0]);
    const hi = Math.min(A[i][1], B[j][1]);
    if (lo < hi) sum += hi - lo;
    if (A[i][1] < B[j][1]) i++;
    else j++;
  }
  return sum;
}
