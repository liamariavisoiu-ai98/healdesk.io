import { PRACTICE_SECTION_WORDS, whatToFix } from "@/lib/engine/practice/sections";
import type { PracticeSection } from "@/lib/engine/practice/types";
import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O9: "One thing to fix" (Annex X5), to the clinic's address, when the
 * practice questions fail on the clinic's own data (lib/engine/practice): a
 * price the clinic's own answers contradict, a phrase on its never-say list
 * that stops AYA giving its price, no number for someone with an urgent
 * problem, a greeting that undoes the AI line. It names the section to fix
 * it in and a count, and never the service, the price or the phrase (Annex
 * X5, "O9: names the Knowledge section and a count, never the service").
 *
 * Once per audit-input version (dedupe `practice_questions_failed:<version>`),
 * so a clinic that saves the same thing again is not told twice. An outbox
 * kind: no token, and the action opens the section behind sign-in.
 */

export type PracticeQuestionsFailedPayload = {
  section: PracticeSection;
  /** How many things in that section made a case fail. */
  count: number;
  /** publicUrl("/c/<slug>/knowledge#…") or ("/c/<slug>/settings#…"): where to fix it. */
  fixUrl: string;
};

export const renderPracticeQuestionsFailed: EmailTemplate<PracticeQuestionsFailedPayload> = (
  payload,
  ctx,
) => {
  const words = PRACTICE_SECTION_WORDS[payload.section];
  if (!words) {
    throw new EmailCompositionError(`"${String(payload.section)}" is not a section to fix.`);
  }
  const what = whatToFix(payload.section, payload.count);
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "One thing to fix",
      preheader: `AYA got a practice question wrong because of ${what}.`,
      blocks: [
        {
          type: "paragraph",
          text: `AYA answers practice questions about ${clinic} before ${ctx.audience} talk to her, and again after every change. One came out wrong because of ${what}.`,
        },
        {
          type: "paragraph",
          text: "Fix it there and she answers them again a couple of minutes after you save.",
        },
        { type: "action", label: `Open ${words.place}`, url: payload.fixUrl },
      ],
    },
    ctx,
  );
};

export const PRACTICE_QUESTIONS_FAILED_ENTRY: TemplateEntry<PracticeQuestionsFailedPayload> = {
  render: renderPracticeQuestionsFailed,
  get fixture(): PracticeQuestionsFailedPayload {
    return {
      section: "prices",
      count: 1,
      fixUrl: publicUrl("/c/radiance-med-spa/knowledge#prices"),
    };
  },
};
