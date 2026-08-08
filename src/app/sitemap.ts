import type { MetadataRoute } from "next";
import { getHoursOverview } from "@/lib/hours";
import { SITE_URL } from "@/lib/site-url";

/**
 * Regenerated hourly rather than on every request.
 *
 * A sitemap is read by crawlers, not people, and the aggregate behind it reads
 * every row — serving it `force-dynamic` would mean a full scan per crawler
 * hit for a document whose contents change when a subject is added, which is
 * rarely. An hour is far fresher than any crawler will notice.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const home: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "daily",
      // The homepage genuinely does change daily — it is the one page whose
      // headline number moves whenever anything is logged.
      priority: 1,
    },
  ];

  try {
    const overview = await getHoursOverview();
    const subjects = overview.subjects
      // The uncategorized bucket has no id and deliberately no URL, and an
      // archived subject is one that has been retired on purpose — neither
      // belongs in a document whose job is to say "these are worth indexing".
      .filter((s) => s.id !== null && s.slug !== "" && !s.archived && s.ms > 0)
      .map((s) => ({
        url: `${SITE_URL}/s/${s.slug}`,
        // `lastAt` is the end of that subject's most recent entry, which is
        // exactly when its page last changed.
        lastModified: s.lastAt ? new Date(s.lastAt) : undefined,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      }));
    return [...home, ...subjects];
  } catch (error) {
    // The build prerenders this route, so an unreachable database here would
    // otherwise fail the whole deploy over a file crawlers read once an hour.
    // Degrade to the homepage — an incomplete sitemap costs some discovery
    // latency, a failed build costs the release.
    console.error("sitemap: could not load subjects, serving homepage only", error);
    return home;
  }
}
