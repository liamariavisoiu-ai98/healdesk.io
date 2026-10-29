import { CHANNELS, type Channel } from "@healdesk/catalog";

import { momentLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L21, "A call AYA didn't answer" or "A message AYA didn't answer" (Annex
 * X5): a call or message routed to AYA was not answered. Normal priority,
 * daytime, to the clinic's one address.
 *
 * Kind and plain (owner, 29 October 2026): what happened, that we are
 * looking into why so it does not recur, and that a reply reaches us. It does not name the
 * first-month guarantee: the Terms (section 5) promise a refund of the first
 * month's subscription fee only for a miss in the first month, and only on
 * the account owner's emailed claim, and this email cannot know the month,
 * so it neither promises nor denies. Minimal payload: the channel id and the
 * moment. No link: a miss has no screen of its own.
 */

export type GuaranteeMissPayload = {
  /** The channel the call or message came in on. */
  channel: Channel;
  /** When it reached AYA unanswered (ISO instant). */
  missedAt: string;
};

export const renderGuaranteeMiss: EmailTemplate<GuaranteeMissPayload> = (payload, ctx) => {
  if (!(CHANNELS as readonly string[]).includes(payload.channel)) {
    throw new EmailCompositionError(`"${String(payload.channel)}" is not a channel.`);
  }
  const noun = payload.channel === "voice" ? "call" : "message";
  const when = momentLong(payload.missedAt, ctx);
  return compose(
    {
      subject: `We're looking into a ${noun}`,
      preheader: "Nothing for you to do. Reply if you'd like to know more.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA wasn't able to answer a ${noun} to ${ctx.clinicName ?? "your practice"} at ${when}. We're looking into why, so it doesn't happen again.`,
        },
        {
          type: "paragraph",
          text: "If you'd like to know more, just reply to this email.",
        },
      ],
    },
    ctx,
  );
};

export const GUARANTEE_MISS_ENTRY: TemplateEntry<GuaranteeMissPayload> = {
  render: renderGuaranteeMiss,
  fixture: { channel: "voice", missedAt: "2026-10-05T18:10:00Z" },
};
