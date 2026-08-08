import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeIntervals,
  unionMs,
  rawMs,
  splitByDay,
  dailyUnion,
  activeYears,
  computeStreak,
  formatHours,
  formatElapsed,
  slugify,
  uniqueSlugs,
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

  it("skips non-finite spans in the raw sum rather than poisoning it", () => {
    // mergeIntervals has always filtered these (see above), but rawMs guarded
    // only `end`: `Math.max(0, NaN)` is NaN, so a single corrupt row turned
    // every per-subject total on the page into NaN.
    expect(rawMs([{ start: NaN, end: 5 }, { start: 0, end: H }])).toBe(H);
    expect(rawMs([{ start: Infinity, end: 5 }, { start: 0, end: H }])).toBe(H);
    expect(rawMs([{ start: NaN, end: NaN }])).toBe(0);
  });

  it("treats a non-finite end as zero duration, not as a dropped row", () => {
    // A still-running entry reaches here with no end; it contributes nothing
    // yet, which is different from the row being invalid.
    expect(rawMs([{ start: 100, end: Infinity }])).toBe(0);
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

describe("splitByDay — day boundaries land on true local midnight", () => {
  const TZ = "America/Los_Angeles";
  // The 2026 US transitions, both in LA:
  //   spring forward  2026-03-08 02:00 PST -> 03:00 PDT  (a 23-hour day)
  //   fall back       2026-11-01 02:00 PDT -> 01:00 PST  (a 25-hour day)
  // The pre-existing tests above use 2026-03-10/03-11, which sit on the same
  // side of the transition as each other — so DST was never actually exercised
  // despite the code comment naming it as the reason for the design.
  const MAR_08_MIDNIGHT = Date.parse("2026-03-08T08:00:00.000Z"); // PST, UTC-8
  const MAR_09_MIDNIGHT = Date.parse("2026-03-09T07:00:00.000Z"); // PDT, UTC-7
  const NOV_01_MIDNIGHT = Date.parse("2026-11-01T07:00:00.000Z"); // PDT, UTC-7
  const NOV_02_MIDNIGHT = Date.parse("2026-11-02T08:00:00.000Z"); // PST, UTC-8

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lands the boundary on the exact millisecond for a sub-minute start", () => {
    // 23:00:37.123 local on 2026-06-30. Stepping in whole minutes put the cut
    // at 00:00:37.123, handing 37 seconds of July to June.
    const start = Date.parse("2026-07-01T06:00:37.123Z");
    const segs = splitByDay({ start, end: start + 3 * H }, TZ);
    expect(segs[0].date).toBe("2026-06-30");
    expect(segs[0].end).toBe(Date.parse("2026-07-01T07:00:00.000Z"));
    expect(segs[1].date).toBe("2026-07-01");
    expect(segs[1].start).toBe(Date.parse("2026-07-01T07:00:00.000Z"));
  });

  it("gives the spring-forward day 23 hours, not 24", () => {
    // Deliberately started off a whole minute, so the boundary assertions below
    // catch minute-granularity stepping as well as a mishandled transition.
    const segs = splitByDay(
      { start: Date.parse("2026-03-07T20:00:17.500Z"), end: Date.parse("2026-03-10T20:00:17.500Z") },
      TZ,
    );
    const mar08 = segs.find((s) => s.date === "2026-03-08")!;
    expect(mar08.start).toBe(MAR_08_MIDNIGHT);
    expect(mar08.end).toBe(MAR_09_MIDNIGHT);
    expect(mar08.end - mar08.start).toBe(23 * H);
  });

  it("gives the fall-back day 25 hours, not 24", () => {
    const segs = splitByDay(
      { start: Date.parse("2026-10-31T20:00:29.750Z"), end: Date.parse("2026-11-03T20:00:29.750Z") },
      TZ,
    );
    const nov01 = segs.find((s) => s.date === "2026-11-01")!;
    expect(nov01.start).toBe(NOV_01_MIDNIGHT);
    expect(nov01.end).toBe(NOV_02_MIDNIGHT);
    expect(nov01.end - nov01.start).toBe(25 * H);
  });

  it("conserves duration and stays contiguous across a transition", () => {
    // The invariant that matters most: however the boundaries move, the day
    // segments must still tile the span exactly.
    const start = Date.parse("2026-03-07T20:00:17.500Z");
    const total = 72 * H;
    const segs = splitByDay({ start, end: start + total }, TZ);
    expect(segs.reduce((s, x) => s + (x.end - x.start), 0)).toBe(total);
    expect(segs[0].start).toBe(start);
    expect(segs[segs.length - 1].end).toBe(start + total);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
  });

  it("splits a span of 500 days without dropping the tail", () => {
    // The old guard stopped at 400 segments and returned quietly, so a timer
    // left running for over a year contributed 400 days to the heatmap while
    // the headline total (which doesn't route through here) counted all of it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = Date.parse("2025-01-01T12:00:00.000Z");
    const total = 500 * 24 * H;
    const segs = splitByDay({ start, end: start + total }, TZ);
    expect(segs.length).toBeGreaterThan(400);
    expect(segs.reduce((s, x) => s + (x.end - x.start), 0)).toBe(total);
    expect(segs[segs.length - 1].end).toBe(start + total);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns rather than truncating silently when the guard does trip", () => {
    // Slow by design — the only way to reach the bound is to actually produce
    // that many segments. It buys the guarantee that a corrupt row announces
    // itself instead of quietly deleting decades, and that it does not throw
    // and take the page down with it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const start = Date.parse("1990-01-01T12:00:00.000Z");
    const segs = splitByDay({ start, end: Date.parse("2026-01-01T12:00:00.000Z") }, TZ);
    expect(segs.length).toBe(10_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("truncated");
  });
});

describe("dailyUnion — the one producer behind both heatmaps", () => {
  const TZ = "America/New_York";
  // 2026-06-30, EDT (UTC-4).
  const at = (hhmm: string) => Date.parse(`2026-06-30T${hhmm}:00.000-04:00`);

  it("returns nothing for no intervals", () => {
    expect(dailyUnion([], TZ)).toEqual({});
  });

  it("sums disjoint spans within a day", () => {
    const daily = dailyUnion(
      [
        { start: at("09:00"), end: at("11:00") },
        { start: at("14:00"), end: at("15:00") },
      ],
      TZ,
    );
    expect(daily).toEqual({ "2026-06-30": 3 * H });
  });

  it("counts two lanes running at once ONCE, not twice", () => {
    // The whole reason a day's cell unions rather than sums: coding while a
    // workout is timed is one hour of that afternoon, not two.
    const parallel = dailyUnion(
      [
        { start: at("13:00"), end: at("14:00") },
        { start: at("13:00"), end: at("14:00") },
      ],
      TZ,
    );
    expect(parallel).toEqual({ "2026-06-30": 1 * H });
  });

  it("merges partially overlapping lanes into their covered span", () => {
    const daily = dailyUnion(
      [
        { start: at("13:00"), end: at("14:30") },
        { start: at("14:00"), end: at("15:00") },
      ],
      TZ,
    );
    expect(daily).toEqual({ "2026-06-30": 2 * H });
  });

  it("splits a cross-midnight span across both days it touches", () => {
    const daily = dailyUnion(
      [{ start: at("23:00"), end: at("23:00") + 2 * H }],
      TZ,
    );
    expect(daily).toEqual({ "2026-06-30": 1 * H, "2026-07-01": 1 * H });
  });

  it("unions per day, not across days", () => {
    // Two lanes overlapping across the same midnight: each day still counts its
    // own covered time once.
    const daily = dailyUnion(
      [
        { start: at("23:00"), end: at("23:00") + 2 * H },
        { start: at("23:30"), end: at("23:30") + 2 * H },
      ],
      TZ,
    );
    expect(daily).toEqual({ "2026-06-30": 1 * H, "2026-07-01": 1.5 * H });
  });
});

describe("activeYears", () => {
  it("returns nothing for an empty map", () => {
    expect(activeYears({})).toEqual([]);
  });

  it("lists each year once, newest first", () => {
    expect(
      activeYears({
        "2024-03-01": H,
        "2026-01-09": H,
        "2024-11-30": H,
        "2025-07-04": H,
      }),
    ).toEqual([2026, 2025, 2024]);
  });

  it("omits a year whose only days are worth zero", () => {
    // splitByDay can emit a zero-length segment exactly on a boundary. Offering
    // that year in the switcher would open the heatmap on an empty grid.
    expect(activeYears({ "2024-01-01": 0, "2026-05-05": H })).toEqual([2026]);
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

  it("handles year boundaries", () => {
    // A run must not reset just because the calendar year did.
    const active = new Set(["2025-12-30", "2025-12-31", "2026-01-01"]);
    const s = computeStreak(active, "2026-01-01");
    expect(s.current).toBe(3);
    expect(s.best).toBe(3);
  });

  it("carries the trailing window back across a year boundary", () => {
    const active = new Set(["2025-12-31", "2026-01-01"]);
    const { days } = computeStreak(active, "2026-01-02", 4);
    // 2025-12-30, 2025-12-31, 2026-01-01, 2026-01-02
    expect(days).toEqual([false, true, true, false]);
  });

  it("pads the window with false when it outruns the history", () => {
    const active = new Set(["2026-07-28"]);
    const s = computeStreak(active, TODAY, 30);
    expect(s.days).toHaveLength(30);
    expect(s.days[29]).toBe(true);
    expect(s.days.slice(0, 29).every((d) => d === false)).toBe(true);
    expect(s.current).toBe(1);
    expect(s.best).toBe(1);
  });

  it("handles a leap day in the window", () => {
    const active = new Set(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(computeStreak(active, "2028-03-01").current).toBe(3);
  });
});

describe("formatting", () => {
  it("formats hours to one decimal at or above an hour", () => {
    expect(formatHours(384.8 * H)).toBe("384.8h");
    expect(formatHours(H)).toBe("1.0h");
  });

  it("drops to minutes below an hour", () => {
    expect(formatHours(42 * 60_000)).toBe("42m");
    expect(formatHours(59.4 * 60_000)).toBe("59m");
  });

  it("switches to the hour format once minutes round up to 60", () => {
    // The unit was chosen before the rounding, so 59.5–59.99 min failed the
    // `>= 1h` test and then rounded to a label of "60m" — a reading the minutes
    // format cannot legitimately produce.
    expect(formatHours(59.5 * 60_000)).toBe("1.0h");
    expect(formatHours(59.99 * 60_000)).toBe("1.0h");
    expect(formatHours(60 * 60_000)).toBe("1.0h");
  });

  it("clamps negative durations to zero", () => {
    // A negative duration is a corrupt row, not a measurement; "-30m" on the
    // page reads like one.
    expect(formatHours(-30 * 60_000)).toBe("0m");
    expect(formatHours(-5 * H)).toBe("0m");
    expect(formatHours(0)).toBe("0m");
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

describe("slugify — the collisions uniqueSlugs exists to resolve", () => {
  // slugify is the right base transform and these assertions are true of it by
  // design: it is a lossy projection of a name onto [a-z0-9-], so distinct names
  // can and do land on the same slug. What was broken was using that projection
  // directly as a URL key — /s/[subject] resolved subjects first-match-wins, so
  // each collision below served one category's numbers under another's name and
  // left the loser unreachable, and an empty slug matched nothing at all.
  // uniqueSlugs (below) layers uniqueness on top; this block documents exactly
  // which inputs make that layer necessary.

  it("collides on names that differ only in stripped punctuation", () => {
    // "C++" and "C#" are two different subjects with one URL between them.
    expect(slugify("C++")).toBe("c");
    expect(slugify("C#")).toBe("c");
    expect(slugify("C++")).toBe(slugify("C#"));
  });

  it("collides on a display name and its own slug", () => {
    expect(slugify("Machine Learning")).toBe("machine-learning");
    expect(slugify("machine-learning")).toBe("machine-learning");
    expect(slugify("Machine Learning")).toBe(slugify("machine-learning"));
  });

  it("collides on names differing only in separators", () => {
    expect(slugify("Deep Work")).toBe(slugify("deep/work"));
    expect(slugify("Deep Work")).toBe(slugify("Deep_Work"));
  });

  it("produces an empty slug for non-ASCII names", () => {
    // Every non-Latin category name maps to the same unroutable "" slug.
    expect(slugify("日本語")).toBe("");
    expect(slugify("Русский")).toBe("");
    expect(slugify("العربية")).toBe("");
    expect(slugify("日本語")).toBe(slugify("Русский"));
  });

  it("strips accents to nothing rather than transliterating them", () => {
    // "Café" should slug to "cafe"; instead the accented letter is a separator.
    expect(slugify("Café")).toBe("caf");
    expect(slugify("Über")).toBe("ber");
  });

  it("produces an empty slug for punctuation-only names", () => {
    expect(slugify("???")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("uniqueSlugs", () => {
  // Real ids are UUIDs; any stable string works, the suffix is hashed from it.
  const cpp = { id: "11111111-1111-4111-8111-111111111111", name: "C++" };
  const csharp = { id: "22222222-2222-4222-8222-222222222222", name: "C#" };
  const cobol = { id: "33333333-3333-4333-8333-333333333333", name: "C  !" };

  /** Every slug present, non-empty, and distinct — the whole point of the fn. */
  const expectUsable = (slugs: string[]) => {
    for (const s of slugs) expect(s).not.toBe("");
    expect(new Set(slugs).size).toBe(slugs.length);
  };

  it("leaves non-colliding names exactly where slugify put them", () => {
    // The common case must not churn a single existing URL.
    const subjects = [
      { id: "a", name: "Islam" },
      { id: "b", name: "Oddjob" },
      { id: "c", name: "Machine Learning" },
    ];
    expect(uniqueSlugs(subjects)).toEqual(subjects.map((s) => slugify(s.name)));
  });

  it("gives C++ and C# separate URLs, first claimant keeps the bare slug", () => {
    const slugs = uniqueSlugs([cpp, csharp]);
    expect(slugs[0]).toBe("c");
    expect(slugs[1]).not.toBe("c");
    expect(slugs[1].startsWith("c-")).toBe(true);
    expectUsable(slugs);
  });

  it("separates a display name from its own slug written out", () => {
    const slugs = uniqueSlugs([
      { id: "a", name: "Machine Learning" },
      { id: "b", name: "machine-learning" },
    ]);
    expect(slugs[0]).toBe("machine-learning");
    expect(slugs[1].startsWith("machine-learning-")).toBe(true);
    expectUsable(slugs);
  });

  it("resolves a three-way collision", () => {
    const slugs = uniqueSlugs([cpp, csharp, cobol]);
    expect(slugs[0]).toBe("c");
    expectUsable(slugs);
  });

  it("gives names with no ASCII alphanumerics a usable slug anyway", () => {
    // These all slugify to "", which does not match the dynamic segment at all:
    // the link rendered as /s/ and 404'd on a category with real hours on it.
    const slugs = uniqueSlugs([
      { id: "a", name: "日本語" },
      { id: "b", name: "Русский" },
      { id: "c", name: "!!!" },
      { id: "d", name: "   " },
    ]);
    for (const s of slugs) expect(s).toMatch(/^subject-[a-z0-9]+$/);
    expectUsable(slugs);
  });

  it("is deterministic across calls", () => {
    const subjects = [cpp, csharp, cobol, { id: "d", name: "日本語" }];
    expect(uniqueSlugs(subjects)).toEqual(uniqueSlugs(subjects));
  });

  it("does not change an existing subject's slug when an unrelated one appears", () => {
    // The reason the suffix is hashed from the id and not from a counter: with
    // a counter, C#'s URL would depend on how many other subjects sorted above
    // it, so logging an hour of chess would silently break every inbound link.
    const before = uniqueSlugs([cpp, csharp]);
    const after = uniqueSlugs([
      { id: "z", name: "Chess" },
      cpp,
      { id: "y", name: "Islam" },
      csharp,
    ]);
    expect(after[1]).toBe(before[0]);
    expect(after[3]).toBe(before[1]);
  });

  it("resolves a generated suffix that collides with a real name's base slug", () => {
    // Someone can legitimately name a category exactly what the suffixer would
    // have produced. The base claimant wins and the suffixed entry lengthens
    // its hash — the one case where an added subject does move another's URL,
    // and unavoidable, since collision-freedom is a property of the whole set.
    const suffixed = uniqueSlugs([cpp, csharp])[1];
    const decoy = { id: "44444444-4444-4444-8444-444444444444", name: suffixed };
    const slugs = uniqueSlugs([cpp, decoy, csharp]);
    expect(slugs[0]).toBe("c");
    expect(slugs[1]).toBe(suffixed);
    expect(slugs[2]).not.toBe(suffixed);
    expect(slugs[2].startsWith(suffixed)).toBe(true);
    expectUsable(slugs);
  });

  it("leaves the uncategorized bucket unaddressable and out of the running", () => {
    // id null is the no-category bucket: never linked, so it must never claim
    // a slug a real category could have had.
    const slugs = uniqueSlugs([
      { id: null, name: "uncategorized" },
      { id: "a", name: "Uncategorized" },
    ]);
    expect(slugs[0]).toBe("");
    expect(slugs[1]).toBe("uncategorized");
  });

  it("returns nothing for an empty list", () => {
    expect(uniqueSlugs([])).toEqual([]);
  });
});
