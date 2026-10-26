import {
  confirmSubscription,
  parseSnsMessage,
  SnsVerificationError,
  verifySnsMessage,
  type CertificateKeyFetcher,
} from "@/lib/email/ses-events";
import { describeError, log } from "@/lib/log";

import { inboundMailTopicArn } from "./config";
import { handleInboundNotice, InboundTransientError, type HandleDeps } from "./handle";
import { inboundNoticeFrom } from "./notice";

/**
 * /api/webhooks/inbound-mail (lane P7g): SES's receipt notices for the
 * support mail rule, as SNS posts them (infra/aws/ses-inbound.tf).
 *
 * Verified exactly as /api/webhooks/ses verifies SES's events, with the same
 * code (lib/email/ses-events.ts): the message must name the topic this host
 * trusts (HEALDESK_INBOUND_MAIL_TOPIC_ARN) and carry SNS's version 2
 * signature, checked against a certificate fetched from SNS's own host for
 * the topic's region; a subscription is confirmed only on those terms, and
 * only at a SubscribeURL on that host.
 *
 * Answers:
 *   404  inbound mail is not set up on this host (no topic to trust): the
 *        feature is off;
 *   400  not an SNS message;
 *   403  another topic, or a signature that does not verify;
 *   200  verified and done, including a mail dropped by a loop guard, a
 *        mail that could not be read (kept as a case with no facts), one
 *        already recorded, and a notice that is not an S3 receipt: SNS
 *        must not retry those;
 *   500  verified, but storage or the database failed: SNS retries, and the
 *        object stays for the retry or the hourly sweep (the bucket's
 *        one-day lifecycle rule is the backstop);
 *   503  verified, but HEALDESK_INBOUND_MAIL_BUCKET is not set while the
 *        topic is: a configuration error, logged as one, and SNS retries.
 *
 * Nothing in the body is logged: SNS's message id, SES's message id, the
 * type and the outcome.
 */

const MAX_BODY_BYTES = 256_000;

export type InboundWebhookDeps = HandleDeps & {
  getKey?: CertificateKeyFetcher;
  confirm?: Parameters<typeof confirmSubscription>[1];
};

export async function inboundMailWebhook(request: Request, deps: InboundWebhookDeps = {}): Promise<Response> {
  const topicArn = inboundMailTopicArn();
  if (!topicArn) return new Response("Not found.", { status: 404 });

  const body = await request.text();
  // In bytes, as the limit is: a string's length counts UTF-16 units.
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return new Response("Too large.", { status: 413 });

  let message;
  try {
    message = parseSnsMessage(body);
  } catch {
    return new Response("Not an SNS message.", { status: 400 });
  }

  try {
    await verifySnsMessage(message, topicArn, deps.getKey);
  } catch (error) {
    const reason = error instanceof SnsVerificationError ? error.message : describeError(error);
    log.warn("inbound mail notice refused", { status: "refused", reason });
    return new Response("Refused.", { status: 403 });
  }

  if (message.Type === "SubscriptionConfirmation") {
    try {
      const ok = await confirmSubscription(message, deps.confirm);
      log.info("inbound mail subscription", { status: ok ? "confirmed" : "not_confirmed", eventId: message.MessageId });
      return new Response(ok ? "Confirmed." : "Not confirmed.", { status: ok ? 200 : 502 });
    } catch (error) {
      log.error("inbound mail subscription failed", { eventId: message.MessageId, error: describeError(error) });
      return new Response("Not confirmed.", { status: 502 });
    }
  }

  if (message.Type === "UnsubscribeConfirmation") {
    log.warn("inbound mail unsubscribed", { eventId: message.MessageId, status: "unsubscribed" });
    return new Response("Noted.", { status: 200 });
  }

  const now = deps.now ?? new Date();
  const notice = inboundNoticeFrom(message.Message, now);
  if (!notice) {
    log.info("inbound mail notice ignored", { eventId: message.MessageId, outcome: "not_a_receipt" });
    return new Response("Ignored.", { status: 200 });
  }

  try {
    const outcome = await handleInboundNotice(notice, { ...deps, now });
    if (outcome.outcome === "refused" && outcome.reason === "not_set_up") {
      // The topic is trusted but no bucket is set: a configuration error, not
      // this mail's fault. 503, so SNS keeps the notice and retries it.
      log.error("inbound mail: HEALDESK_INBOUND_MAIL_BUCKET is not set; notice not handled", {
        eventId: notice.sesMessageId,
        status: "config_error",
      });
      return new Response("Not set up.", { status: 503 });
    }
    if (outcome.outcome === "refused") {
      log.warn("inbound mail notice refused", { eventId: notice.sesMessageId, status: "refused", reason: outcome.reason });
    }
    return new Response("OK.", { status: 200 });
  } catch (error) {
    if (error instanceof InboundTransientError) {
      log.error("inbound mail not recorded", { eventId: notice.sesMessageId, error: describeError(error.cause ?? error) });
      return new Response("Not recorded.", { status: 500 });
    }
    // Anything else is a bug about this one mail: never a retry loop. The
    // object stays for the sweep (which logs it again) or the lifecycle rule.
    log.error("inbound mail failed", { eventId: notice.sesMessageId, error: describeError(error) });
    return new Response("OK.", { status: 200 });
  }
}
