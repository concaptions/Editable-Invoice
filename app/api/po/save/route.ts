import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { saveSubmission } from "@/lib/sheets";
import type { LineItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const submissionId =
    typeof body.submissionId === "string" ? body.submissionId.trim() : "";
  if (!submissionId) {
    return NextResponse.json(
      { ok: false, error: "submissionId is required" },
      { status: 400 }
    );
  }

  try {
    const total = await saveSubmission({
      submissionId,
      invoiceNumber:
        typeof body.invoiceNumber === "string" ? body.invoiceNumber : "",
      invoiceDate: typeof body.invoiceDate === "string" ? body.invoiceDate : "",
      lineItems: Array.isArray(body.lineItems)
        ? (body.lineItems as LineItem[])
        : [],
    });
    return NextResponse.json({ ok: true, total });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Save failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
