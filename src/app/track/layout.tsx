import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { SiteHeader } from "@/components/site-header";
import { LogoutButton } from "@/components/logout-button";
import { TrackNav } from "@/components/track-nav";

export const dynamic = "force-dynamic";

/**
 * `robots` is declared here so every admin route under /track inherits it.
 * Metadata *is* inherited shallowly from a layout — the thing that made a
 * layout-level `alternates.canonical` wrong — but "don't index any of this" is
 * precisely the claim that should apply to a whole subtree, and each page
 * still sets its own title.
 */
export const metadata = { robots: { index: false, follow: false } };

/**
 * The admin gate for the console, the journal and subject management.
 *
 * Every page below this **also** checks. That is not redundancy to be tidied
 * away: there is no middleware in this app, layouts and pages are separate
 * server entry points, and a layout gate has never been what stops a page's
 * data fetch from running. The journal reads private notes — it does its own
 * check, and would still be safe if this file were deleted tomorrow.
 * `isAdminServer` is `cache()`d per request, so the second check costs nothing.
 */
export default async function TrackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdminServer())) redirect("/login");

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <TrackNav />
          <LogoutButton />
        </div>
        {children}
      </main>
    </div>
  );
}
