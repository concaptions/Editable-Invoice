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
  type CatalogPrices,
  type Condition,
  type InvoiceDetail,
  type LineItem,
  type ProofFile,
  type SavePayload,
  type SearchResult,
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
// Exported so the Drive module can authenticate with the same credentials.
export function getServiceAccount(): {
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
  return {
    submissionId: cell(row, col.submissionId),
    contactId: cell(row, col.contactId),
    vendorName: cell(row, col.vendorName),
    email: cell(row, col.email),
    telegram: cell(row, col.telegram) || undefined,
    paymentMethod: cell(row, col.paymentMethod),
    carrier: cell(row, col.carrier),
    invoiceNumber: cell(row, col.invoiceNumber),
    invoiceDate: cell(row, col.invoiceDate),
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
  const cleaningFee = Math.max(0, round2(toNum(payload.cleaningFee)));
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
