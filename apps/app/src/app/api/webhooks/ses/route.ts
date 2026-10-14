import { recordSesTranscriptEvent } from "@/lib/conversations/transcript-outbox";
import {
  confirmSubscription,
  parseSnsMessage,
  sesEventFromNotification,
  sesEventsTopicArn,
  SnsVerificationError,
  verifySnsMessage,
} from "@/lib/email/ses-events";
import { describeError, log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/webhooks/ses — SES's events for the PHI configuration set, as SNS
 * posts them (infra/aws/ses.tf).
 *
 * What it is for: the transcript outbox knows SES accepted a transcript; only
 * this says whether the clinic's mail server took it. A delivery deletes the
 * sealed copy, in the same transaction, and leaves the row as a receipt (the
 * owner's decision of 14 October 2026); a hard bounce, a rejection, a
 * complaint or a rendering failure marks the transcript bounced, so the
 * outbox sends it again an hour later while its 30 days last, and ops hears
 * once (lib/conversations/transcript-outbox.ts). With no event at all for 72
 * hours the outbox deletes the copy itself, so a topic that stops reaching
 * this route costs the clinic a transcript, never a copy kept.
 *
 * Answers:
 *   503  SES events are not set up on this host (no topic to trust);
 *   400  not an SNS message;
 *   403  another topic, or a signature that does not verify;
 *   200  verified, whatever the event was about, including a transcript
 *        whose copy is already gone: SNS must not retry those;
 *   500  verified, but recording it failed: SNS retries (its delivery
 *        policy, about an hour), which loses no event to a deploy.
 *
 * Nothing in the body is logged or kept: the message id SNS gave the event,
 * its type and the outcome.
 */
const MAX_BODY_BYTES = 256_000;

export async function POST(request: Request): Promise<Response> {
  const topicArn = sesEventsTopicArn();
  if (!topicArn) return new Response("SES events are not set up here.", { status: 503 });

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response("Too large.", { status: 413 });

  let message;
  try {
    message = parseSnsMessage(body);
  } catch {
    return new Response("Not an SNS message.", { status: 400 });
  }

  try {
    await verifySnsMessage(message, topicArn);
  } catch (error) {
    const reason = error instanceof SnsVerificationError ? error.message : describeError(error);
    log.warn("ses event refused", { status: "refused", reason });
    return new Response("Refused.", { status: 403 });
  }

  if (message.Type === "SubscriptionConfirmation") {
    try {
      const ok = await confirmSubscription(message);
      log.info("ses events subscription", { status: ok ? "confirmed" : "not_confirmed", eventId: message.MessageId });
      return new Response(ok ? "Confirmed." : "Not confirmed.", { status: ok ? 200 : 502 });
    } catch (error) {
      log.error("ses events subscription failed", { eventId: message.MessageId, error: describeError(error) });
      return new Response("Not confirmed.", { status: 502 });
    }
  }

  if (message.Type === "UnsubscribeConfirmation") {
    log.warn("ses events unsubscribed", { eventId: message.MessageId, status: "unsubscribed" });
    return new Response("Noted.", { status: 200 });
  }

  const event = sesEventFromNotification(message.Message);
  if (!event) return new Response("Ignored.", { status: 200 });

  try {
    const found = await recordSesTranscriptEvent(event);
    log.info("ses event", { eventId: message.MessageId, type: event.type, outcome: found ? "recorded" : "not_ours" });
    return new Response("OK.", { status: 200 });
  } catch (error) {
    log.error("ses event not recorded", { eventId: message.MessageId, type: event.type, error: describeError(error) });
    return new Response("Not recorded.", { status: 500 });
  }
}
