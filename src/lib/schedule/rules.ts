/**
 * The schedule, as rules rather than times.
 *
 * **This file is the thing to edit when your life changes.** Everything else in
 * `lib/schedule/` is the engine that resolves it; none of it knows what a
 * "workout" is. An editor UI is a later job — until then, changing your routine
 * means changing this file, and the tests will tell you what it did.
 *
 * Nothing here is a clock time. Prayer times move by nearly four hours across
 * the year at this latitude, so a fixed timetable would be wrong for all but a
 * few weeks of it. Instead each activity says what it is anchored to and how
 * long it wants, and `resolve.ts` fits them to the actual day.
 */

import type { PrayerName } from "@/lib/prayer-times";
import type { SleepConfig } from "@/lib/schedule/sleep";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A block in the run from waking to bedtime, placed in order.
 *
 * `elastic` is the whole compression story. The targets below add up to more
 * hours than any day has, so something must give every single day — and the
 * answer is that the two long work blocks give, while the workout does not.
 * A fixed block always gets its `targetMs`; elastic blocks share whatever is
 * left, in proportion to their targets, clamped to their own bounds.
 */
export type SequenceBlock = {
  id: string;
  category: string;
  /** A function when the title depends on the weekday, as the workout does. */
  title: string | ((weekday: number) => string);
  targetMs: number;
  elastic: boolean;
  /** Only meaningful when elastic. Compression stops here. */
  minMs?: number;
  /** Only meaningful when elastic. Slack beyond this goes to the other blocks. */
  maxMs?: number;
};

export type Ruleset = {
  sleep: SleepConfig;
  /**
   * How long each prayer takes out of the day. Carved from whatever block is
   * running at the time, so a block spanning Dhuhr is split around it rather
   * than overlapping it.
   */
  prayerGaps: Record<PrayerName, number>;
  /** Fills waking to Asr, in this order. */
  sequence: SequenceBlock[];
};

/**
 * Bryan Johnson's Blueprint protocol, a seven-day rotation rather than a
 * weekday split — the source numbers them Day 1–7. Indexed here by JavaScript's
 * `getDay()` convention (0 = Sunday), so Day 1 lands on Monday and the rest
 * follow. Rotate the array to move the cycle.
 *
 * https://blueprint.bryanjohnson.com/blogs/news/exercise-and-fitness-protocol-for-longevity
 */
const WORKOUT_BY_WEEKDAY = [
  "active recovery — gentle yoga, stretching, meditation", // Sun  (Day 7)
  "full-body resistance + moderate cardio", // Mon  (Day 1)
  "HIIT + steady-state cardio", // Tue  (Day 2)
  "strength + yoga, flexibility, mobility", // Wed  (Day 3)
  "HIIT", // Thu  (Day 4)
  "full-body resistance", // Fri  (Day 5)
  "norwegian protocol HIIT", // Sat  (Day 6)
] as const;

export function workoutTitle(weekday: number): string {
  return WORKOUT_BY_WEEKDAY[weekday] ?? "workout";
}

/**
 * The live ruleset.
 *
 * The stated targets are 6h study, 1h workout, 6h projects, 2h Islamic study,
 * 1h journal and 9h sleep — **25 hours**, which is the point rather than a
 * mistake. The evening windows and sleep take what they take, and the two
 * six-hour blocks absorb the entire shortfall. In practice that lands each of
 * them near 3h45m rather than 6h; the preview prints target against realised so
 * that is visible rather than assumed.
 */
export const RULESET: Ruleset = {
  sleep: {
    targetMs: 9 * HOUR,
    afterIshaMs: 15 * MINUTE,
    // 20:30. Isha reaches 18:10 in December here, and without this the 9-hour
    // ceiling would set the alarm for 03:25.
    bedtimeFloorMinutes: 20 * 60 + 30,
    beforeSunriseMs: 15 * MINUTE,
    tahajjudBeforeFajrMs: 15 * MINUTE,
    // Tahajjud until Fajr enters, then Fajr itself.
    tahajjudBlockMs: 30 * MINUTE,
  },

  prayerGaps: {
    fajr: 15 * MINUTE,
    dhuhr: 30 * MINUTE,
    asr: 15 * MINUTE,
    maghrib: 15 * MINUTE,
    isha: 15 * MINUTE,
  },

  /**
   * The whole waking day, in order, from waking to bedtime.
   *
   * The evening is part of this sequence rather than anchored to prayer windows
   * because it no longer fits in one. Journaling and no-screens want an hour
   * each, and Maghrib to Isha is between 1h17m and 1h31m all year here — two
   * hours of evening has to begin before Maghrib, which means Islamic study
   * cannot also end at Maghrib. So the evening chains backwards from the end of
   * the day: no-screens last, journaling before it, Islamic study before that.
   *
   * That end is **bedtime**, not Isha. Bedtime is `max(Isha + 15m, 20:30)`, so
   * for most of the year it *is* Isha — the Isha prayer fills the final quarter
   * hour and no-screens still ends on it. In December, when Isha is 18:09 and
   * the floor holds bedtime at 20:30, it reaches the floor instead and the two
   * hours between them go to the day rather than to nothing.
   *
   * Fixed blocks are paid first and in full; the two elastic work blocks share
   * whatever is left. Adding two hours of fixed evening therefore comes
   * straight out of them, which is the intended trade.
   */
  sequence: [
    {
      id: "deep-work",
      category: "Study",
      title: "machine learning, cybersecurity",
      targetMs: 6 * HOUR,
      elastic: true,
      minMs: 90 * MINUTE,
    },
    {
      id: "workout",
      category: "Exercise",
      title: workoutTitle,
      targetMs: 1 * HOUR,
      // Fixed. A protocol that shrinks to 40 minutes because the sun moved is
      // not the protocol.
      elastic: false,
    },
    {
      id: "projects",
      category: "Project",
      title: "projects, thehifzproject, hikmah.chat",
      targetMs: 6 * HOUR,
      elastic: true,
      minMs: 90 * MINUTE,
    },
    {
      id: "islam",
      category: "Islam",
      title: "islamic history, hadith, quran",
      targetMs: 2 * HOUR,
      elastic: false,
    },
    {
      id: "journal",
      category: "Journal",
      title: "journal",
      targetMs: 1 * HOUR,
      elastic: false,
    },
    {
      id: "no-screens",
      category: "Journal",
      title: "no screens",
      targetMs: 1 * HOUR,
      elastic: false,
    },
  ],
};
