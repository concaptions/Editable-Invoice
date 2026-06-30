// Shared types for the direct Google Sheets + catalog data layer.

export type Condition = "MINT" | "DING" | "DAMAGE";

export const CONDITIONS: Condition[] = ["MINT", "DING", "DAMAGE"];

export const CONDITION_HELP = "Mint = 9m+, Ding = 6–8m, Damage = 3–5m";

// Quick-fill reasons for a line's poNote. "Other" requires free text.
export const REASON_PRESETS = [
  "Sample – not purchased",
  "Condition downgraded",
  "Repriced to current sheet",
  "Cleaning fee applied",
  "Courtesy item over limit",
  "Other",
] as const;

// Verbatim grading reference shown inline (collapsible) so Landon can grade
// without leaving the page. Title + body rendered as-is.
export interface ConditionReference {
  title: string;
  body: string;
}

export const CONDITION_REFERENCE: ConditionReference[] = [
  {
    title: "MINT CONDITION",
    body:
      "Pristine. Just came off the assembly line at the manufacturer or out of the box at the pharmacy. No rips, stains, tears, label damage, sharpie, pen marks, pen indentations, alcohol stops, dull patches, exp date damage, popped seals, melted seals. No damage of any kind. For most items one small defect is acceptable. Nothing larger than a quarter unless it is a minor crease. No stain of any kind will pass as mint.",
  },
  {
    title: "DINGS",
    body:
      "2 or more defects of any kind. No large tears, stains, reglued boxes, exp-date damage, popped seals, torn seal serrations, separation of top layer of box. No distortion of the shape of the box or discoloration. The type of condition you wouldn't question if receiving it from a pharmacy.",
  },
  {
    title: "DAMAGED",
    body:
      "Major: tears, rips, crushing/dents, creases in multiple areas, distortion of the shape of the box. Any: stain, discoloration, exp-date damage, popped seals, water spots, resealed boxes, torn serrations, sharpie, pen marks, excessive odor.",
  },
  {
    title: "SAMPLE PRODUCTS",
    body:
      'No sample products whatsoever. Check the NDC on the box. Sample products tend to be the lowest dose, say "sample not for resale", are missing the NDC next to the expiration date, may be in a different form of packaging or count.',
  },
];

// A line item as stored (stringified) in the sheet's `Line Items JSON` column.
// `amount` is always derived = round(quantity * rate, 2).
// `item` is a display string = (drug + ' ' + strength).trim().
// `ndc`/`catalogId`/`category` are optional extras carried over from the catalog.
//
// EVERY key here is preserved on read and write — the form (intake) writes
// `customerNote`/`cleaningFee` and the editor must never drop them. The cleaning
// fee is invoice-level now, so per-item `cleaningFee` stays 0 (kept for the PDF
// contract / round-trip fidelity).
export interface LineItem {
  item?: string;
  drug: string;
  strength: string;
  expiry: string;
  condition: Condition;
  quantity: number;
  rate: number;
  amount: number;
  // The vendor's per-item note (read-only in the editor).
  customerNote?: string;
  // Landon's note on the line. Reject / Sample / reason presets all write here.
  poNote?: string;
  // Rejected line: rate + amount forced to 0, reason required in poNote.
  rejected?: boolean;
  // Per-item cleaning fee — always 0; the cleaning fee is invoice-level (§4).
  cleaningFee?: number;
  ndc?: string;
  catalogId?: string;
  category?: string;
  // Per-condition catalog prices captured when the item was added from the
  // catalog, so changing `condition` can re-fill `rate` without a price lookup.
  prices?: CatalogPrices;
}

// A proof file the vendor uploaded (price-match evidence), paired name + link.
export interface ProofFile {
  name: string;
  url: string;
}

// A single row returned by /api/po/search.
export interface SearchResult {
  submissionId: string;
  contactId: string;
  vendorName: string;
  email: string;
  telegram: string;
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
  // Current subtotal of the stored line items.
  total: number;
  lineItems: LineItem[];
  // The vendor's overall note (read-only, `Customer Note` column).
  customerNote: string;
  // Price-match proof files (`File Links` / `File Names`); usually empty.
  proofFiles: ProofFile[];
  // Invoice-level cleaning fee deduction (`Cleaning Fee` column). Default 0.
  cleaningFee: number;
  // Last saved Returned Total (`Returned Total` column); 0 until first save.
  returnedTotal: number;
  // The vendor's original total (`Estimated Total`) — the diff baseline; never
  // overwritten by the editor.
  estimatedTotal: number;
  // Snapshot of the line items as first received (`Original Line Items JSON`),
  // captured once on the first save. Empty until then — fall back to the loaded
  // line items as the in-session diff baseline.
  originalLineItems: LineItem[];
}

// Payload sent to /api/po/save (full edited state for one submission).
export interface SavePayload {
  submissionId: string;
  invoiceNumber: string;
  invoiceDate: string;
  lineItems: LineItem[];
  cleaningFee: number;
}

export interface SaveResponse {
  ok: boolean;
  // `total` is the Returned Total (subtotal − cleaning fee).
  total?: number;
  subtotal?: number;
  cleaningFee?: number;
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
