"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/chrome/button";
import { EmptyState } from "@/components/chrome/empty-state";
import { SiteHeader } from "@/components/site-header";

/**
 * What a reader sees when a page throws.
 *
 * Every route here is `force-dynamic` and every one of them opens by talking to
 * Turso, so "the database is briefly unreachable" is not a hypothetical failure
 * mode — it is *the* failure mode. Without this file that produced the stock
 * Next error screen: an unstyled page, in the wrong typeface, on a white
 * background, saying "Application error: a client-side exception has occurred".
 *
 * `reset()` re-renders the segment without a full page load, which is the right
 * offer here because the overwhelmingly likely cause is transient.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on the server-side stack — Next replaces
    // the real message with a generic one in production and logs the original
    // against this id. Without it in the browser console there is no way to
    // connect a report to a server log.
    console.error("[hours] page failed to render", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl px-5 py-24">
        <EmptyState
          title="that didn't load"
          description="something went wrong reaching the log. it's usually momentary."
          action={
            <Button variant="solid" icon={RotateCcw} onClick={reset}>
              try again
            </Button>
          }
          secondaryAction={
            <Button variant="ghost" href="/">
              back to the overview
            </Button>
          }
        />
        {error.digest && (
          <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-white/20">
            {error.digest}
          </p>
        )}
      </main>
    </div>
  );
}
