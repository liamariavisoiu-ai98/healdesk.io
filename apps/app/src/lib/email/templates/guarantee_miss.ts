import { CHANNELS, type Channel } from "@healdesk/catalog";

import { dayLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L21, "A call AYA didn't answer" or "A message AYA didn't answer" (Annex
 * X5): a call or message routed to AYA was not answered. Normal priority,
 * daytime, to the clinic's one address.
 *
 * Kind and plain (owner's revision, 29 October 2026): what happened, that we
 * are looking into why, and that a reply reaches us. It does not name the
 * first-month guarantee: the Terms (section 5) promise a refund of the first
 * month's subscription fee only for a miss in the first month, and only on
 * the account owner's emailed claim, and this email cannot know the month,
 * so it neither promises nor denies. Minimal payload: the channel id and the
 * day. No link: a miss has no screen of its own.
 */

export type GuaranteeMissPayload = {
  /** The channel the call or message came in on. */
  channel: Channel;
  /** The day it was missed (ISO date, or an instant read on the clinic's clock). */
  missedOn: string;
};

export const renderGuaranteeMiss: EmailTemplate<GuaranteeMissPayload> = (payload, ctx) => {
  if (!(CHANNELS as readonly string[]).includes(payload.channel)) {
    throw new EmailCompositionError(`"${String(payload.channel)}" is not a channel.`);
  }
  const noun = payload.channel === "voice" ? "call" : "message";
  const day = dayLong(payload.missedOn, ctx);
  return compose(
    {
      subject: `A ${noun} AYA didn't answer`,
      preheader: "We're sorry, and we're looking into why.",
      blocks: [
        {
          type: "paragraph",
          text: `A ${noun} to ${ctx.clinicName ?? "your practice"} on ${day} reached AYA, and she didn't answer it. We're sorry. We're looking into why it happened.`,
        },
        {
          type: "paragraph",
          text: "If you'd like to talk it through, just reply to this email.",
        },
      ],
    },
    ctx,
  );
};

export const GUARANTEE_MISS_ENTRY: TemplateEntry<GuaranteeMissPayload> = {
  render: renderGuaranteeMiss,
  fixture: { channel: "voice", missedOn: "2026-10-05" },
};
