import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import { noteLine, phraseWords } from "./contact-words";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O20, "Want us to finish this with you?" (design E2, "Wording: clinic
 * emails"; ops automation lane P6f): the offer of a five-minute call, once
 * per lifecycle stage entry, sent only through the approval inbox after the
 * owner's yes.
 *
 * The call link is this app's own /help/call redirect (lib/setup/help.ts
 * emailCallUrl), present only while a scheduling page is set; without it the
 * clinic is asked to reply with a time. The only editable parts are the
 * phrase naming the step and one approved closing sentence.
 */

export type SetupHelpOfferPayload = {
  /** The step the call is for (./contact-words.ts PHRASES). */
  phrase: string;
  /** This app's /help/call, while a scheduling page is set; else null. */
  callUrl: string | null;
  /** One approved closing sentence, or none. */
  note: string | null;
};

export const renderSetupHelpOffer: EmailTemplate<SetupHelpOfferPayload> = (payload, ctx) => {
  const what = phraseWords(payload.phrase);
  if (!what) throw new EmailCompositionError("A help offer names one phrase from the closed list.");
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Setting up ${what} takes about five minutes with someone on the line. Pick a time and we'll do it together.`,
    },
  ];
  if (payload.callUrl) {
    blocks.push({ type: "action", label: "Book a five-minute call", url: payload.callUrl });
    blocks.push({ type: "paragraph", text: "Or reply with a time that suits you." });
  } else {
    blocks.push({ type: "paragraph", text: "Reply with a time that suits you and we'll call." });
  }
  const note = noteLine(payload.note);
  if (note) blocks.push({ type: "paragraph", text: note });
  return compose(
    {
      subject: "Want us to finish this with you?",
      preheader: "Five minutes on a call, and we'll do it together.",
      blocks,
    },
    ctx,
  );
};

export const SETUP_HELP_OFFER_ENTRY: TemplateEntry<SetupHelpOfferPayload> = {
  render: renderSetupHelpOffer,
  get fixture(): SetupHelpOfferPayload {
    return { phrase: "phone", callUrl: publicUrl("/help/call"), note: null };
  },
};
