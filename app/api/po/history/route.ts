import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getPOHistory } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Chronological log of every PO PDF generated (behind the passcode via
// middleware + this guard). Newest-first; carries only non-sensitive fields
// (PO number, vendor, date, amount, Drive link, submission id).
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const records = await getPOHistory();
    return NextResponse.json({ records });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to load the PO history";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
