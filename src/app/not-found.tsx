import { NotFound } from "@/components/chrome/not-found";

/**
 * Installed as `app/not-found.tsx` — Next.js renders this for `notFound()`
 * and unmatched routes, so the 404 page works with zero extra wiring.
 */
export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white">
      <NotFound
        message="no hours here. the cat hasn't seen them either."
        links={[
          { label: "home", href: "/" },
          { label: "track", href: "/track" },
        ]}
      />
    </div>
  );
}
