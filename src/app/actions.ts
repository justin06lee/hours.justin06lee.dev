"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  SESSION_COOKIE_NAME,
  createSession,
  destroySession,
  verifyAdminKey,
} from "@/lib/auth";
import { isAdminServer } from "@/lib/auth-server";
import {
  getRunningActuals,
  segmentActuals,
  startActual,
  startActuals,
  stopAllActuals,
  type CalendarActual,
  type LaneResume,
  type LaneSegment,
  type SegmentActualsResult,
} from "@/lib/calendar";
import { MAX_TRACK, PRIMARY_TRACK, isValidTrack } from "@/lib/calendar-constants";
import { MAX_NOTES_LEN, MAX_TITLE_LEN, isStringWithin } from "@/lib/calendar-validate";
import { getSiteConfig, resolveTimezone } from "@/lib/site-config";

/**
 * Server Actions are reachable by direct POST, not only through this UI, so
 * every mutating action re-checks admin rather than trusting that the page
 * that rendered the button was itself gated.
 */
async function assertAdmin() {
  if (!(await isAdminServer())) throw new Error("unauthorized");
}

/**
 * Revalidates every surface that shows totals or running state.
 *
 * Called exactly once per user-visible mutation, at the end of the exported
 * action — never from a shared helper. All three pages are
 * `export const dynamic = "force-dynamic"`, so this has no cache to throw
 * away and calling it twice was harmless; it was also meaningless, and a
 * helper that revalidates makes it impossible to tell where a request's
 * side effects actually end.
 */
function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/track");
  revalidatePath("/s/[subject]", "page");
}

export type LoginState = { error: string | null };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0) {
    return { error: "enter the password" };
  }
  // Constant-time compare lives in verifyAdminKey.
  if (!verifyAdminKey(password)) {
    return { error: "wrong password" };
  }

  const token = await createSession();
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24,
  });
  redirect("/track");
}

export async function logout() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await destroySession(token);
  store.delete(SESSION_COOKIE_NAME);
  redirect("/");
}

export type LaneResult =
  | { ok: true; lanes: CalendarActual[] }
  | { ok: false; error: string };

export type StartLaneInput = {
  track: number;
  categoryId: string | null;
  title: string | null;
};

export type SegmentLaneInput = {
  id: string;
  track: number;
  categoryId: string | null;
  title: string | null;
  notes: string | null;
  /** When false the lane is left stopped, e.g. while actually on a break. */
  resume: boolean;
};

/** Every reason a lane mutation can fail for, borrowed from the widest of the
 *  calendar results so a new reason there becomes a compile error here rather
 *  than a silent fallthrough to "could not start". */
type LaneFailureReason = Extract<SegmentActualsResult, { ok: false }>["reason"];

/**
 * Names the offending lane, but only when more than one was in flight. With a
 * single lane the user is looking straight at it and the original unprefixed
 * wording is what they already know; with three, "lane 2:" is the difference
 * between an actionable message and a shrug.
 */
function laneScoped(tracks: number[], index: number | null, message: string): string {
  if (tracks.length <= 1 || index === null) return message;
  return `lane ${tracks[index]}: ${message}`;
}

function startError(tracks: number[], index: number | null, reason: LaneFailureReason): string {
  // A constraint race inside a multi-lane transaction can't be attributed to
  // one insert, so say so plainly rather than blaming an arbitrary lane.
  if (reason === "concurrent-start" && index === null && tracks.length > 1) {
    return "one of those lanes was just started somewhere else";
  }
  const base =
    reason === "concurrent-start"
      ? "that lane was just started somewhere else"
      : reason === "invalid-category"
        ? "that subject no longer exists"
        : "could not start";
  return laneScoped(tracks, index, base);
}

function segmentError(
  tracks: number[],
  result: Extract<SegmentActualsResult, { ok: false }>,
): string {
  return result.phase === "open"
    ? startError(tracks, result.index, result.reason)
    : laneScoped(tracks, result.index, `could not save: ${result.reason}`);
}

/** Shared normalization for both start paths, so a lane started one at a time
 *  and a lane started as part of a batch are validated identically. */
function normalizeStart(
  input: StartLaneInput,
): { ok: true; value: LaneResume } | { ok: false; error: string } {
  if (!isValidTrack(input.track)) {
    return { ok: false, error: `lane must be between ${PRIMARY_TRACK} and ${MAX_TRACK}` };
  }
  // An over-long title is dropped rather than rejected: getting the clock
  // running matters more than the label, and the label is editable after.
  const title =
    input.title && isStringWithin(input.title, MAX_TITLE_LEN) ? input.title.trim() : null;
  return {
    ok: true,
    value: { categoryId: input.categoryId || null, title: title || null, track: input.track },
  };
}

/** The describe-half of a stop: only the fields the caller actually sent, so
 *  "not provided" stays distinguishable from "explicitly cleared". */
function stopPatch(
  input: { title?: string | null; notes?: string | null },
): { ok: true; patch: { title?: string | null; notes?: string | null } } | { ok: false; error: string } {
  const patch: { title?: string | null; notes?: string | null } = {};
  if (input.title !== undefined) {
    if (!isStringWithin(input.title ?? "", MAX_TITLE_LEN)) {
      return { ok: false, error: "title too long" };
    }
    patch.title = input.title?.trim() || null;
  }
  if (input.notes !== undefined) {
    if (!isStringWithin(input.notes ?? "", MAX_NOTES_LEN)) {
      return { ok: false, error: "notes too long" };
    }
    patch.notes = input.notes?.trim() || null;
  }
  return { ok: true, patch };
}

/**
 * Starts a lane. Only ever displaces what was already running on that same
 * lane — other lanes keep ticking, which is the whole point of tracks.
 *
 * `hydrate: false` because the rich `started` / `autoStopped` rows this used
 * to fetch were thrown away here and then answered again by a separate
 * `getRunningActuals()`. The running-lane list now comes back from the write
 * transaction itself.
 */
export async function startLane(input: StartLaneInput): Promise<LaneResult> {
  await assertAdmin();

  const norm = normalizeStart(input);
  if (!norm.ok) return norm;

  const tz = resolveTimezone(await getSiteConfig());
  const result = await startActual({ ...norm.value, timezone: tz }, { hydrate: false });
  if (!result.ok) return { ok: false, error: startError([input.track], 0, result.reason) };

  revalidateAll();
  return { ok: true, lanes: result.lanes };
}

/**
 * Starts several lanes in one server invocation — one admin check, one site
 * config read, one transaction, one revalidate. The break overlay resumes
 * every lane at once, and looping `startLane` made that N POSTs each paying
 * the whole per-request cost.
 *
 * All-or-nothing: `startActuals` runs the inserts in a single transaction, so
 * a lane that loses a race to another client fails the batch instead of
 * leaving the session half-resumed.
 */
export async function startLanes(inputs: StartLaneInput[]): Promise<LaneResult> {
  await assertAdmin();
  if (inputs.length === 0) return { ok: true, lanes: await getRunningActuals() };

  const normalized: LaneResume[] = [];
  for (const input of inputs) {
    const norm = normalizeStart(input);
    if (!norm.ok) return norm;
    normalized.push(norm.value);
  }

  const tz = resolveTimezone(await getSiteConfig());
  const result = await startActuals(normalized.map((v) => ({ ...v, timezone: tz })));
  if (!result.ok) {
    return { ok: false, error: startError(inputs.map((i) => i.track), result.index, result.reason) };
  }

  revalidateAll();
  return { ok: true, lanes: result.lanes };
}

/**
 * Stops one running entry, optionally writing what was done first. This is the
 * "what did you do?" path: the description is saved onto the entry it
 * describes, before the entry is closed.
 *
 * The describe and the close are now one `segmentActuals` call rather than an
 * `updateActual` followed by a `stopActualById`. The ordering that matters —
 * description written while the row is still running, so it stays attached to
 * the right entry even if the close loses a race — is preserved by the
 * statement order inside that call's transaction.
 */
export async function stopLane(input: {
  id: string;
  title?: string | null;
  notes?: string | null;
}): Promise<LaneResult> {
  await assertAdmin();

  if (!isStringWithin(input.id, MAX_TITLE_LEN) || input.id.length === 0) {
    return { ok: false, error: "missing entry" };
  }
  const patch = stopPatch(input);
  if (!patch.ok) return patch;

  const result = await segmentActuals([{ id: input.id, patch: patch.patch, resume: null }]);
  if (!result.ok) return { ok: false, error: segmentError([], result) };

  revalidateAll();
  return { ok: true, lanes: result.lanes };
}

/**
 * Ends the whole session — every lane at once.
 *
 * `lanes` is `[]` straight from `stopAllActuals`, which is exact rather than
 * assumed: see the note there on why a read-back of "what's running now?"
 * after an `UPDATE ... WHERE end_at IS NULL` can only ever return nothing.
 */
export async function stopAllLanes(): Promise<LaneResult> {
  await assertAdmin();
  const { lanes } = await stopAllActuals(undefined, { hydrate: false });
  revalidateAll();
  return { ok: true, lanes };
}

/**
 * Closes the current chunk with its description and immediately opens a new one
 * on the same lane with the same subject. This is what the break alarm calls:
 * the segment just worked gets logged, and the next segment starts clean.
 */
export async function segmentLane(input: SegmentLaneInput): Promise<LaneResult> {
  await assertAdmin();
  return runSegments([input]);
}

/**
 * The same thing for every running lane at once. The break dialog collects a
 * description per lane and then closes them all; doing that as N `segmentLane`
 * POSTs meant N admin checks, N site config reads and N revalidates for one
 * user action.
 */
export async function segmentLanes(inputs: SegmentLaneInput[]): Promise<LaneResult> {
  await assertAdmin();
  return runSegments(inputs);
}

/**
 * Shared body for `segmentLane` / `segmentLanes`. Deliberately not exported
 * and deliberately not admin-checking: both entry points do that first, and
 * this exists only so the two can't drift.
 */
async function runSegments(inputs: SegmentLaneInput[]): Promise<LaneResult> {
  if (inputs.length === 0) return { ok: true, lanes: await getRunningActuals() };

  const segments: LaneSegment[] = [];
  let anyResume = false;
  for (const input of inputs) {
    if (!isStringWithin(input.id, MAX_TITLE_LEN) || input.id.length === 0) {
      return { ok: false, error: "missing entry" };
    }
    // Only `notes` is describable here — the title belongs to the lane, not to
    // the stretch, so segmenting must not quietly rewrite it.
    const patch = stopPatch({ notes: input.notes });
    if (!patch.ok) return patch;

    let resume: LaneResume | null = null;
    if (input.resume) {
      const norm = normalizeStart(input);
      if (!norm.ok) return norm;
      resume = norm.value;
      anyResume = true;
    }
    segments.push({ id: input.id, patch: patch.patch, resume });
  }

  // Only a resume needs a timezone (it anchors the new row's `date`), so a
  // pure "log it and take a break" never pays for the site config read.
  const timezone = anyResume ? resolveTimezone(await getSiteConfig()) : undefined;
  const result = await segmentActuals(segments, { timezone });
  if (!result.ok) {
    return { ok: false, error: segmentError(inputs.map((i) => i.track), result) };
  }

  revalidateAll();
  return { ok: true, lanes: result.lanes };
}

/** Fresh lane state, for polling after the page has been open a while. */
export async function refreshLanes(): Promise<CalendarActual[]> {
  await assertAdmin();
  return getRunningActuals();
}
