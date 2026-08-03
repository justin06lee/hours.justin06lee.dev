"use client";

import { useTransition } from "react";
import { Button } from "@/components/chrome/button";
import { logout } from "@/app/actions";

export function LogoutButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="link"
      onClick={() => start(() => void logout())}
      disabled={pending}
      className="text-sm text-white/40 hover:text-white"
    >
      {pending ? "signing out" : "sign out"}
    </Button>
  );
}
