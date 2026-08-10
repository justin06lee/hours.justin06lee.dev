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
 * A block that owns a span between two anchors, whatever length that turns out
 * to be. Used for the evening, where the prayer-to-prayer windows *are* the
 * intended durations — Asr to Maghrib is however long Asr to Maghrib is.
 */
export type WindowBlock = {
  id: string;
  /** Category name, resolved against `calendar_categories` at materialisation. */
  category: string;
  title: string;
  /** Starts when this prayer's gap ends. */
  from: PrayerName;
  /** Ends at this prayer, or at bedtime. */
  to: PrayerName | "bedtime";
  /**
   * Cap on how much of the window this block actually takes.
   *
   * A capped block **anchors to its end** rather than its start: it finishes at
   * `to` and begins `maxMs` before that, so the surplus falls at the *front* of
   * the window where the morning sequence can still reach it. Anchoring to the
   * start instead would leave the surplus stranded between the block and the
   * next prayer, belonging to nothing.
   */
  maxMs?: number;
  /** What this block is nominally worth, for the target-vs-actual readout. */
  targetMs?: number;
};

/**
 * A block in the run from waking to Asr, placed in order.
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
  /** Placed first; they own their spans outright. */
  windows: WindowBlock[];
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

  windows: [
    {
      id: "islam",
      category: "Islam",
      title: "islamic history, hadith, quran",
      from: "asr",
      to: "maghrib",
      // Two hours, ending at Maghrib. Asr to Maghrib runs to nearly three hours
      // in midsummer, and the surplus is worth more to the work blocks than to
      // a third hour here — so it sits at the front of the window, before this
      // starts, where the morning sequence picks it up.
      maxMs: 2 * HOUR,
      targetMs: 2 * HOUR,
    },
    {
      id: "journal",
      category: "Journal",
      title: "no screens, journal",
      from: "maghrib",
      // To bedtime rather than to Isha. With the floor in play there is a
      // stretch after Isha that belongs to the evening wind-down, and ending
      // this at Isha would leave it unassigned — over two hours of it in
      // December.
      to: "bedtime",
      // Deliberately **not** capped, unlike the Islamic study above. This block
      // is "no screens", which is a rule about the evening rather than a task
      // with a duration — capping it would hand the remainder back to the work
      // blocks, which is exactly the screen time it exists to prevent. In
      // December that makes it over three hours. The target is here only so the
      // readout shows how far past the nominal hour it runs.
      targetMs: 1 * HOUR,
    },
  ],

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
  ],
};
