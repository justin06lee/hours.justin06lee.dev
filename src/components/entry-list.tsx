import type { HoursEntry, Subject } from "@/lib/hours";
import { formatElapsed } from "@/lib/hours-math";
import { epochToHHMMInTz, epochToDateInTz } from "@/lib/calendar-dates";
import { cn } from "@/lib/utils";

/**
 * Chronological log of individual entries, grouped by day.
 *
 * Rows carry their lane when it isn't the primary one, because "3pm to 5pm" on
 * two lanes is not a contradiction here and the reader needs to see why the
 * day's total is smaller than the rows imply.
 */
export function EntryList({
  entries,
  subjects,
  timezone,
  className,
}: {
  entries: HoursEntry[];
  subjects: Subject[];
  timezone: string;
  className?: string;
}) {
  if (entries.length === 0) {
    return <p className={cn("text-sm text-white/40", className)}>nothing logged yet.</p>;
  }

  const colorOf = new Map(subjects.map((s) => [s.id, s.color]));
  const nameOf = new Map(subjects.map((s) => [s.id, s.name]));

  // Group by the day the entry started, in site time.
  const groups: { date: string; rows: HoursEntry[] }[] = [];
  for (const e of entries) {
    const date = epochToDateInTz(e.startAt, timezone);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.rows.push(e);
    else groups.push({ date, rows: [e] });
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {groups.map((g) => (
        <div key={g.date}>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/30">
            {g.date}
          </p>
          <ul className="flex flex-col">
            {g.rows.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline gap-3 border-t border-white/10 py-2 text-sm"
              >
                <span
                  aria-hidden
                  className="mt-1 size-1.5 shrink-0"
                  style={{ background: colorOf.get(e.categoryId) ?? "#7a8085" }}
                />
                <span className="min-w-0 flex-1 truncate text-white/80">
                  {e.title || nameOf.get(e.categoryId) || "untitled"}
                  {e.title && nameOf.get(e.categoryId) && (
                    <span className="text-white/30">
                      {" "}
                      · {nameOf.get(e.categoryId)!.toLowerCase()}
                    </span>
                  )}
                </span>
                {e.track > 0 && (
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-white/30">
                    lane {e.track}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-white/40">
                  {epochToHHMMInTz(e.startAt, timezone)}
                </span>
                <span
                  className={cn(
                    "w-16 shrink-0 text-right tabular-nums",
                    e.running ? "text-white" : "text-white/60",
                  )}
                >
                  {e.running ? "running" : formatElapsed(e.endAt - e.startAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
