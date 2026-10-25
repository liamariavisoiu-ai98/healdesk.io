import { compose, type Block } from "./compose";
import { noteLine } from "./contact-words";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L36, "A quick question about your healdesk agreement" (design E6 §3 item
 * 13; ops automation lane P6f): a practice that signed the Data Protection
 * Agreement as billing no insurance electronically, whose website says it
 * accepts insurance (lib/agreements/misclassification.ts). Accepting
 * insurance is not billing it electronically, so the practice is asked, and
 * the owner records the answer he hears (recordAgreementAnswer); nothing
 * infers it.
 *
 * It says plainly what a Yes or Not sure means: the business associate
 * agreement to sign, and AYA paused until it is signed, at every location
 * when there is more than one (lib/agreements/resign.ts holds every location
 * of the organisation paused while that re-sign is open). Sent only through
 * the approval inbox, after the owner's yes. No link: the answer is a reply.
 * The only editable part is one approved closing sentence.
 */

export type AgreementQuestionPayload = {
  /** How many locations the agreement covers, the clinic's own included. */
  locations: number;
  /** Whether AYA answers anywhere yet: a practice not yet live is told she starts once it is signed. */
  isAnswering: boolean;
  /** One approved closing sentence, or none. */
  note: string | null;
};

export const renderAgreementQuestion: EmailTemplate<AgreementQuestionPayload> = (payload, ctx) => {
  const greeting = ctx.clinicName ? `Hi ${ctx.clinicName} team,` : "Hello,";
  const pause = payload.isAnswering
    ? payload.locations > 1
      ? `AYA pauses at all ${payload.locations} of your locations until it's signed`
      : "AYA pauses until it's signed"
    : "AYA starts answering only once it's signed";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `${greeting} when you signed up you told us your practice doesn't bill insurance electronically, so you signed our Data Protection Agreement. Your website mentions accepting insurance. That can be fine (superbills, or being out of network).`,
    },
    {
      type: "paragraph",
      text: "If your practice sends insurance claims or eligibility checks electronically, though, you need our business associate agreement instead.",
    },
    { type: "paragraph", text: "Could you reply with one word: Yes, No or Not sure?" },
    {
      type: "paragraph",
      text: `If it's Yes or Not sure, we'll send the business associate agreement to sign, and ${pause}. If it's No, nothing changes.`,
    },
  ];
  const note = noteLine(payload.note);
  if (note) blocks.push({ type: "paragraph", text: note });
  return compose(
    {
      subject: "A quick question about your healdesk agreement",
      preheader: "One word back from you: Yes, No or Not sure.",
      blocks,
    },
    ctx,
  );
};

export const AGREEMENT_QUESTION_ENTRY: TemplateEntry<AgreementQuestionPayload> = {
  render: renderAgreementQuestion,
  fixture: { locations: 1, isAnswering: true, note: null },
};
