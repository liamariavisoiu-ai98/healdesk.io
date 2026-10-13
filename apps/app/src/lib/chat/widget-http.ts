import { clientIp } from "@/lib/client-ip";

import { originAllowed, webChatClinic, type WebChatClinic } from "./web-chat";

/**
 * The HTTP edge of the web chat API (app/api/widget/v1/[slug]/*): CORS for
 * the clinic's own website, a body limit, and a per-browser rate limit.
 *
 * The API carries no cookie and no ambient credential: the token in the body
 * is the only handle on a conversation, so CORS here decides which pages may
 * call it, not who may read a reply. A page on another origin gets no CORS
 * headers and its browser refuses the answer.
 */

const MAX_BODY_BYTES = 8_000;
const WINDOW_MS = 60_000;
const LIMIT_PER_WINDOW = 20;
const hits = new Map<string, { start: number; count: number }>();

/** At most LIMIT_PER_WINDOW calls a minute per address and clinic, in this process. */
export function rateLimited(key: string, now: number = Date.now()): boolean {
  const entry = hits.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > LIMIT_PER_WINDOW;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

export function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

export type WidgetRequest = { clinic: WebChatClinic; origin: string | null; body: Record<string, unknown> };

/** The preflight: allowed only for the clinic's own origin. */
export async function preflight(request: Request, slug: string): Promise<Response> {
  const origin = request.headers.get("origin");
  const clinic = await webChatClinic(slug);
  if (!clinic || !originAllowed(origin, clinic.website)) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Resolve the clinic, check the origin, the rate and the body; or the response that refuses it. */
export async function widgetRequest(request: Request, slug: string): Promise<WidgetRequest | Response> {
  const origin = request.headers.get("origin");
  const clinic = await webChatClinic(slug);
  if (!clinic) return json({ error: "not_found" }, 404, null);
  if (!originAllowed(origin, clinic.website)) return json({ error: "origin" }, 403, null);
  if (rateLimited(`${clientIp(request.headers) ?? "unknown"}:${clinic.clinicId}`)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413, origin);
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400, origin);
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_body" }, 400, origin);
  return { clinic, origin, body: body as Record<string, unknown> };
}
