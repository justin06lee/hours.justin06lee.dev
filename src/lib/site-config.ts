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
    description: (() => { try { return map.has("description") ? JSON.parse(map.get("description")!) : EMPTY_CONFIG.description; } catch { return EMPTY_CONFIG.description; } })(),
    socials: (() => { try { return map.has("socials") ? JSON.parse(map.get("socials")!) : EMPTY_CONFIG.socials; } catch { return EMPTY_CONFIG.socials; } })(),
    pfp: (() => { try { return map.has("pfp") ? { ...EMPTY_CONFIG.pfp, ...JSON.parse(map.get("pfp")!) } : EMPTY_CONFIG.pfp; } catch { return EMPTY_CONFIG.pfp; } })(),
    prayerLocation: (() => { try { return map.has("prayerLocation") ? { ...EMPTY_CONFIG.prayerLocation, ...JSON.parse(map.get("prayerLocation")!) } : EMPTY_CONFIG.prayerLocation; } catch { return EMPTY_CONFIG.prayerLocation; } })(),
  };
}

export const getSiteConfig = cache(async (): Promise<SiteConfig> => {
  await initDb();

  const result = await db.execute(SITE_CONFIG_SQL);
  return parseSiteConfigRows(result.rows as unknown as { key: string; value: string }[]);
});

export function resolveTimezone(config: SiteConfig): string {
  return config.prayerLocation.timezone || DEFAULT_TIMEZONE;
}

export function validatePrayerLocation(input: unknown): PrayerLocation | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.city !== "string") return null;
  if (typeof o.country !== "string") return null;
  if (typeof o.method !== "number") return null;
  if (typeof o.timezone !== "string") return null;
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
