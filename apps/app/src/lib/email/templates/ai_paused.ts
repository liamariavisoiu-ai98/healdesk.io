import { CHANNELS, type Channel } from "@healdesk/catalog";

import { fallbackLine, pausedChannelName } from "@/lib/channels/pause-words";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { publicUrl } from "@/lib/public-url";

import { momentLong } from "./billing-copy";
import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L15: "AYA is paused" (Annex X5), to the clinic's address. Sent when:
 *   - the header's switch pauses AYA until tomorrow or until someone turns
 *     her back on (never for an hour), and again 24 hours into a pause with
 *     no end;
 *   - a live channel, or one of the Meta apps, is switched Off in Settings,
 *     which counts as a pause with no end for that channel: again 24 hours
 *     later while it is still off.
 * lib/channels/pause.ts queues all four, in the transaction that makes them
 * true; the reminder waits in the outbox for its 24 hours, and is closed
 * unsent if AYA was turned back on meanwhile (lib/email/superseded.ts).
 *
 * It names the device it was done from (Annex X5, L15), says when it ends,
 * and gives one line per channel that stopped, worded from that channel's
 * real fallback: the same lines the header shows before the switch is
 * pressed (lib/channels/pause-words.ts). And it says what to do when nobody
 * at the practice did it, because this email is how a pause nobody made gets
 * noticed (lib/email/kinds.ts).
 *
 * An outbox kind: no token, and the links open the portal behind sign-in.
 */

export type AiPausedPayload = {
  /** `pause`: the header's switch, every channel at once; `channel_off`: one channel switched Off in Settings. */
  kind: "pause" | "channel_off";
  /** pause: the channels that were answering when it began; channel_off: the one channel. */
  channels: Channel[];
  /** channel_off on the Meta channel: the app switched Off; null for a whole channel. */
  platform: MetaPlatform | null;
  /** The device it was done from, when its name is one an email may carry; null otherwise. */
  deviceName: string | null;
  /** When the pause began, or the channel was switched Off. */
  pausedAt: string;
  /** pause only: when it ends by itself; null until someone turns AYA back on. */
  endsAt: string | null;
  /** The second email, 24 hours into a pause with no end. */
  isReminder: boolean;
  /** The clinic's direct line, for phone's line. */
  directLineE164: string | null;
  /** publicUrl("/c/<slug>"): the switch is in the header of every page. */
  homeUrl: string;
  /** publicUrl("/c/<slug>/settings"): where a channel is switched back On. */
  settingsUrl: string;
};

const PLATFORMS: readonly string[] = ["instagram", "messenger", "whatsapp"];

/** "your phone", "your website chat", "Instagram": the subject's last words. */
function subjectName(channel: Channel, platform: MetaPlatform | null): string {
  if (channel === "voice") return "your phone";
  if (channel === "web") return "your website chat";
  return pausedChannelName(channel, platform);
}

export const renderAiPaused: EmailTemplate<AiPausedPayload> = (payload, ctx) => {
  const channels = payload.channels.filter((c) => (CHANNELS as readonly string[]).includes(c));
  if (channels.length === 0) {
    throw new EmailCompositionError("A pause email needs the channels it stopped.");
  }
  if (payload.platform !== null && !PLATFORMS.includes(payload.platform)) {
    throw new EmailCompositionError(`"${String(payload.platform)}" is not one of the Meta apps.`);
  }
  const clinic = ctx.clinicName ?? "your practice";
  const people = ctx.audience;
  const at = momentLong(payload.pausedAt, ctx);
  const from = payload.deviceName ? ` from ${payload.deviceName}` : "";
  const lines: Block = {
    type: "list",
    items: channels.map((c) =>
      fallbackLine(c, payload.directLineE164, c === "meta" ? payload.platform : null),
    ),
  };

  if (payload.kind === "channel_off") {
    const channel = channels[0]!;
    const name = pausedChannelName(channel, payload.platform);
    const where = subjectName(channel, payload.platform);
    return compose(
      {
        subject: payload.isReminder
          ? `AYA is still paused on ${where}`
          : `AYA is paused on ${where}`,
        preheader: payload.isReminder
          ? "It has been switched off for a day."
          : "It stays off until someone switches it back on.",
        blocks: [
          {
            type: "paragraph",
            text: payload.isReminder
              ? `${name} has been switched off in Settings since ${at}, when it was switched off${from}. AYA isn't answering ${people} there until someone switches it back on.`
              : `${name} was switched off in Settings${from} at ${at}, so AYA isn't answering ${people} there. It stays off until someone switches it back on.`,
          },
          { type: "paragraph", text: "Meanwhile:" },
          lines,
          { type: "action", label: "Open Settings", url: payload.settingsUrl },
          {
            type: "paragraph",
            text: `If nobody at ${clinic} switched it off, switch it back on and reply to this email so we can look into it.`,
          },
        ],
      },
      ctx,
    );
  }

  const ends = payload.endsAt ? momentLong(payload.endsAt, ctx) : null;
  return compose(
    {
      subject: payload.isReminder ? "AYA is still paused" : "AYA is paused",
      preheader: payload.isReminder
        ? "She has been paused for a day."
        : ends
          ? `She answers again from ${ends}.`
          : "She stays paused until someone turns her back on.",
      blocks: [
        {
          type: "paragraph",
          text: payload.isReminder
            ? `AYA has been paused since ${at}, when she was paused${from}. She isn't answering ${people} on any channel.`
            : `AYA was paused${from} at ${at}, so she isn't answering ${people} on any channel.`,
        },
        {
          type: "paragraph",
          text: ends
            ? `She starts answering again by herself at ${ends}.`
            : "She stays paused until someone turns her back on, with the switch at the top of every page in healdesk.",
        },
        { type: "paragraph", text: "While she's paused:" },
        lines,
        { type: "action", label: "Turn AYA back on", url: payload.homeUrl },
        {
          type: "paragraph",
          text: `If nobody at ${clinic} paused her, turn her back on and reply to this email so we can look into it.`,
        },
      ],
    },
    ctx,
  );
};

export const AI_PAUSED_ENTRY: TemplateEntry<AiPausedPayload> = {
  render: renderAiPaused,
  get fixture(): AiPausedPayload {
    return {
      kind: "pause",
      channels: ["voice", "web"],
      platform: null,
      deviceName: "Front desk Mac",
      pausedAt: "2026-10-06T13:14:00Z",
      endsAt: "2026-10-07T12:00:00Z",
      isReminder: false,
      directLineE164: "+14155550100",
      homeUrl: publicUrl("/c/radiance-med-spa"),
      settingsUrl: publicUrl("/c/radiance-med-spa/settings"),
    };
  },
};
