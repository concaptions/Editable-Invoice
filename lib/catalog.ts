// Live product-catalog access.
//
// The catalog lives in a Google Sheet (env CATALOG_SHEET_ID + CATALOG_SHEET_GID,
// or CATALOG_SHEET_TAB), read server-side through the same service account as the
// Submissions sheet and cached in memory for ~5 minutes.
//
// ALL sheet-shape knowledge lives in normalizeCatalogItem(): if the catalog's
// column or price-header names change, edit that one function. The rest of the
// app depends only on the normalized CatalogItem shape.

import "server-only";
import type { CatalogItem } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

// The catalog is served as JSON by a Google Apps Script web app that reads the
// catalog sheet and emits already-normalized rows:
//   { items: [{ id, label, drug, ndc, isGroup, category, prices: {...} }] }
// Override with CATALOG_FEED_URL; the default is Landon's published endpoint so
// the app works on Railway without extra env config.
const DEFAULT_CATALOG_FEED_URL =
  "https://script.google.com/macros/s/AKfycbyvHo-56_8Rq2nQxQM1aPtsLyVmC8YkM3wv_cwjIlGRXk-SKKJwU4zY2L2HSyA_YdPJZw/exec";

function catalogFeedUrl(): string {
  const url = process.env.CATALOG_FEED_URL;
  return url && url.trim() ? url.trim() : DEFAULT_CATALOG_FEED_URL;
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

// Finds the price cell for a condition. Price headers contain the condition plus
// an expiry window (e.g. "Mint 9m+", "Ding 6-8m"), so we match by keyword.
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
  return s === "true" || s === "1" || s === "yes" || s === "✓" || s === "✔";
}

// THE single place that maps a raw catalog row to the normalized CatalogItem.
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
  const label =
    readString(raw, ["label", "Label", "displayName", "description"], ["label"]) ||
    drug;

  // No dedicated strength column in the catalog: the strength/pack lives inside
  // the label (e.g. "Aptiom 200 200mg, 30 count"). Derive it by stripping the
  // leading drug name so `drug + ' ' + strength` reconstructs the label.
  let strength = readString(
    raw,
    ["strength", "Strength", "dose", "dosage"],
    ["strength", "dosage", "dose"]
  );
  if (!strength && label) {
    const d = drug.trim();
    strength =
      d && label.toLowerCase().startsWith(d.toLowerCase())
        ? label.slice(d.length).replace(/^[\s,–—-]+/, "").trim()
        : label.trim();
  }

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

let cache: { items: CatalogItem[]; fetchedAt: number } | null = null;
let inflight: Promise<CatalogItem[]> | null = null;

async function fetchCatalog(): Promise<CatalogItem[]> {
  // We manage our own ~5-min cache below, so don't let Next cache this fetch.
  const res = await fetch(catalogFeedUrl(), {
    cache: "no-store",
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Catalog feed returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as { items?: unknown };
  const rows = Array.isArray(data.items) ? data.items : [];
  return rows
    .map((r) => normalizeCatalogItem(r as RawRow))
    .filter((it) => it.drug || it.ndc || it.catalogId);
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
