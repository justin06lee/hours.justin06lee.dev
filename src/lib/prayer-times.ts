/**
 * Prayer times for a given date at the configured location.
 *
 * **Computed locally rather than fetched.** The shared database already carries
 * a `prayer_times_cache` the sibling site fills from an API, and this module
 * deliberately does not read it, for two reasons. It stores only Fajr, Dhuhr,
 * Asr, Maghrib and Isha — no **sunrise**, which the sleep rule needs twice —
 * and it is another app's cache, keyed and shaped to that app's needs. Computing
 * from latitude and longitude is the same arithmetic every prayer-time API runs
 * server-side, so it agrees with them to the minute while costing no network
 * call, working for any date past or future, and never failing at 3am because
 * somebody else's service is down.
 *
 * That last property is load-bearing: the schedule has to be resolvable for
 * arbitrary historical dates to backfill a log, and for tomorrow to show what
 * is coming. A monthly cache can do neither.
 */

// Named imports, not a default: adhan ships ESM and CJS builds and neither
// declares a default export, so `import adhan from "adhan"` type-checks under
// esModuleInterop and then fails at runtime.
import {
  CalculationMethod,
  Coordinates,
  PrayerTimes,
  type CalculationParameters,
} from "adhan";
import type { PrayerLocation } from "@/lib/site-config";
import { epochToDateInTz } from "@/lib/calendar-dates";

/** The six solar instants a day is built around. Epoch ms. */
export type DayPrayerTimes = {
  /** The site-local date these belong to, "YYYY-MM-DD". */
  date: string;
  fajr: number;
  sunrise: number;
  dhuhr: number;
  asr: number;
  maghrib: number;
  isha: number;
};

export type PrayerName = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";

/** In the order they occur. `sunrise` is not a prayer and is excluded. */
export const PRAYER_ORDER: readonly PrayerName[] = [
  "fajr",
  "dhuhr",
  "asr",
  "maghrib",
  "isha",
];

/**
 * Aladhan's numeric `method` (what `site_config.prayerLocation` stores, because
 * the sibling site talks to that API) mapped onto adhan's named parameter sets.
 *
 * The two libraries implement the same published conventions, so a given method
 * produces the same angles either way — this is a naming translation, not an
 * approximation. Method 2 is ISNA, which adhan calls NorthAmerica, and is what
 * the configured location uses.
 */
const METHOD_BY_ALADHAN_ID: Record<number, () => CalculationParameters> = {
  1: CalculationMethod.Karachi,
  2: CalculationMethod.NorthAmerica,
  3: CalculationMethod.MuslimWorldLeague,
  4: CalculationMethod.UmmAlQura,
  5: CalculationMethod.Egyptian,
  7: CalculationMethod.Tehran,
  8: CalculationMethod.Dubai,
  9: CalculationMethod.Kuwait,
  10: CalculationMethod.Qatar,
  11: CalculationMethod.Singapore,
  13: CalculationMethod.Turkey,
  15: CalculationMethod.MoonsightingCommittee,
};

const reportedUnknownMethods = new Set<number>();

function parametersFor(method: number): CalculationParameters {
  const factory = METHOD_BY_ALADHAN_ID[method];
  if (factory) return factory();
  // A method this map doesn't know is a configuration the sibling site set and
  // this one hasn't been taught. Falling back keeps the schedule resolvable
  // with times that are close rather than refusing to produce a day at all,
  // but it is wrong-by-a-few-minutes and has to be findable.
  if (!reportedUnknownMethods.has(method)) {
    reportedUnknownMethods.add(method);
    console.warn(
      `prayer-times: unknown calculation method ${method}; falling back to Muslim World League. ` +
        `Add it to METHOD_BY_ALADHAN_ID if this location really uses it.`,
    );
  }
  return CalculationMethod.MuslimWorldLeague();
}

/**
 * Builds the `Date` adhan wants for a given calendar day.
 *
 * adhan reads the day out of the Date with `getFullYear`/`getMonth`/`getDate`,
 * which are **system-local** getters. On a server running in UTC — which is
 * every deployment of this app — passing `new Date()` after 5pm Pacific asks for
 * tomorrow's solar day, and every time comes back shifted by a day. Parsing
 * `YYYY-MM-DDT12:00:00` without a zone designator makes the runtime interpret it
 * in system-local time, so those three getters return exactly the requested
 * calendar date whatever the server's zone is. Noon rather than midnight so no
 * rounding or DST shift can push it onto an adjacent day.
 */
function solarDateFor(date: string): Date {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`prayer-times: "${date}" is not a YYYY-MM-DD date`);
  }
  return d;
}

/**
 * Thrown when the location has no coordinates. The schedule cannot be resolved
 * without them, and guessing a location would silently produce a plausible,
 * wrong day — worse than refusing.
 */
export class MissingCoordinatesError extends Error {
  constructor() {
    super(
      "prayer-times: site_config.prayerLocation has no latitude/longitude, so prayer times " +
        "cannot be computed. Set them to enable the schedule.",
    );
    this.name = "MissingCoordinatesError";
  }
}

export function hasCoordinates(
  location: PrayerLocation,
): location is PrayerLocation & { latitude: number; longitude: number } {
  return typeof location.latitude === "number" && typeof location.longitude === "number";
}

/**
 * The six times for one site-local calendar date.
 *
 * `date` is a site-local `YYYY-MM-DD`, and the returned instants are epoch ms —
 * the same currency as everything else in this codebase, so they drop straight
 * into intervals without another timezone conversion.
 */
export function prayerTimesFor(date: string, location: PrayerLocation): DayPrayerTimes {
  if (!hasCoordinates(location)) throw new MissingCoordinatesError();

  const coordinates = new Coordinates(location.latitude, location.longitude);
  const params = parametersFor(location.method);
  const times = new PrayerTimes(coordinates, solarDateFor(date), params);

  return {
    date,
    fajr: times.fajr.getTime(),
    sunrise: times.sunrise.getTime(),
    dhuhr: times.dhuhr.getTime(),
    asr: times.asr.getTime(),
    maghrib: times.maghrib.getTime(),
    isha: times.isha.getTime(),
  };
}

/**
 * Sanity check that the computed day actually lands on the date asked for.
 *
 * Exported because the polar-latitude and date-construction failure modes both
 * show up as "the times are for the wrong day", and a caller materialising a log
 * should be able to assert rather than write a day of entries into the wrong
 * one. Not called on the happy path.
 */
export function prayerTimesLandOnDate(times: DayPrayerTimes, timezone: string): boolean {
  return epochToDateInTz(times.dhuhr, timezone) === times.date;
}
