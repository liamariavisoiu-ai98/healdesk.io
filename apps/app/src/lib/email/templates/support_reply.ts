import { SUPPORT_SIGN_OFF } from "@healdesk/catalog";

import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L37, a support reply (ops automation lane P7c; design E5 §2.6; owner
 * decision D12): the one email in the product whose body is prose. The text
 * is a reply written for one support case, drafted by the drafter or typed by
 * the owner, that passed the reply checks when it was drafted, was approved
 * by the owner with a fresh authenticator code, and passed the checks again
 * on the exact text approved (lib/support/send.ts). It goes to the clinic's
 * one address, on a case the clinic opened: never first contact.
 *
 * Nothing else in it is free: the subject is fixed per topic with the case's
 * ref (lib/support/send-vocab.ts), the sign-off is "The Healdesk Team"
 * (SUPPORT_SIGN_OFF, never a first name), the reference line names the ref
 * so a reply joins the case, and compose() appends the standard footer: why
 * the practice gets this, that replies reach the team, and to leave patient
 * or client details out. Pure: the same payload renders the same bytes, so a
 * retry under the same idempotency key sends what the first try sent.
 *
 * The payload's `approvedReplyText` is the class lib/email/lint.ts accepts
 * for this kind alone, only with `approvedAt` and `approvedByLabel` beside it.
 */

export type SupportReplyPayload = {
  /** The case (support_cases.id). */
  caseId: string;
  /** The reply's own row (support_messages.id): the ledger's period and the idempotency key's id. */
  messageId: string;
  /** The case's ref as printed: "HD-7F3KQ". */
  supportRef: string;
  /** The case's topic (lib/support/escalation-fields.ts), from which the subject is fixed. */
  topic: string;
  /** The text the owner approved, exactly. */
  approvedReplyText: string;
  /** When it was approved, and the label it was approved under (support_messages). */
  approvedAt: string;
  approvedByLabel: string;
};

/** Why the practice gets this email (X1.9), printed in the footer. */
export const SUPPORT_REPLY_REASON = "You get this email because your practice asked healdesk for help.";

/** The reply's paragraphs: its text split on blank lines, each paragraph's lines kept. */
export function replyParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * The subject is passed in rather than built here, because the template
 * registry renders from the payload alone: support_reply's sender builds it
 * with supportReplySubject and checks it is the one the reply was approved
 * under (lib/support/send.ts).
 */
export function renderSupportReplyWith(subject: string): EmailTemplate<SupportReplyPayload> {
  return (payload, ctx) => {
    const paragraphs = replyParagraphs(payload.approvedReplyText);
    if (paragraphs.length === 0) throw new EmailCompositionError("A support reply carries its approved text.");
    const blocks: Block[] = [
      ...paragraphs.map((text): Block => ({ type: "paragraph", text })),
      { type: "paragraph", text: SUPPORT_SIGN_OFF },
      { type: "paragraph", text: `Your reference: ${payload.supportRef}. Reply to this email and it reaches the same request.` },
    ];
    const first = paragraphs[0]!.replace(/\s+/g, " ");
    return compose(
      {
        subject,
        preheader: first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first,
        blocks,
      },
      ctx,
    );
  };
}

const FIXTURE: SupportReplyPayload = {
  caseId: "8b0c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4",
  messageId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  supportRef: "HD-7F3KQ",
  topic: "forwarding",
  approvedReplyText:
    "Hi, calls aren't reaching AYA yet because forwarding on your main line isn't set, so callers reach your line as before and nobody is missed.\n\nThe codes for your carrier are in Settings, under Channels; they take about two minutes. If they don't take, reply here and we'll call you on Monday.",
  approvedAt: "2026-10-26T14:05:00.000Z",
  approvedByLabel: SUPPORT_SIGN_OFF,
};

export const SUPPORT_REPLY_ENTRY: TemplateEntry<SupportReplyPayload> = {
  render: renderSupportReplyWith("Re: Your call forwarding (ref HD-7F3KQ)"),
  fixture: FIXTURE,
};
