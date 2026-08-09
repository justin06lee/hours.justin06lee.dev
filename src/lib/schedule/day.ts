/**
 * The one place that turns "a date" into "a resolved day".
 *
 * Everything below this is pure; everything above it reads configuration. This
 * module is the seam: it fetches the site's location and timezone, computes the
 * three days of prayer times a resolution needs, and hands back the day.
 */

import { cache } from "react";
import { getSiteConfig, resolveTimezone } from "@/lib/site-config";
import { hasCoordinates, prayerTimesFor } from "@/lib/prayer-times";
import { RULESET } from "@/lib/schedule/rules";
import { resolveDay, type ResolvedDay } from "@/lib/schedule/resolve";
import { addDays, todayInTz } from "@/lib/calendar-dates";

/**
 * The weekday of a site-local date, 0 = Sunday.
 *
 * Parsed at noon UTC rather than midnight so no timezone can pull the date onto
 * the day before, which would rotate the workout by one and put Sunday's
 * recovery session on a Saturday.
 */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export type ScheduleUnavailable = {
  ok: false;
  /** Why no schedule could be produced, in words meant for the page. */
  reason: string;
};

export type ScheduleAvailable = {
  ok: true;
  timezone: string;
  today: string;
  days: ResolvedDay[];
};

export type ScheduleResult = ScheduleAvailable | ScheduleUnavailable;

/**
 * Resolves `count` consecutive days starting at `from` (defaulting to today).
 *
 * `cache()`d so a page rendering the schedule twice — metadata and body, or two
 * components — computes it once. The resolution itself is pure arithmetic, but
 * it needs the site config, and that is a database read.
 */
export const getSchedule = cache(
  async (count = 2, from?: string): Promise<ScheduleResult> => {
    const config = await getSiteConfig();
    const timezone = resolveTimezone(config);
    const location = config.prayerLocation;

    if (!hasCoordinates(location)) {
      return {
        ok: false,
        reason:
          "the schedule is driven by prayer times, and site_config.prayerLocation has no " +
          "latitude or longitude set. Add them and the schedule resolves itself.",
      };
    }

    const today = todayInTz(timezone);
    const start = from ?? today;

    const days: ResolvedDay[] = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(start, i);
      // Three days of times per resolved day: yesterday's Isha set last night's
      // bedtime and therefore this morning's wake, and tomorrow's Fajr and
      // sunrise end tonight.
      days.push(
        resolveDay(
          prayerTimesFor(addDays(date, -1), location),
          prayerTimesFor(date, location),
          prayerTimesFor(addDays(date, 1), location),
          RULESET,
          timezone,
          weekdayOf(date),
        ),
      );
    }

    return { ok: true, timezone, today, days };
  },
);
