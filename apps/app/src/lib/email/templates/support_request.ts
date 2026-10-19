import { formatReplyBy } from "@/lib/reply-by";
import { formatPhone } from "@/lib/setup/help";
import { topicLabel } from "@/lib/support/escalation-fields";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L25, "We've got your request" (Annex X5): the acknowledgement of an
 * escalation from the portal's support chat, to the clinic's one address,
 * through the outbox. It says when we'll reply, by date (X1.3: never "within
 * one business day"), and what the request carried: the topic and the
 * details picked in the chat and the account's state, never the chat's
 * words, which healdesk does not keep (spec, "Support chat in the portal").
 *
 * The payload is ids, a topic, a date and healdesk's own support line.
 */

export type SupportRequestPayload = {
  /** The escalation's id: the same as the I3 email's to hello@. */
  requestId: string;
  /** The topic picked in the chat (support/escalation-fields.ts). */
  topic: string;
  /** The next business day, as an ISO date: the day we promise to reply by. */
  replyByOn: string;
  /** healdesk's support voicemail line while the owner has set one. */
  helpPhoneE164: string | null;
};

export const renderSupportRequest: EmailTemplate<SupportRequestPayload> = (payload, ctx) => {
  const replyBy = formatReplyBy(payload.replyByOn);
  const audience = ctx.audience === "clients" ? "client" : "patient";
  return compose(
    {
      subject: "We've got your request",
      preheader: `A person at healdesk will reply by ${replyBy}.`,
      blocks: [
        {
          type: "paragraph",
          text: `We've got the request you sent from the support chat in your portal. A person at healdesk will reply to this address by ${replyBy}.`,
        },
        { type: "facts", rows: [["Topic", topicLabel(payload.topic)]] },
        {
          type: "paragraph",
          text: "The request carried the topic and the details you picked, and your account's setup, channel and billing state. The chat's words were not sent, and healdesk doesn't keep them.",
        },
        {
          type: "paragraph",
          text: payload.helpPhoneE164
            ? `To add anything, reply to this email or leave a message on ${formatPhone(payload.helpPhoneE164)}. Please leave out ${audience} details.`
            : `To add anything, reply to this email. Please leave out ${audience} details.`,
        },
      ],
    },
    ctx,
  );
};

export const SUPPORT_REQUEST_ENTRY: TemplateEntry<SupportRequestPayload> = {
  render: renderSupportRequest,
  fixture: {
    requestId: "6f1e2d3c-4b5a-4968-8776-655443322110",
    topic: "forwarding",
    replyByOn: "2026-10-07",
    helpPhoneE164: "+18886889404",
  },
};
