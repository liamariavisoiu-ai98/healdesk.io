import { audienceSingular } from "@healdesk/catalog";

import { casesNotAskable } from "@/lib/engine/practice/cases";
import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O8: "Your AYA is ready to talk to" (Annex X5), to the clinic's address, once
 * every stage of the build tracker is done: the last of them is the practice
 * questions passing (lib/engine/practice). It says what she passed and where
 * to talk to her, and that nothing in the preview reaches anyone. Once per
 * clinic (dedupe `assistant_ready`).
 *
 * While some cases cannot be asked (casesNotAskable: the booking and the
 * deposit booking, until AYA has booking tools), it names the ones that were
 * and says the booking ones wait, as Home's tracker does
 * (lib/setup/tracker.ts, practicePassedDetail): a pass of the cases asked is
 * not a pass of every case.
 *
 * Nothing about a patient: no case, no answer, no service. An outbox kind: no
 * token, and the action opens Home behind sign-in.
 */

export type AssistantReadyPayload = {
  /** publicUrl("/c/<slug>"): Home, where Talk to your AYA is. */
  homeUrl: string;
};

export const renderAssistantReady: EmailTemplate<AssistantReadyPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const people = ctx.audience;
  const one = audienceSingular(people);
  const unasked = casesNotAskable().length > 0;
  return compose(
    {
      subject: "Your AYA is ready to talk to",
      preheader: unasked
        ? `She has passed the practice questions she can be asked. Nothing in the preview reaches ${people}.`
        : `She has passed her practice questions. Nothing in the preview reaches ${people}.`,
      blocks: [
        {
          type: "paragraph",
          text: unasked
            ? `AYA has passed the practice questions she can be asked about ${clinic}: the line she opens with, a price on your menu and one that isn't, a clinical question she must not answer, an urgent message from a ${one}, an off-topic ${one} and a question your answers don't cover. The ones about booking and deposits wait for her booking tools.`
            : `AYA has passed her practice questions about ${clinic}: a price on your menu and one that isn't, a clinical question she must not answer, and someone who needs help urgently, among others.`,
        },
        {
          type: "paragraph",
          text: `Talk to her before anyone else does. Ask what your ${people} ask; in the preview nothing reaches a ${one}, and nothing is booked. If she gets something wrong, change it in Your practice and she uses it from then on.`,
        },
        { type: "action", label: "Talk to your AYA", url: payload.homeUrl },
      ],
    },
    ctx,
  );
};

export const ASSISTANT_READY_ENTRY: TemplateEntry<AssistantReadyPayload> = {
  render: renderAssistantReady,
  get fixture(): AssistantReadyPayload {
    return { homeUrl: publicUrl("/c/radiance-med-spa") };
  },
};
