"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/app/providers";
import { formatUSD, round2, toNum } from "@/lib/format";
import {
  CONDITIONS,
  CONDITION_HELP,
  type Condition,
  type InvoiceDetail,
  type LineItem,
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
    rate: "0",
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
  const [sendToCustomer, setSendToCustomer] = useState(true);

  const [status, setStatus] = useState("");
  const [poLink, setPoLink] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load the invoice on mount / when the id changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/po/get", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submissionId }),
        });
        const data = (await res.json().catch(() => ({}))) as
          | (InvoiceDetail & { error?: string })
          | { error?: string };

        if (cancelled) return;
        if (!res.ok) {
          setLoadError(
            (data as { error?: string }).error ||
              "Failed to load this purchase order."
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

  function updateItem(id: string, patch: Partial<EditableLineItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
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

  async function approve() {
    setSaving(true);
    try {
      const lineItems: LineItem[] = items.map((it) => ({
        drug: it.drug.trim(),
        strength: it.strength.trim(),
        expiry: it.expiry.trim(),
        condition: it.condition,
        quantity: toNum(it.quantity),
        rate: toNum(it.rate),
        amount: lineAmount(it),
      }));

      const res = await fetch("/api/po/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          invoiceNumber,
          invoiceDate,
          sendToCustomer,
          lineItems,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        total?: number;
        poLink?: string;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        toast("error", data.error || "Approve failed. Your edits are preserved.");
        return;
      }

      setPoLink(typeof data.poLink === "string" ? data.poLink : null);
      setStatus("Approved");
      setDirty(false);
      toast("success", "Purchase order approved and saved.");
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
          Loading purchase order…
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

      {/* Line items */}
      <section className="mt-4 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">Line items</h2>
          <button
            type="button"
            onClick={addItem}
            className="rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
          >
            + Add line item
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
                    No line items. Click “Add line item” to start.
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
                          updateItem(it.id, {
                            condition: e.target.value as Condition,
                          })
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
      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={sendToCustomer}
            onChange={(e) => setSendToCustomer(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-slate-700">
            Send finalized PO to customer on approve
          </span>
        </label>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {poLink && (
              <a
                href={poLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
              >
                View finalized PO ↗
              </a>
            )}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={goBack}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={approve}
              disabled={saving}
              className="flex items-center justify-center gap-2 rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {saving && <Spinner />}
              {saving ? "Approving…" : "Approve & Save"}
            </button>
          </div>
        </div>
      </section>
    </main>
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
