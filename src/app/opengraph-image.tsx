import { ImageResponse } from "next/og";

/**
 * The card social platforms and chat clients show when the site is linked.
 *
 * `layout.tsx` has declared an `openGraph` block since the beginning with no
 * image in it, which means every share rendered as a bare title and a blank
 * rectangle. This is a file-convention route: Next picks it up automatically
 * and injects `og:image` (and, with `summary_large_image` set below in the root
 * metadata, `twitter:image`) into every page's head.
 *
 * Deliberately **static and database-free**. A dynamic card showing the live
 * total would be a nice touch that costs a full-table aggregate every time any
 * crawler re-fetches it, for a number nobody reads off a thumbnail. This is
 * rendered once at build.
 *
 * The typeface is the runtime default rather than Poppins: loading a custom
 * font here means shipping a woff next to this route or reading one out of
 * node_modules at render time, and neither is worth a build-time dependency
 * for one image. The layout and palette carry the identity.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "hours.justin06lee.dev — hours poured into everything, logged honestly";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          padding: 80,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.4)",
          }}
        >
          hours poured in
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 150,
              fontWeight: 600,
              color: "#ffffff",
              letterSpacing: -4,
              lineHeight: 1,
            }}
          >
            hours
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 34,
              color: "rgba(255,255,255,0.6)",
              lineHeight: 1.4,
            }}
          >
            every hour logged across everything. counted once, even when two of
            them happened at the same time.
          </div>
        </div>

        {/* The hairline + wordmark, the site's own footer rhythm. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", height: 1, background: "rgba(255,255,255,0.15)" }} />
          <div
            style={{
              display: "flex",
              marginTop: 24,
              fontSize: 26,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            hours.justin06lee.dev
          </div>
        </div>
      </div>
    ),
    size,
  );
}
