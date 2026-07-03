import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getPaymentDue } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only "payment due" working list (behind the passcode via middleware +
// this guard). Newest-first; payout details are resolved live from the vendor
// master, so account numbers aren't duplicated into the Payment Due tab.
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const entries = await getPaymentDue();
    return NextResponse.json({ entries });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to load the payment-due list";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
