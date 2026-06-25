# LVDTS Invoice / PO Editor

A small, private internal web app for the founder of **Las Vegas Diabetic Test Strips LLC (LVDTS)** to review, edit, and save purchase orders / invoices.

Customers submit invoices through a separate portal; each submission's line items are stored as JSON in a row of a Google Sheet. This tool lets the founder **search a submission, see the line items, edit them — including pulling items from a live product catalog — and save the edits straight back to the Sheet.**

That is the whole job: **read sheet + catalog → edit → write sheet.** There is **no n8n, no PDF generation, and no email** in this app.

## Architecture

```
Browser (founder)  ->  Next.js Route Handlers (/app/api/*)  ->  Google Sheets API (read/write)
                                                           ->  Catalog feed URL  (read-only JSON)
```

- All Google Sheets access and the catalog fetch happen **server-side** in route handlers. The browser only calls same-origin `/api/*`.
- No service-account key, sheet ID, catalog URL, passcode, or session secret ever reaches the client bundle (nothing is prefixed `NEXT_PUBLIC_`).

### Tech stack
- Next.js (App Router) + TypeScript + Tailwind CSS
- Google Sheets via the official [`googleapis`](https://www.npmjs.com/package/googleapis) package, authenticated with a **service account** (JWT)
- No database — the Google Sheet is the source of truth

### Key files
| Path | Purpose |
| --- | --- |
| `middleware.ts` | Protects every route except `/login` and `/api/auth/login` |
| `lib/session.ts` | Signed session cookie (HMAC via Web Crypto; runs in Edge + Node) |
| `lib/auth-guard.ts` | Per-route 401 guard for the API handlers |
| `lib/sheets.ts` | **The single Sheets-access module** — service-account auth, header-row column resolution, search/get/save |
| `lib/catalog.ts` | Catalog feed fetch + cache; **the single `normalizeCatalogItem()`** |
| `app/api/auth/*` | Login / logout |
| `app/api/po/search` | `GET ?q=` → matching submissions that have line items |
| `app/api/po/get` | `GET ?submissionId=` → one submission + parsed line items |
| `app/api/po/save` | `POST` → write edited line items + meta back to the row |
| `app/api/catalog` | `GET` → normalized catalog for the item picker |
| `app/login/page.tsx` | Passcode gate |
| `app/page.tsx` | Search screen |
| `app/po/[submissionId]/page.tsx` + `components/PoEditor.tsx` | Invoice editor |

## Auth

A single passcode gate (one user — the founder):

1. `/login` posts the passcode to `/api/auth/login`, which compares it server-side to `APP_PASSCODE`.
2. On success it sets an **httpOnly, sameSite=lax, signed** session cookie (`secure` in production). The cookie is an HMAC of the issued-at timestamp using `SESSION_SECRET`, with a ~12h expiry.
3. `middleware.ts` redirects unauthenticated page requests to `/login` and returns `401` for unauthenticated API requests. Each `/api/*` data route independently re-checks the cookie.
4. "Log out" (top-right) clears the cookie.

### Future: Google OAuth seam
The passcode check is intentionally isolated so it can later be swapped for Google OAuth restricted to the founder's email **without touching the rest of the app**. The seam is the cookie issued by `app/api/auth/login/route.ts` and verified in `lib/session.ts` / `middleware.ts`. OAuth is **not** built yet.

## Google Sheets — connection & schema

- Spreadsheet ID comes from `SHEET_ID`; the worksheet/tab name from `SHEET_TAB` (default `Submissions`).
- Authenticated with a **service account**; the full key JSON is supplied via `GOOGLE_SERVICE_ACCOUNT_JSON`. Scope: `https://www.googleapis.com/auth/spreadsheets`.
- **You must share the spreadsheet with the service-account email (`client_email` in the key JSON) as an _Editor_** — otherwise reads/writes fail with a permission error.

Columns are resolved by **header name** (read from the first row), not by fixed letters, so the sheet can be reordered. Relevant headers:

| Header | Use |
| --- | --- |
| `Submission ID` | unique key for a row |
| `GHL Contact ID` | searchable ("vendor ID") |
| `Vendor Name` | searchable |
| `Email`, `Telegram`, `Payment Method`, `Carrier`, `Status` | display |
| `Invoice Number`, `Invoice Date` | editable |
| `Estimated Total` | written on save (recomputed) |
| `Line Items JSON` | the editable payload (stringified array) |
| `Line Item Count` | written on save (= number of line items) |
| `DateTime` | left as-is; used to sort results most-recent first |

An **invoice** is a row whose `Line Items JSON` is a non-empty array. Rows without line items do not appear in search results.

**Saving** updates only these cells of the matched row (found by `Submission ID`): `Line Items JSON`, `Line Item Count`, `Estimated Total`, `Invoice Number`, `Invoice Date`. All other columns are left untouched.

## Catalog feed — connection & rules

- A live JSON feed served from a Google Apps Script web app (`CATALOG_FEED_URL`), fetched server-side and cached in memory for ~5 minutes.
- All feed-shape knowledge lives in **one** function, `normalizeCatalogItem()` in `lib/catalog.ts`, which maps each raw row to:
  ```ts
  { catalogId, ndc, drug, strength, category, isGroup,
    prices: { MINT: number | null, DING: number | null, DAMAGE: number | null } }
  ```
  If the live feed's field or price-key names differ, adjust that one function.
- **Null price = editable blank.** A condition with no price comes through as `null` and is rendered blank — **never `$0`** — and stays editable.
- **Group rows are blanket deals.** Rows flagged `isGroup` (label ends in `— All`, synthetic NDC ending `-99`) are shown but clearly marked.

## Line item rules
- Fields: `drug`, `strength`, `expiry` (free text), `condition`, `quantity`, `rate`, `amount`, plus optional `item`, `ndc`, `catalogId`, `category`.
- `condition` ∈ `MINT | DING | DAMAGE` (Mint = 9m+, Ding = 6–8m, Damage = 3–5m).
- `amount` is always derived = `round(quantity × rate, 2)` — read-only in the UI, recomputed live and on save.
- `item` is a display string = `(drug + ' ' + strength).trim()`, recomputed on save.
- Total = sum of all `amount`, recomputed live and on save.

## Environment variables

Copy `.env.example` to `.env.local` for local development and set the same values in Railway for deploy.

| Variable | Required | Description |
| --- | --- | --- |
| `SHEET_ID` | yes | Spreadsheet ID, e.g. `1BLGlj9u0iAtdvqBgfxv9YE4HwvBP5YUV0C8DA8OqF_E` |
| `SHEET_TAB` | yes | Worksheet/tab name (default `Submissions`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | Full service-account key JSON as one string. Share the sheet to its `client_email` as Editor |
| `CATALOG_FEED_URL` | yes | Apps Script web-app JSON feed URL |
| `APP_PASSCODE` | yes | The founder's login passcode |
| `SESSION_SECRET` | yes | Random string used to sign the session cookie (`openssl rand -hex 32`) |

> All variables are server-side only. None are prefixed `NEXT_PUBLIC_`, so none are exposed to the browser.

### Creating the service account (one time)
1. In Google Cloud Console, create (or pick) a project and **enable the Google Sheets API**.
2. Create a **Service Account**, then create a **JSON key** for it and download the file.
3. Put the entire JSON file contents into `GOOGLE_SERVICE_ACCOUNT_JSON` (one line is fine; `\n` inside `private_key` is handled).
4. Open the spreadsheet → **Share** → add the service account's `client_email` as **Editor**.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in the values above
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/login`.

```bash
npm run build   # production build
npm start       # run the production build locally
```

## Deploy on Railway

Two supported options.

### Option A — Dockerfile (recommended, included)
The repo ships a multi-stage `Dockerfile` that builds Next.js in **standalone** mode (configured in `next.config.mjs`).

1. Create a new Railway service from this repo. Railway auto-detects the `Dockerfile`.
2. Add the environment variables from the table above (Railway → service → **Variables**). Paste `GOOGLE_SERVICE_ACCOUNT_JSON` as a single-line value.
3. Deploy. The container listens on `$PORT` (Railway injects `PORT`; defaults to 3000).

### Option B — Nixpacks (no Dockerfile)
1. Set the builder to Nixpacks in service settings (or remove the `Dockerfile`).
2. Railway runs `npm install` → `npm run build` → `npm start`.
3. Add the same environment variables.

Set **all** variables before the first request, or login will fail with a clear "Server not configured" error and Sheets/catalog calls will return a configuration error.

## Out of scope
Any n8n integration, PDF generation, emailing the customer, the customer-facing portal, and Google OAuth (seam only). Saving to the sheet is the end of this app's job.
