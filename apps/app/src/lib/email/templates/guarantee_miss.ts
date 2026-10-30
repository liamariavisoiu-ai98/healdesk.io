import { CHANNELS, type Channel } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { dayLong, momentLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L21, "Looking into a call from {day}" (Annex X5): a call or message routed
 * to AYA was not answered. Normal priority, daytime, to the clinic's one
 * address.
 *
 * Plain and calm (owner's final copy, 29 October 2026): what happened, where
 * it went, that we are fixing it, and a button to that one contact. It names
 * no guarantee and promises no follow-up email. Payload: channel, moment,
 * where it went, and the portal link (built upstream, like every
 * clinic-facing link). No words from the call or message can be in it.
 */

export type GuaranteeMissPayload = {
  /** The channel the call or message came in on. */
  channel: Channel;
  /** When it reached AYA unanswered (ISO instant). */
  missedAt: string;
  /** The call rang through to the direct line, or the contact form was shown. */
  wasRoutedToDirectLine: boolean;
  /** The portal page for that one missed contact. */
  missedUrl: string;
};

export const renderGuaranteeMiss: EmailTemplate<GuaranteeMissPayload> = (payload, ctx) => {
  if (!(CHANNELS as readonly string[]).includes(payload.channel)) {
    throw new EmailCompositionError(`"${String(payload.channel)}" is not a channel.`);
  }
  const call = payload.channel === "voice";
  const noun = call ? "call" : "message";
  // The subject names the day, so the body gives only the clock time.
  const clock = momentLong(payload.missedAt, ctx).replace(/ on .*$/, "");
  const where = !payload.wasRoutedToDirectLine
    ? ""
    : call
      ? " It rang through to your direct line."
      : payload.channel === "web"
        ? " Your contact form was shown instead."
        : "";
  return compose(
    {
      subject: `Looking into a ${noun} from ${dayLong(payload.missedAt, ctx)}`,
      preheader: "We're looking into why, and will fix it.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA wasn't able to answer a ${noun} at ${clock}.${where} We're looking into why and will fix it so this doesn't happen again.`,
        },
        { type: "action", label: `See the ${noun}`, url: payload.missedUrl },
      ],
    },
    ctx,
  );
};

export const GUARANTEE_MISS_ENTRY: TemplateEntry<GuaranteeMissPayload> = {
  render: renderGuaranteeMiss,
  get fixture(): GuaranteeMissPayload {
    return {
      channel: "voice",
      missedAt: "2026-10-05T18:10:00Z",
      wasRoutedToDirectLine: true,
      missedUrl: publicUrl("/c/radiance-med-spa/missed/6b1f2c3d-4e5a-4b6c-8d7e-9f0a1b2c3d4e"),
    };
  },
};
