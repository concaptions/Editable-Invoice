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
  emptyPayout,
  type CatalogItem,
  type CatalogPrices,
  type Condition,
  type InvoiceDetail,
  type LineItem,
  type PayoutDetails,
  type PayoutSaveResponse,
  type SaveResponse,
} from "@/lib/types";

// Cleaning fee is invoice-level: pre-filled to the $10 basis on a fresh PO and
// hard-floored at $5 (never $0 / sub-$5) in the stepper and on manual entry.
const DEFAULT_CLEANING_FEE = 10;
const MIN_CLEANING_FEE = 5;

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

// A price-match proof file pulled from the vendor's Drive folder via the
// get-proof webhook (through /api/proof). `dataUri` is a ready-to-render
// data:<mime>;base64,... string.
interface ProofFileData {
  name: string;
  mimeType: string;
  dataUri: string;
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

  // Payout details. Pre-filled from the resolved submission; edits are saved
  // through the external payout service (its own button), NOT the sheet-save
  // path — so this dirty flag is tracked separately and never blocks a PO.
  const [payout, setPayout] = useState<PayoutDetails>(emptyPayout());
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [payoutDirty, setPayoutDirty] = useState(false);

  const [status, setStatus] = useState("");

  // Diff baseline = the vendor's original line items (snapshot if present, else
  // the items as first loaded). Set once on load; never changes as Landon edits.
  const [baseline, setBaseline] = useState<LineItem[]>([]);

  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The PO PDF saved to Drive on the last successful generate (link shown to
  // Landon). Cleared on any edit so a stale link is never presented.
  const [savedFile, setSavedFile] = useState<{ name: string; url: string } | null>(
    null
  );

  // Vendor's price-match proof (files pulled from Drive via /api/proof). Null =
  // none / not loaded → the review screen shows nothing extra. Never blocks the
  // page: it loads independently after the invoice and fails silently.
  const [proof, setProof] = useState<ProofFileData[] | null>(null);
  // Whether the floating proof panel is expanded (true) or collapsed to a small
  // pill (false). Reset to open each time a new vendor's proof loads.
  const [proofOpen, setProofOpen] = useState(true);

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
        // Fresh PO (no fee saved yet) pre-fills the $10 basis; a previously
        // saved fee (always ≥ the $5 floor) loads as-is.
        const loadedFee = round2(toNum(d.cleaningFee));
        setCleaningFee(
          String(loadedFee >= MIN_CLEANING_FEE ? loadedFee : DEFAULT_CLEANING_FEE)
        );
        setStatus(d.status ?? "");
        setPayout(d.payout ?? emptyPayout());
        setPayoutDirty(false);
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

  // Look up the vendor's price-match proof once the invoice (and thus its
  // resolved contactId + vendorName) is known. Runs independently of the invoice
  // load so it never blocks the page, and fails quietly: any error just leaves
  // `proof` null and the review screen renders nothing extra.
  useEffect(() => {
    const contactId = detail?.contactId?.trim() ?? "";
    const vendorName = detail?.vendorName?.trim() ?? "";
    setProof(null);
    if (!contactId || !vendorName) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/proof", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId, vendorName }),
        });
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          hasProof?: boolean;
          files?: ProofFileData[];
        } | null;
        if (cancelled) return;
        if (data?.hasProof && Array.isArray(data.files) && data.files.length) {
          setProof(data.files);
          setProofOpen(true);
        }
      } catch {
        // Fail quietly — treat as no proof.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail?.contactId, detail?.vendorName]);

  const subtotal = useMemo(
    () => round2(items.reduce((sum, it) => sum + lineAmount(it), 0)),
    [items]
  );
  const cleaning = useMemo(
    () => Math.max(MIN_CLEANING_FEE, round2(toNum(cleaningFee))),
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

  const markDirty = useCallback(() => {
    setDirty(true);
    setSavedFile(null);
  }, []);

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

  // Payout edits are tracked with their own dirty flag (separate from the sheet
  // save) because they persist through the external payout service, not the
  // sheet — so they never interfere with approve/reject/totals.
  function updatePayout(patch: Partial<PayoutDetails>) {
    setPayout((cur) => ({ ...cur, ...patch }));
    setPayoutDirty(true);
  }

  // Single write path: POST the full payout + ids to the payout service (proxied
  // through /api/po/payout). On success the master + GHL are updated; reopening
  // the submission re-reads the saved values. Never keeps payout only in state.
  async function savePayout() {
    setPayoutSaving(true);
    try {
      const res = await fetch("/api/po/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          contactId: detail?.contactId ?? "",
          vendorId: detail?.contactId ?? "",
          payout,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as PayoutSaveResponse;
      if (!res.ok || !data.ok) {
        toast(
          "error",
          data.error ||
            (data.notConfigured
              ? "Payout service isn't configured yet."
              : "Couldn't save payout details.")
        );
        return;
      }
      setPayoutDirty(false);
      toast("success", "Payout details saved.");
    } catch {
      toast("error", "Network error saving payout details.");
    } finally {
      setPayoutSaving(false);
    }
  }

  function changeCleaningFee(value: string) {
    setCleaningFee(value);
    markDirty();
  }
  // Snap a manual entry up to the $5 floor when the field loses focus. Live
  // totals already reflect the clamp via `cleaning`, so this only fixes display.
  function commitCleaningFee() {
    setCleaningFee((cur) =>
      String(Math.max(MIN_CLEANING_FEE, round2(toNum(cur))))
    );
  }
  function bumpCleaningFee(delta: number) {
    setCleaningFee((cur) =>
      String(Math.max(MIN_CLEANING_FEE, round2(toNum(cur) + delta)))
    );
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

  // Open a proof file in a new tab. Browsers block top-frame navigation to a
  // `data:` URL, so convert it to a Blob URL first (works for images and PDFs
  // alike). Called from a click handler, so it's not popup-blocked.
  function openProofFile(file: ProofFileData) {
    try {
      const comma = file.dataUri.indexOf(",");
      const base64 = comma >= 0 ? file.dataUri.slice(comma + 1) : file.dataUri;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: file.mimeType || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      window.open(file.dataUri, "_blank", "noopener,noreferrer");
    }
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

  // Render the PO PDF in-process and save it to the vendor's Drive folder. On
  // success the server returns the saved file's view link, which we surface as a
  // confirmation banner (no browser download).
  async function generatePO() {
    setGenerating(true);
    setSavedFile(null);
    try {
      const payload = {
        documentType: "PO",
        submissionId,
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
        payout,
      };
      const res = await fetch("/api/po/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        fileName?: string;
        webViewLink?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.webViewLink) {
        toast("error", data.error || "Could not generate the PO PDF.");
        return;
      }
      const name = data.fileName || `PO ${invoiceNumber || "draft"}.pdf`;
      setSavedFile({ name, url: data.webViewLink });
      toast("success", `Saved to Drive · ${name}`);
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

      {/* Price-match proof — a floating panel pinned to the top-right, shown ONLY
          when proof exists. It overlays the margin (fixed position) so the review
          layout underneath is unchanged, and it's non-modal so the PO stays fully
          editable. Dismissible to a compact pill. */}
      {proof && proof.length > 0 &&
        (proofOpen ? (
          <aside
            role="alert"
            className="fixed right-4 top-20 z-40 w-[330px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl ring-1 ring-rose-500/10"
          >
            <div className="flex items-start gap-2.5 bg-gradient-to-r from-rose-600 to-red-600 px-4 py-3">
              <span className="mt-0.5 shrink-0 text-white">
                <WarningIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white">
                  Price-match proof
                </p>
                <p className="text-xs text-rose-100">Review before approving.</p>
              </div>
              <button
                type="button"
                onClick={() => setProofOpen(false)}
                title="Hide"
                aria-label="Hide price-match proof"
                className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-rose-100 transition hover:bg-white/15 hover:text-white"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="max-h-[calc(100vh-9rem)] space-y-3 overflow-y-auto p-4">
              {proof.map((file, i) =>
                file.mimeType.startsWith("image/") ? (
                  <div key={`${file.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => openProofFile(file)}
                      title={`Open ${file.name} full size in a new tab`}
                      className="block w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition hover:border-rose-300"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={file.dataUri}
                        alt={file.name}
                        className="max-h-56 w-full object-contain"
                      />
                    </button>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {file.name}
                    </p>
                  </div>
                ) : (
                  <button
                    key={`${file.name}-${i}`}
                    type="button"
                    onClick={() => openProofFile(file)}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
                  >
                    <span className="shrink-0 text-rose-500">
                      <PaperclipIcon />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {file.name}
                    </span>
                    <span className="shrink-0 text-slate-400">
                      <ExternalLinkIcon />
                    </span>
                  </button>
                )
              )}
            </div>
          </aside>
        ) : (
          <button
            type="button"
            onClick={() => setProofOpen(true)}
            className="fixed right-4 top-20 z-40 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-rose-600 to-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg ring-1 ring-rose-500/20 transition hover:from-rose-500 hover:to-red-500"
          >
            <WarningIcon />
            Price-match proof
            {proof.length > 1 && (
              <span className="rounded-full bg-white/25 px-1.5 text-xs font-semibold">
                {proof.length}
              </span>
            )}
          </button>
        ))}

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

      {/* Payout / payment details */}
      <PaymentSection
        payout={payout}
        onChange={updatePayout}
        onSave={savePayout}
        saving={payoutSaving}
        dirty={payoutDirty}
      />

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
              onBlur={commitCleaningFee}
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

      {/* Drive save confirmation */}
      {savedFile && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-emerald-800">
            <CheckIcon />
            <span>
              Saved to the vendor’s Drive folder as{" "}
              <span className="font-semibold">{savedFile.name}</span>.
            </span>
          </div>
          <a
            href={savedFile.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
          >
            Open in Drive
            <ExternalLinkIcon />
          </a>
        </div>
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

const PAYMENT_METHODS = ["ACH", "Wire", "Both"] as const;

// Editable payout / payment section. Method gates which fieldset shows (a blank
// or unknown method shows both, so nothing is ever hidden). Saving goes through
// its own handler (external payout service) — independent of the sheet save.
function PaymentSection({
  payout,
  onChange,
  onSave,
  saving,
  dirty,
}: {
  payout: PayoutDetails;
  onChange: (patch: Partial<PayoutDetails>) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  const m = (payout.method || "").toLowerCase();
  const showAch = !m || m.includes("ach") || m.includes("both");
  const showWire = !m || m.includes("wire") || m.includes("both");

  // Keep a non-standard stored method selectable so it's never silently lost.
  const methodOptions: string[] = [...PAYMENT_METHODS];
  if (
    payout.method &&
    !PAYMENT_METHODS.some((x) => x.toLowerCase() === payout.method.toLowerCase())
  ) {
    methodOptions.push(payout.method);
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            Payout / payment details
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            How this vendor gets paid — prefilled from their record. Fill in
            anything missing; this prints on the PO.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-xs font-medium text-amber-600">
              Unsaved payout
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-md border border-brand-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
          >
            {saving && <Spinner className="h-4 w-4 text-brand-500" />}
            {saving ? "Saving…" : "Save payout"}
          </button>
        </div>
      </div>

      {/* Method */}
      <div className="mt-4 max-w-xs">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Payment method
        </label>
        <select
          value={payout.method}
          onChange={(e) => onChange({ method: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        >
          <option value="">— Select —</option>
          {methodOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>

      {/* ACH */}
      {showAch && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            ACH
          </h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PayoutField
              label="Account holder"
              value={payout.achAccountHolder}
              onChange={(v) => onChange({ achAccountHolder: v })}
            />
            <PayoutField
              label="Routing number"
              value={payout.achRoutingNumber}
              onChange={(v) => onChange({ achRoutingNumber: v })}
            />
            <PayoutField
              label="Account number"
              value={payout.achAccountNumber}
              onChange={(v) => onChange({ achAccountNumber: v })}
            />
            <PayoutField
              label="Account type"
              placeholder="Checking / Savings"
              value={payout.achAccountType}
              onChange={(v) => onChange({ achAccountType: v })}
            />
          </div>
        </div>
      )}

      {/* Wire */}
      {showWire && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Wire
          </h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PayoutField
              label="Bank name"
              value={payout.wireBankName}
              onChange={(v) => onChange({ wireBankName: v })}
            />
            <PayoutField
              label="Routing / SWIFT"
              value={payout.wireRoutingSwift}
              onChange={(v) => onChange({ wireRoutingSwift: v })}
            />
            <PayoutField
              label="Account number"
              value={payout.wireAccountNumber}
              onChange={(v) => onChange({ wireAccountNumber: v })}
            />
            <PayoutField
              label="Beneficiary"
              value={payout.wireBeneficiary}
              onChange={(v) => onChange({ wireBeneficiary: v })}
            />
          </div>
        </div>
      )}

      {/* Bank address (shared) */}
      <div className="mt-4">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Bank address
        </label>
        <textarea
          value={payout.bankAddress}
          onChange={(e) => onChange({ bankAddress: e.target.value })}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          placeholder="Street, city, state, ZIP"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />
      </div>
    </section>
  );
}

function PayoutField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
      />
    </div>
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

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ExternalLinkIcon() {
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
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CloseIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
