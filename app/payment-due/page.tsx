"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { formatUSD } from "@/lib/format";
import {
  hasPayoutDetails,
  type PaymentDueEntry,
  type PayoutDetails,
} from "@/lib/types";

// Owner-only working list of payouts that came due when a PO was generated.
// Newest-first. Each row shows who to pay, how to pay them (resolved live from
// the vendor master — account numbers are never stored in the Payment Due tab),
// the amount, and one click each to open the filed PO PDF and the invoice.

export default function PaymentDuePage() {
  const [entries, setEntries] = useState<PaymentDueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/payment-due");
        const data = (await res.json().catch(() => ({}))) as {
          entries?: PaymentDueEntry[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "Couldn't load the payment-due list.");
        } else {
          setEntries(Array.isArray(data.entries) ? data.entries : []);
        }
      } catch {
        if (!cancelled) setError("Network error loading the payment-due list.");
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
      <h1 className="text-2xl font-semibold text-slate-900">Payment due</h1>
      <p className="mt-1 text-sm text-slate-500">
        Payouts that came due when a PO was generated — newest first. Payout
        details are pulled live from the vendor record.
      </p>

      {loading && (
        <div className="mt-8 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4 text-slate-400" />
          Loading payment-due list…
        </div>
      )}

      {!loading && error && (
        <div className="mt-8 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          No payments due yet. Generate a PO and it will show up here.
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <ul className="mt-6 space-y-4">
          {entries.map((entry, i) => (
            <PaymentDueRow
              key={`${entry.submissionId}-${entry.dateTime}-${i}`}
              entry={entry}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function PaymentDueRow({ entry }: { entry: PaymentDueEntry }) {
  const invoiceHref = `/po/${encodeURIComponent(entry.submissionId)}`;
  const meta = [
    entry.invoiceNumber,
    entry.invoiceDate,
    entry.dateTime ? `logged ${formatDateTime(entry.dateTime)}` : "",
  ].filter(Boolean);

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900">
              {entry.vendorName || "Unknown vendor"}
            </span>
            {entry.status && <StatusBadge status={entry.status} />}
          </div>
          {meta.length > 0 && (
            <div className="mt-0.5 text-xs text-slate-500">
              {meta.join(" · ")}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-semibold text-slate-900">
            {formatUSD(entry.amount)}
          </div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            PO amount
          </div>
        </div>
      </div>

      <PayoutSummary payout={entry.payout} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {entry.poLink ? (
          <a
            href={entry.poLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 transition hover:bg-brand-50"
          >
            Open PO PDF
            <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400">
            PO link unavailable
          </span>
        )}
        <Link
          href={invoiceHref}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Open invoice
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </li>
  );
}

// The payout fields, grouped. Only filled fields render, so the card stays
// compact. Account/routing numbers are shown monospaced for readability — this
// page is behind the passcode and Landon needs the full values to pay.
const ACH_FIELDS = [
  { key: "achAccountHolder", label: "Account holder", mono: false },
  { key: "achRoutingNumber", label: "Routing number", mono: true },
  { key: "achAccountNumber", label: "Account number", mono: true },
  { key: "achAccountType", label: "Account type", mono: false },
] as const;

const WIRE_FIELDS = [
  { key: "wireBankName", label: "Bank name", mono: false },
  { key: "wireRoutingSwift", label: "Routing / SWIFT", mono: true },
  { key: "wireAccountNumber", label: "Account number", mono: true },
  { key: "wireBeneficiary", label: "Beneficiary", mono: false },
] as const;

function PayoutSummary({ payout }: { payout: PayoutDetails }) {
  const method = (payout.method || "").trim();
  const achRows = ACH_FIELDS.filter((f) => (payout[f.key] || "").trim());
  const wireRows = WIRE_FIELDS.filter((f) => (payout[f.key] || "").trim());
  const bankAddress = (payout.bankAddress || "").trim();

  if (!hasPayoutDetails(payout)) {
    return (
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
        No account details on file — add them on the invoice before paying.
        {method && (
          <span className="ml-1 text-amber-600">(Method: {method})</span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
        Payout{method ? ` · ${method}` : ""}
      </div>

      {achRows.length > 0 && (
        <PayoutGroup title="ACH" rows={achRows} payout={payout} />
      )}
      {wireRows.length > 0 && (
        <PayoutGroup title="Wire" rows={wireRows} payout={payout} />
      )}

      {bankAddress && (
        <div className="mt-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Bank address
          </dt>
          <dd className="mt-0.5 whitespace-pre-line break-words text-sm text-slate-800">
            {bankAddress}
          </dd>
        </div>
      )}
    </div>
  );
}

function PayoutGroup({
  title,
  rows,
  payout,
}: {
  title: string;
  rows: ReadonlyArray<{ key: keyof PayoutDetails; label: string; mono: boolean }>;
  payout: PayoutDetails;
}) {
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </div>
      <dl className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map((f) => (
          <div key={f.key}>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {f.label}
            </dt>
            <dd
              className={`mt-0.5 break-words text-sm text-slate-800 ${
                f.mono ? "font-mono text-xs" : ""
              }`}
            >
              {payout[f.key]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
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
