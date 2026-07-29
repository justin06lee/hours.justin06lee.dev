"use client";

import Link from "next/link";
import { BarList, type BarListItem } from "@/components/chrome/bar-list";
import { Heatmap } from "@/components/chrome/heatmap";

/**
 * Client wrappers around the chart components.
 *
 * BarList and Heatmap take formatter/link props, and functions cannot cross
 * the server/client boundary. Rather than turning the pages into client
 * components — they read the database and must stay on the server — the
 * formatters live here, and the pages pass only serializable data.
 */

export function HoursBarList({
  items,
  limit,
}: {
  items: BarListItem[];
  limit?: number;
}) {
  return (
    <BarList
      items={items}
      limit={limit}
      formatValue={(v) => `${v.toFixed(1)}h`}
      linkComponent={Link}
    />
  );
}

export function HoursHeatmap({
  values,
  year,
  today,
}: {
  /** Hours per day, keyed "YYYY-MM-DD". */
  values: Record<string, number>;
  year: number;
  today: string;
}) {
  return (
    <Heatmap
      values={values}
      year={year}
      today={today}
      title={(date, value) =>
        value > 0 ? `${date} — ${value.toFixed(1)}h` : `${date} — nothing`
      }
    />
  );
}
