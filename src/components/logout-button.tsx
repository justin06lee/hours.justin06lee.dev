"use client";

import { useTransition } from "react";
import { logout } from "@/app/actions";

export function LogoutButton() {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => start(() => void logout())}
      disabled={pending}
      className="text-sm text-white/40 underline-offset-4 hover:text-white hover:underline disabled:opacity-50"
    >
      {pending ? "signing out" : "sign out"}
    </button>
  );
}
