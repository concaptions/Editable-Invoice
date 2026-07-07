"use client";

import { useEffect, useState, type FormEvent } from "react";
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

// Owner tool to pre-enter payout details for existing customers, ahead of any
// PO. Lands on the 20 most-recently-updated customers from the Vendor tab
// (newest-first); an optional search reaches older ones by name / business /
// email. Opening a customer shows the SAME payout card used in the PO editor,
// pre-filled from that customer's record. Saving reuses /api/po/payout, keyed by
// the customer's GHL Contact ID — so the details round-trip back through
// seedPayout everywhere.
//
// Every customer here already exists in the Vendor tab (has a GHL contact); this
// tool never creates contacts.
export default function CustomerPayoutsPage() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"recent" | "search">("recent");
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<VendorPayoutMatch[]>([]);
  const [selected, setSelected] = useState<VendorPayoutMatch | null>(null);
  const [payout, setPayout] = useState<PayoutDetails>(emptyPayout());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm("Discard unsaved payout changes?");
  }

  // Single fetch path for both the recent list (empty q) and search (with q).
  async function fetchList(q: string): Promise<VendorPayoutMatch[]> {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/customer-payouts/search?q=${encodeURIComponent(q)}`
      );
      const data = (await res.json().catch(() => ({}))) as VendorPayoutSearchResponse;
      if (!res.ok) {
        toast("error", data.error || "Couldn't load customers.");
        setResults([]);
        return [];
      }
      const list = Array.isArray(data.results) ? data.results : [];
      setResults(list);
      return list;
    } catch {
      toast("error", "Network error while loading customers.");
      setResults([]);
      return [];
    } finally {
      setLoading(false);
    }
  }

  // Land on the recent-20 list.
  useEffect(() => {
    setMode("recent");
    void fetchList("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(e?: FormEvent) {
    e?.preventDefault();
    if (loading) return;
    if (selected && !confirmDiscardIfDirty()) return;
    const q = query.trim();
    setSelected(null);
    setMode(q ? "search" : "recent");
    const list = await fetchList(q);
    // A single clear search hit → open it straight away (recent list doesn't).
    if (q && list.length === 1) selectCustomer(list[0]);
  }

  function selectCustomer(match: VendorPayoutMatch) {
    setSelected(match);
    setPayout(match.payout);
    setDirty(false);
  }

  function backToList() {
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
    const contactId = selected.contactId;
    setSaving(true);
    try {
      const res = await fetch("/api/po/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: `payout-preload:${contactId}`,
          contactId,
          vendorId: contactId,
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
      // Reflect the saved values back into the cached rows so reopening this
      // customer (without a refetch) shows exactly what was just saved.
      setSelected((cur) => (cur ? { ...cur, payout } : cur));
      setResults((list) =>
        list.map((m) => (m.contactId === contactId ? { ...m, payout } : m))
      );
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
        Pre-enter how a customer gets paid, ahead of any PO. Pick a recent
        customer below or search by name, business, or email — fill in ACH / Wire
        details and save. It&apos;s stored on their vendor record and reused
        everywhere.
      </p>

      <form onSubmit={runSearch} className="mt-6 flex flex-wrap gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, business, or email"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-brand-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
        >
          {loading && <Spinner className="h-4 w-4 text-brand-500" />}
          {loading ? "Loading…" : "Search"}
        </button>
      </form>

      {selected ? (
        <div className="mt-6">
          <button
            type="button"
            onClick={backToList}
            className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            ← Back to list
          </button>

          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-base font-semibold text-slate-900">
              {selected.businessName || selected.name || "Unnamed customer"}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {[
                selected.businessName && selected.name ? selected.name : "",
                selected.email,
                selected.method,
                vendorStatusLabel(selected.vendorStatus),
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
            subtitle="Pre-fill how this customer gets paid. Saved straight to their vendor record and reused on every PO."
            saveLabel="Save to record"
          />
        </div>
      ) : (
        <CustomerList
          loading={loading}
          mode={mode}
          results={results}
          onSelect={selectCustomer}
        />
      )}
    </main>
  );
}

// The Vendor tab's "Vendor Status" is a boolean-ish flag ("TRUE"/blank in the
// sheet), not a descriptive status — so a raw "TRUE" pill is meaningless noise.
// Show a readable label for a truthy flag, hide FALSE/blank, and pass through a
// genuinely descriptive status verbatim. Display-only: never touches search/save.
function vendorStatusLabel(raw: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "true") return "Active";
  if (lower === "false") return null;
  return v;
}

function CustomerList({
  loading,
  mode,
  results,
  onSelect,
}: {
  loading: boolean;
  mode: "recent" | "search";
  results: VendorPayoutMatch[];
  onSelect: (m: VendorPayoutMatch) => void;
}) {
  if (loading) {
    return (
      <div className="mt-8 flex items-center gap-2 text-sm text-slate-500">
        <Spinner className="h-4 w-4 text-slate-400" />
        Loading customers…
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
        {mode === "search"
          ? "No customers matched your search."
          : "No customers in the vendor record yet."}
      </div>
    );
  }
  return (
    <div className="mt-6">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {mode === "search"
          ? `Search results (${results.length})`
          : "Recent customers"}
      </div>
      <ul className="space-y-2">
        {results.map((m) => {
          const statusLabel = vendorStatusLabel(m.vendorStatus);
          return (
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
                  {[m.businessName && m.name ? m.name : "", m.email]
                    .filter(Boolean)
                    .join(" · ") || "No email on file"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {statusLabel && (
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-500">
                    {statusLabel}
                  </span>
                )}
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
          );
        })}
      </ul>
    </div>
  );
}
