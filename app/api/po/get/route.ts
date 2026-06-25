import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { callN8n, isOk } from "@/lib/n8n";

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const submissionId = typeof body.submissionId === "string" ? body.submissionId.trim() : "";
  if (!submissionId) {
    return NextResponse.json({ error: "submissionId is required" }, { status: 400 });
  }

  try {
    const { status, data } = await callN8n("N8N_PO_GET_PATH", { submissionId });
    if (!isOk(status)) {
      const err = (data as { error?: string } | null)?.error ?? `Load failed upstream (${status})`;
      return NextResponse.json({ error: err }, { status: 502 });
    }
    return NextResponse.json(data ?? {});
  } catch (e) {
    const message = e instanceof Error ? e.message : "Load failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
