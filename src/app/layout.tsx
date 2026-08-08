import type { Metadata } from "next";
// Self-hosted and version-pinned via the `geist` package rather than
// next/font/google, matching justin06lee.dev: Google refetches at build time,
// so an upstream metrics change would silently shift the mono glyph grid.
import { GeistMono } from "geist/font/mono";
// Poppins, self-hosted and version-pinned for the same reason Geist is, and
// replacing a `@latest` CDN URL that `chrome init` had written into
// globals.css. The latin subsets only — Poppins also ships devanagari, which
// nothing here sets.
//
// Three weights, not one. The CDN declaration covered 400 alone while the app
// renders `font-semibold` in eight places (the homepage headline among them)
// and `font-medium` in one, so those were being synthesised by the browser
// from the regular cut instead of using the real ones.
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "./globals.css";
import { SITE_URL } from "@/lib/site-url";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "hours",
    template: "%s | hours",
  },
  description: "hours poured into everything, logged honestly",
  applicationName: "hours.justin06lee.dev",
  authors: [{ name: "justin06lee" }],
  creator: "justin06lee",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: "hours.justin06lee.dev",
    title: "hours",
    description: "hours poured into everything, logged honestly",
  },
  // Without this a card renders as a small thumbnail beside the text. The
  // image itself comes from `opengraph-image.tsx` via the file convention —
  // Next fills in both `og:image` and `twitter:image` from it.
  twitter: {
    card: "summary_large_image",
    title: "hours",
    description: "hours poured into everything, logged honestly",
  },
  robots: { index: true, follow: true },
};

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="bg-black">
      <body
        className={`${GeistMono.variable} min-h-dvh bg-black text-white antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
