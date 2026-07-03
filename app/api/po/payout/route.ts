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

  const upstreamBody = { submissionId, contactId, vendorId, payout };

  let upstream: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (PAYOUT_API_SECRET) headers.Authorization = `Bearer ${PAYOUT_API_SECRET}`;
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

  if (!upstream.ok) {
    // Read a short, non-sensitive error hint if the service provides one.
    const detail = (await upstream
      .json()
      .catch(() => null)) as { error?: string } | null;
    const message =
      (detail && typeof detail.error === "string" && detail.error) ||
      `Payout service returned HTTP ${upstream.status}`;
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
