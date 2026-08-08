import { Skeleton } from "@/components/chrome/skeleton";

/**
 * Shell for the admin routes. The layout — header, nav, sign out — is already
 * on screen by the time this renders, so this covers only the page body.
 */
export default function Loading() {
  return (
    <div aria-busy="true">
      <Skeleton variant="block" width={140} height={30} label="loading" />
      <div className="mt-8 flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} variant="block" width="100%" height={44} label={null} />
        ))}
      </div>
    </div>
  );
}
