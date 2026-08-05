import { cache } from "react";
import { db, initDb } from "./db";

export type Pfp = {
  url: string;
  scale: number;
  x: number;
  y: number;
};

export type PrayerLocation = {
  city: string;
  country: string;
  method: number;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
};

export type SiteConfig = {
  description: string[];
  socials: {
    github: string;
    linkedin: string;
    x: string;
    email: string;
    instagram: string;
  };
  pfp: Pfp;
  prayerLocation: PrayerLocation;
};

export const DEFAULT_TIMEZONE = "America/New_York";

const EMPTY_CONFIG: SiteConfig = {
  description: [],
  socials: { github: "", linkedin: "", x: "", email: "", instagram: "" },
  pfp: { url: "", scale: 1, x: 0, y: 0 },
  prayerLocation: { city: "", country: "", method: 2, timezone: DEFAULT_TIMEZONE, latitude: null, longitude: null },
};

/**
 * The canonical site_config read. Exported alongside `parseSiteConfigRows` so
 * hours.ts can fold this row fetch into its own batched read without keeping a
 * second copy of the SQL that could drift from this one.
 */
export const SITE_CONFIG_SQL = "SELECT key, value FROM site_config";

/** Keys already reported as undecodable. A corrupt row is read on every page
 *  view, so the log has to be once-per-process, not once-per-render. */
const reportedDecodeFailures = new Set<string>();

/**
 * Decodes one site_config JSON blob, falling back to the default shape when the
 * key is absent or the blob does not parse.
 *
 * `merge` reproduces the two decode styles this table has always had: the
 * object-valued keys spread over their defaults so a partial row keeps the
 * missing fields, the others replace wholesale.
 *
 * The fallback is deliberately silent to the caller but NOT silent in the logs.
 * Corruption that only ever manifests as an empty page is the kind that sits
 * there for months; naming the key once per process is what makes it findable.
 */
function decodeConfigValue<T>(raw: string | undefined, key: string, fallback: T, merge: boolean): T {
  if (raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return merge ? ({ ...fallback, ...parsed } as T) : parsed;
  } catch (e) {
    if (!reportedDecodeFailures.has(key)) {
      reportedDecodeFailures.add(key);
      console.error(`site_config: ignoring unparseable "${key}", using defaults`, e);
    }
    return fallback;
  }
}

/**
 * Pure row-array -> SiteConfig decode, split out of `getSiteConfig` so a caller
 * that already has the rows in hand (hours.ts fetches them as part of one
 * batch) can decode them without a second round trip.
 *
 * site_config is a key/value table of JSON blobs, so every value is decoded
 * defensively: a missing key and a malformed one both fall back to the same
 * empty default rather than throwing. A half-broken config row should degrade
 * one field, never take down the page that reads it.
 */
export function parseSiteConfigRows(rows: { key: string; value: string }[]): SiteConfig {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    description: decodeConfigValue(map.get("description"), "description", EMPTY_CONFIG.description, false),
    socials: decodeConfigValue(map.get("socials"), "socials", EMPTY_CONFIG.socials, false),
    pfp: decodeConfigValue(map.get("pfp"), "pfp", EMPTY_CONFIG.pfp, true),
    prayerLocation: decodeConfigValue(map.get("prayerLocation"), "prayerLocation", EMPTY_CONFIG.prayerLocation, true),
  };
}

export const getSiteConfig = cache(async (): Promise<SiteConfig> => {
  await initDb();

  const result = await db.execute(SITE_CONFIG_SQL);
  return parseSiteConfigRows(result.rows as unknown as { key: string; value: string }[]);
});

/**
 * Memoized `Intl` acceptance test for an IANA zone name.
 *
 * The cache is what makes this usable on the hot path: the answer for a given
 * string never changes, and `resolveTimezone` is called on every render of
 * every page. Keys only ever come from the handful of distinct values the
 * config table can hold, so it cannot grow unbounded.
 */
const timezoneValidity = new Map<string, boolean>();

function isValidTimezone(tz: string): boolean {
  const cached = timezoneValidity.get(tz);
  if (cached !== undefined) return cached;
  let valid: boolean;
  try {
    // The constructor is the whole test — it throws RangeError on a zone Intl
    // does not know. `resolvedOptions()` is read so no minifier can decide the
    // call has no effect and drop it.
    valid = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone.length > 0;
  } catch {
    valid = false;
    console.error(`site_config: unusable timezone ${JSON.stringify(tz)}, falling back to ${DEFAULT_TIMEZONE}`);
  }
  timezoneValidity.set(tz, valid);
  return valid;
}

/**
 * The stored zone is only a hint until Intl agrees with it. `site_config` is
 * writable by the sibling site, and an unusable zone name reaches this app as a
 * `RangeError` thrown deep inside a memoized formatter — which is to say every
 * page 500s at once, for a value nothing in this codebase wrote. Falling back
 * costs a wrong-but-working clock; not falling back costs the whole site.
 */
export function resolveTimezone(config: SiteConfig): string {
  const tz = config.prayerLocation.timezone;
  if (typeof tz !== "string" || tz.length === 0 || !isValidTimezone(tz)) {
    return DEFAULT_TIMEZONE;
  }
  return tz;
}

export function validatePrayerLocation(input: unknown): PrayerLocation | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.city !== "string") return null;
  if (typeof o.country !== "string") return null;
  if (typeof o.method !== "number") return null;
  // Same gate as resolveTimezone, applied at the write boundary so a zone Intl
  // cannot use never enters the table in the first place. Empty stays legal
  // because resolveTimezone reads it as "unset, use the default" — rejecting it
  // here would fail a config save this has always accepted.
  if (typeof o.timezone !== "string") return null;
  if (o.timezone.length > 0 && !isValidTimezone(o.timezone)) return null;
  if (o.latitude !== null && (typeof o.latitude !== "number" || !Number.isFinite(o.latitude) || o.latitude < -90 || o.latitude > 90)) return null;
  if (o.longitude !== null && (typeof o.longitude !== "number" || !Number.isFinite(o.longitude) || o.longitude < -180 || o.longitude > 180)) return null;
  return {
    city: o.city,
    country: o.country,
    method: o.method,
    timezone: o.timezone,
    latitude: o.latitude as number | null,
    longitude: o.longitude as number | null,
  };
}

const ALLOWED_CONFIG_KEYS = ["description", "socials", "pfp", "prayerLocation"];

export async function updateSiteConfig(key: string, value: string) {
  if (!ALLOWED_CONFIG_KEYS.includes(key)) {
    throw new Error(`Invalid config key: ${key}`);
  }
  await initDb();
  await db.execute({
    sql: "INSERT OR REPLACE INTO site_config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [key, value],
  });
}
