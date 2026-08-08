import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Year switcher above a heatmap.
 *
 * Real links rather than the `segmented` component: the year is in the URL, so
 * a year view should be linkable, prefetchable, back-buttonable and reachable
 * without javascript. `segmented` is a controlled client control with an
 * `onChange`, which would make this a client boundary on both public pages to
 * express something the router already models.
 *
 * Renders nothing when there is one year or none — a switcher with a single
 * option is furniture, not a control.
 */
export function YearNav({
  years,
  current,
  /** Base path; the year rides as `?year=`. The newest year links bare. */
  basePath,
  newest,
}: {
  years: number[];
  current: number;
  basePath: string;
  newest: number;
}) {
  if (years.length <= 1) return null;

  return (
    <nav aria-label="year" className="flex flex-wrap items-baseline gap-3">
      {years.map((year) => {
        const active = year === current;
        return (
          <Link
            key={year}
            // The newest year is what the bare path already shows, so it links
            // bare. Two URLs rendering the same page is the sort of thing the
            // per-page canonical exists to clean up after; better not to create
            // the duplicate in the first place.
            href={year === newest ? basePath : `${basePath}?year=${year}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "font-mono text-[11px] uppercase tracking-[0.18em] tabular-nums transition-colors",
              active ? "text-white" : "text-white/30 hover:text-white/70",
            )}
          >
            {year}
          </Link>
        );
      })}
    </nav>
  );
}
