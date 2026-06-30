import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Direct to the Railway PDF service (no n8n). We proxy server-side so the
// browser isn't blocked by CORS and the call stays behind our auth cookie. The
// client sends the finished payload; we forward it and stream back the PDF as a
// download. Override the endpoint with PDF_SERVICE_URL if it ever moves.
const DEFAULT_PDF_URL =
  "https://invoice-generator-landon-production.up.railway.app/generate-invoice";

function pdfServiceUrl(): string {
  const u = process.env.PDF_SERVICE_URL;
  return u && u.trim() ? u.trim() : DEFAULT_PDF_URL;
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(pdfServiceUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/pdf",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach the PDF service." },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: `PDF service returned HTTP ${upstream.status}`,
        detail: detail.slice(0, 500),
      },
      { status: 502 }
    );
  }

  const pdf = Buffer.from(await upstream.arrayBuffer());
  const invoiceNumber =
    typeof body.invoiceNumber === "string" && body.invoiceNumber.trim()
      ? body.invoiceNumber.trim()
      : "PO";
  // Sanitize for a Content-Disposition filename.
  const filename = `PO ${invoiceNumber}.pdf`.replace(/[\\/:*?"<>|]+/g, "_");

  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
