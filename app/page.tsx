"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { formatUSD } from "@/lib/format";
import type { SearchResult } from "@/lib/types";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/po/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: SearchResult[];
        error?: string;
      };

      if (!res.ok) {
        setError(data.error || "Search failed. Please try again.");
        setResults([]);
      } else {
        setResults(Array.isArray(data.results) ? data.results : []);
      }
    } catch {
      setError("Network error. Please try again.");
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">Purchase Orders</h1>
      <p className="mt-1 text-sm text-slate-500">
        Find a submission to review, edit, and approve.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by vendor ID or name"
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />
        <button
          type="submit"
          disabled={loading || query.trim().length === 0}
          className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          {loading && <Spinner />}
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <div className="mt-6">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner className="h-4 w-4 text-slate-400" />
            Searching…
          </div>
        )}

        {!loading && error && (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            {error}
          </div>
        )}

        {!loading && !error && searched && results.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            No results found. Try a different vendor ID or name.
          </div>
        )}

        {!loading && !error && results.length > 0 && (
          <ul className="space-y-3">
            {results.map((r) => (
              <li key={r.submissionId}>
                <ResultCard result={r} />
              </li>
            ))}
          </ul>
        )}

        {!loading && !error && !searched && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-400">
            Enter a vendor ID or name above to begin.
          </div>
        )}
      </div>
    </main>
  );
}

function ResultCard({ result }: { result: SearchResult }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-slate-900">
            {result.vendorName || "Unknown vendor"}
          </span>
          <StatusBadge status={result.status} />
        </div>
        <div className="mt-1 font-mono text-xs text-slate-400">
          {result.contactId || "—"}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {result.invoiceDate || "No date"}
          {typeof result.lineItemCount === "number" && (
            <> · {result.lineItemCount} item{result.lineItemCount === 1 ? "" : "s"}</>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <div className="text-right">
          <div className="text-lg font-semibold text-slate-900">
            {formatUSD(result.total)}
          </div>
        </div>
        <Link
          href={`/po/${encodeURIComponent(result.submissionId)}`}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          Edit
        </Link>
      </div>
    </div>
  );
}
