# hours.justin06lee.dev

A personal hours-tracking site. It logs time against *subjects* (categories) and
can run up to 8 of them at once, on parallel **lanes** — working out while a
build runs, studying while socialising. Two things happening at the same time
are two rows, not a lie about one of them.

## The counting rule

The one thing to understand before reading any number on the site, from
`src/lib/hours-math.ts`:

> **Per-subject totals count overlapping time in full, but the site-wide total
> counts it once.**

An hour spent coding while a chess game runs is a real hour of *each* subject,
so neither is docked for the other. But summing those subject totals would claim
more hours than have actually elapsed, so the headline figure unions the
intervals first. Both numbers are honest; they answer different questions. The
UI labels them wherever they appear together.

That arithmetic lives in `src/lib/hours-math.ts`, deliberately free of any
database or environment coupling so the part that decides whether the numbers
are honest can be tested on its own (`src/lib/hours-math.test.ts`).
`src/lib/hours.ts` only loads rows and applies it.

The rule applies **all the way down**, not just to the headline: the per-title
breakdown on a subject page unions too, so those bars can never add up to more
than the subject total printed above them.

## Two kinds of query

`src/lib/hours.ts` is shaped by one distinction, and it is worth knowing before
adding a query to it:

- **The aggregate** (`getHoursOverview`) reads *every row*, because a union is
  exact or it is nothing — there is no way to push interval merging into SQLite
  and still answer "how many hours have actually elapsed". It reads only three
  narrow columns to do it, never the text.
- **The display queries** (`getEntryPage`, `getJournalPage`,
  `getSubjectBreakdown`) are **bounded**. Nothing rendered as a list is
  unbounded, and nothing unbounded is rendered as a list.

That costs one extra round trip per page versus a single batch, which is the
deliberate trade: one hop that streams the whole table on every view of a public
page, and grows forever, is worse than two that each stay small.

`notes` is selected by exactly one of them. It is the only private field on an
entry — the log is public, the diary attached to it is not — so `getJournalPage`
is the only query that reads it, and every caller of that sits behind the admin
gate.

## Shared database

Turso / libsql, **shared with the sibling site justin06lee.dev**. This app reads
and writes the *same* calendar tables (`calendar_actuals`, `calendar_categories`,
`calendar_tasks`), so a timer stopped here shows up there.

That is why `src/lib/` carries schema and helpers this app never calls — the
schema in `src/lib/db.ts` is the full shared one, and both sites run the same
idempotent `initDb()`. Don't prune the "unused" tables; the other site owns them.

`next.config.ts` lists the libsql packages in `serverExternalPackages` because
they ship native bindings that break at runtime if bundled. That list mirrors
justin06lee.dev's.

## Environment

Four variables, all required in production:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | `src/lib/db.ts` | libsql connection URL |
| `TURSO_AUTH_TOKEN` | `src/lib/db.ts` | libsql auth token |
| `ADMIN_KEY` | `src/lib/auth.ts` | admin password. Unset disables admin login entirely (logs a warning) |
| `NEXT_PUBLIC_SITE_URL` | `src/app/layout.tsx` | metadata base for canonical/OG URLs. Falls back to `https://hours.justin06lee.dev` |

Put them in `.env.local`. `.gitignore` covers `.env*` but negates
`.env.example`, so a committed template of the *names* is possible.

## Routes

| Route | Access | Notes |
| --- | --- | --- |
| `/` | public | Overview — total hours, streak, per-subject bars, heatmap, recent entries |
| `/s/[subject]` | public | One subject: its own total, streak, heatmap and entries |
| `/track` | admin | The timer console — start/stop lanes, pick subjects |
| `/track/journal` | admin | Every entry **with its notes**; edit and delete |
| `/track/subjects` | admin | Add, rename, recolor, archive and delete subjects |
| `/login` | admin | Same password as justin06lee.dev; this subdomain keeps its own session. `noindex` |

Admin is a session cookie checked server-side. `/track/layout.tsx` gates the
whole subtree and declares `noindex` for it, **and every page under it checks
again** — there is no middleware in this app, layouts and pages are separate
server entry points, and a layout gate has never been what stops a page's data
fetch from running. `isAdminServer` is `cache()`d per request, so the second
check costs nothing. `/login` redirects to `/track` when a session is present.

Every view is `force-dynamic` — the whole point is the number moving while a
timer runs.

Both heatmaps take `?year=`, offering only years that actually have data and
defaulting to the newest of them — so on Jan 2nd the page opens on last year's
grid rather than on twelve empty months. The shading ceiling is computed across
*all* years and passed in explicitly, so switching years doesn't renormalize the
colours and a quiet year renders quiet.

The console reconciles with the database every 30 seconds while its tab is
visible, and immediately on the way back to it. That matters because the
database is shared: a lane started on justin06lee.dev, on a phone, or in another
tab was previously invisible here until a manual reload, and the console would
offer a "start" button for a lane something else already held. A poll whose
answer is older than a mutation the client has since made is discarded rather
than applied — see the revision note in `use-lane-sync.ts`.

### The journal

The console can only start and stop. `/track/journal` is the other half:

- it is the **only** place the `notes` written by the break prompt are read
  back. Before it existed, "what did you get done?" was asked every 50 minutes
  and never answered to anyone;
- it is the **repair** surface — a lane left running overnight, a subject
  picked wrong, a start that needs moving. `?notes=1` filters to the entries
  that actually carry a reflection.

Edits go through `updateActual`, which writes only the columns a patch names, so
saving a note cannot move a clock it never mentioned. An entry's end can be set
but never cleared: clearing it would reopen a finished entry, and no reading of
"edit this entry" means "start it running again".

### Archiving vs deleting a subject

`/track/subjects` writes to `calendar_categories`, which **the sibling site
shares**, so it leans on that table's existing constraints rather than inventing
rules: `UNIQUE(LOWER(name))`, the `is_system` lock on the seeded Sleep row, and
the in-use check before a delete.

**Archiving is the normal way to retire a subject** — the hours already filed
under it stay where they are and keep counting, it just stops being offered when
you start a lane. Deleting is only for a subject that was a mistake, and is
refused once anything points at it. That refusal matters more than it looks: the
FK is declared `ON DELETE SET NULL`, but libsql does not enable
`PRAGMA foreign_keys`, so a delete would not blank the references — it would
strand them, and every hour filed under that subject would silently become
uncategorized. The UI only offers delete where it can actually succeed.

## When it breaks

Every route is `force-dynamic` and opens by talking to Turso, so "the database
is briefly unreachable" is not a hypothetical failure mode — it is *the* failure
mode. Three files cover it:

| File | Catches |
| --- | --- |
| `app/loading.tsx`, `app/track/loading.tsx` | Nothing — they're the streamed shell, so the page has shape before the query returns |
| `app/error.tsx` | A page throwing. Offers `reset()`, and prints the digest so a report can be matched to a server log |
| `app/global-error.tsx` | The **root layout** throwing — where a missing `TURSO_DATABASE_URL` surfaces, since `lib/db.ts` calls `requireEnv` at module evaluation. Inline styles, because the layout that would have loaded the stylesheet is the thing that broke |

The two interact in a way worth knowing: because `loading.tsx` puts the route in
a Suspense boundary, the shell flushes immediately and a later failure is
streamed to the client as a boundary error (React's `$RX`), which renders
`error.tsx` in place. Without the loading file the same failure produces a bare
500 document instead. The loading states are load-bearing for the error
experience, not just decoration.

## Discovery

`app/robots.ts` and `app/sitemap.ts`. The sitemap lists the homepage plus every
non-archived subject with time logged, keyed off `lastAt` for `lastmod`, and is
regenerated hourly rather than per request — it is read by crawlers, and the
aggregate behind it reads every row. **It degrades rather than fails**: the
build prerenders this route, so an unreachable database would otherwise break a
deploy over a file crawlers read once an hour; it falls back to the homepage
alone and logs why.

The admin routes carry `noindex` in their own metadata *and* appear in
`Disallow` — the meta tag is what actually keeps them out of an index, the
disallow saves crawl budget.

`app/opengraph-image.tsx` is the share card. `layout.tsx` had declared an
`openGraph` block from the beginning with no image in it, so every share
rendered as a title beside a blank rectangle. Static and database-free on
purpose: a live total would cost a full-table aggregate every time any crawler
re-fetched it, for a number nobody reads off a thumbnail.

## Scripts

| Script | Does |
| --- | --- |
| `dev` | Next dev server (runs `predev` first) |
| `build` | Production build (runs `prebuild` first) |
| `start` | Serve the production build |
| `lint` | ESLint |
| `test` | Vitest, once |
| `typecheck` | `tsc --noEmit` |
| `icons` | Rebuild the raster icons from the committed SVG |
| `icons:draw` | Redraw `src/app/icon.svg` with python, then rebuild the rasters |

### The icon step (the non-obvious part)

`predev` and `prebuild` both run `node scripts/build-icons.mjs`. That script
derives `src/app/favicon.ico` and `src/app/apple-icon.png` from
`src/app/icon.svg`.

**The SVG is the only icon committed.** The two raster files are gitignored,
because a checked-in binary beside the drawing that produced it is a copy
waiting to go stale — which it already did once here, when `generate.py` changed
and the PNG was not re-exported. A derived file that cannot be committed cannot
drift. Wiring it to `predev`/`prebuild` means the outputs exist whenever the app
is run or built, fresh clone included.

Those two stay raster because they cannot be anything else: `/favicon.ico` is the
ICO container by definition, and Apple touch icons have only ever accepted PNG.
The icon browsers actually load is the SVG, and it stays vector.

`icons:draw` is the design-time step and the only one needing python
(`design/favicon/generate.py` draws the ascii-shaded hourglass mark and writes
the SVG). A deploy never depends on it. `sharp` and `png-to-ico` are runtime
`dependencies`, not devDependencies, precisely because `prebuild` needs them —
a production-only install would otherwise crash before Next ever starts.

## Fonts

Two, both **self-hosted and version-pinned as npm packages**, and neither
fetched from anyone else's server at build time or at run time:

| Family | Package | Used for |
| --- | --- | --- |
| Geist Mono | `geist` | Section kickers, figures, anything on the glyph grid |
| Poppins 400/500/600 | `@fontsource/poppins` | Body copy — `--font-sans` |

The rule is the same for both, and it is the reason neither uses
`next/font/google`: an upstream metrics change at an unpinned source ships
silently to every visitor, and a mono glyph grid or a headline figure shifting
underfoot is not something you find out about from a build log.

Poppins previously came from `cdn.jsdelivr.net/…/poppins@latest`, written into
the `@chrome:theme` block by `chrome init` — the same unpinned hazard, plus a
third-party request on every cold visit. It also declared **weight 400 only**
while the app renders `font-semibold` in eight places (the homepage headline
among them) and `font-medium` in one, so those were browser-synthesised fake
bolds rather than the real cuts. All three weights are now bundled; latin
subsets only, since nothing here sets devanagari.

**If `chrome init` is ever re-run** it will restore that CDN `@font-face` into
the fenced block in `globals.css`. Delete it again.

## Security headers

`next.config.ts` sets them for all routes; there is no proxy or middleware, so
that is the only place they come from. `X-Frame-Options: DENY` plus CSP
`frame-ancestors 'none'` are the load-bearing pair: `/track` renders "sign out"
and lane-stop controls, so an invisible frame could steer a click. The session
cookie's `sameSite: "strict"` does not prevent framing. HSTS is set explicitly
because Vercel redirects HTTP to HTTPS but does not send the header on its own.

There is deliberately **no** `script-src` CSP — that needs per-deployment nonce
work and would risk breaking the app.
