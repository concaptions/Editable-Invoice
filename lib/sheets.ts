// Single Google Sheets access module.
//
// This is the ONLY place that talks to the Sheets API. It authenticates with a
// service account (JWT), resolves columns by HEADER NAME (never hard-coded
// letters, so the sheet can be reordered), and reads/writes the Submissions tab.
//
// Server-only: it reads the service-account key + sheet id from env and must
// never be imported by a client component.

import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { round2, toNum } from "./format";
import {
  CONDITIONS,
  emptyPayout,
  type CatalogPrices,
  type Condition,
  type InvoiceDetail,
  type LineItem,
  type PaymentDueEntry,
  type PayoutDetails,
  type POHistoryRecord,
  type ProofFile,
  type SavePayload,
  type SearchResult,
  type VendorPayoutMatch,
} from "./types";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Canonical column key -> exact header text expected in the sheet's first row.
// Resolution is case-insensitive and whitespace-tolerant (see resolveColumns).
const COLUMN_HEADERS = {
  submissionId: "Submission ID",
  contactId: "GHL Contact ID",
  vendorName: "Vendor Name",
  email: "Email",
  telegram: "Telegram",
  paymentMethod: "Payment Method",
  carrier: "Carrier",
  trackingNumber: "Tracking Number",
  status: "Status",
  invoiceNumber: "Invoice Number",
  invoiceDate: "Invoice Date",
  estimatedTotal: "Estimated Total",
  lineItemsJson: "Line Items JSON",
  lineItemCount: "Line Item Count",
  dateTime: "DateTime",
  // Vendor-supplied context surfaced read-only in the editor.
  customerNote: "Customer Note",
  fileLinks: "File Links",
  fileNames: "File Names",
  // Editor-managed columns (added to the sheet manually; matched by header).
  cleaningFee: "Cleaning Fee",
  returnedTotal: "Returned Total",
  originalLineItemsJson: "Original Line Items JSON",
} as const;

type ColumnKey = keyof typeof COLUMN_HEADERS;
type ColumnIndex = Partial<Record<ColumnKey, number>>;

function sheetId(): string {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error("SHEET_ID is not set");
  return id;
}

function sheetTab(): string {
  return process.env.SHEET_TAB || "Submissions";
}

// Parses the full service-account key JSON from env and normalizes the private
// key newlines (they are often stored as literal "\n" in deploy dashboards).
function getServiceAccount(): {
  client_email: string;
  private_key: string;
} {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key"
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

let cachedClient: sheets_v4.Sheets | null = null;

function getSheets(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  const sa = getServiceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: SCOPES,
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

// 0-based column index -> A1 column letters (0 -> A, 25 -> Z, 26 -> AA).
function colToA1(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizeHeader(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Builds canonical-key -> column-index map from the sheet's header row.
function resolveColumns(header: string[]): ColumnIndex {
  const lookup = new Map<string, number>();
  header.forEach((h, i) => {
    const key = normalizeHeader(h);
    if (key && !lookup.has(key)) lookup.set(key, i);
  });
  const out: ColumnIndex = {};
  (Object.keys(COLUMN_HEADERS) as ColumnKey[]).forEach((key) => {
    const idx = lookup.get(normalizeHeader(COLUMN_HEADERS[key]));
    if (idx != null) out[key] = idx;
  });
  return out;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx == null) return "";
  const v = row[idx];
  return v == null ? "" : String(v);
}

function normalizeCondition(value: unknown): Condition {
  const upper = String(value ?? "").toUpperCase();
  return (CONDITIONS as readonly string[]).includes(upper)
    ? (upper as Condition)
    : "MINT";
}

// Parses an optional per-condition price snapshot ({ MINT, DING, DAMAGE }).
// Returns undefined when absent so items without a snapshot stay lean; a
// present-but-empty condition price is kept as null (an editable blank).
function parsePrices(value: unknown): CatalogPrices | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const pick = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return { MINT: pick(o.MINT), DING: pick(o.DING), DAMAGE: pick(o.DAMAGE) };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asFlag(value: unknown): boolean {
  if (value === true) return true;
  const s = asString(value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// THE single place that maps a raw line-item object — from the sheet JSON OR a
// client save payload — to a normalized LineItem. Every key the form/editor
// round-trips is preserved (customerNote, poNote, rejected, cleaningFee), so the
// editor never drops vendor data. `amount` is always derived; a rejected line is
// forced to rate 0 / amount 0; per-item cleaningFee stays 0 (it's invoice-level).
function normalizeLineItem(o: Record<string, unknown>): LineItem {
  const drug = asString(o.drug).trim();
  const strength = asString(o.strength).trim();
  const quantity = toNum(o.quantity as string | number);
  const rejected = asFlag(o.rejected);
  const rate = rejected ? 0 : toNum(o.rate as string | number);
  const item: LineItem = {
    item: asString(o.item).trim() || `${drug} ${strength}`.trim(),
    drug,
    strength,
    expiry: asString(o.expiry).trim(),
    condition: normalizeCondition(o.condition),
    quantity,
    rate,
    amount: round2(quantity * rate),
    customerNote: asString(o.customerNote),
    poNote: asString(o.poNote),
    rejected,
    cleaningFee: 0,
  };
  if (asString(o.ndc)) item.ndc = asString(o.ndc);
  if (asString(o.catalogId)) item.catalogId = asString(o.catalogId);
  if (asString(o.category)) item.category = asString(o.category);
  const prices = parsePrices(o.prices);
  if (prices) item.prices = prices;
  return item;
}

// Parses a `Line Items JSON` cell into normalized line items (amount derived).
function parseLineItems(raw: string): LineItem[] {
  if (!raw || !raw.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => normalizeLineItem((entry ?? {}) as Record<string, unknown>));
}

// Splits a multi-value cell (newline- or comma-separated) into trimmed parts.
function splitCell(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pairs the `File Names` / `File Links` cells into proof files. Links are the
// source of truth; a name is matched by index, falling back to the link text.
function parseProofFiles(names: string, links: string): ProofFile[] {
  const urls = splitCell(links);
  const labels = splitCell(names);
  return urls.map((url, i) => ({ name: labels[i] || url, url }));
}

function lineItemsTotal(items: LineItem[]): number {
  return round2(items.reduce((sum, it) => sum + round2(it.quantity * it.rate), 0));
}

interface Grid {
  header: string[];
  rows: string[][];
  col: ColumnIndex;
}

async function readGrid(): Promise<Grid> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `'${sheetTab()}'`,
  });
  const values = (res.data.values as string[][] | undefined) ?? [];
  if (values.length === 0) {
    return { header: [], rows: [], col: {} };
  }
  const [header, ...rows] = values;
  return { header, rows, col: resolveColumns(header) };
}

// Most-recent-first comparator based on the DateTime column (newest first),
// falling back to original sheet order (later rows first) when dates are absent.
function compareRecency(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  const aOk = Number.isFinite(da);
  const bOk = Number.isFinite(db);
  if (aOk && bOk) return db - da;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

// Builds the display result for one row, or null if it has no Submission ID.
function rowToSearchResult(row: string[], col: ColumnIndex): SearchResult | null {
  const submissionId = cell(row, col.submissionId).trim();
  if (!submissionId) return null;

  // A submission may have no line items yet — Landon builds the invoice from
  // the catalog. Fall back to the customer's Estimated Total for display.
  const lineItems = parseLineItems(cell(row, col.lineItemsJson));
  const total = lineItems.length
    ? lineItemsTotal(lineItems)
    : toNum(cell(row, col.estimatedTotal).replace(/[$,]/g, ""));

  return {
    submissionId,
    contactId: cell(row, col.contactId),
    vendorName: cell(row, col.vendorName),
    email: cell(row, col.email),
    telegram: cell(row, col.telegram),
    invoiceNumber: cell(row, col.invoiceNumber),
    invoiceDate: cell(row, col.invoiceDate),
    total,
    status: cell(row, col.status),
    lineItemCount: lineItems.length,
  };
}

// Collects matching rows (optionally filtered), most-recent first.
function collectResults(
  rows: string[][],
  col: ColumnIndex,
  predicate?: (row: string[]) => boolean
): SearchResult[] {
  const ranked: { result: SearchResult; dateTime: string; order: number }[] = [];
  rows.forEach((row, order) => {
    if (predicate && !predicate(row)) return;
    const result = rowToSearchResult(row, col);
    if (!result) return;
    ranked.push({ result, dateTime: cell(row, col.dateTime), order });
  });
  ranked.sort((a, b) => {
    const byDate = compareRecency(a.dateTime, b.dateTime);
    return byDate !== 0 ? byDate : b.order - a.order;
  });
  return ranked.map((m) => m.result);
}

export async function searchSubmissions(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const { rows, col } = await readGrid();
  if (col.submissionId == null) {
    throw new Error('Sheet is missing the "Submission ID" column');
  }

  // Vendors go by different names across invoice / messaging / our records, so
  // match against every identifier we have, not just the vendor name. Invoice
  // Number is included so a vendor's LVDTS-#### finds the row from this box too.
  return collectResults(rows, col, (row) => {
    const haystack = [
      cell(row, col.contactId),
      cell(row, col.vendorName),
      cell(row, col.email),
      cell(row, col.telegram),
      cell(row, col.invoiceNumber),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

// Resolves an exact Invoice Number (e.g. "LVDTS-1001") to its Submission ID so
// the home page can jump straight into the editor. Case/space-insensitive.
export async function resolveSubmissionIdByInvoiceNumber(
  invoiceNumber: string
): Promise<string | null> {
  const want = invoiceNumber.trim().toLowerCase();
  if (!want) return null;

  const { rows, col } = await readGrid();
  if (col.submissionId == null || col.invoiceNumber == null) return null;

  const row = rows.find(
    (r) => cell(r, col.invoiceNumber).trim().toLowerCase() === want
  );
  if (!row) return null;
  const submissionId = cell(row, col.submissionId).trim();
  return submissionId || null;
}

// Most-recent submissions for the home screen (no search query needed).
export async function getRecentSubmissions(limit = 20): Promise<SearchResult[]> {
  const { rows, col } = await readGrid();
  if (col.submissionId == null) {
    throw new Error('Sheet is missing the "Submission ID" column');
  }
  const results = collectResults(rows, col);
  return limit > 0 ? results.slice(0, limit) : results;
}

export async function getSubmission(
  submissionId: string
): Promise<InvoiceDetail | null> {
  const id = submissionId.trim();
  if (!id) return null;

  const { rows, col } = await readGrid();
  if (col.submissionId == null) {
    throw new Error('Sheet is missing the "Submission ID" column');
  }

  const row = rows.find((r) => cell(r, col.submissionId).trim() === id);
  if (!row) return null;

  const lineItems = parseLineItems(cell(row, col.lineItemsJson));
  const originalLineItems = parseLineItems(cell(row, col.originalLineItemsJson));
  const paymentMethod = cell(row, col.paymentMethod);
  // Payout details live on the Vendor master (keyed by Contact ID), not the
  // submission row. Seed from there; the per-submission Payment Method wins.
  const payout = await resolveVendorPayout(cell(row, col.contactId), paymentMethod);
  return {
    submissionId: cell(row, col.submissionId),
    contactId: cell(row, col.contactId),
    vendorName: cell(row, col.vendorName),
    email: cell(row, col.email),
    telegram: cell(row, col.telegram) || undefined,
    paymentMethod,
    carrier: cell(row, col.carrier),
    invoiceNumber: cell(row, col.invoiceNumber),
    invoiceDate: cell(row, col.invoiceDate),
    submittedAt: cell(row, col.dateTime),
    // Carrier tracking number(s) — one sheet cell holding a comma/newline list.
    trackingNumbers: splitCell(cell(row, col.trackingNumber)),
    status: cell(row, col.status),
    total: lineItemsTotal(lineItems),
    lineItems,
    customerNote: cell(row, col.customerNote),
    proofFiles: parseProofFiles(
      cell(row, col.fileNames),
      cell(row, col.fileLinks)
    ),
    cleaningFee: toNum(cell(row, col.cleaningFee).replace(/[$,]/g, "")),
    returnedTotal: toNum(cell(row, col.returnedTotal).replace(/[$,]/g, "")),
    estimatedTotal: toNum(cell(row, col.estimatedTotal).replace(/[$,]/g, "")),
    originalLineItems,
    payout,
  };
}

// Writes the edited state back to the matched row (keyed by Submission ID).
// Touches: Line Items JSON, Line Item Count, Invoice Number, Invoice Date,
// Cleaning Fee, Returned Total, Status, and — once, on first save — Original
// Line Items JSON. Deliberately NEVER touches Estimated Total (the vendor's
// original total / diff baseline), Customer Note, or File Links. Returns the
// subtotal and the Returned Total (subtotal − cleaning fee).
export async function saveSubmission(
  payload: SavePayload
): Promise<{ subtotal: number; returnedTotal: number }> {
  const id = payload.submissionId.trim();
  if (!id) throw new Error("submissionId is required");

  const { rows, col } = await readGrid();
  if (col.submissionId == null) {
    throw new Error('Sheet is missing the "Submission ID" column');
  }
  if (col.lineItemsJson == null) {
    throw new Error('Sheet is missing the "Line Items JSON" column');
  }

  const rowIndex = rows.findIndex(
    (r) => cell(r, col.submissionId).trim() === id
  );
  if (rowIndex === -1) {
    throw new Error(`No submission found for "${id}"`);
  }
  const row = rows[rowIndex];

  // Normalize through the shared mapper so every key is preserved (customerNote,
  // poNote, rejected, cleaningFee) and a rejected line is forced to rate/amount 0.
  const items: LineItem[] = (
    Array.isArray(payload.lineItems) ? payload.lineItems : []
  ).map((raw) => normalizeLineItem(raw as unknown as Record<string, unknown>));

  const subtotal = lineItemsTotal(items);
  // Cleaning fee is invoice-level with a hard $5 floor (never $0 / sub-$5).
  const cleaningFee = Math.max(5, round2(toNum(payload.cleaningFee)));
  const returnedTotal = round2(subtotal - cleaningFee);

  // Snapshot the vendor's original line items ONCE: on the first save, if the
  // Original Line Items JSON cell is empty, copy the pre-edit Line Items JSON
  // (what's in the sheet right now) into it as the permanent diff baseline.
  const existingOriginal = cell(row, col.originalLineItemsJson).trim();
  const preEditLineItemsJson = cell(row, col.lineItemsJson);

  // header is row 1, rows[0] is sheet row 2 => sheet row = rowIndex + 2.
  const sheetRow = rowIndex + 2;
  const tab = sheetTab();

  const updates: { col: number | undefined; value: string | number }[] = [
    { col: col.lineItemsJson, value: JSON.stringify(items) },
    { col: col.lineItemCount, value: items.length },
    { col: col.invoiceNumber, value: payload.invoiceNumber ?? "" },
    { col: col.invoiceDate, value: payload.invoiceDate ?? "" },
    { col: col.cleaningFee, value: cleaningFee },
    { col: col.returnedTotal, value: returnedTotal },
    { col: col.status, value: "PO Edited" },
  ];
  if (col.originalLineItemsJson != null && !existingOriginal) {
    updates.push({ col: col.originalLineItemsJson, value: preEditLineItemsJson });
  }

  const data: sheets_v4.Schema$ValueRange[] = updates
    .filter((u): u is { col: number; value: string | number } => u.col != null)
    .map((u) => ({
      range: `'${tab}'!${colToA1(u.col)}${sheetRow}`,
      values: [[u.value]],
    }));

  const sheets = getSheets();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { valueInputOption: "RAW", data },
  });

  return { subtotal, returnedTotal };
}

// --- Payout details + payment-due list ------------------------------------
// Payout instructions are NOT on the submission row — they live on the "Vendor"
// tab (keyed by GHL Contact ID). The payout service now writes granular banking
// columns there (ACH/Wire fields + Bank Street/City/State/ZIP), so we PREFER
// those. Older vendors only carry a lossy projection — a single number in
// "ACH/Wire Fields" and a joined address in "Bank Address Fields" — which we
// FALL BACK to. Either way we seed the structured payout and let the editor
// fill the rest. Editing/persisting goes through the external payout service
// (see /api/po/payout) — never written here.

const VENDOR_TAB = "Vendor";
const PAYMENT_DUE_TAB = "Payment Due";

const PAYMENT_DUE_HEADERS = [
  "DateTime",
  "Submission ID",
  "GHL Contact ID",
  "Vendor Name",
  "Invoice Number",
  "Invoice Date",
  "Payment Method",
  "PO Amount",
  "PO Doc Link",
  "Status",
  // Landon wants links to BOTH the PO and the invoice. Appended LAST (never
  // inserted) so existing rows/columns stay aligned; ensureTab reconciles the
  // header onto tabs created before this column existed.
  "Invoice Link",
] as const;

// Case-insensitive, whitespace-tolerant getter over a { header: value } row.
// Returns the first non-empty match among the candidate header names.
function pickCI(row: Record<string, string>, names: string[]): string {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    lower.set(normalizeHeader(k), v);
  }
  for (const n of names) {
    const v = lower.get(normalizeHeader(n));
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Drops obviously-empty blob junk like "undefined undefined undefined".
function cleanBlob(value: string): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (/^(?:undefined|null|na|n\/a)(?:[\s,]+(?:undefined|null|na|n\/a))*$/i.test(s)) {
    return "";
  }
  return s;
}

// Joins the granular Bank Street/City/State/ZIP columns into the single
// free-text address the editor, PO PDF, and Payment Due page expect, e.g.
// "123 Main St, Springfield, IL 62704". State + ZIP share one segment (US
// convention); empty parts are dropped so a street-only value stays "123 Main
// St" and an all-empty input yields "".
function joinBankAddress(
  street: string,
  city: string,
  state: string,
  zip: string
): string {
  const stateZip = [state.trim(), zip.trim()].filter(Boolean).join(" ");
  return [street.trim(), city.trim(), stateZip].filter(Boolean).join(", ");
}

// Reads the Vendor tab as { header: value } rows. Never throws — a missing tab
// or read error yields an empty list so payout seeding degrades to blank.
async function readVendorRows(): Promise<Record<string, string>[]> {
  try {
    return await readSheetRows(sheetId(), { tab: VENDOR_TAB });
  } catch {
    return [];
  }
}

// Builds structured payout from a Vendor row (may be undefined). `method` (from
// the submission) takes precedence over the vendor's own Payment Method.
//
// PREFER the granular banking columns the payout service now writes back to the
// Vendor tab; FALL BACK to the legacy lossy blobs ("ACH/Wire Fields",
// "Bank Address Fields") for vendors captured before those columns existed.
// Every value is read as a STRING (never Number()/parseInt) so leading zeros on
// routing, account, and ZIP survive.
function seedPayout(
  vendorRow: Record<string, string> | undefined,
  method: string
): PayoutDetails {
  const p = emptyPayout();
  p.method = (method || (vendorRow ? pickCI(vendorRow, ["Payment Method"]) : "")).trim();
  if (!vendorRow) return p;

  const m = p.method.toLowerCase();
  const wireOnly = m.includes("wire") && !m.includes("ach") && !m.includes("both");

  // Granular mode is active when ANY of the exact granular columns the payout
  // service writes is non-empty. Detection uses only those exact header names,
  // so a legacy blob-only row can never accidentally trip into granular mode.
  const hasGranular = [
    "ACH Account Holder",
    "ACH Routing",
    "ACH Account Number",
    "ACH Account Type",
    "ACH Bank Name",
    "Wire Account Holder",
    "Wire Bank Name",
    "Wire Routing",
    "Wire SWIFT",
    "Wire Account Number",
    "Bank Street",
    "Bank City",
    "Bank State",
    "Bank ZIP",
  ].some((h) => pickCI(vendorRow, [h]) !== "");

  if (hasGranular) {
    // --- Granular columns (source of truth) → flat PayoutDetails ------------
    // ACH fields map to their own slots (older aliases kept as harmless
    // fallbacks).
    p.achAccountHolder = pickCI(vendorRow, ["ACH Account Holder", "ACH Account Holder Name"]);
    p.achRoutingNumber = pickCI(vendorRow, ["ACH Routing", "ACH Routing Number"]);
    p.achAccountNumber = pickCI(vendorRow, ["ACH Account Number"]);
    p.achAccountType = pickCI(vendorRow, ["ACH Account Type"]);

    // Wire fields map to their own slots. The UI/model keep a single
    // "Routing / SWIFT" slot, so collapse Wire Routing + Wire SWIFT into it
    // (routing preferred; the save path re-classifies by shape).
    p.wireBeneficiary = pickCI(vendorRow, [
      "Wire Account Holder",
      "Wire Account Holder Name",
      "Wire Beneficiary",
      "Beneficiary",
    ]);
    p.wireRoutingSwift =
      pickCI(vendorRow, ["Wire Routing", "Wire Routing Number"]) ||
      pickCI(vendorRow, ["Wire SWIFT", "SWIFT"]);
    p.wireAccountNumber = pickCI(vendorRow, ["Wire Account Number"]);

    // One shared bank-name slot: pick the method-appropriate column, falling
    // back to the other so an ACH-only (or wire-only) payout still carries it.
    const achBankName = pickCI(vendorRow, ["ACH Bank Name"]);
    const wireBankName = pickCI(vendorRow, ["Wire Bank Name", "Bank Name"]);
    p.wireBankName = wireOnly ? wireBankName || achBankName : achBankName || wireBankName;

    // Assemble the single address string from the granular parts; fall back to
    // the legacy address blob if the parts are empty (never lose an address).
    p.bankAddress =
      joinBankAddress(
        pickCI(vendorRow, ["Bank Street"]),
        pickCI(vendorRow, ["Bank City"]),
        pickCI(vendorRow, ["Bank State"]),
        pickCI(vendorRow, ["Bank ZIP", "Bank Zip"])
      ) || cleanBlob(pickCI(vendorRow, ["Bank Address Fields", "Bank Address"]));

    return p;
  }

  // --- Legacy blob fallback (unchanged behavior) ---------------------------
  // Old rows carry only a joined address in "Bank Address Fields" and a single
  // number in "ACH/Wire Fields". Seed that number into the routing field of
  // whichever method applies.
  p.bankAddress = cleanBlob(pickCI(vendorRow, ["Bank Address Fields", "Bank Address"]));

  const blob = cleanBlob(pickCI(vendorRow, ["ACH/Wire Fields"]));
  if (blob) {
    if (wireOnly) {
      if (!p.wireRoutingSwift) p.wireRoutingSwift = blob;
    } else if (!p.achRoutingNumber) {
      p.achRoutingNumber = blob;
    }
  }
  return p;
}

// Resolves one vendor's payout by Contact ID (reads the whole small Vendor tab).
async function resolveVendorPayout(
  contactId: string,
  method: string
): Promise<PayoutDetails> {
  const id = (contactId ?? "").trim();
  if (!id) return seedPayout(undefined, method);
  const rows = await readVendorRows();
  const match = rows.find((r) => pickCI(r, ["GHL Contact ID"]).trim() === id);
  return seedPayout(match, method);
}

// Maps one Vendor-tab row to a payout match for the /customer-payouts tool, or
// null when the row has no GHL Contact ID — that id is the key the payout
// service writes/reads by, so a row without one can't be pre-filled or saved.
// Shared by search + recent so both surface identical fields (incl. the seeded
// payout, so the card opens pre-filled and "On file" badges are accurate).
function vendorRowToPayoutMatch(
  r: Record<string, string>
): VendorPayoutMatch | null {
  const contactId = pickCI(r, ["GHL Contact ID"]);
  if (!contactId) return null;
  const method = pickCI(r, ["Payment Method"]);
  return {
    contactId,
    name: [pickCI(r, ["First Name"]), pickCI(r, ["Last Name"])]
      .filter(Boolean)
      .join(" ")
      .trim(),
    businessName: pickCI(r, ["Business Name"]),
    email: pickCI(r, ["Email"]),
    method,
    vendorStatus: pickCI(r, ["Vendor Status"]),
    payout: seedPayout(r, method),
  };
}

// Searches the Vendor tab for the owner's /customer-payouts tool. Matches a free
// query against name / business name / email (case-insensitive substring) — the
// tab has no Vendor ID column (it's keyed by the internal GHL Contact ID), so
// those human-readable fields are what Landon searches by. Rows without a GHL
// Contact ID are skipped (no key to save payout against).
export async function searchVendorPayouts(
  query: string
): Promise<VendorPayoutMatch[]> {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [];
  const rows = await readVendorRows();
  const matches: VendorPayoutMatch[] = [];
  for (const r of rows) {
    const m = vendorRowToPayoutMatch(r);
    if (!m) continue;
    const haystack = [m.name, m.businessName, m.email].join(" ").toLowerCase();
    if (!haystack.includes(q)) continue;
    matches.push(m);
    if (matches.length >= 25) break; // small cap — this is a lookup, not a list
  }
  return matches;
}

// The N most-recently-touched customers for the /customer-payouts landing list,
// newest-first by "Last Modified" (falling back to "Created Date" when blank,
// then to original sheet order). Same shape as search so the page renders both
// the same way.
export async function listRecentVendorPayouts(
  limit = 20
): Promise<VendorPayoutMatch[]> {
  const rows = await readVendorRows();
  const ranked: { match: VendorPayoutMatch; recency: string; order: number }[] =
    [];
  rows.forEach((r, order) => {
    const match = vendorRowToPayoutMatch(r);
    if (!match) return;
    const recency = pickCI(r, ["Last Modified"]) || pickCI(r, ["Created Date"]);
    ranked.push({ match, recency, order });
  });
  ranked.sort((a, b) => {
    const byDate = compareRecency(a.recency, b.recency);
    return byDate !== 0 ? byDate : b.order - a.order;
  });
  return ranked.slice(0, Math.max(0, limit)).map((x) => x.match);
}

// Ensures a tab exists with the given header row; creates it (with the header)
// on first use. When the tab already exists, reconciles the header row by
// appending any MISSING headers to the right — existing columns are never
// reordered or overwritten, so old rows stay readable. Safe to call repeatedly.
async function ensureTab(title: string, headers: readonly string[]): Promise<void> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId(),
    fields: "sheets(properties(title))",
  });
  const exists = (meta.data.sheets ?? []).some(
    (s) => normalizeHeader(s.properties?.title ?? "") === normalizeHeader(title)
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId(),
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId(),
      range: `'${title}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers as string[]] },
    });
    return;
  }

  // Tab exists — append any headers it doesn't already have (e.g. a newly added
  // "Invoice Link") at the first empty column, leaving A..last untouched.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `'${title}'!1:1`,
  });
  const current = ((res.data.values?.[0] as string[] | undefined) ?? []).map((h) =>
    String(h ?? "")
  );
  const have = new Set(current.map(normalizeHeader));
  const missing = headers.filter((h) => !have.has(normalizeHeader(h)));
  if (!missing.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `'${title}'!${colToA1(current.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [missing] },
  });
}

// Appends one "payment due" row when a PO is generated. Deliberately stores only
// non-sensitive fields (method, amount, links, ids) — NOT account/routing
// numbers, which the owner page resolves live from the vendor master.
export async function appendPaymentDue(entry: {
  submissionId: string;
  contactId: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  method: string;
  amount: number;
  poLink: string;
  invoiceLink: string;
}): Promise<void> {
  await ensureTab(PAYMENT_DUE_TAB, PAYMENT_DUE_HEADERS);
  const sheets = getSheets();
  // Order MUST match PAYMENT_DUE_HEADERS; "Invoice Link" is the last column.
  const rowValues = [
    new Date().toISOString(),
    entry.submissionId,
    entry.contactId,
    entry.vendorName,
    entry.invoiceNumber,
    entry.invoiceDate,
    entry.method,
    round2(entry.amount),
    entry.poLink,
    "Payment Due",
    entry.invoiceLink,
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `'${PAYMENT_DUE_TAB}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
}

// Reads the payment-due list, newest-first, resolving each row's payout details
// live from the vendor master (so account numbers live in exactly one place).
export async function getPaymentDue(): Promise<PaymentDueEntry[]> {
  let rows: Record<string, string>[];
  try {
    rows = await readSheetRows(sheetId(), { tab: PAYMENT_DUE_TAB });
  } catch {
    return []; // tab not created yet → empty list
  }
  if (!rows.length) return [];

  const vendorRows = await readVendorRows();
  const vendorByContact = new Map<string, Record<string, string>>();
  for (const vr of vendorRows) {
    const cid = pickCI(vr, ["GHL Contact ID"]).trim();
    if (cid && !vendorByContact.has(cid)) vendorByContact.set(cid, vr);
  }

  const mapped = rows.map((r, order) => {
    const contactId = pickCI(r, ["GHL Contact ID"]);
    const method = pickCI(r, ["Payment Method"]);
    const vendorRow = contactId ? vendorByContact.get(contactId) : undefined;
    const dateTime = pickCI(r, ["DateTime"]);
    const entry: PaymentDueEntry = {
      dateTime,
      submissionId: pickCI(r, ["Submission ID"]),
      contactId,
      vendorName: pickCI(r, ["Vendor Name"]),
      invoiceNumber: pickCI(r, ["Invoice Number"]),
      invoiceDate: pickCI(r, ["Invoice Date"]),
      amount: toNum(pickCI(r, ["PO Amount"]).replace(/[$,]/g, "")),
      poLink: pickCI(r, ["PO Doc Link"]),
      invoiceLink: pickCI(r, ["Invoice Link"]),
      status: pickCI(r, ["Status"]) || "Payment Due",
      payout: seedPayout(vendorRow, method),
    };
    return { entry, dateTime, order };
  });

  mapped.sort((a, b) => {
    const byDate = compareRecency(a.dateTime, b.dateTime);
    return byDate !== 0 ? byDate : b.order - a.order;
  });
  return mapped.map((m) => m.entry);
}

// --- PO history log -------------------------------------------------------
// A flat, chronological record of every PO PDF generated, so there's one place
// to browse/re-download every PO produced. Appended best-effort from the pdf
// route; a failure here never blocks the PO (which is already filed to Drive).

const PO_HISTORY_TAB = "PO History";

const PO_HISTORY_HEADERS = [
  "PO Number",
  "Vendor Name",
  "Date",
  "Amount",
  "Drive Link",
  "Submission ID",
] as const;

// Appends one PO History row. Creates the tab (with headers) on first use.
export async function appendPORecord(record: {
  poNumber: string;
  vendorName: string;
  amount: number;
  driveLink: string;
  submissionId: string;
}): Promise<void> {
  await ensureTab(PO_HISTORY_TAB, PO_HISTORY_HEADERS);
  const sheets = getSheets();
  const rowValues = [
    record.poNumber,
    record.vendorName,
    new Date().toISOString(),
    round2(record.amount),
    record.driveLink,
    record.submissionId,
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `'${PO_HISTORY_TAB}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
}

// Reads the PO history, newest-first. Never throws — a missing tab (no PO ever
// generated) yields an empty list.
export async function getPOHistory(): Promise<POHistoryRecord[]> {
  let rows: Record<string, string>[];
  try {
    rows = await readSheetRows(sheetId(), { tab: PO_HISTORY_TAB });
  } catch {
    return []; // tab not created yet → empty list
  }
  if (!rows.length) return [];

  const mapped = rows.map((r, order) => {
    const date = pickCI(r, ["Date"]);
    const record: POHistoryRecord = {
      poNumber: pickCI(r, ["PO Number"]),
      vendorName: pickCI(r, ["Vendor Name"]),
      date,
      amount: toNum(pickCI(r, ["Amount"]).replace(/[$,]/g, "")),
      driveLink: pickCI(r, ["Drive Link"]),
      submissionId: pickCI(r, ["Submission ID"]),
    };
    return { record, date, order };
  });

  mapped.sort((a, b) => {
    const byDate = compareRecency(a.date, b.date);
    return byDate !== 0 ? byDate : b.order - a.order;
  });
  return mapped.map((m) => m.record);
}

// --- Generic reader -------------------------------------------------------
// Used by the catalog module to read an arbitrary spreadsheet/tab through the
// same service account. Lives here so all Sheets API access stays in one file.

// Resolves a tab's title from its numeric gid via spreadsheet metadata.
async function resolveSheetTitleByGid(
  spreadsheetId: string,
  gid: number
): Promise<string> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const match = (res.data.sheets ?? []).find(
    (s) => s.properties?.sheetId === gid
  );
  const title = match?.properties?.title;
  if (!title) {
    throw new Error(`No tab with gid ${gid} found in that spreadsheet`);
  }
  return title;
}

// Reads an arbitrary tab as an array of { header: value } row objects (header
// taken from row 1). Identify the tab by name (`tab`) or numeric `gid`.
export async function readSheetRows(
  spreadsheetId: string,
  opts: { tab?: string; gid?: number }
): Promise<Record<string, string>[]> {
  let tab = opts.tab?.trim();
  if (!tab && opts.gid != null) {
    tab = await resolveSheetTitleByGid(spreadsheetId, opts.gid);
  }
  if (!tab) {
    throw new Error("readSheetRows requires a tab name or gid");
  }

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'`,
  });
  const values = (res.data.values as string[][] | undefined) ?? [];
  if (values.length < 2) return [];

  const [header, ...rows] = values;
  const keys = header.map((h) => String(h ?? "").trim());
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (k) obj[k] = row[i] == null ? "" : String(row[i]);
    });
    return obj;
  });
}
