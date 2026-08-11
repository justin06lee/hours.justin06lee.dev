/**
 * Resolving one day of the ruleset into actual spans.
 *
 * The shape of a day, in the order it is decided:
 *
 *   1. **Sleep first**, both ends. Waking is the previous night's answer;
 *      bedtime is tonight's. Everything else lives between them.
 *   2. **Prayers are carved out**, not scheduled around. A block running
 *      through Dhuhr is split by it rather than overlapping it, which is what
 *      makes "30 minutes after Dhuhr" fall out of the model instead of being
 *      a special case.
 *   3. **One sequence fills waking to bedtime.** Fixed blocks — the workout,
 *      Islamic study, journalling, no-screens — are paid in full; the two long
 *      work blocks share whatever the prayers and the fixed blocks leave, in
 *      proportion to their targets.
 *
 * Anchoring the end at bedtime rather than at Isha is what keeps the work
 * blocks steady across a year in which Isha itself swings four hours.
 *
 * Pure: given prayer times and a ruleset it returns the same day every time,
 * with no clock, database or environment involved. That is what makes it
 * testable against real dates, and what lets a log be backfilled for any day in
 * the past and previewed for any day in the future.
 */

import type { DayPrayerTimes, PrayerName } from "@/lib/prayer-times";
import { PRAYER_ORDER } from "@/lib/prayer-times";
import { resolveSleep, type SleepPlan } from "@/lib/schedule/sleep";
import type { Ruleset, SequenceBlock } from "@/lib/schedule/rules";

export type BlockKind = "activity" | "prayer" | "sleep" | "tahajjud";

export type ResolvedBlock = {
  /**
   * Stable for a given date and ruleset, and unique within the day.
   *
   * This is what makes materialisation idempotent: writing a day twice has to
   * recognise the rows it already wrote rather than duplicating them, and a key
   * derived from the date and the block's identity survives the schedule being
   * re-resolved on every page load.
   */
  key: string;
  kind: BlockKind;
  /** Category name; the caller maps it to an id. Null for prayers. */
  category: string | null;
  title: string;
  start: number;
  end: number;
};

/** What a block wanted against what the day could give it. */
export type Compression = {
  id: string;
  title: string;
  targetMs: number;
  actualMs: number;
};

export type ResolvedDay = {
  date: string;
  timezone: string;
  prayers: DayPrayerTimes;
  /** The night that ends this morning. */
  lastNight: SleepPlan;
  /** The night that begins this evening. */
  tonight: SleepPlan;
  wake: number;
  bedtime: number;
  /** Everything, in chronological order. */
  blocks: ResolvedBlock[];
  /** Only the blocks with a target to miss, i.e. the sequence. */
  compression: Compression[];
};

type Span = { start: number; end: number };

/**
 * `span` minus everything in `cuts`. Cuts must be sorted by start and may
 * overlap each other; the result is disjoint, ordered, and never contains
 * zero-length pieces.
 */
export function subtractSpans(span: Span, cuts: readonly Span[]): Span[] {
  const out: Span[] = [];
  let cursor = span.start;
  for (const cut of cuts) {
    if (cut.end <= cursor) continue;
    if (cut.start >= span.end) break;
    if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, span.end) });
    cursor = Math.max(cursor, cut.end);
    if (cursor >= span.end) break;
  }
  if (cursor < span.end) out.push({ start: cursor, end: span.end });
  return out.filter((s) => s.end > s.start);
}

/** Total length of a set of spans. */
export function spanMs(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/**
 * Walks `duration` milliseconds forward through `available`, starting at
 * `index`/`offset`, and returns the pieces covered.
 *
 * This is what lets one block straddle a prayer: it consumes time out of the
 * available spans and hands back however many pieces that took, so a project
 * block that meets Dhuhr comes out as two spans with the prayer between them
 * rather than one span overlapping it.
 */
function take(
  available: readonly Span[],
  index: number,
  offset: number,
  duration: number,
): { spans: Span[]; index: number; offset: number } {
  const spans: Span[] = [];
  let remaining = duration;
  let i = index;
  let at = offset;

  while (remaining > 0 && i < available.length) {
    const span = available[i];
    const start = Math.max(span.start, at);
    const room = span.end - start;
    if (room <= 0) {
      i++;
      at = 0;
      continue;
    }
    const used = Math.min(room, remaining);
    spans.push({ start, end: start + used });
    remaining -= used;
    if (used === room) {
      i++;
      at = 0;
    } else {
      at = start + used;
    }
  }

  return { spans, index: i, offset: at };
}

/**
 * Divides `availableMs` between the sequence blocks.
 *
 * Fixed blocks are paid first and in full — that is what "fixed" means, and it
 * is why the workout survives a compressed day intact. Whatever is left is
 * shared between the elastic blocks in proportion to their targets, then
 * clamped to their bounds; anything a clamp frees up is redistributed to the
 * blocks still able to take it, which matters on the long winter days when one
 * block would otherwise be handed more than its `maxMs`.
 *
 * When the day cannot even cover the fixed blocks, they are scaled down
 * together rather than some being dropped — a 40-minute workout is a worse
 * outcome than a missing one only if you were going to do the full hour, and at
 * that point the day has bigger problems than this function.
 */
export function allocate(
  blocks: readonly SequenceBlock[],
  availableMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const fixed = blocks.filter((b) => !b.elastic);
  const elastic = blocks.filter((b) => b.elastic);

  const fixedTotal = fixed.reduce((sum, b) => sum + b.targetMs, 0);

  if (availableMs <= fixedTotal) {
    const scale = fixedTotal === 0 ? 0 : Math.max(0, availableMs) / fixedTotal;
    for (const b of fixed) out.set(b.id, b.targetMs * scale);
    for (const b of elastic) out.set(b.id, 0);
    return out;
  }

  for (const b of fixed) out.set(b.id, b.targetMs);

  let pool = availableMs - fixedTotal;
  let open = [...elastic];

  // Loop rather than a single division: clamping one block changes the share
  // available to the others, so the split has to settle.
  while (open.length > 0) {
    const targetTotal = open.reduce((sum, b) => sum + b.targetMs, 0);
    if (targetTotal <= 0) {
      for (const b of open) out.set(b.id, 0);
      break;
    }
    let clamped = false;
    const nextOpen: SequenceBlock[] = [];
    for (const b of open) {
      const share = (pool * b.targetMs) / targetTotal;
      const min = b.minMs ?? 0;
      const max = b.maxMs ?? Number.POSITIVE_INFINITY;
      if (share < min) {
        out.set(b.id, min);
        pool -= min;
        clamped = true;
      } else if (share > max) {
        out.set(b.id, max);
        pool -= max;
        clamped = true;
      } else {
        nextOpen.push(b);
      }
    }
    if (!clamped) {
      const remainingTotal = nextOpen.reduce((sum, b) => sum + b.targetMs, 0);
      for (const b of nextOpen) {
        out.set(b.id, remainingTotal === 0 ? 0 : (pool * b.targetMs) / remainingTotal);
      }
      break;
    }
    open = nextOpen;
    // A clamp can drive the pool negative when the minimums exceed the day.
    // Everything still open then gets nothing rather than a negative span.
    if (pool < 0) {
      for (const b of open) out.set(b.id, 0);
      break;
    }
  }

  return out;
}

function titleOf(block: SequenceBlock, weekday: number): string {
  return typeof block.title === "function" ? block.title(weekday) : block.title;
}

/**
 * Resolves the day that *begins* with waking on `today.date`.
 *
 * Three days of prayer times are needed and all three are load-bearing:
 * `yesterday` gives the Isha that set last night's bedtime and therefore this
 * morning's wake; `today` gives the day's own prayers; `tomorrow` gives the
 * Fajr and sunrise that end tonight.
 */
export function resolveDay(
  yesterday: DayPrayerTimes,
  today: DayPrayerTimes,
  tomorrow: DayPrayerTimes,
  ruleset: Ruleset,
  timezone: string,
  weekday: number,
): ResolvedDay {
  const lastNight = resolveSleep(yesterday, today, ruleset.sleep, timezone);
  const tonight = resolveSleep(today, tomorrow, ruleset.sleep, timezone);
  const wake = lastNight.wake;
  const bedtime = tonight.bedtime;

  const blocks: ResolvedBlock[] = [];
  const key = (id: string, i = 0) => `${today.date}:${id}:${i}`;

  // Prayer gaps inside the waking day. Fajr usually falls during sleep or
  // tahajjud, in which case it produces no gap here — it was already paid for.
  const gaps: Span[] = [];
  for (const prayer of PRAYER_ORDER) {
    const at = today[prayer as PrayerName];
    if (at < wake || at >= bedtime) continue;
    const end = Math.min(at + ruleset.prayerGaps[prayer], bedtime);
    if (end <= at) continue;
    gaps.push({ start: at, end });
    blocks.push({
      key: key(`prayer-${prayer}`),
      kind: "prayer",
      category: null,
      title: prayer,
      start: at,
      end,
    });
  }
  gaps.sort((a, b) => a.start - b.start);

  // The waking day is one run from waking to bedtime.
  //
  // Anchoring the end at **bedtime** rather than at Isha is what keeps the work
  // blocks steady across the year. Isha swings by nearly four hours here, so
  // ending the sequence there handed December's early Isha a dead two-hour
  // stretch before the 20:30 floor let sleep begin — time that belonged to
  // nothing and came straight out of the only blocks that flex. Bedtime is
  // already `max(Isha + 15m, floor)`, so in summer this *is* Isha (the Isha
  // prayer fills the final quarter hour and the last block still ends on it),
  // and in winter it reaches the floor and reclaims the gap.
  const morning = { start: wake, end: Math.max(wake, bedtime) };
  const available = subtractSpans(morning, gaps);
  const durations = allocate(ruleset.sequence, spanMs(available));

  let index = 0;
  let offset = 0;
  const compression: Compression[] = [];
  for (const block of ruleset.sequence) {
    const duration = durations.get(block.id) ?? 0;
    const taken = take(available, index, offset, duration);
    index = taken.index;
    offset = taken.offset;
    const title = titleOf(block, weekday);
    taken.spans.forEach((piece, i) => {
      blocks.push({
        key: key(block.id, i),
        kind: "activity",
        category: block.category,
        title,
        start: piece.start,
        end: piece.end,
      });
    });
    compression.push({
      id: block.id,
      title,
      targetMs: block.targetMs,
      actualMs: spanMs(taken.spans),
    });
  }

  // Tonight's sleep, and the tahajjud that interrupts it.
  tonight.segments.forEach((segment, i) => {
    blocks.push({
      key: key("sleep", i),
      kind: "sleep",
      category: "Sleep",
      title: "sleep",
      start: segment.start,
      end: segment.end,
    });
  });
  if (tonight.tahajjud) {
    blocks.push({
      key: key("tahajjud"),
      kind: "tahajjud",
      category: "Islam",
      title: "tahajjud, fajr",
      start: tonight.tahajjud.start,
      end: tonight.tahajjud.end,
    });
  }

  blocks.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    date: today.date,
    timezone,
    prayers: today,
    lastNight,
    tonight,
    wake,
    bedtime,
    blocks,
    compression,
  };
}
