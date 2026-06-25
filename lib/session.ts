// Stateless signed session cookie.
//
// Token format:  base64url(payload) "." base64url(HMAC-SHA256(payload))
// where `payload` is the issued-at timestamp in ms. Verified against
// SESSION_SECRET with a sliding ~12h expiry.
//
// Implemented with the Web Crypto API (`crypto.subtle`) + global btoa/atob so the
// exact same code runs in BOTH the Edge middleware runtime and the Node.js
// route-handler runtime.

const SESSION_COOKIE_NAME = "lvdts_session";
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set");
  }
  return secret;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSign(payload: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createSessionToken(): Promise<string> {
  const payload = String(Date.now());
  const signature = await hmacSign(payload);
  const encoder = new TextEncoder();
  return `${toBase64Url(encoder.encode(payload))}.${toBase64Url(signature)}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  // Fails closed: any malformed token, missing secret, or crypto error => false.
  try {
    if (!token) return false;

    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payloadPart, signaturePart] = parts;

    const payload = new TextDecoder().decode(fromBase64Url(payloadPart));
    const providedSignature = fromBase64Url(signaturePart);

    const issuedAt = Number(payload);
    if (!Number.isFinite(issuedAt)) return false;
    if (Date.now() - issuedAt > MAX_AGE_SECONDS * 1000) return false;

    const expectedSignature = await hmacSign(payload);
    return timingSafeEqual(providedSignature, expectedSignature);
  } catch {
    return false;
  }
}

export const SESSION_COOKIE = {
  name: SESSION_COOKIE_NAME,
  maxAgeSeconds: MAX_AGE_SECONDS,
};
