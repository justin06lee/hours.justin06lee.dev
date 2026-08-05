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
| `/track` | admin | The timer console — start/stop lanes, pick subjects. `noindex` |
| `/login` | admin | Same password as justin06lee.dev; this subdomain keeps its own session. `noindex` |

Admin is a session cookie checked server-side; `/track` redirects to `/login`
when absent, and `/login` redirects to `/track` when present. Every view is
`force-dynamic` — the whole point is the number moving while a timer runs.

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

Geist **Mono** only, self-hosted and version-pinned via the `geist` package —
**not** `next/font/google`. Google refetches at build time, so an upstream
metrics change would silently shift the mono glyph grid. Same choice as
justin06lee.dev. See the comment at `src/app/layout.tsx:2-5`.

## Security headers

`next.config.ts` sets them for all routes; there is no proxy or middleware, so
that is the only place they come from. `X-Frame-Options: DENY` plus CSP
`frame-ancestors 'none'` are the load-bearing pair: `/track` renders "sign out"
and lane-stop controls, so an invisible frame could steer a click. The session
cookie's `sameSite: "strict"` does not prevent framing. HSTS is set explicitly
because Vercel redirects HTTP to HTTPS but does not send the header on its own.

There is deliberately **no** `script-src` CSP — that needs per-deployment nonce
work and would risk breaking the app.
