# Audit findings in Instance B's files

Instance A ran a five-agent audit over this codebase. Every finding below lands
in a file **B claimed** in `AGENT-COORDINATION.md`, so A has not touched any of
them. They are ordered by severity.

Each was confirmed by reading the code, not inferred. Line numbers are against
`master` @ 4b1dc49 and may have shifted under B's in-flight edits — re-locate by
symbol, not by line.

**A is not asking B to fix all of these.** A is asking for the three files in
the handoff request (`auth.ts`, `actions.ts`, `track-console.tsx`) and will fix
those itself. The rest are B's files uncontested; this list exists so the
findings aren't lost. If B would rather A take more, say so.

---

## CRITICAL — do this one regardless of who does it

### 1. `login` has no brute-force protection (`actions.ts:43`, `auth.ts:95`)

`checkRateLimit()` is fully implemented — DB-backed, 15-min rolling window, 10
attempts, 24h lockout, correct atomic upsert (A traced the `CASE` logic through
all six edge cases; it has no off-by-one). **It is never called from anywhere in
the repo.** One grep hit: its own definition.

There is no proxy/middleware and no route handlers — confirmed, `src/app` has no
`api/`, no `route.ts`, no `middleware.ts`, and Next 16's renamed `proxy.ts`
doesn't exist either. So the `login` Server Action is the *only* login surface,
and it goes straight from `verifyAdminKey` to `createSession` with no throttle.

Exploit: pull the login action id from the client chunk (it is served to
unauthenticated visitors by design), then loop `POST /login` with `Next-Action:
<id>` and a matching `Origin`/`Host`. The framework's CSRF check passes trivially
because a scripted attacker sets both headers itself — that check only stops a
victim's browser being tricked, not a script. Failure returns `{error:"wrong
password"}`; success returns `Set-Cookie` + redirect, so it's a clean oracle. No
lockout, no delay, no logging. `ADMIN_KEY` is compared in plaintext with no KDF,
so each guess costs one string compare.

Aggravating: `login/page.tsx:21` tells the user it's the "same password as
justin06lee.dev" — implying a human-memorable secret with a blast radius across
both sites.

**Fix:** `getClientIp` takes a `NextRequest`, which a Server Action does not
have. Add a `headers()`-based sibling and gate `login` before `verifyAdminKey`:

```ts
const h = await headers();
const ip = h.get("x-real-ip")?.trim()
  ?? h.get("x-forwarded-for")?.split(",").map(s => s.trim()).filter(Boolean).at(-1)
  ?? "unknown";
if (!(await checkRateLimit(ip))) return { error: "too many attempts" };
```

Note `x-real-ip` is only trustworthy behind a header-normalizing proxy. On
Vercel it is; self-hosted it is not, and an attacker rotating `X-Real-IP` would
nullify the limiter entirely. Prefer `x-vercel-forwarded-for` if deploying there.

---

## HIGH

### 2. `updateActual` clobbers `end_at`, over-counting hours (`calendar.ts:629-671`)

Full-row read-modify-write: it reads the row, merges the patch, and
unconditionally writes `end_at=?` (line 662) even when the patch never mentions
`endAt`.

`actions.ts:153` (`stopLane`, also reached from the break alarm via
`segmentLane`) calls `updateActual(id, {notes})` on a **running** row and then
stops it. If a second tab or `stopAllActuals` closes that row between
`getActualById` (623) and the UPDATE, `merged.endAt` is still a stale `null`, so
the UPDATE **resurrects the row** (`end_at=NULL`) and `stopActualById` re-closes
it at a later timestamp. The entry's end time silently moves later and hours are
over-counted — in an app whose entire premise is "logged honestly".

**Fix:** build the SET clause from only the keys present in `patch`, and add an
optimistic guard to the WHERE (`AND updated_at = ?` with the value read),
returning a conflict result when `rowsAffected === 0`.

### 3. A notes-only save can fail and silently drop the user's text (`calendar.ts:645-654`)

Same stale read, different branch. Because `merged.endAt` is stale-`null`, the
pre-check at 646-650 treats a pure `{notes}` patch as "this row wants the lane".

User types their description into the stop dialog; meanwhile the lane was
stopped and restarted elsewhere. `getRunningActualOnTrack(0)` now returns the
*new* row, `running.id !== id` → `would-overlap-running`. The notes are never
persisted, and `segmentLane` aborts before resuming the lane.

**Fix:** only run the lane-collision check when `patch.endAt !== undefined` —
i.e. when the caller is actually changing running-ness — not when `endAt` was
merely inherited from the read.

### 4. `updateActual` never recomputes `date` when `start_at` changes (`calendar.ts:621-671`)

`ActualPatch` exposes `startAt` and `createActual:717` derives `date` from it,
but the UPDATE omits `date`. Patching `startAt` to a different day leaves the
row filed under the old `date`, so every `date`-filtered query
(`getActualsInRange:362`, `loadDayPageData:770`,
`getOverlapHeatmapForRange:832`) misplaces it and it vanishes from its real
day's view. Latent today — no caller patches `startAt` — but the exported
signature invites it.

### 5. `slugify` collisions break `/s/[subject]` (`hours-math.ts:155`, `s/[subject]/page.tsx:45`)

**A owns `hours-math.ts` but NOT the page, and the real fix is in the page.**

The page resolves a subject with `subjects.find(s => slugify(s.name) === slug)`
— first match wins. Verified collisions: `"C++"` and `"C#"` both → `"c"`;
`"Ai/ML"` and `"AI ML"` both → `"ai-ml"`; `"Machine Learning"` and
`"machine-learning"` both → `"machine-learning"`. The DB's `UNIQUE(LOWER(name))`
index does **not** prevent these — the two names differ before slugification.

Consequence: `page.tsx:28` renders both bar-list links as `/s/c`; clicking
either shows whichever sorted higher by `ms`. One subject's page becomes
permanently unreachable and the other's title and heatmap are attributed to the
wrong name.

Also: non-ASCII names slugify to the empty string (`"日本語"`, `"!!!"`, `"  "`
all → `""`), producing `href="/s/"`, which doesn't match the dynamic segment at
all → 404 on a category that plainly has hours.

**Fix (needs the page, hence B's):** route by `category.id` (`/s/[id]`), or
persist a unique `slug` column with a de-duplicating suffix and a non-empty
fallback (`slugify(name) || id.slice(0,8)`), enforced by a UNIQUE index.

A has added tests to `hours-math.test.ts` that **pin the current broken
behavior**, clearly commented as characterizing a known defect. When B fixes the
routing, flip those tests.

### 6. Session-expiry failures are invisible in the track console (`track-console.tsx:107,122,132,172,206`)

Every server-action call runs bare inside `startTransition` with no `try/catch`,
and `assertAdmin()` **throws** rather than returning `{ok:false}`. React 19 pipes
the rejection to `reportGlobalError` and settles the transition; nothing in the
component observes it.

The 24h session expires with the console open. User clicks **stop** → `stopLane`
rejects → `apply()` never runs → no toast, `pending` flips back to false, the
card still shows "stop", and the row stays `end_at IS NULL` forever. No signal,
no path to `/login`. Same for start, stop-all, segment, resume.

**Fix:** either wrap each transition body in try/catch with a "session expired"
toast + `router.refresh()`, or — cleaner — have `assertAdmin` return
`{ok:false, error:"unauthorized"}` so it flows through the existing `LaneResult`
channel. `login`/`logout` must keep throwing, since they legitimately `redirect`.

---

## MEDIUM

### 7. The break modal has no dismiss path and strands on partial failure (`track-console.tsx:168-186, 455-508`)

`submitSegments` loops `await segmentLane(...)` and `return`s on the first
failure, leaving `prompting`/`descriptions` untouched. The dialog's only control
is "log it and break" — no cancel, no Escape, no backdrop click.

Two lanes running when the alarm fires. Lane 0 succeeds; lane 1 fails. The modal
stays open still listing lane 0 — whose entry is already closed. Clicking again
re-runs `segmentLane` on the closed id, writing notes onto a finished row and
restarting a lane the user had already stopped. If the failure was `assertAdmin`
throwing (#6), no toast appears either and the user is trapped behind a `fixed
inset-0` overlay with only a page reload as escape.

**Fix:** track per-segment success in a `Set`, skip already-closed ids on retry,
always clear state in a `finally`, and add a skip button plus Escape/backdrop
handlers.

### 8. Granting notification permission turns notifications *off* (`track-console.tsx:438-441`)

```tsx
if (alarm.notifyPermission !== "granted") await alarm.requestNotify();
alarm.setSettings({ notify: !alarm.settings.notify });
```

`DEFAULT_SETTINGS.notify` is already `true`, so the toggle inverts a value that
was never what blocked notifications. Fresh browser, permission `"default"`:
label reads "notifications off", user clicks, browser prompt appears, they click
Allow → permission `"granted"`, then `setSettings({notify: !true})` writes
`false`. Label still reads "notifications off" and the alarm will not notify.
Only a second click fixes it.

**Fix:** when permission was not already granted, request it and set
`notify: true` unconditionally; only toggle when permission was already granted.

### 9. `openLanes` never reconciles with server state (`track-console.tsx:44,49-52`)

`useState(initialLanes)` and the `openLanes` initializer ignore all later prop
values, and `revalidatePath("/track")` re-renders the server component but
cannot reseed `useState`. No polling, no `router.refresh()`, no sync effect.
`refreshLanes()` — the action written for exactly this — is never called.

A lane started on track 2 from justin06lee.dev/calendar (shared DB) appears in
the `LaneBar` but gets no card and no stop button after any local action,
because `openLanes` is still `[0]`. The only way to stop it is "end session".

**Fix:** derive `openLanes` from `lanes` with `useMemo` so any track present in
`lanes` always gets a card, and either wire `refreshLanes` to a
visibility-gated poll or delete it.

### 10. Track-console modal claims `aria-modal` but implements none of it (`track-console.tsx:456-461`)

No focus moved in, no trap, no Escape, page behind stays focusable and
scrollable. `break-overlay.tsx:172-225` does all three correctly — the pattern
already exists in this codebase; reuse it.

### 11. `getHoursOverview` is not wrapped in React `cache()` (`hours.ts:95`)

`getSiteConfig`, `validateSession` and `isAdminServer` all are; this isn't, and
Next only dedupes `fetch`, not arbitrary calls. `s/[subject]/page.tsx` calls it
twice per request (`generateMetadata` at :29 and the body at :44), so the full
unbounded `SELECT … FROM calendar_actuals ORDER BY start_at DESC` runs twice and
the interval math runs twice. It also means the two calls see different
`Date.now()` values, so a running entry's ms can disagree between the `<title>`
and the body. **Squarely B's round-trip remit.**

### 12. The entry query is unbounded (`hours.ts:65-67`)

No `WHERE`, no `LIMIT`, and all three pages are `force-dynamic`. `splitByDay`
then costs ~84 `Intl.format` calls per entry-day (~0.83µs each, so ~700ms of
pure formatting at 10k entries). The `daily` heatmap only ever displays one year.
**Fix:** bound to the displayed window (`WHERE start_at >= ? OR end_at IS NULL`).

### 13. An invalid timezone from the DB takes down every page (`site-config.ts:76-78`)

`resolveTimezone` returns `config.prayerLocation.timezone` verbatim;
`validatePrayerLocation` only checks `typeof === "string"`; `parseSiteConfigRows`
spreads raw parsed JSON over the defaults with no shape check. A
`site_config.prayerLocation` of `{"timezone":"EST5EDT-bogus"}` — writable by the
sibling app — makes `new Intl.DateTimeFormat(…, {timeZone})` throw `RangeError`
inside `getDateFormatter`, 500ing `/`, `/s/[subject]` and `/track`.
**Fix:** validate in `resolveTimezone` (try/catch a throwaway
`Intl.DateTimeFormat`, or `Intl.supportedValuesOf("timeZone")`) and fall back to
`DEFAULT_TIMEZONE`.

### 14. `createCategory` check-then-act against a live UNIQUE index (`calendar-categories.ts:71-86`)

`findCategoryByNameCI` then INSERT, with `idx_calendar_categories_name_lower`
UNIQUE. Two concurrent creates both see no duplicate; the second raises
`SQLITE_CONSTRAINT_UNIQUE`, uncaught, propagating as a 500 instead of the
designed `{ok:false, reason:"duplicate"}`. `SELECT MAX(position)+1` races too.

### 15. Cold-start `ALTER TABLE` race (`db.ts:239-255`)

The comment claims every statement is idempotent. `ALTER TABLE … ADD COLUMN` is
not, and the PRAGMA read is separated from the ALTER batch. Two cold workers
both read PRAGMA, both ALTER, the loser gets `duplicate column name`, the batch
aborts, `doInit` rejects, the request 500s — and the fingerprint is never
written, so it repeats. **Fix:** issue ALTERs individually and swallow
`duplicate column name`.

### 16. The partial UNIQUE index creation can hard-fail permanently (`db.ts:161-162`)

`CREATE UNIQUE INDEX … ON calendar_actuals(track) WHERE end_at IS NULL` fails
outright if the table currently holds two open rows on one track — reachable
from a crashed migration or the sibling app. Then `doInit` rejects and **every
page 500s on every cold start** until someone manually closes the duplicates.
**Fix:** add a repair statement that closes duplicates before creating the index.

### 17. The fingerprint fast path makes a DROP INDEX one-shot, in a shared DB (`db.ts:160,228`)

Once the fingerprint matches, `doInit` returns and POST_STEPS never runs again.
If the sibling app re-creates the old *global* `idx_calendar_actuals_running`,
this app never drops it, so starting lane 1 while lane 0 runs raises the global
unique violation and is reported as "that lane was just started somewhere else"
— permanently, with no recovery short of a code edit. **Fix:** keep the
`DROP INDEX IF EXISTS` on the fast path; it's a cheap no-op.

### 18. `isRunningUniqueViolation` is too broad (`calendar.ts:468-477`)

Returns true for the generic `SQLITE_CONSTRAINT`, not just `_UNIQUE`. A
`NOT NULL constraint failed` is swallowed and reported as `concurrent-start`, so
the UI blames concurrency for an unrelated bug and the real error never reaches
the logs.

### 19. Cross-midnight entries are capped at two days (`calendar.ts:362,717,770`)

`date` anchors to the start day and `loadDayPageData` looks back exactly one day,
so a sleep entry or forgotten timer spanning `08-01 22:00 → 08-04 07:00` doesn't
appear on Aug 3 or Aug 4. `getOverlapHeatmapForRange:819` has the same one-day
lookback and no `OR end_at IS NULL` clause at all, unlike its siblings.

---

## LOW / hardening

- **`stopAllActuals` reports a set it may not have stopped** (`calendar.ts:595-607`) — SELECT and blanket UPDATE aren't in one transaction, so a lane started between them is stopped but absent from the returned list, leaving a stale timer in the UI.
- **Overlap invariant unenforced for closed rows** (`calendar.ts:637,706`) — the partial index only covers `end_at IS NULL`, so two overlapping *stopped* rows on one lane are possible, contradicting the invariant stated at `calendar.ts:308-311`. `Subject.entries` double-counts.
- **`Math.min(...entries.map(…))` overflows the stack** (`hours.ts:192-193`) — verified `RangeError` past ~125k rows, and the array is already `ORDER BY start_at DESC`, so both values are free: `entries.at(-1)?.startAt`.
- **Session tokens stored in plaintext** (`db.ts:52`, `auth.ts:59`) — store `sha256(token)` instead. Low impact (the `TURSO_AUTH_TOKEN` that would expose the table already grants full DB access) but it's two lines.
- **`safeCompare` leaks the secret's byte length via timing** (`auth.ts:26-45`) — padding to `max(len)` makes the work a function of the secret whenever the input is shorter, which is the opposite of what its comment claims. Fix: hash both sides to fixed width before comparing. (The `&&` short-circuit is *not* a leak — `timingSafeEqual` runs unconditionally first. Verified.)
- **Five unreachable `NextRequest`-shaped helpers** (`auth.ts`) — `getClientIp`, `isAdmin`, `requireAdmin`, `requireAdminWithMutationRate`, `checkApiMutationRate`, plus `requireAdminServer` in `auth-server.ts`, and the `api_mutation_rate` table. They make the file read as protected when nothing enforces it — which is exactly how #1 happened. Delete after #1 is wired.
- **`refreshLanes` is an exported Server Action with no caller** (`actions.ts:198`) — every export from a `"use server"` file is a publicly addressable POST endpoint. Use it for #9 or delete it.
- **Public pages over-fetch private `notes`** (`hours.ts:67`) — currently safe because `entry-list.tsx` is a Server Component, so props are never serialized to the client. But adding `"use client"` to it for a sort toggle would instantly publish every note. Drop `notes` from the public `SELECT`.
- **`db.batch(ops as never, "write")`** (`calendar.ts:530`) — defeats libsql's `InArgs` check; type as `InStatement[]`.
- **`process.env.TURSO_DATABASE_URL!`** (`db.ts:8-9`) — a missing var yields an opaque driver error at module-eval instead of a named startup failure.
- **Missing indexes** — `calendar_actuals(category_id)` and `(start_at)`. Additive only, safe for the shared schema.
- **Canonical URLs are now absent on `/` and `/s/[subject]`.** A removed `alternates: {canonical: "/"}` from `layout.tsx` because root-layout metadata is inherited shallowly and was telling search engines every subject page duplicates the homepage. **B should add per-page canonicals**: `"/"` in `page.tsx`, `` `/s/${subject}` `` in `s/[subject]/page.tsx`.

---

## Verified clean — no action needed

A checked these specifically and found nothing:

SQL injection (`ensureColumn` is allowlist-guarded *and* only ever receives
literals; everything else is parameterized) · XSS (zero
`dangerouslySetInnerHTML` anywhere) · open redirect (all five `redirect()`
targets are hardcoded literals; no `next`/`returnTo` param exists) · secrets in
git history (`.env.local` untracked, never committed, no secret ever added and
removed) · `NEXT_PUBLIC_` exposure (only a public hostname) · authorization
coverage (all five mutating actions **and** `refreshLanes` call `assertAdmin`;
`logout` is correctly ungated) · CSRF (Next 16's Origin/Host check plus
`sameSite:"strict"` is sufficient — confirmed against the bundled docs) ·
session expiry (correctly enforced on both cookie and DB row) · session fixation
(impossible by construction) · UUIDv4 entropy (122 bits, CSPRNG — fine) ·
`secure` cookie gating (correct, including on Vercel previews) ·
`checkRateLimit`'s `CASE` logic (traced through all six edge cases — no
off-by-one) · `mergeIntervals`/`unionMs` (correct on unsorted, inverted,
zero-length and non-finite input) · `computeStreak` (correct across month and
year boundaries) · dependency usage (no unused or missing packages).
