import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-side lookup of a vendor's price-match proof. The upstream webhook reads
// the vendor's Drive folder and returns each file inline as a base64 data URI, so
// the response can be a few MB — which is exactly why this is proxied here rather
// than fetched from the browser. The vendor identity (GHL Contact ID + Vendor
// Name) is passed through verbatim so it matches the folder the proof lives in.
//
// This never throws to the client: any failure (bad identity, upstream error,
// timeout, malformed body) resolves to "no proof", so the review screen simply
// renders nothing extra.

const GET_PROOF_WEBHOOK_URL =
  process.env.GET_PROOF_WEBHOOK_URL?.trim() ||
  "https://primary-production-37b78.up.railway.app/webhook/get-proof";

interface ProofFile {
  name: string;
  mimeType: string;
  dataUri: string;
}

interface ProofResponse {
  hasProof: boolean;
  files: ProofFile[];
}

const NO_PROOF: ProofResponse = { hasProof: false, files: [] };

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const contactId =
    typeof body.contactId === "string" ? body.contactId.trim() : "";
  const vendorName =
    typeof body.vendorName === "string" ? body.vendorName.trim() : "";

  // Nothing to look up → no proof (quiet, not an error).
  if (!contactId || !vendorName) {
    return NextResponse.json(NO_PROOF);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const upstream = await fetch(GET_PROOF_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, vendorName }),
      signal: controller.signal,
    });
    if (!upstream.ok) return NextResponse.json(NO_PROOF);

    const data = (await upstream
      .json()
      .catch(() => null)) as Partial<ProofResponse> | null;
    if (!data || data.hasProof !== true || !Array.isArray(data.files)) {
      return NextResponse.json(NO_PROOF);
    }

    // Keep only well-formed files so the client can render them blindly.
    const files = data.files.filter(
      (f): f is ProofFile =>
        !!f &&
        typeof f.name === "string" &&
        typeof f.mimeType === "string" &&
        typeof f.dataUri === "string" &&
        f.dataUri.length > 0
    );
    if (!files.length) return NextResponse.json(NO_PROOF);

    return NextResponse.json({ hasProof: true, files });
  } catch {
    // Network error / timeout / abort → treat as no proof.
    return NextResponse.json(NO_PROOF);
  } finally {
    clearTimeout(timeout);
  }
}
