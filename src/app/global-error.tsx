"use client";

import { useEffect } from "react";

/**
 * The boundary for a failure in the root layout itself.
 *
 * `error.tsx` renders *inside* the layout, so it cannot catch the layout
 * throwing — and the root layout is exactly where a missing `TURSO_DATABASE_URL`
 * surfaces, because `lib/db.ts` calls `requireEnv` at module evaluation. A
 * misconfigured deploy therefore fails here and nowhere else.
 *
 * This file replaces `<html>` and `<body>` wholesale, which is why the styling
 * is inline: the layout that would have loaded globals.css is the thing that
 * broke, so there is no stylesheet to rely on and a class name here would
 * render as unstyled black-on-white.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[hours] root layout failed", error.digest ?? "", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#fff",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          padding: "1.25rem",
        }}
      >
        <div style={{ maxWidth: "32rem", textAlign: "center" }}>
          <p
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              color: "rgba(255,255,255,0.4)",
              margin: 0,
            }}
          >
            hours.justin06lee.dev
          </p>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0.75rem 0 0" }}>
            the site failed to start
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.75,
              color: "rgba(255,255,255,0.6)",
              margin: "1rem 0 0",
            }}
          >
            this one isn&apos;t a page that broke — it&apos;s the whole app. usually a
            missing environment variable on the deploy.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1rem",
              fontSize: 14,
              color: "#000",
              background: "#fff",
              border: "none",
              cursor: "pointer",
            }}
          >
            try again
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: "1.5rem",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "rgba(255,255,255,0.2)",
              }}
            >
              {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
