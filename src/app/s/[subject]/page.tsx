import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { StatTile } from "@/components/chrome/stat-tile";
import { Streak } from "@/components/chrome/streak";
import { HoursBarList, HoursHeatmap } from "@/components/hours-charts";
import { getHoursOverview } from "@/lib/hours";
import {
  computeStreak,
  formatHours,
  MS_PER_HOUR,
  slugify,
  splitByDay,
  unionMs,
} from "@/lib/hours-math";
import { todayInTz } from "@/lib/calendar-dates";
import { EntryList } from "@/components/entry-list";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subject: string }>;
}): Promise<Metadata> {
  const { subject } = await params;
  const overview = await getHoursOverview();
  const match = overview.subjects.find((s) => s.id && slugify(s.name) === subject);
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
}: {
  params: Promise<{ subject: string }>;
}) {
  const { subject: slug } = await params;
  const overview = await getHoursOverview();
  const subject = overview.subjects.find((s) => s.id && slugify(s.name) === slug);
  if (!subject) notFound();

  const entries = overview.entries.filter((e) => e.categoryId === subject.id);
  const today = todayInTz(overview.timezone);
  const year = Number(today.slice(0, 4));

  // Per-day density for this subject only.
  const perDay = new Map<string, { start: number; end: number }[]>();
  for (const e of entries) {
    for (const seg of splitByDay({ start: e.startAt, end: e.endAt }, overview.timezone)) {
      if (!perDay.has(seg.date)) perDay.set(seg.date, []);
      perDay.get(seg.date)!.push({ start: seg.start, end: seg.end });
    }
  }
  const daily: Record<string, number> = {};
  for (const [date, intervals] of perDay) daily[date] = unionMs(intervals) / MS_PER_HOUR;

  const activeDates = new Set(Object.keys(daily).filter((d) => daily[d] > 0));
  const streak = computeStreak(activeDates, today);

  // Break the subject down by what was actually written in the title — this is
  // where "machine learning" and "cybersecurity" live, since categories are
  // broader buckets than the thing you were really doing.
  const byTitle = new Map<string, { ms: number; count: number }>();
  for (const e of entries) {
    const key = (e.title ?? "").trim().toLowerCase() || "(untitled)";
    const cur = byTitle.get(key) ?? { ms: 0, count: 0 };
    cur.ms += e.endAt - e.startAt;
    cur.count++;
    byTitle.set(key, cur);
  }
  const titleBars = [...byTitle.entries()]
    .map(([label, v]) => ({ id: label, label, value: v.ms / MS_PER_HOUR, color: subject.color }))
    .sort((a, b) => b.value - a.value);

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
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            {year}
          </h2>
          <div className="overflow-x-auto">
            <HoursHeatmap values={daily} year={year} today={today} />
          </div>
        </section>

        <section className="py-10">
          <h2 className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            sessions
          </h2>
          <EntryList
            entries={entries.slice(0, 50)}
            subjects={overview.subjects}
            timezone={overview.timezone}
          />
        </section>
      </main>
    </div>
  );
}
