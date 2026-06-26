"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/app/providers";
import { formatUSD, round2, toNum } from "@/lib/format";
import {
  CONDITIONS,
  CONDITION_HELP,
  type CatalogItem,
  type CatalogPrices,
  type Condition,
  type InvoiceDetail,
  type LineItem,
  type SaveResponse,
} from "@/lib/types";

// Editable row keeps quantity/rate as raw strings so the inputs allow free
// typing (clearing, decimals); they're converted to numbers on save.
interface EditableLineItem {
  id: string;
  drug: string;
  strength: string;
  expiry: string;
  condition: Condition;
  quantity: string;
  rate: string;
  ndc?: string;
  catalogId?: string;
  category?: string;
  // Per-condition catalog prices, so changing condition re-fills the rate.
  prices?: CatalogPrices;
}

let rowSeq = 0;
function newRowId(): string {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
}

function normalizeCondition(value: unknown): Condition {
  const upper = String(value ?? "").toUpperCase();
  return (CONDITIONS as readonly string[]).includes(upper)
    ? (upper as Condition)
    : "MINT";
}

function toEditable(items: LineItem[]): EditableLineItem[] {
  return items.map((it) => ({
    id: newRowId(),
    drug: it.drug ?? "",
    strength: it.strength ?? "",
    expiry: it.expiry ?? "",
    condition: normalizeCondition(it.condition),
    quantity: it.quantity != null ? String(it.quantity) : "",
    rate: it.rate != null ? String(it.rate) : "",
    ndc: it.ndc || undefined,
    catalogId: it.catalogId || undefined,
    category: it.category || undefined,
    prices: it.prices || undefined,
  }));
}

function blankRow(): EditableLineItem {
  return {
    id: newRowId(),
    drug: "",
    strength: "",
    expiry: "",
    condition: "MINT",
    quantity: "1",
    rate: "",
  };
}

function lineAmount(item: EditableLineItem): number {
  return round2(toNum(item.quantity) * toNum(item.rate));
}

export function PoEditor({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const toast = useToast();

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Editable state
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [items, setItems] = useState<EditableLineItem[]>([]);

  const [status, setStatus] = useState("");

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Catalog is lifted here (rather than living inside CatalogPicker) so a
  // condition change can re-price any catalog-linked row live — including rows
  // loaded from the sheet that have no saved price snapshot.
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Load the invoice on mount / when the id changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/po/get?submissionId=${encodeURIComponent(submissionId)}`
        );
        const data = (await res.json().catch(() => ({}))) as
          | (InvoiceDetail & { error?: string })
          | { error?: string };

        if (cancelled) return;
        if (!res.ok) {
          setLoadError(
            (data as { error?: string }).error ||
              "Failed to load this invoice."
          );
          return;
        }

        const d = data as InvoiceDetail;
        setDetail(d);
        setInvoiceNumber(d.invoiceNumber ?? "");
        setInvoiceDate(d.invoiceDate ?? "");
        setItems(toEditable(Array.isArray(d.lineItems) ? d.lineItems : []));
        setStatus(d.status ?? "");
        setDirty(false);
      } catch {
        if (!cancelled) setLoadError("Network error while loading.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  const total = useMemo(
    () => round2(items.reduce((sum, it) => sum + lineAmount(it), 0)),
    [items]
  );

  // Warn on tab close / refresh when there are unsaved edits.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const markDirty = useCallback(() => setDirty(true), []);

  // Guards the eager mount-load and any focus-triggered retry: one fetch at a
  // time and no refetch once loaded. Crucially it prevents an auto-retry loop —
  // a stable callback (empty deps) plus this ref keep the mount effect from
  // re-firing every time `catalogLoading` toggles. A failed load resets the ref
  // so the user can retry by focusing the catalog box (or reloading).
  const catalogRequested = useRef(false);
  const loadCatalog = useCallback(async () => {
    if (catalogRequested.current) return;
    catalogRequested.current = true;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch("/api/catalog");
      const data = (await res.json().catch(() => ({}))) as {
        items?: CatalogItem[];
        error?: string;
      };
      if (!res.ok) {
        setCatalogError(data.error || "Failed to load catalog.");
        catalogRequested.current = false;
        return;
      }
      setCatalog(Array.isArray(data.items) ? data.items : []);
    } catch {
      setCatalogError("Network error while loading the catalog.");
      catalogRequested.current = false;
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // Eager-load the catalog so a condition change re-prices immediately, even
  // before the catalog picker has been opened. Runs once (loadCatalog is stable).
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const c of catalog ?? []) if (c.catalogId) m.set(c.catalogId, c);
    return m;
  }, [catalog]);

  function updateItem(id: string, patch: Partial<EditableLineItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    markDirty();
  }
  // Changing condition re-fills the rate from the catalog price for that
  // condition (blank when the catalog has no price for it). Prefers the item's
  // saved price snapshot, falling back to a live catalog lookup by catalogId so
  // rows loaded from the sheet re-price too. Hand-entered rows (no snapshot, no
  // catalogId) keep their rate. The looked-up snapshot is stored on the row so
  // later condition flips stay instant and the prices persist on save.
  function changeCondition(id: string, condition: Condition) {
    setItems((cur) =>
      cur.map((it) => {
        if (it.id !== id) return it;
        const prices =
          it.prices ??
          (it.catalogId ? catalogById.get(it.catalogId)?.prices : undefined);
        if (!prices) return { ...it, condition };
        const price = prices[condition];
        return {
          ...it,
          condition,
          rate: price == null ? "" : String(price),
          prices,
        };
      })
    );
    markDirty();
  }
  function removeItem(id: string) {
    setItems((cur) => cur.filter((it) => it.id !== id));
    markDirty();
  }
  function addItem() {
    setItems((cur) => [...cur, blankRow()]);
    markDirty();
  }

  function addFromCatalog(cat: CatalogItem, condition: Condition) {
    const price = cat.prices[condition];
    setItems((cur) => [
      ...cur,
      {
        id: newRowId(),
        drug: cat.drug,
        strength: cat.strength,
        expiry: "",
        condition,
        quantity: "1",
        rate: price == null ? "" : String(price),
        ndc: cat.ndc || undefined,
        catalogId: cat.catalogId || undefined,
        category: cat.category || undefined,
        prices: cat.prices,
      },
    ]);
    markDirty();
  }

  function setMeta(setter: (v: string) => void, value: string) {
    setter(value);
    markDirty();
  }

  function goBack() {
    if (
      dirty &&
      !window.confirm("You have unsaved changes. Leave without saving?")
    ) {
      return;
    }
    router.push("/");
  }

  async function save() {
    setSaving(true);
    try {
      const lineItems: LineItem[] = items.map((it) => {
        const drug = it.drug.trim();
        const strength = it.strength.trim();
        const quantity = toNum(it.quantity);
        const rate = toNum(it.rate);
        const li: LineItem = {
          item: `${drug} ${strength}`.trim(),
          drug,
          strength,
          expiry: it.expiry.trim(),
          condition: it.condition,
          quantity,
          rate,
          amount: round2(quantity * rate),
        };
        if (it.ndc) li.ndc = it.ndc;
        if (it.catalogId) li.catalogId = it.catalogId;
        if (it.category) li.category = it.category;
        if (it.prices) li.prices = it.prices;
        return li;
      });

      const res = await fetch("/api/po/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          invoiceNumber,
          invoiceDate,
          lineItems,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SaveResponse;

      if (!res.ok || !data.ok) {
        toast("error", data.error || "Save failed. Your edits are preserved.");
        return;
      }

      setDirty(false);
      const savedTotal = typeof data.total === "number" ? data.total : total;
      toast("success", `Saved to sheet · ${formatUSD(savedTotal)}`);
    } catch {
      toast("error", "Network error. Your edits are preserved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-16">
        <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
          <Spinner className="h-5 w-5 text-slate-400" />
          Loading invoice…
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-4 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to search
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
        >
          ← Back
        </button>
        {dirty && (
          <span className="text-xs font-medium text-amber-600">
            Unsaved changes
          </span>
        )}
      </div>

      {/* Header (read-only) */}
      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-slate-900">
            {detail?.vendorName || "Unknown vendor"}
          </h1>
          <StatusBadge status={status} />
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <ReadOnlyField label="Contact ID" value={detail?.contactId} mono />
          <ReadOnlyField label="Email" value={detail?.email} />
          <ReadOnlyField label="Payment method" value={detail?.paymentMethod} />
          <ReadOnlyField label="Carrier" value={detail?.carrier} />
          {detail?.telegram ? (
            <ReadOnlyField label="Telegram" value={detail.telegram} />
          ) : null}
        </dl>
      </section>

      {/* Editable meta */}
      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700">
              Invoice number
            </label>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setMeta(setInvoiceNumber, e.target.value)}
              placeholder="e.g. INV-1024"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">
              Invoice date
            </label>
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setMeta(setInvoiceDate, e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            />
          </div>
        </div>
      </section>

      {/* Add from catalog */}
      <CatalogPicker
        catalog={catalog}
        loading={catalogLoading}
        error={catalogError}
        onLoad={loadCatalog}
        onAdd={addFromCatalog}
      />

      {/* Line items */}
      <section className="mt-4 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Line items</h2>
          <button
            type="button"
            onClick={addItem}
            className="rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
          >
            + Add blank line item
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Drug</th>
                <th className="px-3 py-2">Strength</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2">Condition</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-8 text-center text-sm text-slate-400"
                  >
                    No line items. Add one from the catalog above or click “Add
                    blank line item”.
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={it.drug}
                        onChange={(e) => updateItem(it.id, { drug: e.target.value })}
                        className="w-full min-w-[140px] rounded-md border border-slate-300 px-2 py-1.5 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={it.strength}
                        onChange={(e) =>
                          updateItem(it.id, { strength: e.target.value })
                        }
                        className="w-full min-w-[90px] rounded-md border border-slate-300 px-2 py-1.5 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={it.expiry}
                        onChange={(e) =>
                          updateItem(it.id, { expiry: e.target.value })
                        }
                        placeholder="2026-12"
                        className="w-full min-w-[90px] rounded-md border border-slate-300 px-2 py-1.5 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={it.condition}
                        onChange={(e) =>
                          changeCondition(it.id, e.target.value as Condition)
                        }
                        className="w-full min-w-[100px] rounded-md border border-slate-300 bg-white px-2 py-1.5 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                      >
                        {CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={it.quantity}
                        onChange={(e) =>
                          updateItem(it.id, { quantity: e.target.value })
                        }
                        className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-right outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-slate-400">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={it.rate}
                          placeholder="0.00"
                          onChange={(e) =>
                            updateItem(it.id, { rate: e.target.value })
                          }
                          className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-slate-900">
                      {formatUSD(lineAmount(it))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeItem(it.id)}
                        aria-label="Remove line item"
                        title="Remove line item"
                        className="rounded p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-400">Condition: {CONDITION_HELP}</p>
          <div className="text-right">
            <span className="text-sm text-slate-500">Total</span>
            <span className="ml-3 text-xl font-bold text-slate-900">
              {formatUSD(total)}
            </span>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={goBack}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex items-center justify-center gap-2 rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          {saving && <Spinner />}
          {saving ? "Saving…" : "Save to sheet"}
        </button>
      </section>
    </main>
  );
}

function CatalogPicker({
  catalog,
  loading,
  error,
  onLoad,
  onAdd,
}: {
  catalog: CatalogItem[] | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  onAdd: (cat: CatalogItem, condition: Condition) => void;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !catalog) return [];
    const tokens = q.split(/\s+/);
    return catalog
      .filter((c) => {
        const hay = `${c.drug} ${c.strength} ${c.category} ${c.ndc}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, 50);
  }, [query, catalog]);

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Add from catalog</h2>
        {loading && <Spinner className="h-4 w-4 text-slate-400" />}
      </div>

      <input
        type="text"
        value={query}
        onFocus={onLoad}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a few letters of a drug…"
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
      />

      {error && (
        <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      {query.trim() && !loading && !error && (
        <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
          {matches.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-400">
              No catalog matches.
            </div>
          ) : (
            matches.map((cat, i) => (
              <div
                key={`${cat.catalogId || cat.ndc || cat.drug}-${i}`}
                className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2 first:border-t-0"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-slate-800">
                      {cat.drug || "—"}
                    </span>
                    {cat.strength && (
                      <span className="text-slate-500">{cat.strength}</span>
                    )}
                    {cat.isGroup && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        Group · blanket
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-400">
                    {[cat.category, cat.ndc].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {CONDITIONS.map((c) => {
                    const p = cat.prices[c];
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onAdd(cat, c)}
                        title={
                          p == null
                            ? `Add as ${c} (set rate)`
                            : `Add as ${c} at ${formatUSD(p)}`
                        }
                        className="rounded-md border border-slate-200 px-2 py-1 text-xs transition hover:border-brand-400 hover:bg-brand-50"
                      >
                        <span className="font-semibold text-slate-700">{c}</span>
                        <span className="ml-1 text-slate-500">
                          {p == null ? "—" : formatUSD(p)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <p className="mt-2 text-xs text-slate-400">
        Pick a condition to add the item. Blank ( — ) prices add an editable row
        with no rate set.
      </p>
    </section>
  );
}

function ReadOnlyField({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-words text-sm text-slate-800 ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value?.trim() || "—"}
      </dd>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
