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
  startActual,
  stopActualById,
  stopAllActuals,
  updateActual,
  type CalendarActual,
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

/** Revalidates every surface that shows totals or running state. */
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

/**
 * Starts a lane. Only ever displaces what was already running on that same
 * lane — other lanes keep ticking, which is the whole point of tracks.
 */
export async function startLane(input: {
  track: number;
  categoryId: string | null;
  title: string | null;
}): Promise<LaneResult> {
  await assertAdmin();

  if (!isValidTrack(input.track)) {
    return { ok: false, error: `lane must be between ${PRIMARY_TRACK} and ${MAX_TRACK}` };
  }
  const title =
    input.title && isStringWithin(input.title, MAX_TITLE_LEN) ? input.title.trim() : null;
  const categoryId = input.categoryId || null;

  const tz = resolveTimezone(await getSiteConfig());
  const result = await startActual({
    categoryId,
    title: title || null,
    timezone: tz,
    track: input.track,
  });

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "concurrent-start"
          ? "that lane was just started somewhere else"
          : result.reason === "invalid-category"
            ? "that subject no longer exists"
            : "could not start",
    };
  }

  revalidateAll();
  return { ok: true, lanes: await getRunningActuals() };
}

/**
 * Stops one running entry, optionally writing what was done first. This is the
 * "what did you do?" path: the description is saved onto the entry it
 * describes, before the entry is closed.
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

  // Describe first, then close. Writing the description while the row is still
  // running keeps it attached to the right entry even if the stop then loses a
  // race to another client.
  if (Object.keys(patch).length > 0) {
    const updated = await updateActual(input.id, patch);
    if (!updated.ok) return { ok: false, error: `could not save: ${updated.reason}` };
  }

  await stopActualById(input.id);
  revalidateAll();
  return { ok: true, lanes: await getRunningActuals() };
}

/** Ends the whole session — every lane at once. */
export async function stopAllLanes(): Promise<LaneResult> {
  await assertAdmin();
  await stopAllActuals();
  revalidateAll();
  return { ok: true, lanes: await getRunningActuals() };
}

/**
 * Closes the current chunk with its description and immediately opens a new one
 * on the same lane with the same subject. This is what the break alarm calls:
 * the segment just worked gets logged, and the next segment starts clean.
 */
export async function segmentLane(input: {
  id: string;
  track: number;
  categoryId: string | null;
  title: string | null;
  notes: string | null;
  /** When false the lane is left stopped, e.g. while actually on a break. */
  resume: boolean;
}): Promise<LaneResult> {
  await assertAdmin();

  const closed = await stopLane({ id: input.id, notes: input.notes });
  if (!closed.ok) return closed;

  if (!input.resume) return { ok: true, lanes: await getRunningActuals() };

  return startLane({
    track: input.track,
    categoryId: input.categoryId,
    title: input.title,
  });
}

/** Fresh lane state, for polling after the page has been open a while. */
export async function refreshLanes(): Promise<CalendarActual[]> {
  await assertAdmin();
  return getRunningActuals();
}
