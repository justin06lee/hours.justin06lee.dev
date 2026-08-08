import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { listCategories } from "@/lib/calendar-categories";
import { getRunningActuals } from "@/lib/calendar";
import { TrackConsole } from "@/components/track-console";

export const dynamic = "force-dynamic";

export const metadata = { title: "track" };

export default async function TrackPage() {
  // Also checked by the layout. Kept because a page is its own server entry
  // point and this is what gates the query below — see the note in layout.tsx.
  if (!(await isAdminServer())) redirect("/login");

  const [categories, lanes] = await Promise.all([listCategories(), getRunningActuals()]);

  return (
    <>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">lanes</h1>
      <TrackConsole categories={categories} initialLanes={lanes} />
    </>
  );
}
