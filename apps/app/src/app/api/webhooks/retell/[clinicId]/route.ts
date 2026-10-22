import { describeError, log } from "@/lib/log";
import { verifyRetellSignature } from "@/lib/voice/retell-signature";
import { BACKSTOP_EVENTS, isRetellCallId, retellApiKey, scheduleCallBackstop } from "@/lib/voice/backstop";
import { isEndedEarlyReason, recordRetellEnding } from "@/lib/voice/ended-early";

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
 * that clinic's Retell number. Nothing in the body is queued but the call
 * id, and nothing logged but the event's name: the job reads the call back
 * from Retell itself, and deletes the call at Retell once it is recorded
 * here (lib/voice/recording-alerts.ts). A recording URL on the call is
 * expected until then and is not read here at all.
 *
 * One exception, for a call that ended unexpectedly (lib/voice/ended-early.ts):
 * Retell's disconnection reason is read from the body, and when it names a
 * fault the recorded call is flagged, the clinic's L35 alert queued and,
 * from the body's last turns and caller number, the short-lived sealed
 * redial record kept (lib/voice/redial.ts). A call not yet recorded passes
 * the reason, a code and nothing more, to the backstop's job. Nothing of a
 * call that ended normally is read.
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
  let call: Parameters<typeof recordRetellEnding>[1] = {};
  try {
    const body = JSON.parse(raw) as { event?: unknown; call?: Parameters<typeof recordRetellEnding>[1] };
    event = body.event;
    call = body.call && typeof body.call === "object" ? body.call : {};
    callId = call.call_id;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof event !== "string" || !BACKSTOP_EVENTS.has(event)) return new Response(null, { status: 204 });
  if (!isRetellCallId(callId)) return new Response(null, { status: 400 });

  // A call that ended early: flagged now when it is recorded, else its reason
  // goes to the backstop. A failure here still queues the backstop, with the
  // reason, which flags the call when it runs.
  let endedEarlyReason: string | undefined;
  try {
    const ending = await recordRetellEnding(clinicId, call);
    if (ending.status === "pending") endedEarlyReason = ending.reason;
    if (ending.status === "flagged") log.info("retell call flagged as ended early", { clinicId, event });
  } catch (error) {
    log.error("retell webhook could not record the call's ending", { clinicId, event, error: describeError(error) });
    const reason = typeof call.disconnection_reason === "string" ? call.disconnection_reason : undefined;
    if (isEndedEarlyReason(reason)) endedEarlyReason = reason;
  }

  try {
    await scheduleCallBackstop({ clinicId, callId, ...(endedEarlyReason ? { endedEarlyReason } : {}) });
  } catch (error) {
    log.error("retell webhook could not queue the backstop", { clinicId, event, error: describeError(error) });
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
