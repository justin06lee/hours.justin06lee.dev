import { Skeleton } from "@/components/chrome/skeleton";
import { SiteHeader } from "@/components/site-header";

/**
 * Streamed shell for the overview while its queries run.
 *
 * Every page here is `force-dynamic` and opens with a round trip to Turso, so
 * there was previously nothing on screen at all until that returned — the
 * browser sat on the previous page with no indication a navigation had even
 * started. Adding this file puts the route in a Suspense boundary, so the
 * header and the page's shape arrive immediately and the numbers fill in.
 *
 * The proportions deliberately match `page.tsx`: a skeleton that reserves the
 * wrong amount of space is a layout shift with extra steps.
 */
export default function Loading() {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl px-5 pb-24" aria-busy="true">
        <section className="border-b border-white/10 py-12">
          <Skeleton variant="block" width={110} height={12} label="loading the overview" />
          <div className="mt-4">
            <Skeleton variant="block" width={260} height={64} label={null} />
          </div>
          <div className="mt-5 max-w-xl">
            <Skeleton variant="text" lines={2} label={null} />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-px border-b border-white/10 bg-white/10 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-3 bg-[#0a0a0a] p-4">
              <Skeleton variant="block" width={72} height={10} label={null} />
              <Skeleton variant="block" width={96} height={32} label={null} />
              <Skeleton variant="block" width="100%" height={10} label={null} />
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3 border-b border-white/10 py-10">
          <Skeleton variant="block" width={80} height={10} label={null} />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} variant="block" width="100%" height={22} label={null} />
          ))}
        </section>
      </main>
    </div>
  );
}
