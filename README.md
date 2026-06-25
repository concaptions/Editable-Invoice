# LVDTS PO Editor

A small, private internal web app for the founder of **Las Vegas Diabetic Test Strips LLC (LVDTS)** to review, edit, and approve purchase orders.

Customers submit invoices through a portal; their line items land in a Google Sheet. This tool lets the founder open a submission, mark it up against the package actually received (change quantities/rates, cross items out, add items), and approve. On approve, the edited line items are written back, a finalized PO PDF is regenerated, and (optionally) sent to the customer.

This app **never** talks to Google directly. All data access goes through three existing n8n webhooks, and every call to them happens **server-side**.

## Architecture

```
Browser (founder)  ->  Next.js Route Handlers (/app/api/*)  ->  n8n webhooks
```

- The browser never sees the n8n base URL, webhook paths, the passcode, or the shared secret.
- All three n8n calls run in server-side route handlers (`/app/api/po/*`) that read config from environment variables.
- If `N8N_SHARED_SECRET` is set, it is sent to n8n as an `x-po-secret` header on every call.

### Tech stack
- Next.js (App Router) + TypeScript + Tailwind CSS
- No database — state is fetched from / written to the n8n endpoints
- Zero runtime UI dependencies (plain Tailwind)

### Key files
| Path | Purpose |
| --- | --- |
| `middleware.ts` | Protects every route except `/login` and `/api/auth/login` |
| `lib/session.ts` | Signed session cookie (HMAC via Web Crypto; runs in Edge + Node) |
| `lib/n8n.ts` | Server-only helper that calls the n8n webhooks |
| `lib/auth-guard.ts` | Per-route 401 guard for the API handlers |
| `app/api/auth/*` | Login / logout |
| `app/api/po/*` | `search`, `get`, `approve` proxies to n8n |
| `app/login/page.tsx` | Passcode gate |
| `app/page.tsx` | Search screen |
| `app/po/[submissionId]/page.tsx` + `components/PoEditor.tsx` | Invoice editor |

## Auth

A single passcode gate (one user — the founder):

1. `/login` posts the passcode to `/api/auth/login`, which compares it server-side to `APP_PASSCODE`.
2. On success it sets an **httpOnly, sameSite=lax, signed** session cookie (`secure` in production). The cookie is an HMAC of the issued-at timestamp using `SESSION_SECRET`, with a ~12h expiry.
3. `middleware.ts` redirects unauthenticated page requests to `/login` and returns `401` for unauthenticated API requests.
4. "Log out" (top-right) clears the cookie.

### Future: Google OAuth seam
The passcode check is intentionally isolated so it can later be swapped for Google OAuth restricted to the founder's email **without touching the rest of the app**. The seam is the cookie issued by `app/api/auth/login/route.ts` and verified in `lib/session.ts` / `middleware.ts`: replace the passcode comparison with an OAuth callback that issues the same session cookie, and everything downstream keeps working. OAuth is **not** built yet.

## Environment variables

Copy `.env.example` to `.env.local` for local development and set values in Railway for deploy.

| Variable | Required | Description |
| --- | --- | --- |
| `N8N_BASE_URL` | yes | Base URL of the n8n instance, e.g. `https://primary-production-37b78.up.railway.app` |
| `N8N_PO_SEARCH_PATH` | yes | Search webhook path, e.g. `/webhook/po-search` |
| `N8N_PO_GET_PATH` | yes | Load-invoice webhook path, e.g. `/webhook/po-get` |
| `N8N_PO_APPROVE_PATH` | yes | Approve/save webhook path, e.g. `/webhook/po-approve` |
| `N8N_SHARED_SECRET` | no | If set, sent to n8n as the `x-po-secret` header |
| `APP_PASSCODE` | yes | The founder's login passcode |
| `SESSION_SECRET` | yes | Random string used to sign the session cookie (`openssl rand -hex 32`) |

> All variables are server-side only. None are prefixed `NEXT_PUBLIC_`, so none are exposed to the browser.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in APP_PASSCODE and SESSION_SECRET
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
2. Add the environment variables from the table above (Railway → service → **Variables**).
3. Deploy. The container listens on `$PORT` (defaults to 3000; Railway injects `PORT` automatically).

### Option B — Nixpacks (no Dockerfile)
Railway's Nixpacks can build a Next.js app directly:

1. Remove or ignore the `Dockerfile` (or set the builder to Nixpacks in service settings).
2. Railway runs `npm install` → `npm run build` → `npm start`.
3. Add the same environment variables.

Either way, set **all** variables in the table before the first request, or login will fail with a clear "Server not configured" error.

## Backend contract (provided separately — not built here)

Three `POST` JSON-in/JSON-out n8n webhooks. This app only calls them; it does not implement them.

- **Search** `POST {N8N_BASE_URL}{N8N_PO_SEARCH_PATH}` — `{ "query": "<contactId or vendor name>" }` → `{ "results": [...] }`
- **Get** `POST {N8N_BASE_URL}{N8N_PO_GET_PATH}` — `{ "submissionId": "..." }` → full invoice with `lineItems`
- **Approve** `POST {N8N_BASE_URL}{N8N_PO_APPROVE_PATH}` — full edited state → `{ "ok": true, "total": 60, "poLink": "..." }` (failures return `{ "ok": false, "error": "..." }`, possibly with HTTP 200; both non-2xx and `ok:false` are handled)

## Line item rules
- Fields: `drug`, `strength`, `expiry` (free text), `condition`, `quantity`, `rate`, `amount`.
- `condition` ∈ `MINT | DING | DAMAGE` (Mint = 9m+, Ding = 6–8m, Damage = 3–5m).
- `amount` is always derived = `round(quantity × rate, 2)` — read-only in the UI, recomputed live.
- Total = sum of all `amount`, recomputed live.

## Out of scope
The n8n webhooks themselves, any direct Google Sheets/Drive/GHL integration, the customer-facing portal, the catalog price feed, PDF rendering, and Google OAuth (seam only).
