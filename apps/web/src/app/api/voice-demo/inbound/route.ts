import { clinicVoiceVariables } from "@/lib/demo/clinic-prompts";
import { demoEngineCall } from "@/lib/demo/engine";
import { demoBuyButton, demoOfferFor } from "@/lib/demo/offer";
import { findActiveDemoByCaller, profileOf } from "@/lib/demo/sessions";
import { normalizePhone } from "@/lib/phone";
import { verifyRetellSignature } from "@/lib/retell-signature";

/**
 * POST /api/voice-demo/inbound, the demo line's inbound call webhook.
 *
 * Retell calls this when someone dials the demo line (RETELL_DEMO_FROM_NUMBER),
 * before the call connects, and the answer decides who picks up:
 *
 *   - The caller's number is on a live personalised demo (they typed it in
 *     their demo page's "Call us" tab): the clinic-demo agent answers, as
 *     that clinic, with that clinic's profile.
 *   - Anyone else: an empty answer, so the number's own inbound agent (AYA,
 *     healdesk's demo line) answers as it always has.
 *
 * If this route fails, times out or is unreachable, Retell retries twice and
 * then connects the number's inbound agent, so the demo line never goes dead
 * because of it. That is also why a bad signature gets the empty answer
 * rather than an error: whoever is calling still reaches AYA.
 *
 * The request/response shapes are transcribed from
 * https://docs.retellai.com/features/inbound-call-webhook.md: Retell POSTs
 * `{ event: "call_inbound", call_inbound: { from_number, to_number, ... } }`
 * signed with X-Retell-Signature, and reads
 * `{ call_inbound: { override_agent_id, dynamic_variables, metadata } }`.
 *
 * Business to business: the caller is a clinic owner trying their own demo.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALL_THROUGH = { call_inbound: {} };

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  // The key with the webhook badge in Retell's dashboard; the API key when
  // only one key exists, which is the common case.
  const key = process.env.RETELL_WEBHOOK_KEY || process.env.RETELL_API_KEY;
  if (!key || !verifyRetellSignature(raw, request.headers.get("x-retell-signature"), key)) {
    console.warn("[healdesk] demo line webhook: signature missing or invalid; letting the line's own agent answer");
    return Response.json(FALL_THROUGH);
  }

  let from: unknown;
  try {
    const body = JSON.parse(raw) as { event?: string; call_inbound?: { from_number?: unknown } };
    if (body.event !== "call_inbound") return Response.json(FALL_THROUGH);
    from = body.call_inbound?.from_number;
  } catch {
    return Response.json(FALL_THROUGH);
  }
  const parsed = normalizePhone(from);
  const agentId = process.env.RETELL_CLINIC_DEMO_AGENT_ID;
  if (!parsed.ok || !agentId) return Response.json(FALL_THROUGH);

  let demo;
  try {
    demo = await findActiveDemoByCaller(parsed.e164);
  } catch (error) {
    console.error("[healdesk] demo line webhook: register unreadable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(FALL_THROUGH);
  }
  const profile = demo ? profileOf(demo) : null;
  if (!demo || !profile) return Response.json(FALL_THROUGH);

  // AYA's own engine answers when it is set and apps/app answers
  // (lib/demo/engine.ts). The Sheet keeps no name for the number, so the
  // context has none and AYA greets the caller without one.
  const engine = await demoEngineCall({ slug: demo.slug, profile, mode: "inbound", firstName: null, offer: demoOfferFor(demo), buyButton: demoBuyButton(demo) });

  console.info("[healdesk] demo line answered as a personalised demo", { slug: demo.slug, engine: engine ? "aya" : "clinic-agent" });
  return Response.json({
    call_inbound: {
      override_agent_id: engine ? engine.agentId : agentId,
      dynamic_variables: engine ? engine.variables : clinicVoiceVariables(profile, "inbound"),
      metadata: { demo_slug: demo.slug, source: "healdesk.io personalised demo (dialled in)", ...(engine ? { engine: "aya" } : {}) },
    },
  });
}
