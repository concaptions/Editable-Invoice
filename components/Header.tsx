"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  // No chrome on the login screen.
  if (pathname === "/login") return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the request fails, send the user to login; the cookie guard
      // will stop them reaching protected pages.
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="rounded bg-brand-600 px-2 py-0.5 text-sm font-bold tracking-tight text-white">
            LVDTS
          </span>
          <span className="text-sm font-semibold text-slate-700">PO Editor</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/payment-due"
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              pathname === "/payment-due"
                ? "bg-brand-50 text-brand-700"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            Payment due
          </Link>
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </div>
    </header>
  );
}
