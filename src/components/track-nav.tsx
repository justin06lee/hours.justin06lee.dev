"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/track", label: "lanes" },
  { href: "/track/journal", label: "journal" },
  { href: "/track/subjects", label: "subjects" },
] as const;

/**
 * Nav for the three admin surfaces.
 *
 * Real links rather than the `segmented` component, which is a controlled
 * client control with an `onChange`: these are separate routes, so they should
 * be navigable, prefetchable and middle-clickable, and the router already knows
 * which one is current.
 *
 * `/track` is matched exactly. A `startsWith` test would light "lanes" up on
 * every page here, since every one of them is nested under it.
 */
export function TrackNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-baseline gap-5">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "font-mono text-[11px] uppercase tracking-[0.18em] transition-colors",
              active ? "text-white" : "text-white/40 hover:text-white/70",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
