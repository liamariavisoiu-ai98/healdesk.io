import { describeError, log } from "@/lib/log";
import { verifyRetellSignature } from "@/lib/voice/retell-signature";
import { BACKSTOP_EVENTS, isRetellCallId, retellApiKey, scheduleCallBackstop } from "@/lib/voice/backstop";

/**
 * POST /api/webhooks/retell/<clinic id>: Retell's call events for one
 * clinic's agent (the agent's own `webhook_url`), the backstop for a call
 * the live socket never recorded (lib/voice/backstop.ts).
 *
 * On the public host, because Retell calls it from the internet; the
 * internal host serves only apps/web's signed routes (infra/aws/alb.tf), and
 * the public catch-all brings this to the web tier, never the voice task,
 * which is the process whose crash this covers.
 *
 * The signature is the authentication: HMAC over the raw body with
 * HEALDESK_RETELL_API_KEY, at most five minutes old. The clinic id in the
 * path is not a secret; it only names which clinic to check, and the job
 * records nothing unless Retell's own record of the call shows it reached
 * that clinic's Retell number. Nothing in the body is kept or queued but
 * the call id, and nothing logged but the event's name: the job reads the
 * call back from Retell itself, and deletes the call at Retell once it is
 * recorded here (lib/voice/recording-alerts.ts). A recording URL on the
 * call is expected until then and is not read here at all.
 *
 * Answers in milliseconds (Retell waits ten seconds, then retries three
 * times): 204 for an event handled or ignored, 401 for a bad signature, 503
 * while the key is unset or the queue cannot take the job, so Retell
 * retries.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A call object with a long transcript is well under this. */
const MAX_BODY_BYTES = 2_000_000;

export async function POST(request: Request, { params }: { params: Promise<{ clinicId: string }> }): Promise<Response> {
  const { clinicId } = await params;
  if (!UUID.test(clinicId)) return new Response(null, { status: 404 });

  const key = retellApiKey();
  if (!key) {
    log.error("retell webhook refused: HEALDESK_RETELL_API_KEY is unset", { clinicId });
    return new Response(null, { status: 503 });
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  if (!verifyRetellSignature(raw, request.headers.get("x-retell-signature"), key)) {
    log.warn("retell webhook signature did not verify", { clinicId });
    return new Response(null, { status: 401 });
  }

  let event: unknown;
  let callId: unknown;
  try {
    const body = JSON.parse(raw) as { event?: unknown; call?: { call_id?: unknown } };
    event = body.event;
    callId = body.call?.call_id;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof event !== "string" || !BACKSTOP_EVENTS.has(event)) return new Response(null, { status: 204 });
  if (!isRetellCallId(callId)) return new Response(null, { status: 400 });

  try {
    await scheduleCallBackstop({ clinicId, callId });
  } catch (error) {
    log.error("retell webhook could not queue the backstop", { clinicId, event, error: describeError(error) });
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
