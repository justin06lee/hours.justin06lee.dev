"use client";

import { useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/chrome/button";
import { logout } from "@/app/actions";

export function LogoutButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="link"
      // Awaited, not fire-and-forget: the transition stays pending for as long
      // as the action is in flight, which is what actually disables the button
      // and stops a second click destroying an already-destroyed session.
      onClick={() =>
        start(async () => {
          try {
            await logout();
          } catch (error) {
            // logout() ends in redirect(), and Next signals a redirect by
            // *rejecting* the action promise — the framework's own boundary is
            // what turns that rejection into the navigation. Catching it
            // without rethrowing would strand a signed-out user on /track.
            unstable_rethrow(error);
            console.error("[auth] sign out failed", error);
          }
        })
      }
      disabled={pending}
      className="text-sm text-white/40 hover:text-white"
    >
      {pending ? "signing out" : "sign out"}
    </Button>
  );
}
