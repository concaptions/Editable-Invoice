// Shared types for the direct Google Sheets + catalog data layer.

export type Condition = "MINT" | "DING" | "DAMAGE";

export const CONDITIONS: Condition[] = ["MINT", "DING", "DAMAGE"];

export const CONDITION_HELP = "Mint = 9m+, Ding = 6–8m, Damage = 3–5m";

// A line item as stored (stringified) in the sheet's `Line Items JSON` column.
// `amount` is always derived = round(quantity * rate, 2).
// `item` is a display string = (drug + ' ' + strength).trim().
// `ndc`/`catalogId`/`category` are optional extras carried over from the catalog.
export interface LineItem {
  item?: string;
  drug: string;
  strength: string;
  expiry: string;
  condition: Condition;
  quantity: number;
  rate: number;
  amount: number;
  ndc?: string;
  catalogId?: string;
  category?: string;
}

// A single row returned by /api/po/search.
export interface SearchResult {
  submissionId: string;
  contactId: string;
  vendorName: string;
  email: string;
  invoiceNumber: string;
  invoiceDate: string;
  total: number;
  status: string;
  lineItemCount: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

// Full invoice returned by /api/po/get.
export interface InvoiceDetail {
  submissionId: string;
  contactId: string;
  vendorName: string;
  email: string;
  telegram?: string;
  paymentMethod: string;
  carrier: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: string;
  total: number;
  lineItems: LineItem[];
}

// Payload sent to /api/po/save (full edited state for one submission).
export interface SavePayload {
  submissionId: string;
  invoiceNumber: string;
  invoiceDate: string;
  lineItems: LineItem[];
}

export interface SaveResponse {
  ok: boolean;
  total?: number;
  error?: string;
}

// Normalized catalog item — the ONLY catalog shape the rest of the app sees.
// A null price means "no price set": render as an editable blank, never $0.
export interface CatalogPrices {
  MINT: number | null;
  DING: number | null;
  DAMAGE: number | null;
}

export interface CatalogItem {
  catalogId: string;
  ndc: string;
  drug: string;
  strength: string;
  category: string;
  isGroup: boolean;
  prices: CatalogPrices;
}

export interface CatalogResponse {
  items: CatalogItem[];
}
