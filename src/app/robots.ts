import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

/**
 * A public, indexed site had no robots.txt at all.
 *
 * The admin routes already declare `noindex` in their own metadata, which is
 * the control that actually keeps them out of an index — a crawler has to
 * fetch a page to read a meta tag, and this file only stops well-behaved ones
 * asking. Both are worth having: `Disallow` saves the crawl budget and stops
 * `/login` showing up in a site: query, and the `noindex` covers the crawlers
 * that ignore this file.
 *
 * The sitemap line is the other half of why this exists — it is the standard
 * way to advertise one, and without it a crawler only finds subject pages by
 * following links from the homepage.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // `/track` covers the subtree; the trailing-slash form is listed too
      // because the prefix match is literal and `/track/journal` should be
      // excluded whether or not a crawler normalises the path.
      disallow: ["/track", "/track/", "/login"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
