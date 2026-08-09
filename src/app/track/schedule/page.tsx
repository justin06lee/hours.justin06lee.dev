import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { listCategories } from "@/lib/calendar-categories";
import { getSchedule } from "@/lib/schedule/day";
import type { ResolvedDay } from "@/lib/schedule/resolve";
import { Timeline } from "@/components/chrome/timeline";
import { Callout } from "@/components/chrome/callout";
import { clampActualToDay, epochToHHMMInTz } from "@/lib/calendar-dates";
import { formatElapsed, MS_PER_HOUR } from "@/lib/hours-math";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = { title: "schedule" };

/** Kinds that aren't a category get their own muted treatment. */
const PRAYER_COLOR = "#8a7a5b";
const SLEEP_COLOR = "#5b5b8a";

/**
 * What the schedule engine says today and tomorrow look like.
 *
 * **Read-only, and nothing is written from here.** The engine resolves a day
 * from prayer times and a ruleset; this page is how that gets checked against a
 * real day before it is allowed to log anything. The compression figures are
 * the point of it: the targets add up to 25 hours, so every day gives something
 * back, and this says exactly how much rather than leaving it to be discovered
 * from a total that looks wrong months later.
 */
export default async function SchedulePage() {
  if (!(await isAdminServer())) redirect("/login");

  const [schedule, categories] = await Promise.all([getSchedule(2), listCategories()]);

  if (!schedule.ok) {
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">schedule</h1>
        <Callout variant="warn" title="no schedule yet">
          {schedule.reason}
        </Callout>
      </>
    );
  }

  const colorOf = new Map(categories.map((c) => [c.name, c.color]));

  return (
    <>
      <h1 className="mb-3 text-2xl font-semibold tracking-tight">schedule</h1>
      <p className="mb-10 max-w-xl text-[15px] leading-7 text-white/60">
        not a timetable — a set of durations anchored to prayer times, resolved
        fresh for each day. nothing here is written down yet; this is the engine
        showing its work.
      </p>

      {schedule.days.map((day, i) => (
        <Day
          key={day.date}
          day={day}
          colorOf={colorOf}
          heading={i === 0 ? "today" : "tomorrow"}
          showNow={i === 0}
        />
      ))}
    </>
  );
}

function Day({
  day,
  colorOf,
  heading,
  showNow,
}: {
  day: ResolvedDay;
  colorOf: Map<string, string>;
  heading: string;
  showNow: boolean;
}) {
  const tz = day.timezone;
  const at = (ms: number) => epochToHHMMInTz(ms, tz);

  const colorFor = (kind: string, category: string | null) => {
    if (kind === "prayer" || kind === "tahajjud") return PRAYER_COLOR;
    if (kind === "sleep") return SLEEP_COLOR;
    return (category && colorOf.get(category)) || "#7a8085";
  };

  // The timeline axis is a fixed 0–1440 minutes, so blocks are clamped to this
  // calendar day. Tonight's sleep runs past midnight and is cut at it — the
  // remainder belongs to tomorrow's column, which is exactly where it appears.
  const events = day.blocks
    .map((b) => {
      const window = clampActualToDay(day.date, b.start, b.end, tz, b.end);
      if (!window) return null;
      return {
        id: b.key,
        startMin: window.startMin,
        endMin: window.endMin,
        label: b.title,
        color: colorFor(b.kind, b.category),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const markers = (["fajr", "dhuhr", "asr", "maghrib", "isha"] as const).map((p) => {
    const window = clampActualToDay(day.date, day.prayers[p], day.prayers[p] + 1, tz);
    return { minutes: window?.startMin ?? 0, label: p, color: PRAYER_COLOR };
  });

  const waking = day.bedtime - day.wake;

  return (
    <section className="mb-14">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
          {heading} · {day.date}
        </h2>
        <span className="text-xs text-white/30">
          up {at(day.wake)} · bed {at(day.bedtime)} · {formatElapsed(waking)} awake
        </span>
      </div>

      <SleepNote day={day} />

      <div className="mb-6">
        <Timeline events={events} markers={markers} showNow={showNow} />
      </div>

      <ol className="mb-6 flex flex-col">
        {day.blocks.map((b) => (
          <li
            key={b.key}
            className="flex items-baseline gap-3 border-t border-white/10 py-1.5 text-sm"
          >
            <span
              aria-hidden
              className="mt-1 size-1.5 shrink-0"
              style={{ background: colorFor(b.kind, b.category) }}
            />
            <span className="w-24 shrink-0 tabular-nums text-white/40">
              {at(b.start)}–{at(b.end)}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                b.kind === "prayer" ? "text-white/45" : "text-white/80",
              )}
            >
              {b.title}
            </span>
            <span className="shrink-0 tabular-nums text-white/40">
              {formatElapsed(b.end - b.start)}
            </span>
          </li>
        ))}
      </ol>

      <div>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
          target vs actual
        </h3>
        <ul className="flex flex-col gap-2">
          {day.compression.map((c) => {
            const ratio = c.targetMs === 0 ? 1 : c.actualMs / c.targetMs;
            return (
              <li key={c.id} className="flex items-center gap-3 text-sm">
                <span className="w-44 shrink-0 truncate text-white/60">{c.title}</span>
                <span className="h-1.5 min-w-0 flex-1 bg-white/10">
                  <span
                    className="block h-full bg-white/50"
                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                  />
                </span>
                <span className="w-28 shrink-0 text-right tabular-nums text-white/40">
                  {(c.actualMs / MS_PER_HOUR).toFixed(1)}h of{" "}
                  {(c.targetMs / MS_PER_HOUR).toFixed(0)}h
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Why the night came out the way it did — the part that is hardest to infer.
 *
 * Describes **tonight**, which is not the sleep that produced this day's wake
 * time. The heading above already shows that one; saying "wake 07:12" here
 * without qualification put two different wake times a minute apart on the same
 * screen, reading as a bug rather than as two different nights.
 */
function SleepNote({ day }: { day: ResolvedDay }) {
  const at = (ms: number) => epochToHHMMInTz(ms, day.timezone);
  const night = day.tonight;

  const shape =
    night.shape === "split"
      ? `too short for 9h before sunrise, so it splits: up ${at(night.tahajjud!.start)} for tahajjud and fajr, back down ${at(night.tahajjud!.end)}`
      : night.shape === "unsplittable"
        ? "fajr lands too close to bedtime to split the night, so it runs straight through"
        : "long enough for the full 9h, so the ceiling sets the alarm";

  return (
    <p className="mb-5 text-[13px] leading-6 text-white/40">
      <span className="text-white/55">tonight:</span> bed {at(night.bedtime)}
      {night.flooredBedtime ? " (held by the 20:30 floor, not isha)" : " (isha + 15m)"} ·{" "}
      {shape} · up {at(night.wake)} the next morning
    </p>
  );
}
