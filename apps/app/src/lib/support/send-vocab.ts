import type { EscalationTopic } from "./escalation-fields";

/**
 * The closed lists of a support reply's send (ops automation Phase 7, lane
 * P7c; design E5 §2.3), one source for the schema's CHECK constraints and
 * the send path (./send.ts). Pure: no database, so the schema can import it.
 */

/**
 * How many times a reply is tried before the sending stops as dead: the
 * outbox's rule (lib/email/outbox.ts MAX_NOTICE_ATTEMPTS, one try and then
 * one per RETRY_DELAYS_MINUTES), held equal to it by tests/support-send.test.ts.
 */
export const SUPPORT_SEND_MAX_ATTEMPTS = 6;

/**
 * Why a reply's sending stopped without the email going:
 *   dead         every try failed (notifyOps support_reply_dead);
 *   case_closed  the case was closed before a retry, so nothing more goes;
 *   clinic_left  the clinic has no address to send to any more (its
 *                account closed, or its sign-in is gone).
 */
export const SUPPORT_SEND_STOPPED_REASONS = ["dead", "case_closed", "clinic_left"] as const;
export type SupportSendStoppedReason = (typeof SUPPORT_SEND_STOPPED_REASONS)[number];

/**
 * The subject a reply goes under, fixed per topic (never the model's or the
 * owner's words): "Re: <this> (ref HD-7F3KQ)". The ref is the case's, so a
 * reply to it can be joined to the case by the inbound slice later.
 */
export const SUPPORT_REPLY_SUBJECTS: Readonly<Record<EscalationTopic, string>> = {
  forwarding: "Your call forwarding",
  calendar: "Your calendar connection",
  channel: "Your channels",
  plan: "Your plan",
  billing: "Your billing question",
  transcript: "Your transcripts",
  sign_in: "Signing in",
  other: "Your question to healdesk",
};

/** The subject of a reply on a case of this topic and printed ref ("HD-7F3KQ"). */
export function supportReplySubject(topic: string, printedRef: string): string {
  const base = (SUPPORT_REPLY_SUBJECTS as Readonly<Record<string, string>>)[topic] ?? SUPPORT_REPLY_SUBJECTS.other;
  return `Re: ${base} (ref ${printedRef})`;
}
