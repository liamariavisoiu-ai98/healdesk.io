import { recordIntentSession } from "@/lib/checkout/intents";
import { problem, readSignedJson } from "@/lib/checkout/signed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/intents/session: which Checkout Session an attempt
 * created. apps/web sends it, signed, right after Stripe answers, so the next
 * press of Pay can expire it: a buyer who cancels and pays again must never
 * have two sessions they could both complete.
 */
export async function POST(request: Request): Promise<Response> {
  const read = await readSignedJson(request, 4_000);
  if (!read.ok) return read.response;
  const body = read.body as { ref?: unknown; attempt?: unknown; sessionId?: unknown } | null;
  if (
    typeof body?.ref !== "string" ||
    typeof body.attempt !== "number" ||
    !Number.isInteger(body.attempt) ||
    typeof body.sessionId !== "string"
  ) {
    return problem("Invalid request body.", 400);
  }
  const recorded = await recordIntentSession(body.ref, body.attempt, body.sessionId);
  // 409 when a newer attempt, or the purchase itself, got there first.
  return recorded
    ? Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
    : problem("That attempt is no longer the open one.", 409);
}
