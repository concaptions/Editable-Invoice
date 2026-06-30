"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { formatUSD } from "@/lib/format";
import type { SearchResult } from "@/lib/types";

export default function SearchPage() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const [recent, setRecent] = useState<SearchResult[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Direct "open by invoice number" lookup (exact match, e.g. LVDTS-1001).
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const searching = q.length > 0;

  // Load the 20 most recent submissions on mount for the dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/po/recent?limit=20");
        const data = (await res.json().catch(() => ({}))) as {
          results?: SearchResult[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setRecentError(data.error || "Couldn't load recent submissions.");
        } else {
          setRecent(Array.isArray(data.results) ? data.results : []);
        }
      } catch {
        if (!cancelled) setRecentError("Network error loading recent submissions.");
      } finally {
        if (!cancelled) setRecentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live search (debounced) across name / email / Telegram / contact ID.
  useEffect(() => {
    if (!q) {
      setResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/po/search?q=${encodeURIComponent(q)}`);
        const data = (await res.json().catch(() => ({}))) as {
          results?: SearchResult[];
          error?: string;
        };
        if (!res.ok) {
          setSearchError(data.error || "Search failed. Please try again.");
          setResults([]);
        } else {
          setSearchError(null);
          setResults(Array.isArray(data.results) ? data.results : []);
        }
      } catch {
        setSearchError("Network error. Please try again.");
        setResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function openInvoice(submissionId: string) {
    setOpen(false);
    router.push(`/po/${encodeURIComponent(submissionId)}`);
  }

  // Resolve an exact Invoice Number to its Submission ID, then open it. The
  // internal route key stays the Submission ID; this is just a convenience entry.
  async function openByInvoiceNumber(e: React.FormEvent) {
    e.preventDefault();
    const num = invoiceNumber.trim();
    if (!num || lookupLoading) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const res = await fetch(
        `/api/po/resolve?invoiceNumber=${encodeURIComponent(num)}`
      );
      const data = (await res.json().catch(() => ({}))) as {
        submissionId?: string;
        error?: string;
      };
      if (!res.ok || !data.submissionId) {
        setLookupError(data.error || `No submission found for ${num}.`);
        return;
      }
      router.push(`/po/${encodeURIComponent(data.submissionId)}`);
    } catch {
      setLookupError("Network error. Please try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  const loading = searching ? searchLoading : recentLoading;
  const error = searching ? searchError : recentError;
  const list = searching ? results : recent;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">Purchase Orders</h1>
      <p className="mt-1 text-sm text-slate-500">
        Pick a recent submission or search by name, email, Telegram, or vendor ID.
      </p>

      <div ref={containerRef} className="relative mt-6">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search name, email, Telegram, or vendor ID — or click to see recent"
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />

        {open && (
          <div className="absolute z-20 mt-2 max-h-[28rem] w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {searching ? "Search results" : "Recent submissions"}
            </div>

            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-slate-500">
                <Spinner className="h-4 w-4 text-slate-400" />
                {searching ? "Searching…" : "Loading recent submissions…"}
              </div>
            )}

            {!loading && error && (
              <div className="px-3 py-4 text-sm text-rose-700">{error}</div>
            )}

            {!loading && !error && list.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-slate-400">
                {searching
                  ? "No matches. Try an email, Telegram handle, or vendor ID."
                  : "No submissions yet."}
              </div>
            )}

            {!loading &&
              !error &&
              list.map((r) => (
                <SubmissionRow
                  key={r.submissionId}
                  result={r}
                  onClick={() => openInvoice(r.submissionId)}
                />
              ))}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
          or open by invoice number
        </span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <form onSubmit={openByInvoiceNumber} className="mt-4">
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={invoiceNumber}
            onChange={(e) => {
              setInvoiceNumber(e.target.value);
              if (lookupError) setLookupError(null);
            }}
            placeholder="Invoice number, e.g. LVDTS-1001"
            className="w-full max-w-xs rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          />
          <button
            type="submit"
            disabled={!invoiceNumber.trim() || lookupLoading}
            className="inline-flex shrink-0 items-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {lookupLoading && <Spinner className="h-4 w-4 text-white" />}
            Open
          </button>
        </div>
        {lookupError && (
          <p className="mt-2 text-sm text-rose-700">{lookupError}</p>
        )}
      </form>
    </main>
  );
}

function SubmissionRow({
  result,
  onClick,
}: {
  result: SearchResult;
  onClick: () => void;
}) {
  const identifiers = [result.email, result.telegram, result.contactId].filter(
    Boolean
  );
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-t border-slate-100 px-3 py-2.5 text-left transition first:border-t-0 hover:bg-slate-50"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-900">
            {result.vendorName || "Unknown vendor"}
          </span>
          <StatusBadge status={result.status} />
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {identifiers.length ? identifiers.join(" · ") : "—"}
        </div>
        <div className="mt-0.5 text-xs text-slate-400">
          {result.invoiceDate || "No date"}
          {typeof result.lineItemCount === "number" && (
            <> · {result.lineItemCount} item{result.lineItemCount === 1 ? "" : "s"}</>
          )}
        </div>
      </div>
      <div className="shrink-0 text-sm font-semibold text-slate-900">
        {formatUSD(result.total)}
      </div>
    </button>
  );
}
