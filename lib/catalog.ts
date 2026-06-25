// Live product-catalog feed access.
//
// The catalog is a read-only JSON feed served from a Google Apps Script web app
// (env CATALOG_FEED_URL) — the same feed the customer form uses (~700 rows).
// It is fetched server-side and cached in memory for ~5 minutes.
//
// ALL feed-shape knowledge lives in normalizeCatalogItem(): if the live feed's
// field or price-key names change, edit that one function. The rest of the app
// depends only on the normalized CatalogItem shape.

import "server-only";
import type { CatalogItem } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

function feedUrl(): string {
  const url = process.env.CATALOG_FEED_URL;
  if (!url) throw new Error("CATALOG_FEED_URL is not set");
  return url;
}

type RawRow = Record<string, unknown>;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, " ");
}

// Reads a string field, trying exact (normalized) header matches first, then a
// loose "key contains substring" fallback. Reads by bracket key throughout.
function readString(raw: RawRow, exact: string[], contains: string[] = []): string {
  const entries = Object.keys(raw).map((k) => [normalizeKey(k), k] as const);
  for (const want of exact) {
    const w = normalizeKey(want);
    const hit = entries.find(([nk]) => nk === w);
    if (hit) {
      const v = raw[hit[1]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  for (const sub of contains) {
    const s = normalizeKey(sub);
    const hit = entries.find(([nk]) => nk.includes(s));
    if (hit) {
      const v = raw[hit[1]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  return "";
}

// Parses a price into a number, or null when truly unset.
// Null/undefined/empty => null (an editable blank — NEVER rendered as $0).
function parsePrice(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Finds the price cell for a condition. Price keys contain spaces + an expiry
// window (e.g. "Mint Price (9m+)"), so we match by keyword on the bracket key.
function readPrice(raw: RawRow, keyword: string): number | null {
  // Support a nested prices object too: { prices: { MINT: 60 } }.
  const nested = raw.prices;
  if (nested && typeof nested === "object") {
    const np = nested as RawRow;
    for (const k of Object.keys(np)) {
      if (normalizeKey(k).includes(keyword)) return parsePrice(np[k]);
    }
  }
  const keys = Object.keys(raw);
  // Prefer a key that mentions both the condition and a price/window hint.
  const strong = keys.find((k) => {
    const nk = normalizeKey(k);
    return nk.includes(keyword) && /(price|\$|m\+|m\b|month)/.test(nk);
  });
  if (strong) return parsePrice(raw[strong]);
  const loose = keys.find((k) => normalizeKey(k).includes(keyword));
  return loose ? parsePrice(raw[loose]) : null;
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// THE single place that maps a raw feed row to the normalized CatalogItem shape.
export function normalizeCatalogItem(raw: RawRow): CatalogItem {
  const catalogId = readString(
    raw,
    ["catalogId", "catalog_id", "id", "ID", "rowId", "sku"],
    ["catalog id", "id"]
  );
  const ndc = readString(raw, ["ndc", "NDC"], ["ndc"]);
  const drug = readString(
    raw,
    ["drug", "drugName", "Drug Name", "name", "product", "Product", "medication"],
    ["drug", "product", "name", "medication"]
  );
  const strength = readString(
    raw,
    ["strength", "Strength", "dose", "dosage"],
    ["strength", "dosage", "dose"]
  );
  const category = readString(
    raw,
    [
      "category",
      "Category",
      "deliveryMethod",
      "Delivery Method",
      "delivery",
      "method",
      "form",
      "type",
    ],
    ["category", "delivery", "method", "form", "type"]
  );

  const label = readString(raw, ["label", "Label", "displayName"], ["label"]) || drug;
  const isGroup =
    truthy(raw.isGroup ?? raw.is_group ?? raw.group) ||
    /[-—]\s*all$/i.test(label.trim()) ||
    /-99$/.test(ndc.trim());

  return {
    catalogId,
    ndc,
    drug,
    strength,
    category,
    isGroup,
    prices: {
      MINT: readPrice(raw, "mint"),
      DING: readPrice(raw, "ding"),
      DAMAGE: readPrice(raw, "damage"),
    },
  };
}

function extractRows(payload: unknown): RawRow[] {
  if (Array.isArray(payload)) return payload as RawRow[];
  if (payload && typeof payload === "object") {
    const obj = payload as RawRow;
    for (const key of ["items", "products", "rows", "data", "catalog", "results"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as RawRow[];
    }
  }
  return [];
}

let cache: { items: CatalogItem[]; fetchedAt: number } | null = null;
let inflight: Promise<CatalogItem[]> | null = null;

async function fetchCatalog(): Promise<CatalogItem[]> {
  const res = await fetch(feedUrl(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Catalog feed returned ${res.status}`);
  }
  const payload = (await res.json()) as unknown;
  return extractRows(payload).map(normalizeCatalogItem);
}

export async function getCatalog(): Promise<CatalogItem[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items;
  }
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .then((items) => {
      cache = { items, fetchedAt: Date.now() };
      return items;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
