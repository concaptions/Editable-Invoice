import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getRecentSubmissions } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unauthorized = await requireAuth(request);
  if (unauthorized) return unauthorized;

  const raw = request.nextUrl.searchParams.get("limit");
  const parsed = raw ? Number(raw) : NaN;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;

  try {
    const results = await getRecentSubmissions(limit);
    return NextResponse.json({ results });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load recent submissions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
