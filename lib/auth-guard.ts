// Auth guard for API route handlers.
//
// Every PO route calls this first; it returns a 401 response when the session
// cookie is missing or invalid, or null when the request is authorized.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export async function requireAuth(request: NextRequest): Promise<NextResponse | null> {
  const token = request.cookies.get(SESSION_COOKIE.name)?.value;
  const valid = await verifySessionToken(token);
  if (!valid) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
