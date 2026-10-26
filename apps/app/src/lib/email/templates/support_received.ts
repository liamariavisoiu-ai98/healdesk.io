import { formatReplyBy } from "@/lib/reply-by";

import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L38, "We've got your email" (ops automation lane P7g; design E5 §2.6;
 * owner decision D14: a fixed acknowledgement goes without approval): the
 * acknowledgement of a practice's email to support, once per case, through
 * the outbox, which sends it to the practice's owners and billing contacts
 * (lib/billing/recipients.ts), never to the email's From, so a stranger's
 * mail is never answered. The outbox has no fixed recipient per kind, so the
 * words do not say which address the reply will go to: a support reply goes
 * to the practice's sign-in address (lib/support/send.ts), which may be
 * another.
 *
 * Fixed words throughout. It carries the case's ref, so a reply joins the
 * case, and the day a person will reply by. It quotes nothing of the email,
 * which healdesk does not keep. When the screen found what looked like a
 * patient's or client's details, one fixed sentence asks that they be left
 * out and points to where the practice already sees them in its portal.
 */

export type SupportReceivedPayload = {
  /** The case (support_cases.id). */
  caseId: string;
  /** The case's ref as printed: "HD-7F3KQ". */
  supportRef: string;
  /** The next business day in New York, as an ISO date. */
  replyByOn: string;
  /** The screen found numbers, addresses, treatment names or clinical words in the email. */
  hasPatientDetails: boolean;
};

export const renderSupportReceived: EmailTemplate<SupportReceivedPayload> = (payload, ctx) => {
  const replyBy = formatReplyBy(payload.replyByOn);
  const who = ctx.audience === "clients" ? "client" : "patient";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `We've got your email to healdesk support. A person at healdesk will reply by ${replyBy}.`,
    },
    { type: "facts", rows: [["Your reference", payload.supportRef]] },
    {
      type: "paragraph",
      text: "To add anything, reply to this email and keep the reference in the subject, so it joins the same request.",
    },
  ];
  if (payload.hasPatientDetails) {
    blocks.push({
      type: "paragraph",
      text: `Your email looked like it might include ${who} details. Please leave them out of support emails: you can see each conversation and booking in your portal, under Conversations and Bookings.`,
    });
  }
  return compose(
    {
      subject: `We've got your email (ref ${payload.supportRef})`,
      preheader: `A person at healdesk will reply by ${replyBy}.`,
      blocks,
    },
    ctx,
  );
};

export const SUPPORT_RECEIVED_ENTRY: TemplateEntry<SupportReceivedPayload> = {
  render: renderSupportReceived,
  fixture: {
    caseId: "8b0c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4",
    supportRef: "HD-7F3KQ",
    replyByOn: "2026-10-27",
    hasPatientDetails: true,
  },
};
