import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { resolveSubmissionIdByInvoiceNumber } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exact Invoice Number (e.g. "LVDTS-1001") -> Submission ID, so the home page
// can open a known invoice directly. Rows stay keyed by Submission ID.
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const invoiceNumber =
    request.nextUrl.searchParams.get("invoiceNumber")?.trim() ?? "";
  if (!invoiceNumber) {
    return NextResponse.json(
      { error: "invoiceNumber is required" },
      { status: 400 }
    );
  }

  try {
    const submissionId =
      await resolveSubmissionIdByInvoiceNumber(invoiceNumber);
    if (!submissionId) {
      return NextResponse.json(
        { error: `No submission found for invoice ${invoiceNumber}` },
        { status: 404 }
      );
    }
    return NextResponse.json({ submissionId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Lookup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
