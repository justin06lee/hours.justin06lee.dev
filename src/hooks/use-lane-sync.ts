"use client";

import { useEffect, useRef } from "react";
import type { CalendarActual } from "@/lib/calendar";
import { refreshLanes } from "@/app/actions";

/** How often to ask the server what is running, while the tab is visible. */
export const LANE_SYNC_INTERVAL_MS = 30_000;

export type LaneSyncOptions = {
  /**
   * Whether to poll at all. False while a dialog owns the lane state — the
   * break prompt holds a snapshot it is collecting answers against, and
   * replacing the lanes underneath it would be answering a different question
   * than the one on screen.
   */
  enabled: boolean;
  /**
   * Bumped by the caller every time a mutation writes new lane state.
   *
   * This is the whole reason polling is safe here. A poll reads "what is
   * running" at some instant and applies it some milliseconds later; if a
   * start or stop commits inside that window, the response in flight is
   * *older* than what the client already knows, and applying it would flicker
   * a stopped lane back to running until the next tick. Capturing the revision
   * at request time and discarding the result if it moved makes the mutation
   * always win, whatever the ordering.
   */
  revision: number;
  onLanes: (lanes: CalendarActual[]) => void;
  /** Called when the action rejects — in practice, an expired session. */
  onExpired: () => void;
  intervalMs?: number;
};

/**
 * Keeps the console's lane list in agreement with the database.
 *
 * `refreshLanes` existed from the beginning and had no caller, which left one
 * real hole: this database is shared with justin06lee.dev, and lanes started or
 * stopped there — or in another tab, or on a phone — were invisible here until
 * a manual reload. The console would happily offer a "start" button for a lane
 * something else was already holding, and the user would get "that lane was
 * just started somewhere else" for a lane that looked idle on screen.
 *
 * Only polls while the tab is actually visible, and syncs immediately on the
 * way back to it — which is the moment the local view is most likely to be
 * stale, and the moment a background timer would have been most wasteful.
 */
export function useLaneSync({
  enabled,
  revision,
  onLanes,
  onExpired,
  intervalMs = LANE_SYNC_INTERVAL_MS,
}: LaneSyncOptions): void {
  // Latest-callback refs: both callbacks are fresh closures every render, and
  // depending on them directly would tear down and re-arm the interval on each
  // one — resetting the countdown to the next poll every time anything renders.
  const onLanesRef = useRef(onLanes);
  const onExpiredRef = useRef(onExpired);
  const revisionRef = useRef(revision);
  useEffect(() => {
    onLanesRef.current = onLanes;
    onExpiredRef.current = onExpired;
    revisionRef.current = revision;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // Guards against a slow poll overlapping the next tick — without it, a
    // request taking longer than the interval would stack up requests behind
    // it, each one staler than the last.
    let inFlight = false;

    const sync = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

      const seenAt = revisionRef.current;
      inFlight = true;
      try {
        const lanes = await refreshLanes();
        // Three ways this result is no longer wanted: the effect was torn down,
        // polling was disabled, or a mutation landed while it was in flight and
        // already knows better.
        if (cancelled || revisionRef.current !== seenAt) return;
        onLanesRef.current(lanes);
      } catch {
        if (cancelled) return;
        // The action re-checks admin and that check throws, so an expired
        // session lands here rather than returning a result. Stop polling by
        // handing it to the caller, which refreshes into the login redirect.
        onExpiredRef.current();
      } finally {
        inFlight = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void sync();
    };

    const id = setInterval(() => void sync(), intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}
