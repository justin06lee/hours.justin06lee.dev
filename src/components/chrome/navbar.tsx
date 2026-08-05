"use client";

import { useEffect, useId, useRef } from "react";
import * as motion from "motion/react-client";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavbar } from "@/hooks/use-navbar";

export type NavLink = {
  /** Plain text or any node (e.g. a styled span). */
  label: React.ReactNode;
  /** Renders a plain <a href>. Omit it (with onClick) to render a <button> instead. */
  href?: string;
  /** Runs on click. Without href the item is a <button>; with href it runs alongside navigation. */
  onClick?: () => void;
  /** Stable React key. Recommended when labels are nodes or hrefs repeat (e.g. "#"). */
  id?: string;
};

export type NavbarProps = {
  /** Left-side brand — your logo, name, or any node. */
  brand?: React.ReactNode;
  /** Items next to the brand on desktop; listed before `links` in the mobile panel. */
  leftLinks?: NavLink[];
  /** Right-side items on desktop; listed after `leftLinks` in the mobile panel. */
  links?: NavLink[];
  /** Right-side extras shown on desktop (e.g. a theme toggle). */
  actions?: React.ReactNode;
  className?: string;
  /** Heading shown at the top of the mobile panel. Defaults to "menu". */
  menuLabel?: string;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Labels can be ReactNodes and placeholder hrefs (e.g. "#") can repeat, so keys
// always fold in the index — `id` exists for callers who want stability across reorders.
function navItemKey(link: NavLink, index: number) {
  return link.id ?? `${link.href ?? "button"}-${index}`;
}

function NavItem({
  link,
  className,
  onNavigate,
}: {
  link: NavLink;
  className?: string;
  onNavigate?: () => void;
}) {
  const handleClick = () => {
    link.onClick?.();
    onNavigate?.();
  };

  if (link.href === undefined) {
    return (
      <button type="button" onClick={handleClick} className={className}>
        {link.label}
      </button>
    );
  }
  return (
    <a href={link.href} onClick={handleClick} className={className}>
      {link.label}
    </a>
  );
}

/**
 * Fixed top navigation. Desktop shows a left cluster (brand + leftLinks) and a
 * right cluster (links + actions); below `md` it collapses to a hamburger whose
 * slide-in panel lists the union of leftLinks and links. Routes are caller-supplied —
 * plain <a href> (or a <button> when an item has onClick and no href), framework-
 * agnostic. Behavior lives in the headless useNavbar hook.
 */
export function Navbar({
  brand,
  leftLinks = [],
  links = [],
  actions,
  className,
  menuLabel = "menu",
}: NavbarProps) {
  const { open, setOpen, panelRef } = useNavbar();
  // Element focused before the panel opened, restored on close.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const reduceMotion = useReducedMotion();

  const linkClass =
    "text-sm text-white underline-offset-4 hover:underline whitespace-nowrap";

  // Capture focus on open, hand it back on close — same shape as BreakOverlay,
  // which is the other modal surface in this library.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (focusables && focusables.length > 0 ? focusables[0] : panel)?.focus();
    return () => {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [open, panelRef]);

  // Tab focus trap. Escape and outside-click close are already wired by the hook.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last?.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, panelRef]);

  return (
    <nav className={cn("fixed inset-x-0 top-0 z-40 w-full", className)}>
      <div className="flex items-center gap-6 px-4 py-2 sm:px-6">
        {(brand || leftLinks.length > 0) && (
          <div className="mr-auto flex items-center gap-6">
            {brand}
            {leftLinks.length > 0 && (
              <div className="hidden items-center gap-6 md:flex">
                {leftLinks.map((l, i) => (
                  <NavItem key={navItemKey(l, i)} link={l} className={linkClass} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="ml-auto hidden items-center gap-1 md:flex">
          {links.map((l, i) => (
            <NavItem key={navItemKey(l, i)} link={l} className={cn(linkClass, "px-4 py-2")} />
          ))}
          {actions}
        </div>

        <div className="ml-auto md:hidden">
          {/* Stays mounted while open (hidden, not unmounted) so the close
              handler has a live element to hand focus back to. `invisible`
              also takes it out of the tab order and the a11y tree, so it can't
              be reached behind the panel. */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="open navigation menu"
            className={cn(
              "inline-flex size-9 items-center justify-center transition-colors hover:bg-white/10",
              open && "invisible",
            )}
          >
            <Menu className="size-5" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="fixed inset-0 z-50 bg-black/50"
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              transition={{
                type: "tween",
                duration: reduceMotion ? 0 : 0.3,
                ease: "easeInOut",
              }}
              className="fixed inset-y-0 right-0 z-[80] flex w-72 flex-col gap-4 border-l border-white/10 bg-black sm:w-80"
            >
              <div className="flex items-center justify-between p-4">
                <span id={titleId} className="font-semibold text-white">
                  {menuLabel}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="close navigation menu"
                  className="opacity-70 transition-opacity hover:opacity-100"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex flex-col items-start gap-2 px-4">
                {/* Union of both clusters — left first, indexed continuously for key safety. */}
                {[...leftLinks, ...links].map((l, i) => (
                  <NavItem
                    key={navItemKey(l, i)}
                    link={l}
                    className={cn(linkClass, "py-1")}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </nav>
  );
}
