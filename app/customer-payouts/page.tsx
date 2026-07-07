"use client";

import { useState, type FormEvent } from "react";
import { Spinner } from "@/components/Spinner";
import { PaymentSection } from "@/components/PaymentSection";
import { useToast } from "@/app/providers";
import {
  emptyPayout,
  hasPayoutDetails,
  type PayoutDetails,
  type PayoutSaveResponse,
  type VendorPayoutMatch,
  type VendorPayoutSearchResponse,
} from "@/lib/types";

// Owner tool to pre-enter payout details for chosen customers, ahead of any PO.
// Search the Vendor tab (by email / Vendor ID / name), open the SAME payout card
// used in the PO editor pre-filled from that customer's record, and save. Saving
// reuses the existing /api/po/payout write path, keyed by the customer's GHL
// Contact ID — so the details round-trip back through seedPayout everywhere.
//
// Only customers already in the Vendor tab (i.e. with a GHL contact) can be
// found here; a brand-new customer has no contact id to key on yet.
export default function CustomerPayoutsPage() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<VendorPayoutMatch[]>([]);
  const [selected, setSelected] = useState<VendorPayoutMatch | null>(null);
  const [payout, setPayout] = useState<PayoutDetails>(emptyPayout());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm("Discard unsaved payout changes?");
  }

  async function runSearch(e?: FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    if (selected && !confirmDiscardIfDirty()) return;
    setSearching(true);
    setSearched(true);
    setSelected(null);
    try {
      const res = await fetch(
        `/api/customer-payouts/search?q=${encodeURIComponent(q)}`
      );
      const data = (await res.json().catch(() => ({}))) as VendorPayoutSearchResponse;
      if (!res.ok) {
        toast("error", data.error || "Search failed.");
        setResults([]);
        return;
      }
      const list = Array.isArray(data.results) ? data.results : [];
      setResults(list);
      // A single clear hit → open it straight away.
      if (list.length === 1) selectCustomer(list[0]);
    } catch {
      toast("error", "Network error while searching.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function selectCustomer(match: VendorPayoutMatch) {
    setSelected(match);
    setPayout(match.payout);
    setDirty(false);
  }

  function backToResults() {
    if (!confirmDiscardIfDirty()) return;
    setSelected(null);
    setDirty(false);
  }

  function updatePayout(patch: Partial<PayoutDetails>) {
    setPayout((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  }

  // Single write path: reuse /api/po/payout (the payout-service proxy). There's
  // no submission here, so send a clearly labeled sentinel submissionId — the
  // service persists by contactId, which is what identifies this customer.
  async function savePayout() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/po/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: `payout-preload:${selected.contactId}`,
          contactId: selected.contactId,
          vendorId: selected.contactId,
          payout,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as PayoutSaveResponse;
      if (!res.ok || !data.ok) {
        toast(
          "error",
          data.error ||
            (data.notConfigured
              ? "Payout service isn't configured yet — your entries are kept."
              : "Couldn't save payout details.")
        );
        return;
      }
      setDirty(false);
      toast("success", "Payout saved to the customer's record.");
    } catch {
      toast("error", "Network error saving payout details.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">Customer payouts</h1>
      <p className="mt-1 text-sm text-slate-500">
        Pre-enter how a customer gets paid, ahead of any PO. Find them below, fill
        in ACH / Wire details, and save — it&apos;s stored on their vendor record
        and reused everywhere.
      </p>

      <form onSubmit={runSearch} className="mt-6 flex flex-wrap gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by email, name, or Vendor ID"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-brand-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
        >
          {searching && <Spinner className="h-4 w-4 text-brand-500" />}
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {selected ? (
        <div className="mt-6">
          <button
            type="button"
            onClick={backToResults}
            className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            ← Back to results
          </button>

          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-base font-semibold text-slate-900">
              {selected.businessName || selected.name || "Unnamed customer"}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {[
                selected.businessName && selected.name ? selected.name : "",
                selected.email,
                `Vendor ID ${selected.contactId}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>

          <PaymentSection
            payout={payout}
            onChange={updatePayout}
            onSave={savePayout}
            saving={saving}
            dirty={dirty}
            subtitle="Pre-fill how this customer gets paid. Saved straight to their vendor record (keyed by Vendor ID) and reused on every PO."
            saveLabel="Save to record"
          />
        </div>
      ) : (
        <SearchResults
          searching={searching}
          searched={searched}
          results={results}
          onSelect={selectCustomer}
        />
      )}
    </main>
  );
}

function SearchResults({
  searching,
  searched,
  results,
  onSelect,
}: {
  searching: boolean;
  searched: boolean;
  results: VendorPayoutMatch[];
  onSelect: (m: VendorPayoutMatch) => void;
}) {
  if (searching) {
    return (
      <div className="mt-8 flex items-center gap-2 text-sm text-slate-500">
        <Spinner className="h-4 w-4 text-slate-400" />
        Searching customers…
      </div>
    );
  }
  if (!searched) {
    return (
      <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
        Search for a customer to begin.
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
        No customers matched. They must already exist in the vendor record (have a
        GHL contact) to pre-enter payout here.
      </div>
    );
  }
  return (
    <ul className="mt-6 space-y-2">
      {results.map((m) => (
        <li key={m.contactId}>
          <button
            type="button"
            onClick={() => onSelect(m)}
            className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:bg-brand-50/40"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">
                {m.businessName || m.name || "Unnamed customer"}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {[
                  m.businessName && m.name ? m.name : "",
                  m.email,
                  `Vendor ID ${m.contactId}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {m.method && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {m.method}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  hasPayoutDetails(m.payout)
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {hasPayoutDetails(m.payout) ? "On file" : "No details"}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
