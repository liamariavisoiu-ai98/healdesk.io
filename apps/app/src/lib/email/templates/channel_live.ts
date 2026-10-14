import { audienceSingular, CHANNEL_NAMES, type Channel } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * L1: "AYA is answering on {channel}" (Annex X5), to the clinic's address,
 * once per channel, queued in the transaction that records the channel
 * `live` (lib/channels/events.ts).
 *
 * It says what is now true and what it costs, and nothing else: before any
 * channel has answered a patient, that the monthly plan starts the day AYA
 * first does; once one has, that this channel's price joins the plan from
 * its own first answer (Annex X5, L1). No price and no date of a charge:
 * the charge's own email (L2 or L3) carries those when it happens.
 *
 * An outbox kind: no token, and the links open the portal behind sign-in.
 */

export type ChannelLivePayload = {
  channel: Channel;
  /** When the channel went live. */
  liveAt: string;
  /** Whether a channel of this clinic had already answered a patient when this one went live. */
  isPlanStarted: boolean;
  /** publicUrl("/c/<slug>"): Home. */
  homeUrl: string;
  /** publicUrl("/c/<slug>/settings"): where each channel is switched On or Off. */
  settingsUrl: string;
  helpPhoneE164: string | null;
};

/** The subject and opening line for each channel, in the clinic's words. */
function words(
  channel: Channel,
  clinic: string,
  people: "patients" | "clients",
): { subject: string; opening: string; where: string; name: string } {
  switch (channel) {
    case "voice":
      return {
        subject: "AYA is answering your phone",
        opening: `Calls forwarded from ${clinic}'s line now reach AYA, and she answers them. Whenever she can't, they go to your direct line.`,
        where: "by phone",
        name: "phone",
      };
    case "web":
      return {
        subject: "AYA is answering your website chat",
        opening: `The chat on ${clinic}'s website is working, and AYA now answers the ${people} who write to you there.`,
        where: "in website chat",
        name: "website chat",
      };
    case "meta":
      return {
        subject: "AYA is answering on Instagram, Messenger & WhatsApp",
        opening: `AYA now answers the ${people} who message ${clinic} on the apps you connected.`,
        where: "on Instagram, Messenger or WhatsApp",
        name: "Instagram, Messenger & WhatsApp",
      };
  }
}

export const renderChannelLive: EmailTemplate<ChannelLivePayload> = (payload, ctx) => {
  if (!(payload.channel in CHANNEL_NAMES)) {
    throw new EmailCompositionError(`Channel "${String(payload.channel)}" has no live email.`);
  }
  const clinic = ctx.clinicName ?? "your practice";
  const one = audienceSingular(ctx.audience);
  const { subject, opening, where, name } = words(payload.channel, clinic, ctx.audience);
  const price = payload.isPlanStarted
    ? `Its price joins your monthly plan from the day AYA first answers a ${one} ${where}. We'll email you the new price that day.`
    : `Your monthly plan starts the day AYA first answers a ${one}. We'll email you that day.`;
  return compose(
    {
      subject,
      preheader: payload.isPlanStarted
        ? "Its price joins your plan from its first answer."
        : "Your monthly plan starts the day she first answers.",
      blocks: [
        { type: "paragraph", text: opening },
        { type: "paragraph", text: price },
        { type: "action", label: "See where things stand", url: payload.homeUrl },
        {
          type: "paragraph",
          text: `You can switch ${name} off in Settings at any time: ${payload.settingsUrl}`,
        },
        { type: "paragraph", text: helpLine(payload, one) },
      ],
    },
    ctx,
  );
};

export const CHANNEL_LIVE_ENTRY: TemplateEntry<ChannelLivePayload> = {
  render: renderChannelLive,
  get fixture(): ChannelLivePayload {
    return {
      channel: "web",
      liveAt: "2026-10-14T15:20:00Z",
      isPlanStarted: false,
      homeUrl: publicUrl("/c/radiance-med-spa"),
      settingsUrl: publicUrl("/c/radiance-med-spa/settings"),
      helpPhoneE164: "+18885550100",
    };
  },
};
