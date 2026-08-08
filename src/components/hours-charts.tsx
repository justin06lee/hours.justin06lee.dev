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
  max,
}: {
  /** Hours per day, keyed "YYYY-MM-DD". One year's worth. */
  values: Record<string, number>;
  year: number;
  today: string;
  /**
   * Intensity ceiling. Passed explicitly — and computed across *every* year,
   * not just the one being rendered — so switching years doesn't renormalize
   * the shading. Left to its default, Heatmap scales against the busiest day it
   * was handed, which would make a quiet year look exactly as dark as a
   * relentless one and stop the grid meaning anything across years.
   */
  max?: number;
}) {
  return (
    <Heatmap
      values={values}
      year={year}
      today={today}
      max={max}
      title={(date, value) =>
        value > 0 ? `${date} — ${value.toFixed(1)}h` : `${date} — nothing`
      }
    />
  );
}
