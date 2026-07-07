import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { PAYOUT_DETAIL_KEYS, type PayoutDetails } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single write path for a vendor's payout details. The app never writes payout
// to the sheet directly — it forwards the full payout object (plus the ids that
// identify the vendor/submission) to the external payout service, which is the
// source of truth: it persists to the master sheet and mirrors to GoHighLevel.
//
// The endpoint URL + auth secret come from env (placeholders until supplied).
// When they're unset the route responds `notConfigured` so the editor keeps the
// typed values and shows a clear notice instead of losing Landon's input.
//
// SECURITY: account / routing numbers are NEVER logged. Only status codes and
// non-sensitive identifiers may appear in error paths.

const PAYOUT_API_URL = process.env.PAYOUT_API_URL?.trim() || "";
const PAYOUT_API_SECRET = process.env.PAYOUT_API_SECRET?.trim() || "";

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// Coerce an arbitrary body.payout into a well-formed PayoutDetails (strings
// only) so we never forward unexpected shapes upstream.
function normalizePayout(raw: unknown): PayoutDetails {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { method: asString(o.method).trim() } as PayoutDetails;
  for (const k of PAYOUT_DETAIL_KEYS) {
    out[k] = asString(o[k]).trim();
  }
  return out;
}

// The external service expects the payout grouped into ach / wire / bankAddress
// objects. Our internal model is a flat, lossy projection, so we expand it here:
//  - wire routing vs SWIFT: our UI stores one "Routing / SWIFT" field. A US
//    routing number is digits-only; a SWIFT/BIC always contains letters. Route
//    the single value by that shape (unknown/blank → routingNumber).
//  - ach.bankName: the model captures a single bank name (under Wire); reuse it
//    so an ACH-only payout still carries the bank name when one was entered.
//  - bankAddress: the UI keeps this as one free-text field, so send the full
//    text as `street` (city/state/zip blank). Lossless, and round-trips cleanly
//    because the vendor master reads the address back as a single blob.
interface UpstreamPayout {
  method: string;
  ach: {
    accountHolder: string;
    routingNumber: string;
    accountNumber: string;
    accountType: string;
    bankName: string;
  };
  wire: {
    beneficiary: string;
    bankName: string;
    routingNumber: string;
    swift: string;
    accountNumber: string;
  };
  bankAddress: { street: string; city: string; state: string; zip: string };
}

function splitRoutingSwift(value: string): {
  routingNumber: string;
  swift: string;
} {
  const v = value.trim();
  if (!v) return { routingNumber: "", swift: "" };
  return /[A-Za-z]/.test(v)
    ? { routingNumber: "", swift: v }
    : { routingNumber: v, swift: "" };
}

function toUpstreamPayout(p: PayoutDetails): UpstreamPayout {
  const { routingNumber, swift } = splitRoutingSwift(p.wireRoutingSwift);
  return {
    method: p.method,
    ach: {
      accountHolder: p.achAccountHolder,
      routingNumber: p.achRoutingNumber,
      accountNumber: p.achAccountNumber,
      accountType: p.achAccountType,
      bankName: p.wireBankName,
    },
    wire: {
      beneficiary: p.wireBeneficiary,
      bankName: p.wireBankName,
      routingNumber,
      swift,
      accountNumber: p.wireAccountNumber,
    },
    bankAddress: { street: p.bankAddress, city: "", state: "", zip: "" },
  };
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const submissionId = asString(body.submissionId).trim();
  const contactId = asString(body.contactId).trim();
  const vendorId = asString(body.vendorId).trim();
  const payout = normalizePayout(body.payout);

  if (!submissionId) {
    return NextResponse.json(
      { ok: false, error: "submissionId is required" },
      { status: 400 }
    );
  }

  // Not wired up yet → keep the client's data, tell it plainly.
  if (!PAYOUT_API_URL) {
    return NextResponse.json(
      {
        ok: false,
        notConfigured: true,
        error:
          "Payout service isn't configured yet (set PAYOUT_API_URL). Your entries are kept — save again once it's connected.",
      },
      { status: 503 }
    );
  }

  const upstreamBody = {
    vendorId,
    contactId,
    submissionId,
    payout: toUpstreamPayout(payout),
  };

  let upstream: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // The payout service authenticates via this exact header name.
    if (PAYOUT_API_SECRET) headers["x-payout-secret"] = PAYOUT_API_SECRET;
    upstream = await fetch(PAYOUT_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    // Do not include the payload in the message (it holds bank details).
    return NextResponse.json(
      { ok: false, error: "Could not reach the payout service. Your entries are kept." },
      { status: 502 }
    );
  }

  // Success is HTTP 2xx and — when the service returns a body — not an explicit
  // { ok: false }. The live endpoint returns { ok: true } on a successful save.
  // Any error hint read here is non-sensitive (never the payload).
  const result = (await upstream
    .json()
    .catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!upstream.ok || (result && result.ok === false)) {
    const message =
      (result && typeof result.error === "string" && result.error) ||
      `Payout service returned HTTP ${upstream.status}`;
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
