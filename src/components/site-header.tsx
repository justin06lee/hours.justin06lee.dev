import Link from "next/link";

/**
 * Site chrome. Deliberately not the `navbar` component: this site has two
 * links, and navbar's mobile drawer would be more machinery than content.
 *
 * `runningCount` is passed in rather than fetched here so the header can't
 * trigger a second database round trip per page.
 */
export function SiteHeader({ runningCount = 0 }: { runningCount?: number }) {
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-4">
        <Link href="/" className="text-sm tracking-tight text-white hover:opacity-70">
          hours<span className="text-white/30">.justin06lee.dev</span>
        </Link>

        <nav className="flex items-center gap-4 text-sm">
          {runningCount > 0 && (
            <span className="flex items-center gap-2 text-white/60">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-white"
              />
              <span className="tabular-nums">
                {runningCount} running
              </span>
            </span>
          )}
          <a
            href="https://justin06lee.dev/calendar"
            className="text-white/60 underline-offset-4 hover:text-white hover:underline"
          >
            calendar
          </a>
          <Link
            href="/track"
            className="text-white/60 underline-offset-4 hover:text-white hover:underline"
          >
            track
          </Link>
        </nav>
      </div>
    </header>
  );
}
