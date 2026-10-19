import { forwardingInstructions } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";
import { WIDGET_SCRIPT_PATH } from "@/lib/setup/snippet";

import { compose, EmailCompositionError, type Block } from "./compose";
import { forwardingBlocks, type ForwardingFields } from "./forwarding-steps";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";
import { PASTE_WHERE, webLineBlock, type WebLineFields } from "./web-line";

/**
 * O11: "Steps from {clinic}" (Annex X5), when the clinic sends a step on to
 * the person who will do it: the forwarding steps to its office manager, or
 * its phone company's contact; the website-chat line to its web person
 * (spec: "a 'send this to my web person' button emails the snippet with a
 * two-sentence instruction"). A fixed template, with no free text from
 * anyone, because the address is the clinic's to choose and the words are
 * ours; at most three a day per clinic, whichever channel's
 * (lib/notices/steps-sent.ts). Its footer says who asked for it and carries
 * the link that stops any more of them reaching this address.
 *
 * The Meta channels' step is the clinic's own Facebook login, which nobody
 * can do for it from an email, so a payload for them is refused.
 */

export type StepsSentPayload =
  | (ForwardingFields & {
      channel: "voice";
      /** This app's /help/call, while a scheduling page is set. */
      callUrl: string | null;
    })
  | (WebLineFields & { channel: "web" });

export const renderStepsSent: EmailTemplate<StepsSentPayload> = (payload, ctx) => {
  if (payload.channel === "web") return renderWebLine(payload, ctx);
  if (payload.channel !== "voice") {
    throw new EmailCompositionError(
      `Channel "${String((payload as { channel: unknown }).channel)}" has no steps to send on until its step exists.`,
    );
  }
  const clinic = ctx.clinicName ?? "a practice";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `${clinic} asked us to send you these steps. They forward the practice's main line to AYA, its AI assistant from healdesk, so the calls the front desk can't take are answered. ${howItIsDone(payload)}`,
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
  blocks.push({ type: "paragraph", text: QUESTIONS_LINE });
  return compose(
    {
      subject: `Call forwarding steps from ${clinic}`.slice(0, 70),
      preheader: "The steps to forward the practice's main line to AYA.",
      blocks,
    },
    ctx,
  );
};

const QUESTIONS_LINE = "Questions? Reply to this email and a person at healdesk answers.";

/**
 * What doing the steps below involves, never how long it takes (the set-up
 * promise describes the step, never the time; until 19 October 2026 this
 * said "It takes a few minutes"). The same three paths the steps take
 * (forwardingInstructions): the carrier's steps for the kind of line, which
 * for some lines are a call to the carrier or a setting on the phone rather
 * than a code, so the sentence names the steps and only then the codes; a
 * rule in a cloud phone system's admin; or, with no codes for the carrier, a
 * request to it.
 */
function howItIsDone(fields: ForwardingFields): string {
  if (fields.phoneSystem === "voip") {
    return "It's done in the admin of the practice's phone system, as below.";
  }
  const { needsCarrierHelp } = forwardingInstructions({
    carrier: fields.carrier,
    phoneSystemType: fields.phoneSystem,
    routing: fields.routing,
    destinationE164: fields.ayaNumberE164,
  });
  return needsCarrierHelp
    ? "It's done by asking the practice's phone company, as below."
    : "It's done by following the steps below for the practice's kind of line, dialling each code from the main line itself.";
}

/** Website chat's: who asked, the two-sentence instruction, and the line. */
function renderWebLine(
  payload: Extract<StepsSentPayload, { channel: "web" }>,
  ctx: TemplateContext,
) {
  const clinic = ctx.clinicName ?? "a practice";
  return compose(
    {
      subject: `Website chat line from ${clinic}`.slice(0, 70),
      preheader: "One line to paste on the practice's website.",
      blocks: [
        {
          type: "paragraph",
          text: `${clinic} asked us to send you this line for its website. Paste it once, ${PASTE_WHERE} of the site. AYA, the practice's AI assistant from healdesk, is designed to start answering chats there once it's in.`,
        },
        webLineBlock(payload),
        { type: "paragraph", text: QUESTIONS_LINE },
      ],
    },
    ctx,
  );
}

/** The footer's line: who asked for it (Annex X5, O11). */
export function stepsReason(clinicName: string | null): string {
  return `You're receiving this because someone at ${clinicName ?? "a practice"} asked us to send it to this address.`;
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

/** Website chat's variant, beside the registry's phone fixture, for the tests and the seed script. */
export function stepsSentWebFixture(): Extract<StepsSentPayload, { channel: "web" }> {
  return {
    channel: "web",
    scriptUrl: publicUrl(WIDGET_SCRIPT_PATH),
    clinicSlug: "radiance-med-spa",
  };
}
