import { CHANNELS, type Channel } from "@healdesk/catalog";

import { dayLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L21, "We missed a call" or "We missed a message" (Annex X5): a guarantee
 * miss is recorded, a call or message routed to AYA that she did not answer.
 * Normal priority, daytime, to the clinic's one address, within the Terms'
 * notice days (whatever records the miss decides when; this only words it).
 *
 * One sentence of what happened, on which channel and which day, owning it,
 * and the one thing to do: reply if the clinic wants the first-month
 * guarantee checked (Terms § 5 and L30 take the claim from the account
 * owner's reply). No link: a miss has no screen of its own and nothing about
 * the call or message is stored to show. The plan did not declare the
 * payload, so it is the minimal set: the channel id and the day.
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
  const call = payload.channel === "voice";
  const noun = call ? "call" : "message";
  const where = call
    ? "your phone"
    : payload.channel === "web"
      ? "your website chat"
      : "Instagram, Messenger or WhatsApp";
  const day = dayLong(payload.missedOn, ctx);
  return compose(
    {
      subject: `We missed a ${noun}`,
      preheader: `AYA didn't answer a ${noun} on ${where}.`,
      blocks: [
        {
          type: "paragraph",
          text: `A ${noun} on ${where} on ${day} was routed to AYA and she didn't answer it. That's our miss, and we're sorry.`,
        },
        {
          type: "paragraph",
          text: "If this happened in your first month, our guarantee covers it. Reply to this email from your account address and we'll check our records and tell you what we found.",
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
