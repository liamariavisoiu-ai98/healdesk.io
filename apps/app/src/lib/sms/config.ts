import { voiceRealCallsAllowed } from "@/lib/voice/real-calls";

/**
 * Whether healdesk's one texting number is ready (owner, 30 October 2026;
 * docs/design/launch-readiness-2026-10-27/payment-link-text-route-scope.md).
 *
 * The optional payment-link text after a call is sent from ONE US toll-free
 * number that healdesk registers once with AWS End User Messaging SMS. The
 * registration takes up to 15 business days, so readiness is not a date or a
 * flag in code: it is this one environment variable, which only the owner
 * sets, by pasting the approved number's identity into Parameter Store
 * (infra/aws, `HEALDESK_SMS_ORIGINATION_IDENTITY`). Until then Terraform
 * holds `__unset__` there, the image's entrypoint unsets it, and every
 * reader below answers "not ready": the switch stays locked
 * (lib/portal/switch-rules.ts), nothing is offered on a call and nothing is
 * sent (lib/sms/payment-text.ts).
 *
 * The value is the number's AWS identity: the toll-free number itself in
 * E.164, its phone-number id, or its full ARN. Anything else reads as not
 * ready rather than being handed to AWS, so a typo keeps the text off
 * instead of failing on a caller.
 */

const TOLL_FREE_E164 = /^\+18(?:00|33|44|55|66|77|88)[2-9]\d{6}$/;
const PHONE_NUMBER_ID = /^phone-[0-9a-f]{32}$/;
const PHONE_NUMBER_ARN = /^arn:aws:sms-voice:[a-z0-9-]+:\d{12}:phone-number\/phone-[0-9a-f]{32}$/;

/** The texting number's identity, or null while it is not set (or not one we recognise). */
export function smsOriginationIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = env.HEALDESK_SMS_ORIGINATION_IDENTITY?.trim();
  if (!value || value === "__unset__") return null;
  return TOLL_FREE_E164.test(value) || PHONE_NUMBER_ID.test(value) || PHONE_NUMBER_ARN.test(value) ? value : null;
}

/** Whether healdesk's texting number is ready: the one fact of the text that is healdesk's, not the clinic's. */
export function smsSenderConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return smsOriginationIdentity(env) !== null;
}

/**
 * Healdesk's side of the text, as the clinic's checklist shows it ("Our
 * texting number is ready"): the number is set AND the voice endpoint is out
 * of its test-calls-only mode (HEALDESK_VOICE_REAL_CALLS=1), since no text
 * is offered on a test call. One check for the clinic, never the flags'
 * names.
 */
export function healdeskTextReady(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return smsSenderConfigured(env) && voiceRealCallsAllowed(env);
}
