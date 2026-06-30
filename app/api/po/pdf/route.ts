import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireAuth } from "@/lib/auth-guard";
import { InvoicePdf, type InvoicePdfData } from "@/lib/InvoicePdf";
import { savePdfToVendorFolder, type UploadedFile } from "@/lib/drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render the edited PO / invoice to a PDF in-process with @react-pdf/renderer
// (pure JS — no external service, no headless browser) and save it straight to
// the vendor's Google Drive folder using the same service account that backs
// Sheets. Returns the saved file's view link so the editor can link to it.
//
// Pass ?download=1 to ALSO stream the binary back as a download; saving to
// Drive is the default and required behavior.

function sanitizeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").trim();
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as InvoicePdfData | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "Invalid payload" },
      { status: 400 }
    );
  }

  // 1) Render the PDF in-process. Totals are used exactly as passed.
  let pdf: Buffer;
  try {
    // Call the component directly so the rendered <Document> element is passed
    // to renderToBuffer (DocumentProps is all-optional, so wrapping it in
    // createElement(InvoicePdf, …) would fail TypeScript's weak-type check).
    pdf = await renderToBuffer(InvoicePdf({ data: body }));
  } catch (e) {
    const message = e instanceof Error ? e.message : "PDF render failed";
    return NextResponse.json(
      { ok: false, error: `Could not render the PDF: ${message}` },
      { status: 500 }
    );
  }

  // Filename: "PO <invoiceNumber> - <invoiceDate>.pdf". Deliberately distinct
  // from the catalog flow's "<date> - Generated Invoice.pdf" so vendor-submitted
  // invoices and Landon's POs are distinguishable in the same folder.
  const isPO = (body.documentType ?? "").trim().toUpperCase() === "PO";
  const prefix = isPO ? "PO" : "Invoice";
  const numPart = sanitizeFilePart(body.invoiceNumber?.trim() || "draft");
  const datePart = sanitizeFilePart(body.invoiceDate?.trim() || todayIso());
  const fileName = `${prefix} ${numPart} - ${datePart}.pdf`;

  const wantsDownload = request.nextUrl.searchParams.get("download") === "1";

  // 2) Save to the vendor's Drive folder (creating it under the by-vendor root
  // if it doesn't exist yet).
  let saved: UploadedFile;
  try {
    saved = await savePdfToVendorFolder({
      contactId: body.contactId?.trim() || "",
      vendorName: body.vendorName?.trim() || "",
      fileName,
      pdf,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Drive upload failed";
    // If the caller explicitly asked for the binary, hand it back even when the
    // Drive save failed, so the PDF isn't lost — but flag the failure.
    if (wantsDownload) {
      return new NextResponse(new Uint8Array(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
          "X-Drive-Error": headerSafe(message),
        },
      });
    }
    return NextResponse.json(
      { ok: false, error: `PDF rendered but Drive save failed: ${message}` },
      { status: 502 }
    );
  }

  if (wantsDownload) {
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Drive-File-Id": saved.id,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    fileName: saved.name,
    fileId: saved.id,
    webViewLink: saved.webViewLink,
  });
}
