import "server-only";
import { createHash, timingSafeEqual, randomUUID } from "crypto";
import { cache } from "react";
import { headers } from "next/headers";
import { db, initDb } from "@/lib/db";

/**
 * Resolve the client IP from the incoming request's proxy headers. Prefers
 * x-real-ip (set by Vercel and most reverse proxies, and not forwarded from the
 * client), falling back to the rightmost value of x-forwarded-for — the hop
 * nearest to us. The leftmost value is whatever the client claimed and is
 * trivially spoofed, so rate-limiting on it would let one attacker spread
 * guesses across unlimited buckets.
 *
 * Takes no request object because its only caller is a Server Action, which
 * doesn't get one; `headers()` is async in this version of Next.
 *
 * Returns "unknown" when neither header is present, and callers must treat that
 * as a real bucket rather than a reason to skip the limit — see the note at the
 * call site in `login`.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();

  const realIp = h.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  return "unknown";
}

function safeCompare(a: string, b: string): boolean {
  // Hash both sides to a fixed 32-byte digest before comparing. Comparing the
  // raw bytes — even padded out to a common length — makes the work a function
  // of the *longer* input, so every guess shorter than the secret costs
  // len(ADMIN_KEY) and every guess longer costs len(guess). An attacker submits
  // passwords of increasing length, times the responses, and reads the secret's
  // length straight off the inflection point where the cost starts rising.
  // sha256 is fixed-width for any input, so the comparison below always looks
  // at exactly 32 bytes and reveals nothing about either length. The only
  // remaining length-dependent work is hashing the attacker's own guess, which
  // tells them what they already knew, plus a constant for the secret.
  const h = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(h(a), h(b));
}

/* ── Session store (DB-backed, survives cold starts / redeploys) ── */

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE = "admin_session";

/**
 * The `sessions` table stores sha256(token), never the token itself. The raw
 * token exists only in the admin's cookie and in the memory of the request
 * handling it, so read access to the database — a leaked TURSO_AUTH_TOKEN, a
 * backup, a dump — yields digests rather than live credentials. Previously a
 * row could be pasted straight into an `admin_session` cookie for instant admin
 * with no password.
 *
 * A plain unsalted sha256 is the right primitive here, unlike for a password: a
 * token is 122 bits of CSPRNG output, so there is no dictionary to precompute
 * and nothing for a slow KDF to buy. Lookup happens on every admin check, so
 * the cost matters.
 *
 * Migration: rows written before this change hold the raw UUID. A 36-character
 * UUID can never equal a 64-character hex digest, so an old cookie simply
 * misses on lookup and `validateSession` returns false — the user is asked to
 * sign in again, which is the intended outcome, and never an error. The orphan
 * rows are swept by the TTL prune in `createSession` within a day.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createSession(): Promise<string> {
  await initDb();
  const token = randomUUID();
  const now = Date.now();
  // Prune expired sessions, then insert the new one — one network round trip
  // to Turso instead of two. `batch` preserves statement order and runs the
  // whole list in a single transaction, so the prune can never delete the row
  // we are about to write (it only touches rows older than the TTL) and a
  // failed insert can't leave the prune half-applied.
  await db.batch(
    [
      {
        sql: "DELETE FROM sessions WHERE created_at < ?",
        args: [now - SESSION_TTL],
      },
      {
        sql: "INSERT INTO sessions (token, created_at) VALUES (?, ?)",
        args: [hashToken(token), now],
      },
    ],
    "write",
  );
  // The raw token goes back to the caller for the cookie; only its digest was
  // persisted above.
  return token;
}

/**
 * Is this session token still good? Memoized per request with React's `cache`,
 * keyed by `token`.
 *
 * Why this matters: every admin check in the app funnels through here, and a
 * single user action can check admin several times. `segmentLane()` calls
 * `assertAdmin()`, then `stopLane()` (which asserts again), then `startLane()`
 * (a third time) — that was three identical SELECTs against `sessions` for one
 * button press. Page renders have the same shape. Memoizing collapses them to
 * one query.
 *
 * This is NOT a security hole, and is not a cross-request cache. React's
 * `cache` is scoped to a single request/render pass: the memo is created when
 * the request starts and thrown away when it ends. A session revoked by
 * another request is invisible for at most the remainder of the one request
 * that already read it — the same window you'd get from any two DB reads that
 * aren't in the same transaction. Nothing is cached between requests, so a
 * revoked session is rejected on the very next one.
 *
 * The memoized value is the boolean result of the whole function, so the
 * expired-session DELETE below still runs on a genuine first call within the
 * request; only the redundant repeats are skipped.
 */
export const validateSession = cache(async (token: string): Promise<boolean> => {
  await initDb();
  // Look the session up by digest — the raw token is never stored, so an
  // unrecognised cookie (including one issued before tokens were hashed) simply
  // finds no row and is reported invalid. `cache` is still keyed on the raw
  // token, which is equivalent: the same token always hashes the same way.
  const key = hashToken(token);
  const result = await db.execute({
    sql: "SELECT created_at FROM sessions WHERE token = ?",
    args: [key],
  });
  if (result.rows.length === 0) return false;
  const createdAt = result.rows[0].created_at as number;
  if (Date.now() - createdAt > SESSION_TTL) {
    await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [key] });
    return false;
  }
  return true;
});

export async function destroySession(token: string) {
  await initDb();
  await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [hashToken(token)] });
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/* ── Rate limiter (DB-backed; survives serverless cold starts) ── */

const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;
const LOCKOUT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours once MAX_ATTEMPTS hit

export async function checkRateLimit(ip: string): Promise<boolean> {
  await initDb();
  const now = Date.now();
  const windowStart = now - RATE_WINDOW;
  const lockoutStart = now - LOCKOUT_WINDOW;

  // Prune entries older than the longest retention window
  await db.execute({
    sql: "DELETE FROM login_attempts WHERE first_attempt < ?",
    args: [lockoutStart],
  });

  // Atomic read-modify-write so concurrent attempts from the same IP can't both
  // read the same count and clobber each other's increment (which would let an
  // attacker exceed MAX_ATTEMPTS under load). The CASE order encodes the same
  // precedence as the prior app-level branches:
  //   1. Lockout wins: once count > MAX_ATTEMPTS within LOCKOUT_WINDOW, neither
  //      count nor first_attempt change, so the block persists the full 24h and
  //      the rolling-window reset can't lift it early.
  //   2. Otherwise, an expired rolling window (first_attempt < windowStart)
  //      resets the counter to 1 and re-anchors the window.
  //   3. Otherwise, increment.
  const result = await db.execute({
    sql: `INSERT INTO login_attempts (ip, count, first_attempt) VALUES (?, 1, ?)
          ON CONFLICT(ip) DO UPDATE SET
            count = CASE
              WHEN login_attempts.count > ? AND login_attempts.first_attempt >= ? THEN login_attempts.count
              WHEN login_attempts.first_attempt < ? THEN 1
              ELSE login_attempts.count + 1 END,
            first_attempt = CASE
              WHEN login_attempts.count > ? AND login_attempts.first_attempt >= ? THEN login_attempts.first_attempt
              WHEN login_attempts.first_attempt < ? THEN ?
              ELSE login_attempts.first_attempt END
          RETURNING count`,
    args: [ip, now, MAX_ATTEMPTS, lockoutStart, windowStart, MAX_ATTEMPTS, lockoutStart, windowStart, now],
  });
  const count = Number((result.rows[0] as unknown as { count: number }).count);
  return count <= MAX_ATTEMPTS;
}

/* ── Admin verification ── */

let warnedMissingAdminKey = false;

export function verifyAdminKey(password: string): boolean {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    if (!warnedMissingAdminKey) {
      warnedMissingAdminKey = true;
      console.warn("[auth] ADMIN_KEY is not set; admin login is disabled.");
    }
    return false;
  }
  if (typeof password !== "string") return false;
  return safeCompare(password, adminKey);
}
