// Shared types mirroring the n8n backend contract.

export type Condition = "MINT" | "DING" | "DAMAGE";

export const CONDITIONS: Condition[] = ["MINT", "DING", "DAMAGE"];

export const CONDITION_HELP =
  "Mint = 9m+, Ding = 6–8m, Damage = 3–5m";

// Line item as it travels over the wire (to/from n8n). `amount` is always derived.
export interface LineItem {
  drug: string;
  strength: string;
  expiry: string;
  condition: Condition;
  quantity: number;
  rate: number;
  amount: number;
}

// A single row from the search endpoint.
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

// Full invoice loaded from the get endpoint.
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

// Payload sent to the approve endpoint (full edited state).
export interface ApprovePayload {
  submissionId: string;
  invoiceNumber: string;
  invoiceDate: string;
  sendToCustomer: boolean;
  lineItems: LineItem[];
}

export interface ApproveResponse {
  ok: boolean;
  total?: number;
  poLink?: string;
  error?: string;
}
