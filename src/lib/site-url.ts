/**
 * The site's own origin, for anything that has to emit an absolute URL:
 * `metadataBase`, `robots.txt`'s sitemap line, and the sitemap's own entries.
 *
 * Lives here rather than in `layout.tsx` because those three have to agree —
 * a sitemap advertising one origin while the canonicals declare another is the
 * kind of mismatch that costs indexing and shows up nowhere in a build log.
 *
 * No trailing slash, ever: callers concatenate paths onto it.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://hours.justin06lee.dev"
).replace(/\/+$/, "");
