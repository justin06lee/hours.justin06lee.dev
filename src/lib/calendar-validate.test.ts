import { describe, it, expect } from "vitest";
import {
  MAX_PAGE_SIZE,
  clampPageLimit,
  clampPageOffset,
  pageToOffset,
} from "@/lib/calendar-validate";

/**
 * These three exist to stand between a query string and a `LIMIT`/`OFFSET`
 * clause, so the interesting cases are all the ways a URL can carry something
 * that isn't a page number.
 */

describe("clampPageLimit", () => {
  it("passes a sane value through", () => {
    expect(clampPageLimit(20)).toBe(20);
    expect(clampPageLimit(1)).toBe(1);
  });

  it("caps at MAX_PAGE_SIZE", () => {
    expect(clampPageLimit(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(clampPageLimit(10_000)).toBe(MAX_PAGE_SIZE);
  });

  it("rejects zero and negatives rather than passing them to SQL", () => {
    // The load-bearing case: SQLite reads `LIMIT -1` as *no limit*, so a
    // negative slipping through would silently undo the bound entirely and
    // serve the whole table from a surface that looks paginated.
    expect(clampPageLimit(-1)).toBe(20);
    expect(clampPageLimit(0)).toBe(20);
  });

  it("falls back for values that are not usable numbers", () => {
    expect(clampPageLimit(NaN)).toBe(20);
    expect(clampPageLimit(Infinity)).toBe(20);
    expect(clampPageLimit(undefined)).toBe(20);
    expect(clampPageLimit(null)).toBe(20);
    expect(clampPageLimit("banana")).toBe(20);
    expect(clampPageLimit({})).toBe(20);
  });

  it("reads a numeric string, since that is what a query string carries", () => {
    expect(clampPageLimit("50")).toBe(50);
  });

  it("floors fractions", () => {
    expect(clampPageLimit(20.9)).toBe(20);
  });

  it("honours a caller's own fallback", () => {
    expect(clampPageLimit("nonsense", 25)).toBe(25);
  });
});

describe("clampPageOffset", () => {
  it("passes a non-negative integer through", () => {
    expect(clampPageOffset(0)).toBe(0);
    expect(clampPageOffset(120)).toBe(120);
  });

  it("floors a negative offset to zero", () => {
    // `OFFSET -5` is an error in SQLite rather than a silent misread, but a
    // 500 on a hand-edited URL is still worse than page one.
    expect(clampPageOffset(-5)).toBe(0);
  });

  it("resolves junk to zero", () => {
    expect(clampPageOffset(NaN)).toBe(0);
    expect(clampPageOffset(Infinity)).toBe(0);
    expect(clampPageOffset(undefined)).toBe(0);
    expect(clampPageOffset("banana")).toBe(0);
  });

  it("reads a numeric string and floors fractions", () => {
    expect(clampPageOffset("40")).toBe(40);
    expect(clampPageOffset(40.7)).toBe(40);
  });
});

describe("pageToOffset", () => {
  it("treats page 1 as offset 0", () => {
    expect(pageToOffset(1, 25)).toBe(0);
  });

  it("steps by the page size", () => {
    expect(pageToOffset(2, 25)).toBe(25);
    expect(pageToOffset(4, 20)).toBe(60);
  });

  it("treats page 0, negatives and junk as page 1", () => {
    // `?page=0` is the obvious hand-edit, and it must not produce OFFSET -25.
    expect(pageToOffset(0, 25)).toBe(0);
    expect(pageToOffset(-3, 25)).toBe(0);
    expect(pageToOffset("banana", 25)).toBe(0);
    expect(pageToOffset(undefined, 25)).toBe(0);
  });

  it("reads the numeric string a query string actually carries", () => {
    expect(pageToOffset("3", 25)).toBe(50);
  });
});
