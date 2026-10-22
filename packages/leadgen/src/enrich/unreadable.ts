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
      ? `I went to look at ${clinic.domain} but couldn't get it to load properly.`
      : `I went to look at ${clinic.domain} but couldn't find much on it.`;

  // No clinic-specific capability claim, because we have no idea which one
  // fits. Round-the-clock cover is the one thing true of the product for
  // everybody, so it is the only thing asserted.
  //
  // "might end up" rather than "end up": we do not know that their phone goes
  // unanswered, and these are the recipients least willing to be told
  // something about themselves that we cannot have observed.
  const offer =
    `If visitors hit the same thing, they might call instead, and AYA, our ` +
    `${assistant} assistant, can answer and book them in around the clock.`;

  // No preview offer: the demo is built from the clinic's own site, and this
  // is the one list whose site we could not read.
  const closingQuestion = "Who's catching those calls right now?";

  return { hook, offer, closingQuestion, assistantTerm: assistant, reason };
}
