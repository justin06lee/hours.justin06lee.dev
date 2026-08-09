/**
 * The sleep rule.
 *
 * Everything else in the schedule is placed around when you wake and when you
 * go to bed, and both of those are functions of the sun rather than the clock —
 * so this resolver runs first and the rest of the day is fitted into what it
 * leaves. Pure arithmetic over epoch milliseconds; no database, no `Date.now()`.
 *
 * The rule, stated once:
 *
 *   1. Bed at Isha + 15 minutes, but never earlier than the floor (20:30).
 *      Without the floor, December's 18:10 Isha would put bedtime at 18:25 and
 *      — via rule 2 — wake at 03:25, two and a half hours before Fajr.
 *   2. Sleep 9 hours. That is a target *and* a ceiling: never more, and never
 *      so late that it runs past sunrise.
 *   3. If there isn't room for 9 hours before sunrise, don't shorten the night —
 *      split it. Up at Fajr − 15 for tahajjud and Fajr, then back to sleep for
 *      whatever is left of the 9 hours. Since the night is being interrupted
 *      anyway, it may as well be interrupted for the prayer.
 */

import { localInputToEpoch, minutesToHHMM } from "@/lib/calendar-dates";
import type { DayPrayerTimes } from "@/lib/prayer-times";

export type SleepConfig = {
  /** How much sleep to get. Both the target and the hard ceiling. */
  targetMs: number;
  /** Gap between Isha and bed, for praying it. */
  afterIshaMs: number;
  /**
   * Earliest bedtime, as minutes since site-local midnight. `null` disables it.
   *
   * This exists because Isha swings by nearly four hours across the year here,
   * and rule 2 turns an early Isha into an equally early morning. The floor
   * stops a December evening collapsing into a 6:25pm bedtime.
   */
  bedtimeFloorMinutes: number | null;
  /** How far before sunrise sleep must end, when sleeping through to morning. */
  beforeSunriseMs: number;
  /** How early to rise for tahajjud, measured back from Fajr. */
  tahajjudBeforeFajrMs: number;
  /** How long tahajjud plus Fajr takes, before going back to bed. */
  tahajjudBlockMs: number;
};

export type SleepSegment = { start: number; end: number };

/**
 * Why a night came out the way it did. Surfaced in the preview, because "why am
 * I waking at 05:30" should be answerable without reading this file.
 */
export type SleepShape =
  /** The night was long enough; the 9-hour ceiling decided the wake time. */
  | "ceiling"
  /** Too short for 9 hours before sunrise, so it was split around tahajjud. */
  | "split"
  /**
   * Degenerate: Fajr arrives at or before bedtime, so there is no first segment
   * to split off. Cannot happen at temperate latitudes — Isha and Fajr would
   * have to converge — but at high latitudes in summer they do, and returning a
   * usable night beats throwing inside a scheduler.
   */
  | "unsplittable";

export type SleepPlan = {
  bedtime: number;
  /** The final wake, after any tahajjud interruption. */
  wake: number;
  /** One segment normally, two when the night is split. */
  segments: SleepSegment[];
  /** The tahajjud-and-Fajr window between the segments, when split. */
  tahajjud: SleepSegment | null;
  shape: SleepShape;
  /** Time actually asleep, excluding any tahajjud gap. */
  sleepMs: number;
  /** True when the floor, not Isha, decided bedtime. */
  flooredBedtime: boolean;
};

/**
 * Splitting a night to gain a few minutes is worse than not splitting it: you
 * would be woken from the deepest part of the night for a first segment barely
 * long enough to count. Below this, sleep straight through instead.
 */
const MIN_FIRST_SEGMENT_MS = 30 * 60_000;

/**
 * Resolves the night that begins on `night.date`.
 *
 * `morning` must be the following day's times — the Fajr and sunrise that end
 * this night, not the ones that began it. Passing the same day twice produces a
 * night that ends before it starts, which is why the two are separate
 * parameters rather than one date the function walks itself.
 */
export function resolveSleep(
  night: DayPrayerTimes,
  morning: DayPrayerTimes,
  config: SleepConfig,
  timezone: string,
): SleepPlan {
  const afterIsha = night.isha + config.afterIshaMs;
  const floor =
    config.bedtimeFloorMinutes === null
      ? Number.NEGATIVE_INFINITY
      : localInputToEpoch(
          `${night.date}T${minutesToHHMM(config.bedtimeFloorMinutes)}`,
          timezone,
        );

  const bedtime = Math.max(afterIsha, floor);
  const flooredBedtime = floor > afterIsha;

  const latestWake = morning.sunrise - config.beforeSunriseMs;
  const uninterrupted = latestWake - bedtime;

  // Room for the whole night before sunrise: the ceiling decides.
  if (uninterrupted >= config.targetMs) {
    const wake = bedtime + config.targetMs;
    return {
      bedtime,
      wake,
      segments: [{ start: bedtime, end: wake }],
      tahajjud: null,
      shape: "ceiling",
      sleepMs: config.targetMs,
      flooredBedtime,
    };
  }

  const tahajjudStart = morning.fajr - config.tahajjudBeforeFajrMs;
  const firstSegment = tahajjudStart - bedtime;

  if (firstSegment < MIN_FIRST_SEGMENT_MS) {
    const wake = bedtime + config.targetMs;
    return {
      bedtime,
      wake,
      segments: [{ start: bedtime, end: wake }],
      tahajjud: null,
      shape: "unsplittable",
      sleepMs: config.targetMs,
      flooredBedtime,
    };
  }

  // Split. The tahajjud window is carved out of the night rather than counted
  // as part of it, so the two segments still add up to the full target.
  const resume = tahajjudStart + config.tahajjudBlockMs;
  const wake = resume + (config.targetMs - firstSegment);

  return {
    bedtime,
    wake,
    segments: [
      { start: bedtime, end: tahajjudStart },
      { start: resume, end: wake },
    ],
    tahajjud: { start: tahajjudStart, end: resume },
    shape: "split",
    sleepMs: config.targetMs,
    flooredBedtime,
  };
}
