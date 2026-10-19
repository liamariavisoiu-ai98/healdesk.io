import { audienceSingular } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";
import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import { WIDGET_SCRIPT_PATH } from "@/lib/setup/snippet";

import { compose, EmailCompositionError, type Block } from "./compose";
import { forwardingBlocks, type ForwardingFields } from "./forwarding-steps";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";
import { PASTE_WHERE, webLineBlock, type WebLineFields } from "./web-line";
import { helpLine } from "./welcome";

/**
 * O10: "{Channel} is ready: one step left" (Annex X5), to the clinic's
 * address, when a channel is ready on our side and still waiting on the
 * clinic an hour after it became ready. Not sent when the step was done
 * within the hour: lib/notices/channel-ready.ts queues it, and the outbox
 * asks again at its due time whether the channel still waits on that step
 * (lib/email/superseded.ts).
 *
 * Phone carries what forwarding needs: AYA's number, the steps for the
 * clinic's carrier and how its calls reach AYA, the undo, and the
 * five-minute call. Website chat carries the line to paste, built from the
 * stored script address and slug exactly as the screens print it
 * (./web-line.ts), with the way to send it on from Settings. The Meta
 * channels' step is the Facebook login, which an email cannot carry, so a
 * payload for them is refused rather than sent without its step.
 *
 * An outbox kind: no token, and the action opens the portal behind sign-in.
 */

export type ChannelReadyPayload =
  | (ForwardingFields & {
      channel: "voice";
      /** publicUrl("/c/<slug>/setup?s=channels"): the forwarding screen. */
      setupUrl: string;
      /** This app's /help/call, while a scheduling page is set. */
      callUrl: string | null;
      helpPhoneE164: string | null;
    })
  | (WebLineFields & {
      channel: "web";
      /** publicUrl("/c/<slug>/settings#website-line"): the line, its copy button and "Email to my web person". */
      settingsUrl: string;
      helpPhoneE164: string | null;
    });

export const renderChannelReady: EmailTemplate<ChannelReadyPayload> = (payload, ctx) => {
  if (payload.channel === "web") return renderWebReady(payload, ctx);
  if (payload.channel !== "voice") {
    throw new EmailCompositionError(
      `Channel "${String((payload as { channel: unknown }).channel)}" has no ready email until its step exists.`,
    );
  }
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA is ready to answer ${clinic}'s calls. One step is left, and it's yours: forward your main line to her, so the calls your team can't take reach her.`,
    },
    ...forwardingBlocks(payload),
    { type: "action", label: "See the steps in healdesk", url: payload.setupUrl },
  ];
  if (payload.callUrl) {
    blocks.push(
      {
        type: "paragraph",
        text: "Forwarding is easier with someone on the line. Book a five-minute call and we'll do it with you.",
      },
      { type: "action", label: "Book a five-minute call", url: payload.callUrl },
    );
  }
  blocks.push({ type: "paragraph", text: helpLine(payload, audience) });
  return compose(
    {
      subject: "Phone is ready: one step left",
      preheader: "Forward your main line to AYA and she starts answering.",
      blocks,
    },
    ctx,
  );
};

/**
 * Website chat's: the line, where it goes, that a chat on the live site is a
 * real one (as every screen showing the line says), and Settings, where the
 * line stays with its copy button and "Email to my web person".
 */
function renderWebReady(
  payload: Extract<ChannelReadyPayload, { channel: "web" }>,
  ctx: TemplateContext,
) {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Website chat is ready: one step left",
      preheader: "Paste one line on your website and AYA starts answering there.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA is ready to answer chats on ${clinic}'s website. One step is left, and it's yours: paste this line once, ${PASTE_WHERE} of your website.`,
        },
        webLineBlock(payload),
        { type: "paragraph", text: WEB_CHAT_COUNTS_LINE },
        {
          type: "paragraph",
          text: "If someone else looks after your website, send it to them from Settings: we email them the line and where it goes, and nothing else.",
        },
        { type: "action", label: "Open the line in Settings", url: payload.settingsUrl },
        { type: "paragraph", text: helpLine(payload, audienceSingular(ctx.audience)) },
      ],
    },
    ctx,
  );
}

export const CHANNEL_READY_ENTRY: TemplateEntry<ChannelReadyPayload> = {
  render: renderChannelReady,
  get fixture(): ChannelReadyPayload {
    return {
      channel: "voice",
      ayaNumberE164: "+15125550142",
      carrier: "verizon",
      phoneSystem: "landline",
      routing: "conditional",
      setupUrl: publicUrl("/c/radiance-med-spa/setup?s=channels"),
      callUrl: publicUrl("/help/call"),
      helpPhoneE164: "+18885550100",
    };
  },
};

/** Website chat's variant, beside the registry's phone fixture, for the tests and the seed script. */
export function channelReadyWebFixture(): Extract<ChannelReadyPayload, { channel: "web" }> {
  return {
    channel: "web",
    scriptUrl: publicUrl(WIDGET_SCRIPT_PATH),
    clinicSlug: "radiance-med-spa",
    settingsUrl: publicUrl("/c/radiance-med-spa/settings#website-line"),
    helpPhoneE164: "+18885550100",
  };
}
