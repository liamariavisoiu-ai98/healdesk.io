import type { Clinic } from "./dedupe.ts";
import { assistantTerm } from "./outreach.ts";

/**
 * Outreach for the clinics whose website could not be read.
 *
 * 307 of them. Every one has a domain, an email and a company name; what is
 * missing is everything the crawl would have produced. No service, no hours, no
 * booking platform, no gap.
 *
 * ## Why this cannot reuse buildOutreachRow
 *
 * Every branch of buildHook asserts something observed: a measured gap, a named
 * service, a booking page we followed. For these clinics we observed nothing,
 * so any hook implying otherwise is a claim the recipient can disprove by
 * looking at their own site. They are also the people most likely to check,
 * because the thing that failed is theirs.
 *
 * ## What it does instead
 *
 * Says plainly that the site would not load, which is true, checkable, and the
 * only thing we actually know about them. That is a weaker opening than a
 * 90-hour gap and it is an honest one, and for a founder-led practice a note
 * saying "your site would not load for me" is closer to useful than to
 * salesy.
 *
 * Deliberately short and deliberately one touch. There is no personalisation
 * to sustain a four-email sequence, and sending four generic emails to somebody
 * whose only distinguishing feature is a broken website is how a domain gets
 * burned for no return.
 */

export type UnreadableRow = {
  hook: string;
  offer: string;
  closingQuestion: string;
  assistantTerm: "smart" | "virtual";
  reason: string;
};

export type UnreadableReason = "no pages fetched" | "too little text";

export function buildUnreadableRow(
  clinic: Clinic,
  contact: { jobTitle: string; email: string },
  reason: UnreadableReason,
): UnreadableRow {
  const assistant = assistantTerm(contact.jobTitle, contact.email);

  // Two different observations, and conflating them would be the one
  // inaccuracy this whole file exists to avoid. A site that timed out is a
  // different fact from a site that loaded and said almost nothing.
  const hook =
    reason === "no pages fetched"
      ? `I went to look at ${clinic.domain} before writing and it would not load for me, which is worth knowing either way.`
      : `I had a look at ${clinic.domain} before writing and could not find much on it, which is worth knowing either way.`;

  // No capability claim, because we have no idea which one fits. What is true
  // of every clinic is that the phone is the fallback when the site is not
  // doing the work.
  const offer =
    `If patients are hitting the same thing, the phone is where they end up, ` +
    `and our ${assistant} assistant answers it and books them in.`;

  const closingQuestion = "Is that reaching you at the moment?";

  return { hook, offer, closingQuestion, assistantTerm: assistant, reason };
}
