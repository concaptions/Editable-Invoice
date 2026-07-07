import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireAuth } from "@/lib/auth-guard";
import { InvoicePdf, type InvoicePdfData } from "@/lib/InvoicePdf";
import { appendPaymentDue, appendPORecord, getSubmission } from "@/lib/sheets";
import { toNum } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render the edited PO / invoice to a PDF in-process with @react-pdf/renderer
// (pure JS — no external service, no headless browser), then hand the bytes to
// the n8n webhook that files it into the vendor's Google Drive folder. The app
// itself no longer touches Drive; it only renders the PDF and POSTs it.
//
// The vendor identity that decides WHICH Drive folder the PO lands in
// (contactId, vendorName, email) is read back from the submission row in the
// sheet — never trusted from the client — so a PO always files into the same
// folder as that vendor's catalog invoice. The webhook responds synchronously
// with the saved file's name + view link, which we relay to the editor.

const STORE_PO_WEBHOOK_URL =
  process.env.STORE_PO_WEBHOOK_URL?.trim() ||
  "https://primary-production-37b78.up.railway.app/webhook/store-po";

// Where we read the vendor's invoice link from when logging a payment-due row.
// The URL has a public default; the auth key is server-side only (env, never a
// hardcoded fallback) so it can't leak into the client bundle.
const SUBMISSION_INFO_URL =
  process.env.SUBMISSION_INFO_URL?.trim() ||
  "https://primary-production-37b78.up.railway.app/webhook/submission-info";
const SUBMISSION_INFO_SECRET = process.env.SUBMISSION_INFO_SECRET?.trim() || "";

interface StorePoResponse {
  ok?: boolean;
  fileName?: string;
  webViewLink?: string;
  error?: string;
}

// Best-effort lookup of the vendor's invoice link for a submission. Never
// throws and never logs the URL (it carries the secret): any failure or missing
// key yields "" so the PO/payment-due write proceeds with a blank invoice link.
async function fetchInvoiceLink(submissionId: string): Promise<string> {
  if (!SUBMISSION_INFO_SECRET) return "";
  try {
    const url = `${SUBMISSION_INFO_URL}?sid=${encodeURIComponent(
      submissionId
    )}&k=${encodeURIComponent(SUBMISSION_INFO_SECRET)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return "";
    const data = (await res.json().catch(() => null)) as
      | { invoiceLink?: unknown }
      | null;
    return typeof data?.invoiceLink === "string" ? data.invoiceLink.trim() : "";
  } catch {
    return "";
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as
    | (InvoicePdfData & { submissionId?: string })
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "Invalid payload" },
      { status: 400 }
    );
  }

  const submissionId = body.submissionId?.trim() || "";
  if (!submissionId) {
    return NextResponse.json(
      { ok: false, error: "submissionId is required" },
      { status: 400 }
    );
  }

  // Authoritative vendor identity from the sheet. These three fields decide the
  // Drive folder, so they come from the row — not the client payload.
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

  const contactId = submission.contactId?.trim() || "";
  const vendorName = submission.vendorName?.trim() || "";
  const email = submission.email?.trim() || "";

  // 1) Render the PDF in-process. Totals are honored exactly as passed; only the
  // vendor identity is overridden with the sheet's authoritative values so the
  // document's vendor box matches the folder it's filed into.
  let pdf: Buffer;
  try {
    // Call the component directly so the rendered <Document> element is passed
    // to renderToBuffer (DocumentProps is all-optional, so wrapping it in
    // createElement(InvoicePdf, …) would fail TypeScript's weak-type check).
    pdf = await renderToBuffer(
      InvoicePdf({
        data: {
          ...body,
          contactId,
          vendorName,
          email,
          // Carrier tracking number(s) — from the client if sent, else the sheet.
          trackingNumbers: body.trackingNumbers ?? submission.trackingNumbers ?? [],
          // Print what Landon sees; fall back to the resolved vendor payout.
          payout: body.payout ?? submission.payout,
        },
      })
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "PDF render failed";
    return NextResponse.json(
      { ok: false, error: `Could not render the PDF: ${message}` },
      { status: 500 }
    );
  }

  // 2) Hand the rendered bytes (base64) to the n8n webhook, which builds the
  // filename and files the PDF into the vendor's Drive folder.
  const webhookBody = {
    documentType: "PO",
    invoiceNumber: body.invoiceNumber?.trim() || "",
    invoiceDate: body.invoiceDate?.trim() || "",
    contactId,
    email,
    vendorName,
    businessName: body.businessName?.trim() || "",
    submissionId,
    pdfBase64: pdf.toString("base64"),
  };

  let upstream: Response;
  try {
    upstream = await fetch(STORE_PO_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Webhook request failed";
    return NextResponse.json(
      { ok: false, error: `PDF rendered but filing it failed: ${message}` },
      { status: 502 }
    );
  }

  const data = (await upstream
    .json()
    .catch(() => null)) as StorePoResponse | null;

  if (!upstream.ok || !data || data.ok !== true) {
    const message =
      data?.error || `Filing service returned HTTP ${upstream.status}`;
    return NextResponse.json(
      { ok: false, error: `PDF rendered but Drive save failed: ${message}` },
      { status: 502 }
    );
  }

  // Generating a PO = the moment a payment becomes due. Log a payment-due entry
  // Landon can work from without opening a sheet. Best-effort: a failure here
  // must NOT fail the PO (it's already filed), and we never log bank details.
  // Resolve the invoice link too so the list can link to BOTH the PO and the
  // invoice (blank when unavailable — never fails the PO).
  const invoiceLink = await fetchInvoiceLink(submissionId);
  try {
    await appendPaymentDue({
      submissionId,
      contactId,
      vendorName,
      invoiceNumber: body.invoiceNumber?.trim() || "",
      invoiceDate: body.invoiceDate?.trim() || "",
      method: (submission.payout?.method || submission.paymentMethod || "").trim(),
      amount: toNum(body.total),
      poLink: data.webViewLink || "",
      invoiceLink,
    });
  } catch (e) {
    console.error(
      "payment-due append failed:",
      e instanceof Error ? e.message : "unknown error"
    );
  }

  // Log a chronological PO History entry (browse/re-download every PO). Same
  // best-effort contract: never fail the PO if this write hiccups.
  try {
    await appendPORecord({
      poNumber: body.invoiceNumber?.trim() || "",
      vendorName,
      amount: toNum(body.total),
      driveLink: data.webViewLink || "",
      submissionId,
    });
  } catch (e) {
    console.error(
      "po-history append failed:",
      e instanceof Error ? e.message : "unknown error"
    );
  }

  return NextResponse.json({
    ok: true,
    fileName: data.fileName,
    webViewLink: data.webViewLink,
    // The rendered bytes, so the editor can offer a direct download alongside
    // the Drive link (no second round-trip). Drive link stays authoritative.
    pdfBase64: pdf.toString("base64"),
  });
}
