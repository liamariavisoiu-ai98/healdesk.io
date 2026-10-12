import { audienceSingular } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import { forwardingBlocks, type ForwardingFields } from "./forwarding-steps";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * O10: "{Channel} is ready: one step left" (Annex X5), to the clinic's
 * address, when a channel is ready on our side and still waiting on the
 * clinic an hour after it became ready. Not sent when the step was done
 * within the hour: lib/notices/channel-ready.ts queues it, and the job that
 * calls it once readiness is recorded checks that first.
 *
 * Phone carries what forwarding needs: AYA's number, the steps for the
 * clinic's carrier and how its calls reach AYA, the undo, and the
 * five-minute call. Website chat carries the line to paste, which is the
 * widget's (Launch-plan 1.8) and not on main, so it has no variant here
 * yet; neither has the Meta channels' Facebook login. A payload for either
 * is refused rather than sent without its step.
 *
 * An outbox kind: no token, and the action opens the wizard's channel
 * screen behind sign-in.
 */

export type ChannelReadyPayload = ForwardingFields & {
  channel: "voice";
  /** publicUrl("/c/<slug>/setup?s=channels"): the forwarding screen. */
  setupUrl: string;
  /** This app's /help/call, while a scheduling page is set. */
  callUrl: string | null;
  helpPhoneE164: string | null;
};

export const renderChannelReady: EmailTemplate<ChannelReadyPayload> = (payload, ctx) => {
  if (payload.channel !== "voice") {
    throw new EmailCompositionError(
      `Channel "${String(payload.channel)}" has no ready email until its step exists.`,
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
