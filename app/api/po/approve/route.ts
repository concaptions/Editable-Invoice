import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { callN8n, isOk } from "@/lib/n8n";

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const submissionId = typeof body.submissionId === "string" ? body.submissionId.trim() : "";
  if (!submissionId) {
    return NextResponse.json({ ok: false, error: "submissionId is required" }, { status: 400 });
  }

  // Forward the full edited state. Line items are validated/normalized client-side;
  // we pass them through untouched so n8n receives exactly what the founder saw.
  const payload = {
    submissionId,
    invoiceNumber: typeof body.invoiceNumber === "string" ? body.invoiceNumber : "",
    invoiceDate: typeof body.invoiceDate === "string" ? body.invoiceDate : "",
    sendToCustomer: Boolean(body.sendToCustomer),
    lineItems: Array.isArray(body.lineItems) ? body.lineItems : [],
  };

  try {
    const { status, data } = await callN8n("N8N_PO_APPROVE_PATH", payload);
    // Non-2xx from upstream -> normalize to ok:false.
    if (!isOk(status)) {
      const err = (data as { error?: string } | null)?.error ?? `Approve failed upstream (${status})`;
      return NextResponse.json({ ok: false, error: err }, { status: 502 });
    }
    // 2xx: pass the body straight through (it may itself be { ok:false, error }).
    return NextResponse.json(data ?? { ok: false, error: "Empty response from approve" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Approve failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
