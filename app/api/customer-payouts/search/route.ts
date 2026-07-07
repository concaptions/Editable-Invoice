import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { listRecentVendorPayouts, searchVendorPayouts } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only vendor lookup for the /customer-payouts pre-upload tool (behind the
// passcode via middleware + this guard). With a query, returns Vendor-tab
// customers matching by name / business / email; with no query, returns the 20
// most-recently-updated customers (the page's landing list). Each carries its
// payout seeded so the editor card opens pre-filled. Read-only: saving goes back
// through the existing /api/po/payout write path, not here.
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const q = request.nextUrl.searchParams.get("q")?.trim() || "";

  try {
    const results = q
      ? await searchVendorPayouts(q)
      : await listRecentVendorPayouts(20);
    return NextResponse.json({ results });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to load customers";
    return NextResponse.json({ results: [], error: message }, { status: 500 });
  }
}
