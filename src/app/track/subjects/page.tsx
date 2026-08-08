import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { listCategories } from "@/lib/calendar-categories";
import { getHoursOverview } from "@/lib/hours";
import { SubjectManager, type SubjectStat } from "@/components/subject-manager";

export const dynamic = "force-dynamic";

export const metadata = { title: "subjects" };

/**
 * Subject (category) management.
 *
 * Categories are the buckets every hour on the site is filed under, and this
 * app could previously only read them — adding, renaming, recoloring or
 * retiring one meant going to justin06lee.dev, which shares the table.
 *
 * The list comes from `listCategories` rather than from the overview, because
 * the overview only knows about categories that have entries: a subject you
 * created and haven't used yet has to appear here, and a subject you archived
 * has to stay visible to be un-archived.
 */
export default async function SubjectsPage() {
  if (!(await isAdminServer())) redirect("/login");

  const [categories, overview] = await Promise.all([listCategories(), getHoursOverview()]);

  // The overview already unions per subject; reuse it rather than counting
  // again. Subjects with nothing logged are simply absent, which the row
  // renders as "nothing logged".
  const stats: Record<string, SubjectStat> = {};
  for (const s of overview.subjects) {
    if (s.id !== null) stats[s.id] = { ms: s.ms, entries: s.entries };
  }

  return (
    <>
      <h1 className="mb-3 text-2xl font-semibold tracking-tight">subjects</h1>
      <p className="mb-8 max-w-xl text-[15px] leading-7 text-white/60">
        the buckets hours get filed under. archiving keeps everything already
        logged and stops the subject being offered when you start a lane —
        that&apos;s the normal way to retire one. deleting is only for a subject
        nothing points at.
      </p>

      <SubjectManager categories={categories} stats={stats} />
    </>
  );
}
