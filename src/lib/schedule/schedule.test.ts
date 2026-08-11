import { describe, it, expect } from "vitest";
import { prayerTimesFor, type DayPrayerTimes } from "@/lib/prayer-times";
import { resolveSleep, type SleepConfig } from "@/lib/schedule/sleep";
import {
  allocate,
  resolveDay,
  spanMs,
  subtractSpans,
  type ResolvedDay,
} from "@/lib/schedule/resolve";
import { RULESET } from "@/lib/schedule/rules";
import type { PrayerLocation } from "@/lib/site-config";
import { addDays, epochToHHMMInTz } from "@/lib/calendar-dates";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The configured location, so the tests exercise the real geometry. */
const SUNNYVALE: PrayerLocation = {
  city: "Sunnyvale",
  country: "US",
  method: 2,
  timezone: "America/Los_Angeles",
  latitude: 37.33377137804415,
  longitude: -122.01867475180633,
};
const TZ = SUNNYVALE.timezone;

const at = (ms: number) => epochToHHMMInTz(ms, TZ);

function day(date: string): ResolvedDay {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return resolveDay(
    prayerTimesFor(addDays(date, -1), SUNNYVALE),
    prayerTimesFor(date, SUNNYVALE),
    prayerTimesFor(addDays(date, 1), SUNNYVALE),
    RULESET,
    TZ,
    weekday,
  );
}

/* ── interval algebra ─────────────────────────────────────────────────── */

describe("subtractSpans", () => {
  const span = { start: 0, end: 100 };

  it("returns the whole span when nothing is cut", () => {
    expect(subtractSpans(span, [])).toEqual([{ start: 0, end: 100 }]);
  });

  it("cuts a hole in the middle", () => {
    expect(subtractSpans(span, [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("trims the ends", () => {
    expect(subtractSpans(span, [{ start: -10, end: 20 }])).toEqual([{ start: 20, end: 100 }]);
    expect(subtractSpans(span, [{ start: 80, end: 200 }])).toEqual([{ start: 0, end: 80 }]);
  });

  it("ignores cuts outside the span", () => {
    expect(subtractSpans(span, [{ start: 200, end: 300 }])).toEqual([{ start: 0, end: 100 }]);
  });

  it("merges overlapping cuts rather than emitting a negative piece", () => {
    expect(
      subtractSpans(span, [
        { start: 20, end: 50 },
        { start: 40, end: 70 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 70, end: 100 },
    ]);
  });

  it("returns nothing when fully covered", () => {
    expect(subtractSpans(span, [{ start: 0, end: 100 }])).toEqual([]);
  });
});

/* ── the compression math ─────────────────────────────────────────────── */

describe("allocate", () => {
  /**
   * A local fixture rather than `RULESET.sequence`. These tests are about the
   * allocator, and pinning them to the live ruleset meant every change to the
   * schedule broke tests that had nothing to do with it.
   */
  const blocks = [
    { id: "deep-work", category: "x", title: "deep work", targetMs: 6 * HOUR, elastic: true },
    { id: "workout", category: "x", title: "workout", targetMs: 1 * HOUR, elastic: false },
    { id: "projects", category: "x", title: "projects", targetMs: 6 * HOUR, elastic: true },
  ];

  it("pays fixed blocks in full and splits the rest by target", () => {
    // 13h of targets (6 + 1 + 6) into 13h: everyone gets what they asked for.
    const got = allocate(blocks, 13 * HOUR);
    expect(got.get("workout")).toBe(1 * HOUR);
    expect(got.get("deep-work")).toBeCloseTo(6 * HOUR, -2);
    expect(got.get("projects")).toBeCloseTo(6 * HOUR, -2);
  });

  it("protects the fixed block while the elastic ones absorb the squeeze", () => {
    // The whole point of the design: a short day costs work time, not the
    // workout. 8h available, 1h of it spoken for, 7h split evenly.
    const got = allocate(blocks, 8 * HOUR);
    expect(got.get("workout")).toBe(1 * HOUR);
    expect(got.get("deep-work")).toBeCloseTo(3.5 * HOUR, -2);
    expect(got.get("projects")).toBeCloseTo(3.5 * HOUR, -2);
  });

  it("hands surplus to the elastic blocks rather than the fixed one", () => {
    const got = allocate(blocks, 20 * HOUR);
    expect(got.get("workout")).toBe(1 * HOUR);
    expect(got.get("deep-work")).toBeCloseTo(9.5 * HOUR, -2);
  });

  it("splits in proportion to target, not evenly", () => {
    const got = allocate(
      [
        { id: "a", category: "x", title: "a", targetMs: 3 * HOUR, elastic: true },
        { id: "b", category: "x", title: "b", targetMs: 1 * HOUR, elastic: true },
      ],
      8 * HOUR,
    );
    expect(got.get("a")).toBeCloseTo(6 * HOUR, -2);
    expect(got.get("b")).toBeCloseTo(2 * HOUR, -2);
  });

  it("respects a minimum, taking the shortfall from the block that can give", () => {
    const got = allocate(
      [
        { id: "a", category: "x", title: "a", targetMs: 6 * HOUR, elastic: true },
        { id: "b", category: "x", title: "b", targetMs: 6 * HOUR, elastic: true, minMs: 5 * HOUR },
      ],
      8 * HOUR,
    );
    expect(got.get("b")).toBe(5 * HOUR);
    expect(got.get("a")).toBeCloseTo(3 * HOUR, -2);
  });

  it("caps at a maximum and redistributes the surplus", () => {
    const got = allocate(
      [
        { id: "a", category: "x", title: "a", targetMs: 6 * HOUR, elastic: true, maxMs: 2 * HOUR },
        { id: "b", category: "x", title: "b", targetMs: 6 * HOUR, elastic: true },
      ],
      10 * HOUR,
    );
    expect(got.get("a")).toBe(2 * HOUR);
    expect(got.get("b")).toBeCloseTo(8 * HOUR, -2);
  });

  it("scales the fixed blocks down rather than overrunning an impossible day", () => {
    const got = allocate(blocks, 30 * MIN);
    expect(got.get("workout")).toBeCloseTo(30 * MIN, -2);
    expect(got.get("deep-work")).toBe(0);
    // Never negative: a negative duration would produce a block ending before
    // it starts, and every total downstream reads those.
    for (const v of got.values()) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("never returns a negative duration even when minimums exceed the day", () => {
    const got = allocate(
      [
        { id: "a", category: "x", title: "a", targetMs: 6 * HOUR, elastic: true, minMs: 5 * HOUR },
        { id: "b", category: "x", title: "b", targetMs: 6 * HOUR, elastic: true, minMs: 5 * HOUR },
      ],
      6 * HOUR,
    );
    for (const v of got.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});

/* ── the sleep rule ───────────────────────────────────────────────────── */

describe("resolveSleep", () => {
  const config: SleepConfig = RULESET.sleep;

  /**
   * Synthetic days, so each branch is exercised exactly rather than whenever
   * the sun happens to cooperate.
   *
   * The `-08:00` offset is Pacific *Standard* time, so **every date used with
   * this helper must be in winter**. A June date here reads an hour off, which
   * is a fixture bug that looks exactly like an engine bug.
   */
  const mk = (date: string, isha: string, fajr: string, sunrise: string): DayPrayerTimes => ({
    date,
    fajr: Date.parse(`${date}T${fajr}:00.000-08:00`),
    sunrise: Date.parse(`${date}T${sunrise}:00.000-08:00`),
    dhuhr: Date.parse(`${date}T12:00:00.000-08:00`),
    asr: Date.parse(`${date}T15:00:00.000-08:00`),
    maghrib: Date.parse(`${date}T17:00:00.000-08:00`),
    isha: Date.parse(`${date}T${isha}:00.000-08:00`),
  });

  it("takes the 9-hour ceiling when the night is long enough", () => {
    const night = mk("2026-01-10", "19:00", "06:00", "07:20");
    const morning = mk("2026-01-11", "19:00", "06:00", "07:20");
    const plan = resolveSleep(night, morning, config, TZ);
    expect(plan.shape).toBe("ceiling");
    expect(plan.segments).toHaveLength(1);
    expect(plan.sleepMs).toBe(9 * HOUR);
    expect(plan.wake - plan.bedtime).toBe(9 * HOUR);
  });

  it("applies the bedtime floor when Isha is early", () => {
    const night = mk("2026-01-10", "18:00", "06:00", "07:20");
    const morning = mk("2026-01-11", "18:00", "06:00", "07:20");
    const plan = resolveSleep(night, morning, config, TZ);
    expect(plan.flooredBedtime).toBe(true);
    // 18:00 + 15m is 18:15, floored to 20:30.
    expect(at(plan.bedtime)).toBe("20:30");
    expect(at(plan.wake)).toBe("05:30");
  });

  it("does not apply the floor when Isha is already late", () => {
    const night = mk("2026-01-10", "22:00", "06:00", "07:20");
    const morning = mk("2026-01-11", "22:00", "06:00", "07:20");
    const plan = resolveSleep(night, morning, config, TZ);
    expect(plan.flooredBedtime).toBe(false);
    expect(at(plan.bedtime)).toBe("22:15");
  });

  it("splits the night around tahajjud when 9 hours will not fit", () => {
    // Bed 22:15, sunrise-15 is 07:05 — 8h50m, just short of 9h.
    const night = mk("2026-01-10", "22:00", "06:00", "07:20");
    const morning = mk("2026-01-11", "22:00", "06:00", "07:20");
    const plan = resolveSleep(night, morning, config, TZ);

    expect(plan.shape).toBe("split");
    expect(plan.segments).toHaveLength(2);
    expect(plan.tahajjud).not.toBeNull();
    // Up 15 minutes before Fajr, back down 30 minutes later.
    expect(at(plan.tahajjud!.start)).toBe("05:45");
    expect(at(plan.tahajjud!.end)).toBe("06:15");
    // Still exactly nine hours asleep, the interruption excluded.
    expect(plan.segments[0].end - plan.segments[0].start).toBe(7.5 * HOUR);
    expect(plan.segments[1].end - plan.segments[1].start).toBe(1.5 * HOUR);
    expect(plan.sleepMs).toBe(9 * HOUR);
    expect(at(plan.wake)).toBe("07:45");
  });

  it("never counts the tahajjud gap as sleep", () => {
    const night = mk("2026-01-10", "22:00", "06:00", "07:20");
    const morning = mk("2026-01-11", "22:00", "06:00", "07:20");
    const plan = resolveSleep(night, morning, config, TZ);
    const slept = plan.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(slept).toBe(9 * HOUR);
    // The wall-clock span is longer than the sleep by exactly the interruption.
    expect(plan.wake - plan.bedtime).toBe(9 * HOUR + 30 * MIN);
  });

  it("sleeps straight through rather than splitting off a scrap of a night", () => {
    // Deliberately impossible geometry — Fajr and sunrise minutes after a
    // near-midnight Isha — because the branch it exercises only occurs where
    // Isha and Fajr converge, which is a polar summer rather than anywhere a
    // real location produces. Bed 00:05, Fajr 00:20, so tahajjud would start
    // at the moment of going to bed and there is no first segment to split.
    const night = mk("2026-01-10", "23:50", "06:00", "07:20");
    const morning = mk("2026-01-11", "23:50", "00:20", "00:50");
    const plan = resolveSleep(night, morning, config, TZ);
    expect(plan.shape).toBe("unsplittable");
    expect(plan.segments).toHaveLength(1);
    expect(plan.sleepMs).toBe(9 * HOUR);
  });
});

/* ── whole days, against the real sun ─────────────────────────────────── */

describe("resolveDay — invariants that must hold on every day of the year", () => {
  // Every third day for a year: solstices, equinoxes, both DST transitions and
  // the floor engaging and disengaging all fall inside this sweep.
  const dates: string[] = [];
  for (let i = 0; i < 365; i += 3) dates.push(addDays("2026-01-01", i));

  it("covers the waking day completely, with no gaps and no overlaps", () => {
    for (const date of dates) {
      const d = day(date);
      const waking = d.blocks
        .filter((b) => b.kind === "activity" || b.kind === "prayer")
        .sort((a, b) => a.start - b.start);

      expect(waking.length, `${date}: no waking blocks`).toBeGreaterThan(0);
      expect(waking[0].start, `${date}: day starts at wake`).toBe(d.wake);
      expect(waking[waking.length - 1].end, `${date}: day ends at bedtime`).toBe(d.bedtime);

      for (let i = 1; i < waking.length; i++) {
        expect(waking[i].start, `${date}: gap or overlap at block ${i}`).toBe(
          waking[i - 1].end,
        );
      }
      expect(spanMs(waking), `${date}: total covers wake to bedtime`).toBe(
        d.bedtime - d.wake,
      );
    }
  });

  it("never produces a block that ends before it starts", () => {
    for (const date of dates) {
      for (const b of day(date).blocks) {
        expect(b.end, `${date}: ${b.key}`).toBeGreaterThan(b.start);
      }
    }
  });

  it("sleeps exactly nine hours every night", () => {
    for (const date of dates) {
      const d = day(date);
      const slept = d.blocks
        .filter((b) => b.kind === "sleep")
        .reduce((sum, b) => sum + (b.end - b.start), 0);
      expect(slept, `${date}`).toBe(9 * HOUR);
    }
  });

  it("keeps the workout at exactly one hour whatever the day looks like", () => {
    for (const date of dates) {
      const d = day(date);
      const workout = d.compression.find((c) => c.id === "workout")!;
      expect(workout.actualMs, `${date}`).toBe(1 * HOUR);
    }
  });

  it("never schedules an activity during a prayer", () => {
    for (const date of dates) {
      const d = day(date);
      const prayers = d.blocks.filter((b) => b.kind === "prayer");
      const activities = d.blocks.filter((b) => b.kind === "activity");
      for (const p of prayers) {
        for (const a of activities) {
          const overlaps = a.start < p.end && p.start < a.end;
          expect(overlaps, `${date}: ${a.title} overlaps ${p.title}`).toBe(false);
        }
      }
    }
  });

  it("holds the elastic work blocks above their floor", () => {
    for (const date of dates) {
      const d = day(date);
      // Scoped to the two elastic sequence blocks. The evening windows are in
      // `compression` for the readout but take whatever their prayer window
      // gives them, and a short March evening legitimately falls under an hour.
      for (const id of ["deep-work", "projects"]) {
        const c = d.compression.find((x) => x.id === id)!;
        expect(c.actualMs, `${date}: ${id}`).toBeGreaterThanOrEqual(90 * MIN);
      }
    }
  });

  it("gives every fixed block exactly its target, every day", () => {
    // Islamic study, journaling, no-screens and the workout are all fixed now,
    // so the sun never shortens any of them — it shortens the work blocks.
    for (const date of dates) {
      const d = day(date);
      for (const [id, want] of [
        ["workout", 1 * HOUR],
        ["islam", 2 * HOUR],
        ["journal", 1 * HOUR],
        ["no-screens", 1 * HOUR],
      ] as const) {
        const c = d.compression.find((x) => x.id === id)!;
        expect(c.actualMs, `${date}: ${id}`).toBe(want);
      }
    }
  });

  it("ends the waking sequence exactly at bedtime", () => {
    // The evening chains backwards from bedtime, not Isha. For most of the year
    // those are the same thing — the Isha prayer fills the final quarter hour —
    // but in winter the 20:30 floor sits hours after Isha, and that stretch
    // belongs to the day rather than to nothing.
    for (const date of dates) {
      const d = day(date);
      const activities = d.blocks.filter((b) => b.kind === "activity");
      expect(activities.length, `${date}`).toBeGreaterThan(0);
      // No-screens is always the last *activity*. Whether it also touches
      // bedtime depends on where the Isha prayer falls: for most of the year
      // Isha + 15m reaches bedtime exactly, so the final block of the day is
      // the prayer. The full-coverage invariant above is what guarantees there
      // is no hole either way.
      expect(activities[activities.length - 1].title, `${date}`).toBe("no screens");
    }
  });

  it("emits blocks in chronological order", () => {
    for (const date of dates) {
      const blocks = day(date).blocks;
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i].start, `${date}`).toBeGreaterThanOrEqual(blocks[i - 1].start);
      }
    }
  });
});

describe("resolveDay — the days worth eyeballing", () => {
  it("midsummer: split night, late bedtime, heavy compression", () => {
    const d = day("2026-06-15");
    expect(at(d.wake)).toBe("07:46");
    expect(at(d.bedtime)).toBe("22:16");
    expect(d.lastNight.shape).toBe("split");
    expect(d.tonight.flooredBedtime).toBe(false);

    // 13h of targets into a day that cannot hold them.
    for (const id of ["deep-work", "projects"]) {
      const c = d.compression.find((x) => x.id === id)!;
      expect(c.actualMs).toBeLessThan(c.targetMs);
    }
  });

  it("midwinter: the floor holds bedtime at 20:30 and wake at 05:30", () => {
    const d = day("2026-12-15");
    expect(at(d.bedtime)).toBe("20:30");
    expect(at(d.wake)).toBe("05:30");
    expect(d.tonight.flooredBedtime).toBe(true);
    expect(d.tonight.shape).toBe("ceiling");
    // Without the floor this would be a 03:25 start.
    expect(d.wake).toBeGreaterThan(d.prayers.fajr - 40 * MIN);
  });

  it("spring forward: still exactly nine hours of sleep across the lost hour", () => {
    // 2026-03-08, clocks go 02:00 to 03:00 in Los Angeles.
    const d = day("2026-03-08");
    const slept = d.lastNight.segments.reduce((s, x) => s + (x.end - x.start), 0);
    expect(slept).toBe(9 * HOUR);
  });

  it("fall back: nine hours of sleep, and a genuinely 25-hour day", () => {
    // 2026-11-01, clocks go 02:00 back to 01:00.
    const d = day("2026-11-01");
    const slept = d.lastNight.segments.reduce((s, x) => s + (x.end - x.start), 0);
    expect(slept).toBe(9 * HOUR);
    // Bed at 20:30 the night before, nine hours later reads 04:30 rather than
    // 05:30 — the hour that happened twice.
    expect(at(d.wake)).toBe("04:30");
  });

  it("orders the evening backwards from Isha: study, journal, no screens", () => {
    const d = day("2026-06-15");
    const islam = d.blocks.filter((b) => b.title === "islamic history, hadith, quran");
    const journal = d.blocks.filter((b) => b.title === "journal");
    const noScreens = d.blocks.filter((b) => b.title === "no screens");

    expect(islam.length).toBeGreaterThan(0);
    expect(journal.length).toBeGreaterThan(0);
    expect(noScreens.length).toBeGreaterThan(0);

    // no screens is the hour ending at Isha; journaling the hour before that;
    // islamic study the two hours before that.
    expect(noScreens[noScreens.length - 1].end).toBe(d.prayers.isha);
    expect(journal[journal.length - 1].end).toBe(noScreens[0].start);
    expect(islam[islam.length - 1].end).toBe(journal[0].start);
  });

  it("keeps journalling a full hour even when Maghrib lands inside it", () => {
    // The evening chain is laid out in *activity* time, so a prayer falling in
    // the middle of a block splits it rather than eating into it. Without that,
    // "journal for an hour" would quietly be 45 minutes on any day where
    // Maghrib happened to land there.
    for (const date of ["2026-06-15", "2026-08-09", "2026-12-15", "2026-03-08"]) {
      const d = day(date);
      const journal = d.compression.find((c) => c.id === "journal")!;
      expect(journal.actualMs, date).toBe(1 * HOUR);
    }
  });

  it("reclaims the winter gap between Isha and the bedtime floor", () => {
    // December's Isha is 18:09 and the floor holds bedtime at 20:30. Anchoring
    // the sequence to Isha left those two hours and change owned by nothing and
    // took them out of the work blocks; anchored to bedtime the day runs
    // through them, and the work blocks go from 3h12m each to 4h15m.
    const d = day("2026-12-15");
    expect(at(d.prayers.isha)).toBe("18:09");
    expect(at(d.bedtime)).toBe("20:30");

    const afterIsha = d.blocks.filter(
      (b) => b.kind === "activity" && b.start >= d.prayers.isha,
    );
    expect(spanMs(afterIsha)).toBeGreaterThan(2 * HOUR);

    for (const id of ["deep-work", "projects"]) {
      const c = d.compression.find((x) => x.id === id)!;
      expect(c.actualMs).toBeGreaterThan(4 * HOUR);
    }
  });

  it("keeps the work blocks within a narrow band all year", () => {
    // The point of anchoring to bedtime. Isha swings nearly four hours across
    // the year; the work total must not follow it.
    const sample: number[] = [];
    for (let i = 0; i < 365; i += 3) {
      const d = day(addDays("2026-01-01", i));
      sample.push(
        d.compression
          .filter((c) => c.id === "deep-work" || c.id === "projects")
          .reduce((sum, c) => sum + c.actualMs, 0),
      );
    }

    const min = Math.min(...sample);
    const max = Math.max(...sample);
    // The extremes are the two DST days, which are genuinely 23 and 25 hours.
    expect(min).toBeGreaterThanOrEqual(7.5 * HOUR);
    expect(max).toBeLessThanOrEqual(9.75 * HOUR);

    // Ordinary days cluster far more tightly than that.
    const tight = sample.filter((t) => t >= 8 * HOUR && t <= 9 * HOUR);
    expect(tight.length / sample.length).toBeGreaterThan(0.9);
  });

  it("rotates the workout title with the weekday", () => {
    // 2026-06-15 is a Monday: Day 1 of the protocol.
    const monday = day("2026-06-15").compression.find((c) => c.id === "workout")!;
    const sunday = day("2026-06-14").compression.find((c) => c.id === "workout")!;
    expect(monday.title).toBe("full-body resistance + moderate cardio");
    expect(sunday.title).toBe("active recovery — gentle yoga, stretching, meditation");
  });
});
