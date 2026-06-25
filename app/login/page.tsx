"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "@/components/Spinner";

export default function LoginPage() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error || "Incorrect passcode");
        setLoading(false);
        return;
      }

      // Honor a same-site ?next=… redirect target, default to home.
      const search =
        typeof window !== "undefined" ? window.location.search : "";
      const next = new URLSearchParams(search).get("next");
      const dest = next && next.startsWith("/") ? next : "/";
      router.replace(dest);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="inline-block rounded bg-brand-600 px-3 py-1 text-lg font-bold tracking-tight text-white">
            LVDTS
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-900">
            Purchase Order Editor
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your passcode to continue.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label
            htmlFor="passcode"
            className="block text-sm font-medium text-slate-700"
          >
            Passcode
          </label>
          <input
            id="passcode"
            name="passcode"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            placeholder="••••••••"
          />

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || passcode.length === 0}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {loading && <Spinner />}
            {loading ? "Checking…" : "Log in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          Authorized use only.
        </p>
      </div>
    </main>
  );
}
