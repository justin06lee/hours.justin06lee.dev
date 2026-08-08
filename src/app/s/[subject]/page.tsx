import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { StatTile } from "@/components/chrome/stat-tile";
import { Streak } from "@/components/chrome/streak";
import { HoursBarList, HoursHeatmap } from "@/components/hours-charts";
import { getEntryPage, getHoursOverview, getSubjectBreakdown } from "@/lib/hours";
import {
  computeStreak,
  formatHours,
  MS_PER_HOUR,
  resolveYear,
  yearValues,
} from "@/lib/hours-math";
import { todayInTz } from "@/lib/calendar-dates";
import { EntryList } from "@/components/entry-list";
import { SiteHeader } from "@/components/site-header";
import { YearNav } from "@/components/year-nav";

export const dynamic = "force-dynamic";

/** How many of the subject's sessions the page lists. */
const SESSION_LIMIT = 50;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subject: string }>;
}): Promise<Metadata> {
  const { subject } = await params;
  const overview = await getHoursOverview();
  // Matching on the de-duplicated `slug` rather than re-slugifying the name is
  // what makes this a bijection: two categories whose names slugify alike used
  // to share one URL, and first-match-wins served the busier one's numbers
  // under both names while the other page was unreachable.
  const match = overview.subjects.find((s) => s.id && s.slug === subject);
  if (!match) return { title: "not found" };
  return {
    title: match.name.toLowerCase(),
    description: `${formatHours(match.ms)} logged on ${match.name.toLowerCase()}`,
    // Per-page, because root-layout metadata is inherited shallowly: a
    // canonical declared there would mark every subject page a duplicate of
    // the homepage.
    alternates: { canonical: `/s/${subject}` },
  };
}

export default async function SubjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ subject: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const [{ subject: slug }, query, overview] = await Promise.all([
    params,
    searchParams,
    getHoursOverview(),
  ]);
  const subject = overview.subjects.find((s) => s.id && s.slug === slug);
  if (!subject) notFound();

  // The subject's own history, and one bounded page of its entries. Both are
  // scoped to this category in SQL rather than filtered out of a full-table
  // read in JS, so a busy subject costs its own rows and a quiet one costs
  // almost nothing.
  const [breakdown, page] = await Promise.all([
    getSubjectBreakdown(subject.id!, overview.timezone),
    getEntryPage({ categoryId: subject.id, limit: SESSION_LIMIT }),
  ]);

  const today = todayInTz(overview.timezone);

  const daily = Object.fromEntries(
    Object.entries(breakdown.daily).map(([d, ms]) => [d, ms / MS_PER_HOUR]),
  );
  // Scoped to this subject's own years, not the site's: a subject that ran for
  // one year shouldn't offer three empty ones.
  const year = resolveYear(query.year, breakdown.years, Number(today.slice(0, 4)));
  const heatmapMax = Object.values(daily).reduce((m, h) => Math.max(m, h), 1);

  const activeDates = new Set(Object.keys(daily).filter((d) => daily[d] > 0));
  const streak = computeStreak(activeDates, today);

  // Break the subject down by what was actually written in the title — this is
  // where "machine learning" and "cybersecurity" live, since categories are
  // broader buckets than the thing you were really doing. The union happens in
  // getSubjectBreakdown, so these bars obey the same counting rule as the
  // headline above them.
  const titleBars = breakdown.titles.map((t) => ({
    id: t.label,
    label: t.label,
    value: t.ms / MS_PER_HOUR,
    color: subject.color,
  }));

  const daysActive = activeDates.size;

  return (
    <div className="min-h-dvh">
      <SiteHeader runningCount={overview.runningCount} />

      <main className="mx-auto w-full max-w-5xl px-5 pb-24">
        <section className="border-b border-white/10 py-10">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white"
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            all subjects
          </Link>

          <div className="mt-5 flex items-center gap-3">
            <span
              aria-hidden
              className="size-3 shrink-0"
              style={{ background: subject.color }}
            />
            <h1 className="text-3xl font-semibold tracking-tight">
              {subject.name.toLowerCase()}
            </h1>
          </div>

          <div className="mt-4 flex items-baseline gap-3">
            <span className="text-5xl font-semibold tabular-nums tracking-tight">
              {(subject.ms / MS_PER_HOUR).toFixed(1)}
            </span>
            <span className="text-xl text-white/40">hours</span>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-px border-b border-white/10 bg-white/10 lg:grid-cols-4">
          <StatTile className="border-0" label="sessions" value={subject.entries} />
          <StatTile
            className="border-0"
            label="days active"
            value={daysActive}
            footnote={
              daysActive > 0 ? `avg ${formatHours(subject.ms / daysActive)} per day` : undefined
            }
          />
          <StatTile
            className="border-0"
            label="share"
            value={
              overview.totalMs > 0
                ? ((subject.ms / overview.totalMs) * 100).toFixed(0)
                : "0"
            }
            unit="%"
            footnote="of all tracked time"
          />
          <div className="bg-[#0a0a0a] p-4">
            <Streak current={streak.current} best={streak.best} days={streak.days} />
          </div>
        </section>

        {titleBars.length > 0 && (
          <section className="border-b border-white/10 py-10">
            <div className="mb-5 flex items-baseline justify-between gap-4">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
                what exactly
              </h2>
              <span className="text-right text-xs text-white/30">by session title</span>
            </div>
            <HoursBarList items={titleBars} limit={15} />
          </section>
        )}

        <section className="border-b border-white/10 py-10">
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
              {year}
            </h2>
            <YearNav
              years={breakdown.years}
              current={year}
              basePath={`/s/${slug}`}
              newest={breakdown.years[0] ?? year}
            />
          </div>
          <div className="overflow-x-auto">
            <HoursHeatmap
              values={yearValues(daily, year)}
              max={heatmapMax}
              year={year}
              today={today}
            />
          </div>
        </section>

        <section className="py-10">
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            sessions
          </h2>
          <EntryList
            entries={page.entries}
            subjects={overview.subjects}
            timezone={overview.timezone}
          />
        </section>
      </main>
    </div>
  );
}
