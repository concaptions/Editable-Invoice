"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Spinner } from "@/components/Spinner";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/app/providers";
import { formatUSD, round2, toNum } from "@/lib/format";
import {
  CONDITIONS,
  CONDITION_HELP,
  CONDITION_REFERENCE,
  REASON_PRESETS,
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
  // The vendor's per-item note (read-only). Carried through untouched.
  customerNote: string;
  // Landon's note. Reject / Sample / reason presets all write here.
  poNote: string;
  rejected: boolean;
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
    customerNote: it.customerNote ?? "",
    poNote: it.poNote ?? "",
    rejected: Boolean(it.rejected),
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
    customerNote: "",
    poNote: "",
    rejected: false,
  };
}

// Rejected lines contribute 0 regardless of the typed rate.
function lineAmount(item: EditableLineItem): number {
  if (item.rejected) return 0;
  return round2(toNum(item.quantity) * toNum(item.rate));
}

// A "sample" line: $0, marked via the poNote keyword, not rejected.
function isSampleLine(it: EditableLineItem): boolean {
  return (
    !it.rejected &&
    it.poNote.trim().toLowerCase() === "sample" &&
    toNum(it.rate) === 0
  );
}

// Stable identity for matching a current line against the original snapshot.
function lineKey(it: {
  catalogId?: string;
  ndc?: string;
  drug?: string;
  strength?: string;
}): string {
  return (
    it.catalogId?.trim() ||
    it.ndc?.trim() ||
    `${(it.drug ?? "").trim()} ${(it.strength ?? "").trim()}`
      .trim()
      .toLowerCase()
  );
}

type ChangeKind = "rejected" | "sample" | "repriced" | "added" | "removed";
interface ChangeRow {
  key: string;
  name: string;
  kind: ChangeKind;
  note?: string;
  from?: number;
  to?: number;
}

// Diffs the current lines against the vendor's original snapshot so the returned
// number is self-explanatory: per line (rejected / sample / repriced / added /
// removed). The total delta is rendered separately from estimated → returned.
function computeChanges(
  baseline: LineItem[],
  current: EditableLineItem[]
): ChangeRow[] {
  const baseByKey = new Map<string, LineItem>();
  for (const b of baseline) {
    const k = lineKey(b);
    if (k && !baseByKey.has(k)) baseByKey.set(k, b);
  }
  const seen = new Set<string>();
  const out: ChangeRow[] = [];

  for (const it of current) {
    const k = lineKey(it);
    const name = `${it.drug} ${it.strength}`.trim() || "(unnamed)";
    if (k) seen.add(k);
    if (it.rejected) {
      out.push({ key: k, name, kind: "rejected", note: it.poNote.trim() });
      continue;
    }
    if (isSampleLine(it)) {
      out.push({ key: k, name, kind: "sample", note: it.poNote.trim() });
      continue;
    }
    const curRate = toNum(it.rate);
    const base = k ? baseByKey.get(k) : undefined;
    if (base) {
      if (round2(base.rate) !== round2(curRate)) {
        out.push({ key: k, name, kind: "repriced", from: base.rate, to: curRate });
      }
    } else {
      out.push({ key: k, name, kind: "added", to: curRate });
    }
  }

  for (const [k, b] of baseByKey) {
    if (!seen.has(k)) {
      out.push({
        key: k,
        name: `${b.drug} ${b.strength}`.trim() || "(unnamed)",
        kind: "removed",
        from: b.rate,
      });
    }
  }

  return out;
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
  const [cleaningFee, setCleaningFee] = useState("0");

  const [status, setStatus] = useState("");

  // Diff baseline = the vendor's original line items (snapshot if present, else
  // the items as first loaded). Set once on load; never changes as Landon edits.
  const [baseline, setBaseline] = useState<LineItem[]>([]);

  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
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
        setCleaningFee(String(d.cleaningFee ?? 0));
        setStatus(d.status ?? "");
        setBaseline(
          Array.isArray(d.originalLineItems) && d.originalLineItems.length
            ? d.originalLineItems
            : Array.isArray(d.lineItems)
              ? d.lineItems
              : []
        );
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

  const subtotal = useMemo(
    () => round2(items.reduce((sum, it) => sum + lineAmount(it), 0)),
    [items]
  );
  const cleaning = useMemo(
    () => Math.max(0, round2(toNum(cleaningFee))),
    [cleaningFee]
  );
  const returnedTotal = useMemo(
    () => round2(subtotal - cleaning),
    [subtotal, cleaning]
  );
  const changes = useMemo(
    () => computeChanges(baseline, items),
    [baseline, items]
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
  // rows loaded from the sheet re-price too. Rejected rows keep their $0 rate.
  function changeCondition(id: string, condition: Condition) {
    setItems((cur) =>
      cur.map((it) => {
        if (it.id !== id) return it;
        if (it.rejected) return { ...it, condition };
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

  // Reject toggles the line: rate forced to 0, reason goes in poNote. No
  // struck-through price — the amount simply shows $0.
  function toggleReject(id: string) {
    setItems((cur) =>
      cur.map((it) => {
        if (it.id !== id) return it;
        const rejected = !it.rejected;
        return { ...it, rejected, rate: rejected ? "0" : it.rate };
      })
    );
    markDirty();
  }

  // Sample: $0, write "sample" into poNote, leave rejected false.
  function markSample(id: string) {
    setItems((cur) =>
      cur.map((it) =>
        it.id === id
          ? { ...it, rejected: false, rate: "0", poNote: "sample" }
          : it
      )
    );
    markDirty();
  }

  function applyPreset(id: string, preset: string) {
    if (!preset || preset === "Other") return; // "Other" = type your own
    updateItem(id, { poNote: preset });
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
        customerNote: "",
        poNote: "",
        rejected: false,
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

  function changeCleaningFee(value: string) {
    setCleaningFee(value);
    markDirty();
  }
  function bumpCleaningFee(delta: number) {
    setCleaningFee((cur) => String(Math.max(0, round2(toNum(cur) + delta))));
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

  // Builds the normalized line items for save + PDF (rejected => rate/amount 0,
  // every key preserved for round-trip fidelity).
  function buildLineItems(): LineItem[] {
    return items.map((it) => {
      const drug = it.drug.trim();
      const strength = it.strength.trim();
      const quantity = toNum(it.quantity);
      const rate = it.rejected ? 0 : toNum(it.rate);
      const li: LineItem = {
        item: `${drug} ${strength}`.trim(),
        drug,
        strength,
        expiry: it.expiry.trim(),
        condition: it.condition,
        quantity,
        rate,
        amount: round2(quantity * rate),
        customerNote: it.customerNote ?? "",
        poNote: it.poNote ?? "",
        rejected: it.rejected,
        cleaningFee: 0,
      };
      if (it.ndc) li.ndc = it.ndc;
      if (it.catalogId) li.catalogId = it.catalogId;
      if (it.category) li.category = it.category;
      if (it.prices) li.prices = it.prices;
      return li;
    });
  }

  async function save() {
    const missingReason = items.filter((it) => it.rejected && !it.poNote.trim());
    if (missingReason.length) {
      toast(
        "error",
        `Add a reason for ${missingReason.length} rejected line${
          missingReason.length > 1 ? "s" : ""
        }.`
      );
      return;
    }

    setSaving(true);
    try {
      const lineItems = buildLineItems();
      const res = await fetch("/api/po/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          invoiceNumber,
          invoiceDate,
          lineItems,
          cleaningFee: cleaning,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SaveResponse;

      if (!res.ok || !data.ok) {
        toast("error", data.error || "Save failed. Your edits are preserved.");
        return;
      }

      setDirty(false);
      setStatus("PO Edited");
      const savedTotal =
        typeof data.total === "number" ? data.total : returnedTotal;
      toast("success", `Saved · returned ${formatUSD(savedTotal)}`);
    } catch {
      toast("error", "Network error. Your edits are preserved.");
    } finally {
      setSaving(false);
    }
  }

  // Generate the PO PDF directly via the Railway service (proxied) and download.
  async function generatePO() {
    setGenerating(true);
    try {
      const payload = {
        documentType: "PO",
        invoiceNumber,
        invoiceDate,
        vendorName: detail?.vendorName ?? "",
        businessName: "",
        contactId: detail?.contactId ?? "",
        email: detail?.email ?? "",
        phone: "",
        lineItems: buildLineItems(),
        subtotal,
        cleaningFee: cleaning,
        total: returnedTotal,
      };
      const res = await fetch("/api/po/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast("error", data.error || "Could not generate the PO PDF.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PO ${invoiceNumber || "draft"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("success", "PO PDF downloaded.");
    } catch {
      toast("error", "Network error while generating the PO.");
    } finally {
      setGenerating(false);
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

  const estimatedTotal = detail?.estimatedTotal ?? 0;
  const totalDelta = round2(returnedTotal - estimatedTotal);
  const proofFiles = detail?.proofFiles ?? [];
  const customerNote = detail?.customerNote?.trim() || "";

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

        {/* Vendor's overall note + price-match proof files (read-only). */}
        {(customerNote || proofFiles.length > 0) && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            {customerNote && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Vendor note
                </dt>
                <dd className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {customerNote}
                </dd>
              </div>
            )}
            {proofFiles.length > 0 && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Price-match proof
                </dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {proofFiles.map((f, i) => (
                    <a
                      key={`${f.url}-${i}`}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-brand-700 transition hover:border-brand-400 hover:bg-brand-50"
                    >
                      <PaperclipIcon />
                      {f.name}
                    </a>
                  ))}
                </dd>
              </div>
            )}
          </div>
        )}
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
              placeholder="e.g. LVDTS-1001"
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

      {/* Condition reference (collapsible) */}
      <details className="group mt-4 rounded-xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm font-semibold text-slate-700">
          Condition reference (grading guide)
          <span className="text-xs font-normal text-slate-400 group-open:hidden">
            Show ▾
          </span>
          <span className="hidden text-xs font-normal text-slate-400 group-open:inline">
            Hide ▴
          </span>
        </summary>
        <div className="space-y-3 border-t border-slate-200 px-5 py-4">
          {CONDITION_REFERENCE.map((c) => (
            <div key={c.title}>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-700">
                {c.title}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </details>

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
                items.map((it) => {
                  const sample = isSampleLine(it);
                  return (
                    <Fragment key={it.id}>
                      <tr
                        className={`border-t border-slate-100 ${
                          it.rejected ? "bg-rose-50/40" : ""
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={it.drug}
                            onChange={(e) =>
                              updateItem(it.id, { drug: e.target.value })
                            }
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
                              disabled={it.rejected}
                              onChange={(e) =>
                                updateItem(it.id, { rate: e.target.value })
                              }
                              className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200 disabled:bg-slate-100 disabled:text-slate-400"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="font-medium text-slate-900">
                            {formatUSD(lineAmount(it))}
                          </div>
                          {it.rejected && (
                            <span className="mt-0.5 inline-block rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                              Rejected
                            </span>
                          )}
                          {sample && (
                            <span className="mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                              Sample
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right align-top">
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

                      {/* Notes + per-line actions */}
                      <tr className={it.rejected ? "bg-rose-50/40" : ""}>
                        <td colSpan={8} className="px-3 pb-3 pt-0">
                          <div className="flex flex-col gap-2 rounded-md bg-slate-50 px-3 py-2 lg:flex-row lg:items-center">
                            {it.customerNote.trim() && (
                              <div className="shrink-0 text-xs text-slate-500 lg:max-w-[40%]">
                                <span className="font-semibold text-slate-600">
                                  Vendor:
                                </span>{" "}
                                {it.customerNote}
                              </div>
                            )}
                            <div className="flex flex-1 flex-wrap items-center gap-2">
                              <select
                                value=""
                                onChange={(e) => {
                                  applyPreset(it.id, e.target.value);
                                  e.currentTarget.selectedIndex = 0;
                                }}
                                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-200"
                              >
                                <option value="">Reason…</option>
                                {REASON_PRESETS.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                value={it.poNote}
                                onChange={(e) =>
                                  updateItem(it.id, { poNote: e.target.value })
                                }
                                placeholder="PO note (reason / sample / comment)"
                                className={`min-w-[160px] flex-1 rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-brand-200 ${
                                  it.rejected && !it.poNote.trim()
                                    ? "border-rose-300 focus:border-rose-400"
                                    : "border-slate-300 focus:border-brand-500"
                                }`}
                              />
                              <button
                                type="button"
                                onClick={() => toggleReject(it.id)}
                                className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                                  it.rejected
                                    ? "border-rose-300 bg-rose-100 text-rose-700"
                                    : "border-slate-300 bg-white text-slate-600 hover:border-rose-300 hover:text-rose-600"
                                }`}
                              >
                                {it.rejected ? "Rejected ✓" : "Reject"}
                              </button>
                              <button
                                type="button"
                                onClick={() => markSample(it.id)}
                                className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                                  sample
                                    ? "border-amber-300 bg-amber-100 text-amber-700"
                                    : "border-slate-300 bg-white text-slate-600 hover:border-amber-300 hover:text-amber-600"
                                }`}
                              >
                                Sample
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="border-t border-slate-200 px-5 py-3 text-xs text-slate-400">
          Condition: {CONDITION_HELP}
        </p>
      </section>

      {/* Cleaning fee + totals */}
      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Cleaning fee */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">
            Cleaning fee (single deduction)
          </h2>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-slate-400">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={cleaningFee}
              onChange={(e) => changeCleaningFee(e.target.value)}
              className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            />
            <button
              type="button"
              onClick={() => bumpCleaningFee(10)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              +$10
            </button>
            <button
              type="button"
              onClick={() => bumpCleaningFee(-10)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              −$10
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            $10/item is the basis. $5/item only on invoices $10k+ you’re
            expediting — your call. Applied once for the whole invoice.
          </p>
        </div>

        {/* Totals */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Subtotal</dt>
              <dd className="font-medium text-slate-900">
                {formatUSD(subtotal)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Cleaning fee</dt>
              <dd className="font-medium text-rose-600">
                −{formatUSD(cleaning)}
              </dd>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
              <dt className="font-semibold text-slate-700">Returned total</dt>
              <dd className="text-xl font-bold text-slate-900">
                {formatUSD(returnedTotal)}
              </dd>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <dt>Vendor estimate</dt>
              <dd>{formatUSD(estimatedTotal)}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* What changed vs original */}
      {(changes.length > 0 || totalDelta !== 0) && (
        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">
            What changed vs original
          </h2>
          {changes.length > 0 ? (
            <ul className="mt-3 space-y-1.5 text-sm">
              {changes.map((c) => (
                <li
                  key={`${c.kind}-${c.key}-${c.name}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <ChangeBadge kind={c.kind} />
                  <span className="font-medium text-slate-700">{c.name}</span>
                  <span className="text-slate-500">
                    {c.kind === "repriced" &&
                      `${formatUSD(c.from ?? 0)} → ${formatUSD(c.to ?? 0)}`}
                    {c.kind === "removed" && "removed from invoice"}
                    {c.kind === "added" && `added at ${formatUSD(c.to ?? 0)}`}
                    {(c.kind === "rejected" || c.kind === "sample") &&
                      (c.note ? `— ${c.note}` : "")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-400">
              No line-level changes.
            </p>
          )}
          <p className="mt-3 border-t border-slate-100 pt-3 text-sm">
            <span className="text-slate-500">Total: </span>
            <span className="font-medium text-slate-700">
              {formatUSD(estimatedTotal)} → {formatUSD(returnedTotal)}
            </span>
            <span
              className={`ml-2 font-semibold ${
                totalDelta < 0 ? "text-rose-600" : "text-emerald-600"
              }`}
            >
              ({totalDelta < 0 ? "" : "+"}
              {formatUSD(totalDelta)})
            </span>
          </p>
        </section>
      )}

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
          onClick={generatePO}
          disabled={generating}
          className="flex items-center justify-center gap-2 rounded-md border border-brand-300 bg-white px-5 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
        >
          {generating && <Spinner className="h-4 w-4 text-brand-500" />}
          {generating ? "Generating…" : "Generate PO PDF"}
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

function ChangeBadge({ kind }: { kind: ChangeKind }) {
  const map: Record<ChangeKind, { label: string; cls: string }> = {
    rejected: { label: "Rejected", cls: "bg-rose-100 text-rose-700" },
    sample: { label: "Sample", cls: "bg-amber-100 text-amber-700" },
    repriced: { label: "Repriced", cls: "bg-sky-100 text-sky-700" },
    added: { label: "Added", cls: "bg-emerald-100 text-emerald-700" },
    removed: { label: "Removed", cls: "bg-slate-200 text-slate-600" },
  };
  const { label, cls } = map[kind];
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
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

function PaperclipIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
