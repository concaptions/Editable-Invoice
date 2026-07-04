"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { formatUSD } from "@/lib/format";
import type { POHistoryRecord } from "@/lib/types";

// Chronological log of every PO PDF generated — newest first. Each row links to
// the filed Drive copy and offers a fresh re-download (regenerated from the
// authoritative sheet row), plus a jump back into the invoice editor.

export default function PoHistoryPage() {
  const [records, setRecords] = useState<POHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/po/history");
        const data = (await res.json().catch(() => ({}))) as {
          records?: POHistoryRecord[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "Couldn't load the PO history.");
        } else {
          setRecords(Array.isArray(data.records) ? data.records : []);
        }
      } catch {
        if (!cancelled) setError("Network error loading the PO history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">PO history</h1>
      <p className="mt-1 text-sm text-slate-500">
        Every purchase order generated — newest first. Open the filed Drive copy
        or download a fresh PDF.
      </p>

      {loading && (
        <div className="mt-8 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4 text-slate-400" />
          Loading PO history…
        </div>
      )}

      {!loading && error && (
        <div className="mt-8 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!loading && !error && records.length === 0 && (
        <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          No POs generated yet. Generate a PO and it will show up here.
        </div>
      )}

      {!loading && !error && records.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-medium">PO #</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <PoHistoryRow
                  key={`${r.submissionId}-${r.date}-${i}`}
                  record={r}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function PoHistoryRow({ record }: { record: POHistoryRecord }) {
  const downloadHref = record.submissionId
    ? `/api/po/pdf/download?submissionId=${encodeURIComponent(
        record.submissionId
      )}`
    : "";

  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
      <td className="px-4 py-3 font-medium text-slate-900">
        {record.submissionId ? (
          <Link
            href={`/po/${encodeURIComponent(record.submissionId)}`}
            className="text-brand-700 hover:underline"
          >
            {record.poNumber || "—"}
          </Link>
        ) : (
          record.poNumber || "—"
        )}
      </td>
      <td className="px-4 py-3 text-slate-700">
        {record.vendorName || "Unknown vendor"}
      </td>
      <td className="px-4 py-3 text-slate-500">{formatDateTime(record.date)}</td>
      <td className="px-4 py-3 text-right font-semibold text-slate-900">
        {formatUSD(record.amount)}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {record.driveLink ? (
            <a
              href={record.driveLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50"
            >
              Open in Drive
              <span aria-hidden="true">↗</span>
            </a>
          ) : null}
          {downloadHref ? (
            <a
              href={downloadHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Download PDF
            </a>
          ) : null}
          {!record.driveLink && !downloadHref ? (
            <span className="text-xs text-slate-400">Unavailable</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
