import { StatTile } from "@/components/chrome/stat-tile";
import { Streak } from "@/components/chrome/streak";
import { HoursBarList, HoursHeatmap } from "@/components/hours-charts";
import { FadeIn } from "@/components/chrome/fade-in";
import { getEntryPage, getHoursOverview } from "@/lib/hours";
import { computeStreak, formatHours, MS_PER_HOUR } from "@/lib/hours-math";
import { todayInTz } from "@/lib/calendar-dates";
import { EntryList } from "@/components/entry-list";
import { SiteHeader } from "@/components/site-header";

// Every view is live: the whole point is the number moving while a timer runs.
export const dynamic = "force-dynamic";

// Declared per-page rather than inherited from the root layout. Layout
// metadata is inherited shallowly, so a canonical set there would tell search
// engines that every subject page is a duplicate of this one.
export const metadata = { alternates: { canonical: "/" } };

/** How many entries the homepage's "recent" section shows. */
const RECENT_LIMIT = 20;

export default async function HomePage() {
  // Concurrent rather than sequential: the aggregate and the recent page are
  // independent queries against the same snapshot-free read, and neither needs
  // the other's result. Both take their "now" from the request-scoped
  // `requestNow()`, so a running entry is clamped to the same instant in the
  // headline total and in the list beneath it.
  const [overview, recent] = await Promise.all([
    getHoursOverview(),
    getEntryPage({ limit: RECENT_LIMIT }),
  ]);
  const today = todayInTz(overview.timezone);
  const year = Number(today.slice(0, 4));

  const activeDates = new Set(Object.keys(overview.daily).filter((d) => overview.daily[d] > 0));
  const streak = computeStreak(activeDates, today);

  const tracked = overview.subjects.filter((s) => s.ms > 0);
  const bars = tracked.map((s) => ({
    id: s.id ?? "uncategorized",
    label: s.name.toLowerCase(),
    value: s.ms / MS_PER_HOUR,
    color: s.color,
    // s.slug, not slugify(s.name): the overview de-duplicates slugs across the
    // whole list, so this is the one string /s/[subject] will match on.
    href: s.id ? `/s/${s.slug}` : undefined,
  }));

  const daysTracked = activeDates.size;
  const avgPerActiveDay = daysTracked > 0 ? overview.totalMs / daysTracked : 0;

  return (
    <div className="min-h-dvh">
      <SiteHeader runningCount={overview.runningCount} />

      <main className="mx-auto w-full max-w-5xl px-5 pb-24">
        <FadeIn>
          <section className="border-b border-white/10 py-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
              hours poured in
            </p>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-6xl font-semibold tabular-nums tracking-tight sm:text-7xl">
                {(overview.totalMs / MS_PER_HOUR).toFixed(1)}
              </span>
              <span className="text-2xl text-white/40">hours</span>
            </div>
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-white/60">
              every hour logged across everything — studying, building, training,
              resting. counted once, even when two of them happened at the same
              time.
            </p>
          </section>
        </FadeIn>

        <section className="grid grid-cols-2 gap-px border-b border-white/10 bg-white/10 lg:grid-cols-4">
          <StatTile
            className="border-0"
            label="subjects"
            value={tracked.length}
            footnote="categories with time logged"
          />
          <StatTile
            className="border-0"
            label="days tracked"
            value={daysTracked}
            footnote={`avg ${formatHours(avgPerActiveDay)} per active day`}
          />
          <StatTile
            className="border-0"
            label="in parallel"
            value={(overview.parallelMs / MS_PER_HOUR).toFixed(1)}
            unit="h"
            footnote="two things at once, counted once above"
          />
          <div className="bg-[#0a0a0a] p-4">
            <Streak current={streak.current} best={streak.best} days={streak.days} />
          </div>
        </section>

        <section className="border-b border-white/10 py-10">
          <div className="mb-5 flex items-baseline justify-between gap-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
              by subject
            </h2>
            <span className="text-right text-xs text-white/30">
              overlapping time counts in full here
            </span>
          </div>
          {bars.length > 0 ? (
            <HoursBarList items={bars} />
          ) : (
            <p className="text-sm text-white/40">nothing logged yet.</p>
          )}
        </section>

        <section className="border-b border-white/10 py-10">
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            {year}
          </h2>
          <div className="overflow-x-auto">
            <HoursHeatmap
              values={Object.fromEntries(
                Object.entries(overview.daily).map(([d, ms]) => [d, ms / MS_PER_HOUR]),
              )}
              year={year}
              today={today}
            />
          </div>
        </section>

        <section className="py-10">
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            recent
          </h2>
          <EntryList
            entries={recent.entries}
            subjects={overview.subjects}
            timezone={overview.timezone}
          />
        </section>
      </main>
    </div>
  );
}
