/** An ellipsis gap in the page list. */
export const GAP = "gap" as const;

export type PageItem = number | typeof GAP;

/**
 * The page numbers to render, with `GAP` where pages are elided.
 *
 * Split out from the component because this is the part with edge cases worth
 * testing: a run only one page shorter than the gap that would replace it, and
 * a current page close enough to an end that a naively clamped window would
 * shrink.
 */
export function paginationRange(
  page: number,
  pageCount: number,
  siblings = 1,
  boundaries = 1,
): PageItem[] {
  const total = Math.max(0, Math.floor(pageCount));
  if (total <= 0) return [];

  // Everything fits: the two boundary runs, the sibling window either side of
  // the current page, and the two positions an ellipsis could occupy.
  const visible = boundaries * 2 + siblings * 2 + 3;
  if (total <= visible) return Array.from({ length: total }, (_, i) => i + 1);

  const current = Math.min(Math.max(1, page), total);

  // The window keeps a constant width even at the ends: clamping it without
  // shifting would render "1 2 … 20" on page 1 and "1 … 18 19 20" on page 20,
  // so the control would change width as you paged through it.
  const windowSize = siblings * 2 + 1;
  let windowStart = Math.max(boundaries + 1, current - siblings);
  let windowEnd = windowStart + windowSize - 1;
  if (windowEnd > total - boundaries) {
    windowEnd = total - boundaries;
    windowStart = Math.max(boundaries + 1, windowEnd - windowSize + 1);
  }

  const out: PageItem[] = [];
  for (let i = 1; i <= boundaries; i++) out.push(i);

  // A gap standing in for exactly one page is replaced by that page: "1 … 3"
  // costs the same width as "1 2 3" and tells the reader less.
  if (windowStart > boundaries + 2) out.push(GAP);
  else if (windowStart === boundaries + 2) out.push(boundaries + 1);

  for (let i = windowStart; i <= windowEnd; i++) out.push(i);

  if (windowEnd < total - boundaries - 1) out.push(GAP);
  else if (windowEnd === total - boundaries - 1) out.push(total - boundaries);

  for (let i = total - boundaries + 1; i <= total; i++) out.push(i);

  return out;
}
