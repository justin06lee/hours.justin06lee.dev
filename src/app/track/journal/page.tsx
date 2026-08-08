import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminServer } from "@/lib/auth-server";
import { getHoursOverview, getJournalPage } from "@/lib/hours";
import { listCategories } from "@/lib/calendar-categories";
import { pageToOffset } from "@/lib/calendar-validate";
import { JournalList } from "@/components/journal-list";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = { title: "journal" };

/** Entries per page. */
const PAGE_SIZE = 25;

/**
 * The reading half of the break prompt.
 *
 * Every 50 minutes the console asks what you got done and writes the answer
 * onto the entry it describes. Until this page existed nothing ever read those
 * answers back — the prompt was a chore with no payoff, and the one genuinely
 * private field on an entry was write-only. This is also the repair surface:
 * the console can only start and stop, so a lane left running overnight or a
 * subject picked wrong is fixed from here.
 */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; notes?: string }>;
}) {
  if (!(await isAdminServer())) redirect("/login");

  const params = await searchParams;
  const notedOnly = params.notes === "1";
  const offset = pageToOffset(params.page, PAGE_SIZE);

  // `listCategories`, not `overview.subjects`: the subject list is derived from
  // the entries that exist, so a category nothing has been logged against yet
  // is missing from it — and that is exactly the one the editor's dropdown has
  // to be able to offer.
  const [overview, categories, journal] = await Promise.all([
    getHoursOverview(),
    listCategories(),
    getJournalPage({ limit: PAGE_SIZE, offset, notedOnly }),
  ]);

  const pageCount = Math.max(1, Math.ceil(journal.total / PAGE_SIZE));
  // Derived back from the offset the query actually used, so a `?page=0` or a
  // `?page=banana` shows the pager sitting on the page it really served rather
  // than echoing the nonsense back.
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">journal</h1>
        <div className="flex items-center gap-4 text-xs">
          <FilterLink href="/track/journal" active={!notedOnly}>
            everything
          </FilterLink>
          <FilterLink href="/track/journal?notes=1" active={notedOnly}>
            only reflections
          </FilterLink>
        </div>
      </div>

      <p className="mb-8 max-w-xl text-[15px] leading-7 text-white/60">
        {notedOnly
          ? "the stretches you wrote something down for."
          : "every entry, newest first. edit one to fix a time, move it to another subject, or write down what it was."}
      </p>

      <JournalList
        entries={journal.entries}
        categories={categories}
        timezone={overview.timezone}
        page={page}
        pageCount={pageCount}
        total={journal.total}
        notedOnly={notedOnly}
      />
    </>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "underline-offset-4 transition-colors",
        active ? "text-white underline" : "text-white/40 hover:text-white",
      )}
    >
      {children}
    </Link>
  );
}
