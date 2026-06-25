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
  type Condition,
  type InvoiceDetail,
  type LineItem,
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
function getServiceAccount(): { client_email: string; private_key: string } {
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

// Parses the `Line Items JSON` cell into normalized line items (amount derived).
function parseLineItems(raw: string): LineItem[] {
  if (!raw || !raw.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    const drug = typeof o.drug === "string" ? o.drug : "";
    const strength = typeof o.strength === "string" ? o.strength : "";
    const quantity = toNum(o.quantity as string | number);
    const rate = toNum(o.rate as string | number);
    const item: LineItem = {
      item:
        typeof o.item === "string" && o.item.trim()
          ? o.item
          : `${drug} ${strength}`.trim(),
      drug,
      strength,
      expiry: typeof o.expiry === "string" ? o.expiry : "",
      condition: normalizeCondition(o.condition),
      quantity,
      rate,
      amount: round2(quantity * rate),
    };
    if (typeof o.ndc === "string" && o.ndc) item.ndc = o.ndc;
    if (typeof o.catalogId === "string" && o.catalogId) item.catalogId = o.catalogId;
    if (typeof o.category === "string" && o.category) item.category = o.category;
    return item;
  });
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

export async function searchSubmissions(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const { rows, col } = await readGrid();
  if (col.submissionId == null) {
    throw new Error('Sheet is missing the "Submission ID" column');
  }

  const matches: { result: SearchResult; dateTime: string; order: number }[] = [];

  rows.forEach((row, order) => {
    const lineItems = parseLineItems(cell(row, col.lineItemsJson));
    // Only rows that actually have line items are editable invoices.
    if (lineItems.length === 0) return;

    const contactId = cell(row, col.contactId);
    const vendorName = cell(row, col.vendorName);
    const haystack = `${contactId} ${vendorName}`.toLowerCase();
    if (!haystack.includes(q)) return;

    matches.push({
      order,
      dateTime: cell(row, col.dateTime),
      result: {
        submissionId: cell(row, col.submissionId),
        contactId,
        vendorName,
        email: cell(row, col.email),
        invoiceNumber: cell(row, col.invoiceNumber),
        invoiceDate: cell(row, col.invoiceDate),
        total: lineItemsTotal(lineItems),
        status: cell(row, col.status),
        lineItemCount: lineItems.length,
      },
    });
  });

  matches.sort((a, b) => {
    const byDate = compareRecency(a.dateTime, b.dateTime);
    return byDate !== 0 ? byDate : b.order - a.order;
  });

  return matches.map((m) => m.result);
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
  };
}

// Writes the edited state back to the matched row. Touches ONLY these columns:
// Line Items JSON, Line Item Count, Estimated Total, Invoice Number, Invoice Date.
// Returns the recomputed total.
export async function saveSubmission(payload: SavePayload): Promise<number> {
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

  // Recompute amounts + item label, then total. Preserve optional extras.
  const items: LineItem[] = (
    Array.isArray(payload.lineItems) ? payload.lineItems : []
  ).map((raw) => {
    const drug = typeof raw.drug === "string" ? raw.drug.trim() : "";
    const strength = typeof raw.strength === "string" ? raw.strength.trim() : "";
    const quantity = toNum(raw.quantity);
    const rate = toNum(raw.rate);
    const item: LineItem = {
      item: `${drug} ${strength}`.trim(),
      drug,
      strength,
      expiry: typeof raw.expiry === "string" ? raw.expiry.trim() : "",
      condition: normalizeCondition(raw.condition),
      quantity,
      rate,
      amount: round2(quantity * rate),
    };
    if (typeof raw.ndc === "string" && raw.ndc) item.ndc = raw.ndc;
    if (typeof raw.catalogId === "string" && raw.catalogId)
      item.catalogId = raw.catalogId;
    if (typeof raw.category === "string" && raw.category)
      item.category = raw.category;
    return item;
  });

  const total = lineItemsTotal(items);

  // header is row 1, rows[0] is sheet row 2 => sheet row = rowIndex + 2.
  const sheetRow = rowIndex + 2;
  const tab = sheetTab();

  const updates: { col: number | undefined; value: string | number }[] = [
    { col: col.lineItemsJson, value: JSON.stringify(items) },
    { col: col.lineItemCount, value: items.length },
    { col: col.estimatedTotal, value: total },
    { col: col.invoiceNumber, value: payload.invoiceNumber ?? "" },
    { col: col.invoiceDate, value: payload.invoiceDate ?? "" },
  ];

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

  return total;
}
