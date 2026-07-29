import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { listCategories } from "@/lib/calendar-categories";
import { getRunningActuals } from "@/lib/calendar";
import { TrackConsole } from "@/components/track-console";
import { SiteHeader } from "@/components/site-header";
import { LogoutButton } from "@/components/logout-button";

export const dynamic = "force-dynamic";

export const metadata = { title: "track", robots: { index: false, follow: false } };

export default async function TrackPage() {
  if (!(await isAdminServer())) redirect("/login");

  const [categories, lanes] = await Promise.all([listCategories(), getRunningActuals()]);

  return (
    <div className="min-h-dvh">
      <SiteHeader runningCount={lanes.length} />
      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        <div className="mb-8 flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">track</h1>
          <LogoutButton />
        </div>
        <TrackConsole categories={categories} initialLanes={lanes} />
      </main>
    </div>
  );
}
