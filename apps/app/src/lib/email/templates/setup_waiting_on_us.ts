import { compose, EmailCompositionError, type Block } from "./compose";
import { noteLine, phraseWords } from "./contact-words";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O19, "Nothing for you to do: we're finishing ..." (design E2, "Wording:
 * clinic emails"; ops automation lane P6f): the clinic has done its part and
 * a step is ours. Sent only through the approval inbox, after the owner's
 * yes.
 *
 * It never extends anything and never says the wait is credited (owner
 * decision D6: days waiting on us never extend the deadline by themselves;
 * E2's "doesn't count against your setup window" clause is left out because
 * nothing makes it true). The only editable parts are the phrase naming what
 * we are finishing and one approved closing sentence (./contact-words.ts).
 * No link: there is nothing for the clinic to do.
 */

export type SetupWaitingOnUsPayload = {
  /** What we are finishing (./contact-words.ts PHRASES). */
  phrase: string;
  /** One approved closing sentence, or none. */
  note: string | null;
};

export const renderSetupWaitingOnUs: EmailTemplate<SetupWaitingOnUsPayload> = (payload, ctx) => {
  const what = phraseWords(payload.phrase);
  if (!what) throw new EmailCompositionError("A waiting-on-us notice names one phrase from the closed list.");
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `You've done your part. We're finishing ${what} on our side and will email you when it's ready. You don't need to do anything.`,
    },
  ];
  const note = noteLine(payload.note);
  if (note) blocks.push({ type: "paragraph", text: note });
  return compose(
    {
      subject: `Nothing for you to do: we're finishing ${what}`,
      preheader: "You've done your part. The next step is ours.",
      blocks,
    },
    ctx,
  );
};

export const SETUP_WAITING_ON_US_ENTRY: TemplateEntry<SetupWaitingOnUsPayload> = {
  render: renderSetupWaitingOnUs,
  fixture: { phrase: "phone", note: null },
};
