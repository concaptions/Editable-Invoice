import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { callN8n, isOk } from "@/lib/n8n";

export async function POST(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ results: [] });
  }

  try {
    const { status, data } = await callN8n("N8N_PO_SEARCH_PATH", { query });
    if (!isOk(status)) {
      const err = (data as { error?: string } | null)?.error ?? `Search failed upstream (${status})`;
      return NextResponse.json({ error: err }, { status: 502 });
    }
    return NextResponse.json(data ?? { results: [] });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
