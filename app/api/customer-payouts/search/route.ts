import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { searchVendorPayouts } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only vendor lookup for the /customer-payouts pre-upload tool (behind the
// passcode via middleware + this guard). Returns customers from the Vendor tab
// matching the query by email / Vendor (GHL Contact) ID / name, each with its
// payout seeded so the editor card opens pre-filled. Read-only: saving goes back
// through the existing /api/po/payout write path, not here.
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const q = request.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q) return NextResponse.json({ results: [] });

  try {
    const results = await searchVendorPayouts(q);
    return NextResponse.json({ results });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to search customers";
    return NextResponse.json({ results: [], error: message }, { status: 500 });
  }
}
