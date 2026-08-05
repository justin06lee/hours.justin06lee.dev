"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import * as motion from "motion/react-client";
import { cn } from "@/lib/utils";
import { Ascii } from "@/components/chrome/ascii";
import { CAT_ASCII } from "./cat-ascii";

/** The cat never changes on its own, so there is nothing to subscribe to. */
const noop = () => () => {};

export interface NotFoundLink {
  label: string;
  href: string;
}

export interface NotFoundProps {
  /** Big mono headline. Default "404". */
  title?: string;
  /** Muted line under the headline. */
  message?: string;
  /** Footer links (plain anchors, framework-agnostic). */
  links?: NotFoundLink[];
  /** Override the random pick with a fixed cat (0-9) — e.g. for visual tests. */
  cat?: number;
  /** Show the subtle "made by justin06lee.dev" line at the bottom. Default true. */
  credit?: boolean;
  className?: string;
}

/**
 * The justin06lee.dev 404 block: one of ten random ascii cats fades in above a
 * big mono headline, a muted excuse, and footer links. The cat is picked on
 * mount (SSR-safe) and rendered through the `ascii` component. Page chrome
 * (navbar, min-h-screen) is the caller's.
 */
export function NotFound({
  title = "404",
  message = "this page wandered off. the cat hasn't seen it either.",
  links = [{ label: "home", href: "/" }],
  cat,
  credit = true,
  className,
}: NotFoundProps) {
  // The cat has to be chosen on the client — Math.random() on the server would
  // pick a different one and blow up hydration — but it is not state that ever
  // changes, so it is read as an external store rather than pushed in from an
  // effect. The server snapshot is null (blank slot), the client snapshot is a
  // number cached per instance, so React never sees it move and there is no
  // second render. Remounting with a fresh key still deals a new cat, which is
  // what the demo's "another cat" button relies on.
  const seed = useRef<number | null>(null);
  const random = useSyncExternalStore(
    noop,
    useCallback(() => (seed.current ??= Math.floor(Math.random() * CAT_ASCII.length)), []),
    () => null,
  );
  const index = cat != null ? cat % CAT_ASCII.length : random;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-8 px-6 text-center",
        className,
      )}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: index == null ? 0 : 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <Ascii size={12} className="text-[10px] sm:text-xs md:text-sm">
          {index == null ? " " : (CAT_ASCII[index] ?? " ")}
        </Ascii>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.3 }}
        className="font-mono text-5xl tracking-tight sm:text-6xl"
      >
        {title}
      </motion.div>

      {message ? (
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="max-w-md text-sm text-white/60"
        >
          {message}
        </motion.p>
      ) : null}

      {links.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7 }}
          className="flex gap-6 text-sm"
        >
          {links.map((link) => (
            <a
              key={`${link.label}:${link.href}`}
              href={link.href}
              className="px-4 py-2 underline-offset-4 hover:underline"
            >
              {link.label}
            </a>
          ))}
        </motion.div>
      ) : null}

      {credit ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1 }}
          className="mt-10"
        >
          <a
            href="https://justin06lee.dev"
            className="font-mono text-[11px] text-white/30 transition-colors hover:text-white/60"
          >
            made by justin06lee.dev
          </a>
        </motion.div>
      ) : null}
    </div>
  );
}
