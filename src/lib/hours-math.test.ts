import { describe, it, expect } from "vitest";
import {
  mergeIntervals,
  unionMs,
  rawMs,
  splitByDay,
  computeStreak,
  formatHours,
  formatElapsed,
  slugify,
  MS_PER_HOUR,
} from "@/lib/hours-math";

const H = MS_PER_HOUR;

describe("mergeIntervals", () => {
  it("returns nothing for no input", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it("leaves disjoint intervals alone, in order", () => {
    expect(mergeIntervals([{ start: 3, end: 4 }, { start: 1, end: 2 }])).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("merges overlapping intervals", () => {
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toEqual([
      { start: 0, end: 20 },
    ]);
  });

  it("merges back-to-back intervals", () => {
    // The break-alarm closes one chunk and opens the next at the same instant;
    // those are one continuous stretch of work, not two.
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual([
      { start: 0, end: 20 },
    ]);
  });

  it("absorbs a fully-contained interval", () => {
    expect(mergeIntervals([{ start: 0, end: 100 }, { start: 10, end: 20 }])).toEqual([
      { start: 0, end: 100 },
    ]);
  });

  it("discards zero-length and inverted spans", () => {
    expect(mergeIntervals([{ start: 5, end: 5 }, { start: 10, end: 4 }])).toEqual([]);
  });

  it("discards non-finite spans rather than poisoning the total", () => {
    expect(mergeIntervals([{ start: 0, end: Infinity }, { start: NaN, end: 5 }])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [{ start: 0, end: 10 }, { start: 5, end: 20 }];
    const copy = structuredClone(input);
    mergeIntervals(input);
    expect(input).toEqual(copy);
  });
});

describe("unionMs vs rawMs — the site's central distinction", () => {
  it("counts an hour of two parallel activities once in the union", () => {
    // Coding and chess, same hour. One hour of life passed.
    const parallel = [{ start: 0, end: H }, { start: 0, end: H }];
    expect(unionMs(parallel)).toBe(H);
  });

  it("counts that same hour twice in the raw sum", () => {
    // ...but it really was an hour of each subject.
    const parallel = [{ start: 0, end: H }, { start: 0, end: H }];
    expect(rawMs(parallel)).toBe(2 * H);
  });

  it("counts partial overlap correctly", () => {
    // 0-2h and 1-3h: three hours covered, four hours claimed.
    const overlapping = [{ start: 0, end: 2 * H }, { start: H, end: 3 * H }];
    expect(unionMs(overlapping)).toBe(3 * H);
    expect(rawMs(overlapping)).toBe(4 * H);
  });

  it("agrees with the raw sum when nothing overlaps", () => {
    const serial = [{ start: 0, end: H }, { start: 2 * H, end: 3 * H }];
    expect(unionMs(serial)).toBe(rawMs(serial));
  });

  it("never lets the union exceed elapsed wall-clock time", () => {
    // The invariant that makes the headline number trustworthy.
    const many = Array.from({ length: 8 }, () => ({ start: 0, end: H }));
    expect(unionMs(many)).toBeLessThanOrEqual(H);
  });
});

describe("splitByDay", () => {
  const TZ = "America/Los_Angeles";
  // 2026-03-10T12:00:00 in LA.
  const noon = Date.parse("2026-03-10T20:00:00.000Z");

  it("keeps a within-day span on one day", () => {
    const segs = splitByDay({ start: noon, end: noon + 2 * H }, TZ);
    expect(segs).toHaveLength(1);
    expect(segs[0].date).toBe("2026-03-10");
    expect(segs[0].end - segs[0].start).toBe(2 * H);
  });

  it("splits a cross-midnight span across both days", () => {
    // 23:00 to 01:00 local.
    const late = Date.parse("2026-03-11T06:00:00.000Z"); // 23:00 LA on the 10th
    const segs = splitByDay({ start: late, end: late + 2 * H }, TZ);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0].date).toBe("2026-03-10");
    expect(segs[segs.length - 1].date).toBe("2026-03-11");
  });

  it("conserves total duration when splitting", () => {
    // Whatever the boundary handling, no time may be invented or lost.
    const late = Date.parse("2026-03-11T06:00:00.000Z");
    const total = 5 * H;
    const segs = splitByDay({ start: late, end: late + total }, TZ);
    const summed = segs.reduce((s, x) => s + (x.end - x.start), 0);
    expect(summed).toBe(total);
  });

  it("produces contiguous, ordered segments", () => {
    const late = Date.parse("2026-03-11T06:00:00.000Z");
    const segs = splitByDay({ start: late, end: late + 5 * H }, TZ);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBe(segs[i - 1].end);
    }
  });

  it("returns nothing for an empty span", () => {
    expect(splitByDay({ start: noon, end: noon }, TZ)).toEqual([]);
  });
});

describe("computeStreak", () => {
  const TODAY = "2026-07-28";

  it("counts a run ending today", () => {
    const active = new Set(["2026-07-26", "2026-07-27", "2026-07-28"]);
    expect(computeStreak(active, TODAY).current).toBe(3);
  });

  it("does not break the streak just because today has nothing yet", () => {
    // The day isn't over. Logging nothing at 9am must not zero a 5-day run.
    const active = new Set(["2026-07-26", "2026-07-27"]);
    expect(computeStreak(active, TODAY).current).toBe(2);
  });

  it("breaks once a full empty day has passed", () => {
    // Nothing on the 27th or 28th: the 27th is genuinely missed.
    const active = new Set(["2026-07-25", "2026-07-26"]);
    expect(computeStreak(active, TODAY).current).toBe(0);
  });

  it("reports zero for an empty history", () => {
    expect(computeStreak(new Set(), TODAY)).toEqual({
      current: 0,
      best: 0,
      days: Array(14).fill(false),
    });
  });

  it("finds the best historical run even when it is not current", () => {
    const active = new Set([
      "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
      "2026-07-28",
    ]);
    const s = computeStreak(active, TODAY);
    expect(s.best).toBe(4);
    expect(s.current).toBe(1);
  });

  it("never reports a best below the current run", () => {
    const active = new Set(["2026-07-27", "2026-07-28"]);
    const s = computeStreak(active, TODAY);
    expect(s.best).toBeGreaterThanOrEqual(s.current);
  });

  it("returns the trailing window most-recent-last", () => {
    const active = new Set(["2026-07-28"]);
    const { days } = computeStreak(active, TODAY, 3);
    expect(days).toEqual([false, false, true]);
  });

  it("handles month boundaries", () => {
    const active = new Set(["2026-06-30", "2026-07-01"]);
    expect(computeStreak(active, "2026-07-01").current).toBe(2);
  });
});

describe("formatting", () => {
  it("formats hours to one decimal at or above an hour", () => {
    expect(formatHours(384.8 * H)).toBe("384.8h");
    expect(formatHours(H)).toBe("1.0h");
  });

  it("drops to minutes below an hour", () => {
    expect(formatHours(42 * 60_000)).toBe("42m");
  });

  it("formats elapsed like now-playing-bar", () => {
    expect(formatElapsed(H + 2 * 60_000)).toBe("1h 2m");
    expect(formatElapsed(2 * 60_000 + 3000)).toBe("2m 3s");
    expect(formatElapsed(4000)).toBe("4s");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Machine Learning")).toBe("machine-learning");
  });

  it("strips punctuation and collapses runs", () => {
    expect(slugify("  C++  //  Rust!  ")).toBe("c-rust");
  });

  it("handles the real category names", () => {
    expect(slugify("Islam")).toBe("islam");
    expect(slugify("Oddjob")).toBe("oddjob");
  });
});
