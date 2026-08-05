import { describe, it, expect } from "vitest";
import {
  addDays,
  monthRange,
  buildMonthGrid,
  hhmmToMinutes,
  isValidDateString,
  isValidHhmm,
  epochToDateInTz,
  epochToMinutesOfDay,
  minutesToHHMM,
  epochToHHMMInTz,
  epochToLocalInput,
  localInputToEpoch,
  clampActualToDay,
  intervalIntersectionMinutes,
  overlapIntensityClass,
} from "@/lib/calendar-dates";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

// The 2026 US transitions, expressed as the exact instant local midnight falls:
//   spring forward  2026-03-08 02:00 PST -> 03:00 PDT  (a 23-hour day)
//   fall back       2026-11-01 02:00 PDT -> 01:00 PST  (a 25-hour day)
const MAR_08_MIDNIGHT_LA = Date.parse("2026-03-08T08:00:00.000Z"); // PST, UTC-8
const MAR_09_MIDNIGHT_LA = Date.parse("2026-03-09T07:00:00.000Z"); // PDT, UTC-7
const NOV_01_MIDNIGHT_LA = Date.parse("2026-11-01T07:00:00.000Z"); // PDT, UTC-7
const NOV_02_MIDNIGHT_LA = Date.parse("2026-11-02T08:00:00.000Z"); // PST, UTC-8

describe("addDays", () => {
  it("moves forward and back within a month", () => {
    expect(addDays("2026-07-15", 1)).toBe("2026-07-16");
    expect(addDays("2026-07-15", -1)).toBe("2026-07-14");
    expect(addDays("2026-07-15", 0)).toBe("2026-07-15");
  });

  it("zero-pads single-digit results", () => {
    expect(addDays("2026-01-09", 1)).toBe("2026-01-10");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });

  it("crosses month boundaries in both directions", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-01-01", 365)).toBe("2027-01-01");
  });

  it("handles leap and non-leap Februaries", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    // 2100 is divisible by 4 but not a leap year; 2000 is.
    expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
    expect(addDays("2000-02-28", 1)).toBe("2000-02-29");
  });

  it("never skips or repeats a day across a DST transition", () => {
    // The whole point of doing this in UTC on the date string: calendar days
    // are counted, not 24-hour blocks, so a 23- or 25-hour day is still one day.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("round-trips: forward then back is the identity", () => {
    for (const d of ["2026-01-01", "2026-02-28", "2028-02-29", "2026-12-31"]) {
      expect(addDays(addDays(d, 40), -40)).toBe(d);
    }
  });

  it("always emits a valid date string", () => {
    let cursor = "2025-12-20";
    for (let i = 0; i < 80; i++) {
      cursor = addDays(cursor, 1);
      expect(isValidDateString(cursor)).toBe(true);
    }
  });
});

describe("monthRange", () => {
  it("returns the first and last day of a 31-day month", () => {
    expect(monthRange("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(monthRange("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("returns the first and last day of a 30-day month", () => {
    expect(monthRange("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });

  it("gets February right in both leap and non-leap years", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2100-02").to).toBe("2100-02-28");
  });

  it("does not roll the year over on December", () => {
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("buildMonthGrid", () => {
  const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);

  it("always returns a whole number of weeks", () => {
    // The grid renders as fixed 7-column rows; a ragged length would shear it.
    for (const m of [...MONTHS, "2028-02", "2025-11", "2100-02"]) {
      expect(buildMonthGrid(m).length % 7).toBe(0);
    }
  });

  it("pads the front with one null per weekday before the 1st", () => {
    // 2026-02-01 is a Sunday, so February needs no leading padding at all.
    expect(buildMonthGrid("2026-02")[0]).toBe("2026-02-01");
    // 2026-04-01 is a Wednesday: three leading nulls.
    const april = buildMonthGrid("2026-04");
    expect(april.slice(0, 3)).toEqual([null, null, null]);
    expect(april[3]).toBe("2026-04-01");
  });

  it("contains every day of the month exactly once, in order", () => {
    for (const m of MONTHS) {
      const days = buildMonthGrid(m).filter((c): c is string => c !== null);
      const { from, to } = monthRange(m);
      expect(days[0]).toBe(from);
      expect(days[days.length - 1]).toBe(to);
      expect(new Set(days).size).toBe(days.length);
      for (let i = 1; i < days.length; i++) expect(days[i]).toBe(addDays(days[i - 1], 1));
    }
  });

  it("keeps padding at the edges only — never a hole mid-month", () => {
    for (const m of MONTHS) {
      const cells = buildMonthGrid(m);
      const first = cells.findIndex((c) => c !== null);
      const last = cells.length - 1 - [...cells].reverse().findIndex((c) => c !== null);
      for (let i = first; i <= last; i++) expect(cells[i]).not.toBeNull();
    }
  });

  it("never pads a full extra week", () => {
    for (const m of MONTHS) {
      const cells = buildMonthGrid(m);
      expect(cells.length - cells.filter((c) => c === null).length).toBeGreaterThan(0);
      expect(cells.length).toBeLessThanOrEqual(42);
    }
  });
});

describe("hhmmToMinutes", () => {
  it("converts valid times to minutes since midnight", () => {
    expect(hhmmToMinutes("00:00")).toBe(0);
    expect(hhmmToMinutes("09:15")).toBe(555);
    expect(hhmmToMinutes("12:00")).toBe(720);
    expect(hhmmToMinutes("23:59")).toBe(1439);
  });

  it("returns null for absent input", () => {
    expect(hhmmToMinutes(null)).toBeNull();
    expect(hhmmToMinutes("")).toBeNull();
  });

  it("returns null for out-of-range components", () => {
    expect(hhmmToMinutes("24:00")).toBeNull();
    expect(hhmmToMinutes("99:99")).toBeNull();
    expect(hhmmToMinutes("12:60")).toBeNull();
  });

  it("returns null for anything that isn't exactly HH:MM", () => {
    expect(hhmmToMinutes("9:15")).toBeNull();
    expect(hhmmToMinutes("09:15:00")).toBeNull();
    expect(hhmmToMinutes("09-15")).toBeNull();
    expect(hhmmToMinutes("abcde")).toBeNull();
  });

  it("agrees with isValidHhmm on what it accepts", () => {
    for (const s of ["00:00", "23:59", "24:00", "12:60", "9:15", "abcde"]) {
      expect(hhmmToMinutes(s) !== null).toBe(isValidHhmm(s));
    }
  });

  it("round-trips through minutesToHHMM", () => {
    for (const m of [0, 1, 59, 60, 555, 719, 1439]) {
      expect(hhmmToMinutes(minutesToHHMM(m))).toBe(m);
    }
  });
});

describe("epochToDateInTz", () => {
  // 2026-07-15T03:30Z — the same instant is three different calendar dates
  // depending on where you stand. This is why every date here is tz-qualified.
  const instant = Date.parse("2026-07-15T03:30:00.000Z");

  it("returns the local calendar date, not the UTC one", () => {
    expect(epochToDateInTz(instant, "UTC")).toBe("2026-07-15");
    expect(epochToDateInTz(instant, LA)).toBe("2026-07-14");
    expect(epochToDateInTz(instant, NY)).toBe("2026-07-14");
    expect(epochToDateInTz(instant, "Asia/Tokyo")).toBe("2026-07-15");
  });

  it("flips exactly at local midnight, not at a fixed UTC hour", () => {
    expect(epochToDateInTz(MAR_08_MIDNIGHT_LA - 1, LA)).toBe("2026-03-07");
    expect(epochToDateInTz(MAR_08_MIDNIGHT_LA, LA)).toBe("2026-03-08");
    expect(epochToDateInTz(MAR_09_MIDNIGHT_LA - 1, LA)).toBe("2026-03-08");
    expect(epochToDateInTz(MAR_09_MIDNIGHT_LA, LA)).toBe("2026-03-09");
  });

  it("shows the transition days as 23 and 25 hours long", () => {
    expect(MAR_09_MIDNIGHT_LA - MAR_08_MIDNIGHT_LA).toBe(23 * 3_600_000);
    expect(NOV_02_MIDNIGHT_LA - NOV_01_MIDNIGHT_LA).toBe(25 * 3_600_000);
  });

  it("keeps returning the same date across a repeated fall-back hour", () => {
    // 01:30 PDT and 01:30 PST are two distinct instants on the same date.
    expect(epochToDateInTz(Date.parse("2026-11-01T08:30:00.000Z"), LA)).toBe("2026-11-01");
    expect(epochToDateInTz(Date.parse("2026-11-01T09:30:00.000Z"), LA)).toBe("2026-11-01");
  });
});

describe("epochToMinutesOfDay / epochToHHMMInTz", () => {
  it("reports minutes since local midnight", () => {
    expect(epochToMinutesOfDay(MAR_08_MIDNIGHT_LA, LA)).toBe(0);
    expect(epochToMinutesOfDay(MAR_08_MIDNIGHT_LA + 90 * 60_000, LA)).toBe(90);
    expect(epochToMinutesOfDay(Date.parse("2026-07-15T03:30:00.000Z"), LA)).toBe(20 * 60 + 30);
  });

  it("never returns 1440 — midnight is 0, not the end of the previous day", () => {
    for (const t of [MAR_08_MIDNIGHT_LA, MAR_09_MIDNIGHT_LA, NOV_01_MIDNIGHT_LA]) {
      expect(epochToMinutesOfDay(t, LA)).toBe(0);
      expect(epochToHHMMInTz(t, LA)).toBe("00:00");
    }
  });

  it("skips the spring-forward hour", () => {
    // 01:59 local is followed one minute later by 03:00 local.
    expect(epochToHHMMInTz(Date.parse("2026-03-08T09:59:00.000Z"), LA)).toBe("01:59");
    expect(epochToHHMMInTz(Date.parse("2026-03-08T10:00:00.000Z"), LA)).toBe("03:00");
  });

  it("formats minutes back to a zero-padded HH:MM", () => {
    expect(minutesToHHMM(0)).toBe("00:00");
    expect(minutesToHHMM(5)).toBe("00:05");
    expect(minutesToHHMM(555)).toBe("09:15");
    expect(minutesToHHMM(1439)).toBe("23:59");
  });
});

describe("clampActualToDay", () => {
  // A block running 09:00–11:00 local on 2026-07-15 in LA.
  const start = Date.parse("2026-07-15T16:00:00.000Z");
  const end = Date.parse("2026-07-15T18:00:00.000Z");

  it("returns the local minute window for a block inside the day", () => {
    expect(clampActualToDay("2026-07-15", start, end, LA)).toEqual({
      startMin: 9 * 60,
      endMin: 11 * 60,
    });
  });

  it("returns null for a block that ends before the day", () => {
    expect(clampActualToDay("2026-07-16", start, end, LA)).toBeNull();
  });

  it("returns null for a block that starts after the day", () => {
    expect(clampActualToDay("2026-07-14", start, end, LA)).toBeNull();
  });

  it("returns null for a zero-length or inverted block", () => {
    expect(clampActualToDay("2026-07-15", start, start, LA)).toBeNull();
    expect(clampActualToDay("2026-07-15", end, start, LA)).toBeNull();
  });

  it("clamps the tail of a block that runs past midnight", () => {
    // 22:00 on the 15th to 02:00 on the 16th, local.
    const late = Date.parse("2026-07-16T05:00:00.000Z");
    const nextMorning = Date.parse("2026-07-16T09:00:00.000Z");
    expect(clampActualToDay("2026-07-15", late, nextMorning, LA)).toEqual({
      startMin: 22 * 60,
      endMin: 1440,
    });
  });

  it("clamps the head of a block that started the previous day", () => {
    const late = Date.parse("2026-07-16T05:00:00.000Z");
    const nextMorning = Date.parse("2026-07-16T09:00:00.000Z");
    expect(clampActualToDay("2026-07-16", late, nextMorning, LA)).toEqual({
      startMin: 0,
      endMin: 2 * 60,
    });
  });

  it("fills a day the block only passes through", () => {
    // A three-day block: the middle day is covered end to end.
    const from = Date.parse("2026-07-14T20:00:00.000Z");
    const to = Date.parse("2026-07-17T04:00:00.000Z");
    expect(clampActualToDay("2026-07-15", from, to, LA)).toEqual({ startMin: 0, endMin: 1440 });
  });

  it("uses nowMs as the right edge of a still-running block", () => {
    // `nowMs` is passed explicitly everywhere it matters; tests must never lean
    // on the real clock.
    const now = Date.parse("2026-07-15T17:30:00.000Z"); // 10:30 local
    expect(clampActualToDay("2026-07-15", start, null, LA, now)).toEqual({
      startMin: 9 * 60,
      endMin: 10 * 60 + 30,
    });
  });

  it("returns null for a still-running block whose start is in the future", () => {
    const now = Date.parse("2026-07-15T15:00:00.000Z");
    expect(clampActualToDay("2026-07-15", start, null, LA, now)).toBeNull();
  });

  it("clamps a still-running block that began yesterday", () => {
    const yesterdayEvening = Date.parse("2026-07-15T05:00:00.000Z"); // 22:00 on the 14th
    const now = Date.parse("2026-07-15T16:30:00.000Z"); // 09:30 on the 15th
    expect(clampActualToDay("2026-07-15", yesterdayEvening, null, LA, now)).toEqual({
      startMin: 0,
      endMin: 9 * 60 + 30,
    });
  });

  it("reads the same block differently in different timezones", () => {
    // 09:00–11:00 LA is 12:00–14:00 NY on the same date.
    expect(clampActualToDay("2026-07-15", start, end, NY)).toEqual({
      startMin: 12 * 60,
      endMin: 14 * 60,
    });
  });

  it("KNOWN APPROXIMATION: treats every day as 1440 minutes", () => {
    // Documented in the JSDoc, deliberately not fixed here. The 2026-11-01
    // fall-back day is really 1500 minutes long, and the 2026-03-08
    // spring-forward day really 1380, but the value feeds a fixed 0–1440 render
    // axis and is intersected against a literal [[0, 1440]] full-day window, so
    // a truer number would be clipped straight back. Worst case: 60 minutes on
    // 2 days a year. These assertions pin the current behavior so the day the
    // axis is fixed, the change here is visible.
    const before = NOV_01_MIDNIGHT_LA - 3_600_000;
    const after = NOV_02_MIDNIGHT_LA + 3_600_000;
    expect(clampActualToDay("2026-11-01", before, after, LA)).toEqual({
      startMin: 0,
      endMin: 1440, // the true figure is 1500
    });
    expect(clampActualToDay("2026-03-08", MAR_08_MIDNIGHT_LA - 3_600_000, MAR_09_MIDNIGHT_LA + 3_600_000, LA)).toEqual({
      startMin: 0,
      endMin: 1440, // the true figure is 1380
    });
  });
});

describe("epochToLocalInput / localInputToEpoch", () => {
  it("formats an epoch in the configured tz, not the host's", () => {
    const instant = Date.parse("2026-07-15T03:30:00.000Z");
    expect(epochToLocalInput(instant, "UTC")).toBe("2026-07-15T03:30");
    expect(epochToLocalInput(instant, LA)).toBe("2026-07-14T20:30");
    expect(epochToLocalInput(instant, NY)).toBe("2026-07-14T23:30");
  });

  it("renders midnight as 00:00, never 24:00", () => {
    expect(epochToLocalInput(MAR_08_MIDNIGHT_LA, LA)).toBe("2026-03-08T00:00");
    expect(epochToLocalInput(NOV_02_MIDNIGHT_LA, LA)).toBe("2026-11-02T00:00");
  });

  it("parses a wall-clock string in the configured tz", () => {
    expect(localInputToEpoch("2026-07-15T12:00", "UTC")).toBe(
      Date.parse("2026-07-15T12:00:00.000Z"),
    );
    expect(localInputToEpoch("2026-07-15T12:00", LA)).toBe(
      Date.parse("2026-07-15T19:00:00.000Z"),
    );
    expect(localInputToEpoch("2026-01-15T12:00", LA)).toBe(
      Date.parse("2026-01-15T20:00:00.000Z"),
    );
  });

  it("handles a half-hour offset zone", () => {
    expect(localInputToEpoch("2026-06-15T09:15", "Asia/Kolkata")).toBe(
      Date.parse("2026-06-15T03:45:00.000Z"),
    );
  });

  it("round-trips every hour across the spring-forward day", () => {
    // Every hour that exists must survive the round trip unchanged.
    for (let h = 0; h < 24; h++) {
      const t = MAR_08_MIDNIGHT_LA + h * 3_600_000;
      if (t >= MAR_09_MIDNIGHT_LA) break;
      const s = epochToLocalInput(t, LA);
      expect(localInputToEpoch(s, LA)).toBe(t);
    }
  });

  it("round-trips every hour across the fall-back day", () => {
    for (let h = 0; h < 25; h++) {
      const t = NOV_01_MIDNIGHT_LA + h * 3_600_000;
      const s = epochToLocalInput(t, LA);
      // The repeated hour is genuinely ambiguous: 01:00 names two instants and
      // one string cannot distinguish them, so neither member of the pair can
      // round-trip. Everything else is exact.
      const ambiguous =
        s === epochToLocalInput(t + 3_600_000, LA) || s === epochToLocalInput(t - 3_600_000, LA);
      if (ambiguous) continue;
      expect(localInputToEpoch(s, LA)).toBe(t);
    }
  });

  it("resolves an ambiguous fall-back time to the first, pre-transition instant", () => {
    // 01:30 happens twice on 2026-11-01. We pick the earlier (PDT) one.
    const first = Date.parse("2026-11-01T08:30:00.000Z");
    const second = Date.parse("2026-11-01T09:30:00.000Z");
    expect(epochToLocalInput(first, LA)).toBe("2026-11-01T01:30");
    expect(epochToLocalInput(second, LA)).toBe("2026-11-01T01:30");
    expect(localInputToEpoch("2026-11-01T01:30", LA)).toBe(first);
  });

  it("snaps a non-existent spring-forward time FORWARD, never backward", () => {
    // 02:30 does not exist on 2026-03-08: the clock jumps 02:00 -> 03:00. The
    // two-pass correction used to oscillate and settle on 01:30 — an hour
    // BEFORE what was typed, which silently moves an entry into the wrong hour.
    const got = localInputToEpoch("2026-03-08T02:30", NY);
    expect(got).toBe(Date.parse("2026-03-08T07:30:00.000Z"));
    expect(epochToLocalInput(got, NY)).toBe("2026-03-08T03:30");
    expect(got).toBeGreaterThan(localInputToEpoch("2026-03-08T01:59", NY));
  });

  it("snaps forward across the whole gap, in every zone", () => {
    for (const [input, tz, expected] of [
      ["2026-03-08T02:00", NY, "2026-03-08T03:00"],
      ["2026-03-08T02:30", LA, "2026-03-08T03:30"],
      ["2026-03-08T02:59", LA, "2026-03-08T03:59"],
      // Northern and southern hemispheres, and a zone whose gap is at 01:00.
      ["2026-03-29T01:30", "Europe/London", "2026-03-29T02:30"],
      ["2026-10-04T02:30", "Australia/Sydney", "2026-10-04T03:30"],
    ] as const) {
      const got = localInputToEpoch(input, tz);
      expect(epochToLocalInput(got, tz)).toBe(expected);
    }
  });

  it("leaves times just outside the gap alone", () => {
    expect(epochToLocalInput(localInputToEpoch("2026-03-08T01:59", NY), NY)).toBe(
      "2026-03-08T01:59",
    );
    expect(epochToLocalInput(localInputToEpoch("2026-03-08T03:00", NY), NY)).toBe(
      "2026-03-08T03:00",
    );
  });

  it("returns NaN for malformed input — callers must test for it", () => {
    // The contract is NaN, not null and not a throw, so the return type can
    // stay `number` for the calendar layer. NaN compares false against
    // everything, so an unchecked result silently drops rows.
    for (const bad of ["", "nope", "2026-07-15", "2026-07-15 12:00", "2026-7-15T12:00", "2026-07-15T12:00:00"]) {
      expect(Number.isNaN(localInputToEpoch(bad, LA))).toBe(true);
    }
  });

  it("KNOWN: validates shape only, so out-of-range fields normalize instead of failing", () => {
    // The regex checks digit counts, not calendar validity, and Date.UTC rolls
    // month 13 into the next January. Pinned so the behavior is visible; the
    // <input type="datetime-local"> that feeds this cannot produce it.
    expect(Number.isNaN(localInputToEpoch("2026-13-01T00:00", "UTC"))).toBe(false);
    expect(epochToLocalInput(localInputToEpoch("2026-13-01T00:00", "UTC"), "UTC")).toBe(
      "2027-01-01T00:00",
    );
  });
});

describe("intervalIntersectionMinutes", () => {
  it("returns zero for empty input on either side", () => {
    expect(intervalIntersectionMinutes([], [[0, 100]])).toBe(0);
    expect(intervalIntersectionMinutes([[0, 100]], [])).toBe(0);
    expect(intervalIntersectionMinutes([], [])).toBe(0);
  });

  it("returns zero for disjoint sets", () => {
    expect(intervalIntersectionMinutes([[0, 60]], [[120, 180]])).toBe(0);
  });

  it("returns zero for intervals that merely touch", () => {
    // Abutting is not overlapping: no minute is inside both.
    expect(intervalIntersectionMinutes([[0, 60]], [[60, 120]])).toBe(0);
  });

  it("measures a partial overlap", () => {
    expect(intervalIntersectionMinutes([[0, 90]], [[60, 180]])).toBe(30);
  });

  it("measures containment and identity", () => {
    expect(intervalIntersectionMinutes([[0, 120]], [[30, 60]])).toBe(30);
    expect(intervalIntersectionMinutes([[0, 120]], [[0, 120]])).toBe(120);
  });

  it("does not double-count duplicates or overlaps within one set", () => {
    // A plan listed twice, or two overlapping actuals, must not inflate the
    // fulfilled figure past the wall-clock time that actually elapsed.
    expect(intervalIntersectionMinutes([[0, 60], [0, 60]], [[0, 60]])).toBe(60);
    expect(intervalIntersectionMinutes([[0, 60], [30, 90]], [[0, 1440]])).toBe(90);
  });

  it("walks several intervals on both sides", () => {
    const plans: [number, number][] = [[60, 120], [300, 400], [600, 660]];
    const actuals: [number, number][] = [[90, 310], [650, 700]];
    // 90–120 = 30, 300–310 = 10, 650–660 = 10.
    expect(intervalIntersectionMinutes(plans, actuals)).toBe(50);
  });

  it("is order-independent on both input order and argument order", () => {
    // Unsorted input on the left: 90–120 = 30, plus 600–640 = 40.
    const a: [number, number][] = [[600, 660], [60, 120]];
    const b: [number, number][] = [[90, 640]];
    expect(intervalIntersectionMinutes(a, b)).toBe(70);
    expect(intervalIntersectionMinutes(b, a)).toBe(70);
  });

  it("drops zero-length and inverted intervals", () => {
    expect(intervalIntersectionMinutes([[60, 60]], [[0, 120]])).toBe(0);
    expect(intervalIntersectionMinutes([[120, 60]], [[0, 120]])).toBe(0);
  });

  it("never exceeds the length of either side", () => {
    const a: [number, number][] = [[0, 100], [50, 150]];
    const b: [number, number][] = [[0, 1440]];
    expect(intervalIntersectionMinutes(a, b)).toBeLessThanOrEqual(150);
  });

  it("does not mutate its inputs", () => {
    const a: [number, number][] = [[600, 660], [60, 120]];
    const copy = structuredClone(a);
    intervalIntersectionMinutes(a, [[0, 1440]]);
    expect(a).toEqual(copy);
  });
});

describe("overlapIntensityClass", () => {
  it("grades a fill ratio onto the five buckets, monotonically", () => {
    const ratios = [0, 0.1, 0.3, 0.6, 0.9, 1];
    for (const scale of ["year", "month"] as const) {
      const classes = ratios.map((r) => overlapIntensityClass(r, scale));
      expect(classes[0]).toBe(overlapIntensityClass(-1, scale));
      expect(classes[4]).toBe(classes[5]);
      expect(new Set(classes).size).toBe(5);
    }
  });
});
