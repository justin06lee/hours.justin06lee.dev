"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  SESSION_COOKIE_NAME,
  checkRateLimit,
  createSession,
  destroySession,
  getClientIp,
  verifyAdminKey,
} from "@/lib/auth";
import { isAdminServer } from "@/lib/auth-server";
import {
  deleteActual,
  getRunningActuals,
  segmentActuals,
  startActual,
  startActuals,
  stopAllActuals,
  updateActual,
  type ActualPatch,
  type CalendarActual,
  type LaneResume,
  type LaneSegment,
  type SegmentActualsResult,
  type UpdateActualResult,
} from "@/lib/calendar";
import { MAX_TRACK, PRIMARY_TRACK, isValidTrack } from "@/lib/calendar-constants";
import {
  MAX_NAME_LEN,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
  isEntryId,
  isFiniteEpochMs,
  isStringWithin,
} from "@/lib/calendar-validate";
import {
  categoryUsage,
  createCategory,
  deleteCategory,
  updateCategory,
} from "@/lib/calendar-categories";
import { isPaletteColor } from "@/lib/colors";
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
  revalidatePath("/track/journal");
  revalidatePath("/track/subjects");
  revalidatePath("/s/[subject]", "page");
}

export type LoginState = { error: string | null };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0) {
    // Deliberately ahead of the rate limit: an empty field is a UI slip, not a
    // guess, and it never reaches the compare, so it shouldn't burn an attempt.
    return { error: "enter the password" };
  }

  // Brute-force gate. This action is the only login surface in the app — there
  // is no middleware, no proxy, and no route handlers — so with nothing here an
  // attacker scripts unlimited guesses against ADMIN_KEY at line speed with a
  // clean success/failure oracle and no lockout or delay. The limit runs
  // *before* verifyAdminKey so a locked-out caller learns nothing about whether
  // the guess it just sent was right.
  //
  // A request whose IP can't be determined buckets to "unknown", and that
  // shared counter is enforced like any other. Skipping the limit there would
  // be a one-header bypass of the whole control. The cost of sharing is that
  // ten failures from unattributable requests lock that bucket out, but this is
  // a single-admin site: in production x-forwarded-for is always set, so
  // "unknown" is only reached in local dev or with a misconfigured proxy, and
  // the blast radius is one person waiting out a window rather than an open
  // door. Fail closed, and prefer the mild failure to the trivial bypass.
  const ip = await getClientIp();
  if (!(await checkRateLimit(ip))) {
    return { error: "too many attempts" };
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

/* ── Editing what was already logged ───────────────────────────────────────
 *
 * The console can only ever start and stop. Everything below is the repair
 * path: a lane left running overnight, a subject picked wrong, a description
 * worth rewriting. It writes through `updateActual`, which touches only the
 * columns a patch actually names and refuses a patch computed against a row
 * that has since moved — so a save from a stale journal tab reports a conflict
 * rather than overwriting whatever happened in between.
 */

export type EntryResult = { ok: true } | { ok: false; error: string };

/**
 * What the journal's editor may change.
 *
 * `endAt` is deliberately `number` and not `number | null`. Writing null would
 * *reopen* a finished entry — the exact resurrection `updateActual`'s SET-list
 * narrowing exists to prevent — and there is no reading of "edit this entry" in
 * which the answer is "start it running again". Stopping a running entry is a
 * concrete end time; that is available, and it is the only thing this offers.
 */
export type EntryPatchInput = {
  id: string;
  categoryId?: string | null;
  title?: string | null;
  notes?: string | null;
  startAt?: number;
  endAt?: number;
};

/** Every reason `updateActual` can refuse, so a new one becomes a compile
 *  error here rather than a silent fallthrough to a generic message. */
type UpdateFailureReason = Extract<UpdateActualResult, { ok: false }>["reason"];

function updateError(reason: UpdateFailureReason): string {
  switch (reason) {
    case "not-found":
      return "that entry no longer exists";
    case "start-after-end":
      return "the end has to come after the start";
    case "would-overlap-running":
      return "that would collide with a lane that's still running";
    case "invalid-category":
      return "that subject no longer exists";
    case "conflict":
      // Not a failure so much as "you were looking at an old copy". Say what
      // to do about it, because the fix is not obvious from the word alone.
      return "that entry changed somewhere else — reload and try again";
  }
}

/**
 * Edits one logged entry.
 *
 * Only the fields the caller actually sends are written: "not provided" stays
 * distinguishable from "explicitly cleared" all the way down to the SET list,
 * so saving a note cannot move a clock it never mentioned.
 */
export async function updateEntry(input: EntryPatchInput): Promise<EntryResult> {
  await assertAdmin();

  if (!isEntryId(input.id)) return { ok: false, error: "missing entry" };

  const patch: ActualPatch = {};

  if (input.categoryId !== undefined) {
    // An empty string is the "no subject" option in the select, which means
    // uncategorized — a real choice, and distinct from not touching the field.
    if (input.categoryId !== null && !isEntryId(input.categoryId)) {
      return { ok: false, error: "that subject no longer exists" };
    }
    patch.categoryId = input.categoryId || null;
  }

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

  // Bounded to years 2001–2100. The client parses its datetime-local input with
  // `localInputToEpoch`, which returns NaN rather than throwing on a malformed
  // value — so an unparseable box arrives here as NaN and has to be rejected
  // before it reaches a column every total is derived from.
  if (input.startAt !== undefined) {
    if (!isFiniteEpochMs(input.startAt)) return { ok: false, error: "that start time isn't valid" };
    patch.startAt = input.startAt;
  }
  if (input.endAt !== undefined) {
    if (!isFiniteEpochMs(input.endAt)) return { ok: false, error: "that end time isn't valid" };
    patch.endAt = input.endAt;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  // `hydrate: false` — the journal re-reads the page after a save, so the
  // read-back would be thrown away.
  const result = await updateActual(input.id, patch, { hydrate: false });
  if (!result.ok) return { ok: false, error: updateError(result.reason) };

  revalidateAll();
  return { ok: true };
}

/**
 * Deletes one logged entry outright.
 *
 * Genuinely destructive and genuinely necessary: a lane started by mistake has
 * no other way out, and leaving it in would corrupt every total that reads it.
 * The journal confirms before calling this.
 */
export async function deleteEntry(input: { id: string }): Promise<EntryResult> {
  await assertAdmin();
  if (!isEntryId(input.id)) return { ok: false, error: "missing entry" };

  // The result is deliberately ignored. `deleteActual` reports whether a row
  // was actually removed, and a miss means somebody else already deleted it —
  // the caller wanted the row gone and the row is gone, so that is a successful
  // no-op rather than an error to show anyone.
  await deleteActual(input.id);

  revalidateAll();
  return { ok: true };
}

/* ── Subjects ──────────────────────────────────────────────────────────────
 *
 * Categories are the buckets every hour on the site is filed under, and until
 * now they could only be created on the sibling site — this app read them and
 * offered no way to add, rename, recolor or retire one. The library functions
 * were all there; none of them had a caller.
 *
 * `calendar_categories` is shared with justin06lee.dev, so these are writes to
 * a table another app reads. Everything below leans on the constraints that
 * table already carries rather than inventing new rules: UNIQUE(LOWER(name)),
 * the `is_system` lock on the seeded Sleep row, and the in-use check before a
 * delete.
 */

export type SubjectResult = { ok: true } | { ok: false; error: string };

/** Shared shape check for a name, so create and rename can't diverge on it. */
function checkName(name: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (!isStringWithin(name, MAX_NAME_LEN)) {
    return { ok: false, error: `name must be ${MAX_NAME_LEN} characters or fewer` };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: "give it a name" };
  return { ok: true, value: trimmed };
}

/**
 * The palette gate, applied here as well as in the library.
 *
 * `createCategory`/`updateCategory` both check it too, and that is the check
 * that actually protects the column. This one exists so the action returns the
 * same lowercase sentence as every other failure here, rather than the
 * library's `invalid-color` reason leaking through a generic branch.
 */
function checkColor(color: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof color !== "string" || !isPaletteColor(color)) {
    return { ok: false, error: "pick a color from the palette" };
  }
  return { ok: true, value: color };
}

export async function createSubject(input: {
  name: string;
  color: string;
}): Promise<SubjectResult> {
  await assertAdmin();

  const name = checkName(input.name);
  if (!name.ok) return name;
  const color = checkColor(input.color);
  if (!color.ok) return color;

  const result = await createCategory({ name: name.value, color: color.value });
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "duplicate"
          ? "a subject with that name already exists"
          : result.reason === "invalid-color"
            ? "pick a color from the palette"
            : "give it a name",
    };
  }

  revalidateAll();
  return { ok: true };
}

/**
 * Renames, recolors, archives or unarchives one subject.
 *
 * Archiving rather than deleting is the normal way to retire a subject: the
 * hours already filed under it stay exactly where they are and keep counting,
 * the subject just stops being offered when starting a lane. Deleting is for
 * a subject that was a mistake, and is refused outright once anything points
 * at it.
 */
export async function updateSubject(input: {
  id: string;
  name?: string;
  color?: string;
  archived?: boolean;
}): Promise<SubjectResult> {
  await assertAdmin();
  if (!isEntryId(input.id)) return { ok: false, error: "missing subject" };

  const patch: { name?: string; color?: string; archived?: boolean } = {};

  if (input.name !== undefined) {
    const name = checkName(input.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (input.color !== undefined) {
    const color = checkColor(input.color);
    if (!color.ok) return color;
    patch.color = color.value;
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") return { ok: false, error: "could not save" };
    patch.archived = input.archived;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  const result = await updateCategory(input.id, patch);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "not-found"
          ? "that subject no longer exists"
          : result.reason === "duplicate"
            ? "a subject with that name already exists"
            : result.reason === "system-name-locked"
              ? "sleep is built in — it can be recolored but not renamed"
              : result.reason === "invalid-color"
                ? "pick a color from the palette"
                : "give it a name",
    };
  }

  revalidateAll();
  return { ok: true };
}

/**
 * Deletes a subject, but only one nothing is filed under.
 *
 * `deleteCategory` counts plans and actuals first and refuses when either is
 * non-zero, which is the right rule for a table shared with the sibling site:
 * the FK is declared `ON DELETE SET NULL` but libsql does not enable
 * `PRAGMA foreign_keys`, so a delete would not blank the references — it would
 * strand them, and every hour filed under that subject would silently become
 * uncategorized. The count comes back with the refusal so the message can say
 * how much is in the way.
 */
export async function deleteSubject(input: { id: string }): Promise<SubjectResult> {
  await assertAdmin();
  if (!isEntryId(input.id)) return { ok: false, error: "missing subject" };

  const result = await deleteCategory(input.id);
  if (!result.ok) {
    if (result.reason === "in-use") {
      const entries = result.actualCount ?? 0;
      const plans = result.planCount ?? 0;
      const parts: string[] = [];
      if (entries > 0) parts.push(`${entries} ${entries === 1 ? "entry" : "entries"}`);
      if (plans > 0) parts.push(`${plans} ${plans === 1 ? "plan" : "plans"}`);
      return {
        ok: false,
        error: `${parts.join(" and ")} still point at it — archive it instead`,
      };
    }
    return {
      ok: false,
      error:
        result.reason === "system-locked"
          ? "sleep is built in and can't be deleted"
          : "that subject no longer exists",
    };
  }

  revalidateAll();
  return { ok: true };
}

/** How much is filed under a subject, for the delete confirmation. */
export async function getSubjectUsage(
  id: string,
): Promise<{ entries: number; plans: number }> {
  await assertAdmin();
  if (!isEntryId(id)) return { entries: 0, plans: 0 };
  const usage = await categoryUsage(id);
  return { entries: usage.actualCount, plans: usage.planCount };
}
