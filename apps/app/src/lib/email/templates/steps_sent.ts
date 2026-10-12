import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import { forwardingBlocks, type ForwardingFields } from "./forwarding-steps";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O11: "Steps from {clinic}" (Annex X5), when the clinic sends a step on to
 * the person who will do it: the forwarding steps to its office manager, or
 * its phone company's contact. A fixed template, with no free text from
 * anyone, because the address is the clinic's to choose and the words are
 * ours; at most three a day per clinic (lib/notices/steps-sent.ts). Its
 * footer says who asked for it and carries the link that stops any more of
 * them reaching this address.
 *
 * Phone only for now: the website line goes to the clinic's web person with
 * the widget (Launch-plan 1.8), whose line is not on main, so a payload for
 * website chat is refused rather than sent without its step.
 */

export type StepsSentPayload = ForwardingFields & {
  channel: "voice";
  /** This app's /help/call, while a scheduling page is set. */
  callUrl: string | null;
};

export const renderStepsSent: EmailTemplate<StepsSentPayload> = (payload, ctx) => {
  if (payload.channel !== "voice") {
    throw new EmailCompositionError(
      `Channel "${String(payload.channel)}" has no steps to send on until its step exists.`,
    );
  }
  const clinic = ctx.clinicName ?? "a practice";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `${clinic} asked us to send you these steps. They forward the practice's main line to AYA, its AI assistant from healdesk, so the calls the front desk can't take are answered. It takes a few minutes, from the practice's own phone.`,
    },
    ...forwardingBlocks(payload),
  ];
  if (payload.callUrl) {
    blocks.push(
      {
        type: "paragraph",
        text: "Easier with someone on the line? Book a five-minute call and we'll do it with you.",
      },
      { type: "action", label: "Book a five-minute call", url: payload.callUrl },
    );
  }
  blocks.push({
    type: "paragraph",
    text: "Questions? Reply to this email and a person at healdesk answers.",
  });
  return compose(
    {
      subject: `Call forwarding steps from ${clinic}`.slice(0, 70),
      preheader: "The steps to forward the practice's main line to AYA.",
      blocks,
    },
    ctx,
  );
};

/** The footer's line: who asked for it (Annex X5, O11). */
export function stepsReason(clinicName: string): string {
  return `You're receiving this because someone at ${clinicName} asked us to send it to this address.`;
}

export const STEPS_SENT_ENTRY: TemplateEntry<StepsSentPayload> = {
  render: renderStepsSent,
  get fixture(): StepsSentPayload {
    return {
      channel: "voice",
      ayaNumberE164: "+15125550142",
      carrier: "att",
      phoneSystem: "landline",
      routing: "conditional",
      callUrl: publicUrl("/help/call"),
    };
  },
};
