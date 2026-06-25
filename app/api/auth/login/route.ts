import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, createSessionToken } from "@/lib/session";

// Length-aware constant-time string comparison.
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function POST(request: NextRequest) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Server not configured: APP_PASSCODE is missing" },
      { status: 500 }
    );
  }

  let body: { passcode?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const provided = typeof body.passcode === "string" ? body.passcode : "";
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ ok: false, error: "Incorrect passcode" }, { status: 401 });
  }

  const token = await createSessionToken();
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE.name,
    value: token,
    httpOnly: true,
    // Secure in production; relaxed on http://localhost for local dev.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE.maxAgeSeconds,
  });
  return response;
}
