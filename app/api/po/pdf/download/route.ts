import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireAuth } from "@/lib/auth-guard";
import { InvoicePdf, type InvoicePdfData } from "@/lib/InvoicePdf";
import { getSubmission } from "@/lib/sheets";
import { round2 } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-renders a submission's PO to a PDF and streams it back as a file download
// (Content-Disposition: attachment). Used by the PO History page's "Download
// PDF" action so an old PO can be pulled without re-opening the editor. The PDF
// is rebuilt from the authoritative sheet row (never client input) — totals are
// honored exactly as saved: subtotal from the stored line items, minus the saved
// cleaning fee.
export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const submissionId =
    request.nextUrl.searchParams.get("submissionId")?.trim() || "";
  if (!submissionId) {
    return NextResponse.json(
      { ok: false, error: "submissionId is required" },
      { status: 400 }
    );
  }

  let submission;
  try {
    submission = await getSubmission(submissionId);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Could not read the submission";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  if (!submission) {
    return NextResponse.json(
      { ok: false, error: `No submission found for "${submissionId}"` },
      { status: 404 }
    );
  }

  const subtotal = round2(submission.total);
  const cleaningFee = round2(submission.cleaningFee);
  const total = round2(subtotal - cleaningFee);

  const data: InvoicePdfData = {
    documentType: "PO",
    invoiceNumber: submission.invoiceNumber,
    invoiceDate: submission.invoiceDate,
    vendorName: submission.vendorName,
    contactId: submission.contactId,
    email: submission.email,
    lineItems: submission.lineItems,
    subtotal,
    cleaningFee,
    total,
    trackingNumbers: submission.trackingNumbers,
    payout: submission.payout,
  };

  let pdf: Buffer;
  try {
    pdf = await renderToBuffer(InvoicePdf({ data }));
  } catch (e) {
    const message = e instanceof Error ? e.message : "PDF render failed";
    return NextResponse.json(
      { ok: false, error: `Could not render the PDF: ${message}` },
      { status: 500 }
    );
  }

  // Build a safe download filename from the invoice number.
  const safeName =
    (submission.invoiceNumber || submissionId)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "purchase-order";
  const filename = `PO-${safeName}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
