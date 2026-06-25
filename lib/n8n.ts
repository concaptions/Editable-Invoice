// Server-only helper for talking to the n8n webhooks.
//
// IMPORTANT: this module must never be imported by client components. It reads
// the n8n base URL, webhook paths, and shared secret from server env vars and
// must stay on the server side (route handlers only).

import "server-only";

type N8nPathEnv =
  | "N8N_PO_SEARCH_PATH"
  | "N8N_PO_GET_PATH"
  | "N8N_PO_APPROVE_PATH";

export interface N8nResult {
  status: number;
  // n8n returns JSON; shape varies by endpoint, validated by callers.
  data: unknown;
}

export async function callN8n(pathEnv: N8nPathEnv, body: unknown): Promise<N8nResult> {
  const base = process.env.N8N_BASE_URL;
  const path = process.env[pathEnv];

  if (!base || !path) {
    throw new Error(`n8n is not configured: set N8N_BASE_URL and ${pathEnv}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Optional shared secret — forwarded as x-po-secret when present.
  const secret = process.env.N8N_SHARED_SECRET;
  if (secret) {
    headers["x-po-secret"] = secret;
  }

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body — surface it so the caller can decide what to do.
      data = { error: "Upstream returned a non-JSON response", raw: text };
    }
  }

  return { status: response.status, data };
}

export function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}
