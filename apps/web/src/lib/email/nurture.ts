import { type AgreementKind, COHORT_SETUP_CREDIT } from "@healdesk/catalog";

import type { Lead } from "@/lib/leads";

import { setupFeeRangeLabel } from "@/lib/pricing";
import { site } from "@/lib/site";

import { unsubscribeUrl } from "./index";
import { commercialFooter, longDate } from "./setup-emails";

/**
 * The follow-up sequence for people who tried the demo and ticked the box.
 *
 * Four emails over eight days, then silence. Every one is plain text, from a
 * person, and says something true about the product as it exists — no
 * "your draft expires" (nothing expires), no invented countdown, no claimed
 * recovery rate. The one number the sequence offers is the visitor's own
 * calculator, which they set themselves.
 *
 * Timing is hours after consent, not after the previous send, so a cron that
 * missed a day sends the touch that is due and not three at once: a lead is
 * eligible for TOUCHES[nurtureStep] once `consentAt + afterHours` has passed,
 * and the cron sends at most one touch per lead per run.
 *
 * The "still open" message (P7) is separate (below) and is `relationship`
 * mail: it goes to someone who started a purchase, whether or not they
 * ticked the box.
 */

export type Touch = {
  step: number;
  afterHours: number;
  subject: string;
  text: (lead: Lead) => string;
};

function firstName(lead: Lead): string {
  const local = lead.email.split("@")[0] ?? "";
  const guess = local.split(/[._-]/)[0] ?? "";
  return /^[a-z]{2,}$/i.test(guess) ? guess[0]!.toUpperCase() + guess.slice(1).toLowerCase() : "there";
}

/**
 * The footer every commercial email carries (Annex X1.9 and X1.10, the same
 * one the setup-link emails use): why it came and the one-click way to stop
 * it, that replies reach the healdesk team and should leave out patient
 * details, the operating entity as the site names it, and the mailing address
 * CAN-SPAM requires. It replaced, on 14 October 2026, a footer that named the
 * trade name alone and asked no one to keep patient details out of replies.
 */
function footer(lead: Lead): string {
  return (
    "\n" +
    commercialFooter(
      `You're getting this because you ticked "email me about ${site.agent}" on ${site.domain}.`,
      unsubscribeUrl(lead.id),
    )
  );
}

export const TOUCHES: readonly Touch[] = [
  {
    step: 0,
    afterHours: 24,
    subject: `What ${site.agent} would have said on your phone last night`,
    text: (lead) =>
      `Hi ${firstName(lead)},\n\n` +
      `You tried the ${site.agent} demo yesterday. Thank you — most people leave after one question, so if you got further, you saw the part that matters: it books, it declines clinical questions, and it says it is an AI.\n\n` +
      `The number worth knowing is yours, not ours. The calculator at ${site.url}/why-wait lets you set your own call volume, your own miss rate, and your own guess at how many of those calls ${site.agent} would keep. We deliberately do not fill that last one in.\n\n` +
      `If you want to hear it on a real call, the phone panel beside the demo on ${site.url} will place one demo call to you with ${site.agent} on it — because you asked, once, and never again unless you ask. For your clinic she only answers; she never dials a patient.\n\n` +
      `Reply to this email and a person answers.` +
      footer(lead),
  },
  {
    step: 1,
    afterHours: 72,
    subject: `The two things ${site.agent} will not do`,
    text: (lead) =>
      `Hi ${firstName(lead)},\n\n` +
      `Two things clinic owners ask first, answered plainly.\n\n` +
      `1. It does not give medical advice. Ask it whether a treatment is safe during pregnancy and it says it can't answer that and offers to book a consultation with your provider instead. That is the product, not a limitation.\n\n` +
      `2. It does not pretend to be a person. Every call, chat and DM opens by saying it is an AI assistant, and on the phone that the call is transcribed, not recorded. You cannot switch that off.\n\n` +
      `What it does do: answer every call, chat and DM, day or night; qualify; book straight into your Google Calendar during the conversation; take deposits in chat through your own checkout link; and show you what it handled and booked. Every product, its price per step of 100 and its setup fee are on one page: ${site.url}/pricing\n\n` +
      `Reply with your booking system and I'll tell you whether it reads Google Calendar for conflicts, which decides whether she books live for you or your staff confirm each booking.` +
      footer(lead),
  },
  {
    step: 2,
    afterHours: 120,
    subject: `Your front desk, forwarded — how the first week goes`,
    text: (lead) =>
      `Hi ${firstName(lead)},\n\n` +
      `The question I hear at this point is "what does setup actually involve". Here it is, without the brochure:\n\n` +
      `- You keep your phone number. You forward it to ${site.agent} for every call, for overflow and after hours, or after hours only, and you can remove the forwarding yourself at any time.\n` +
      `- We pre-fill the agent from your website. You confirm your services, prices and hours, set how she behaves, and connect your Google Calendar: about fifteen minutes of your time. An automated test of your prices, bookings and clinical questions has to pass before she answers a patient.\n` +
      `- Each channel goes live on its own: website chat once the snippet is on your site, Instagram and Messenger once you connect them, WhatsApp once your WhatsApp account has a payment method, your phone once forwarding is set.\n` +
      `- You sign the data agreement your practice needs at checkout, before payment. The full text is on that step, and a copy is emailed to you.\n` +
      `- Your dashboard and a daily summary email show conversations handled, appointments booked, calls answered that would have rung out, deposits collected and booked value.\n\n` +
      `If the missing piece is a vendor question — "does it work with X" — reply with X.` +
      footer(lead),
  },
  {
    step: 3,
    afterHours: 192,
    subject: `Last one from me`,
    text: (lead) =>
      `Hi ${firstName(lead)},\n\n` +
      `This is the last email in this sequence; I don't chase. If the timing is wrong, nothing happens and you won't hear from me again unless you come back.\n\n` +
      `If it was a specific doubt — price, the booking system, whether a cash-pay practice even needs the HIPAA paperwork — reply with it and I'll answer it straight, including "no, not yet" where that is the answer.\n\n` +
      `One thing I can do: a setup credit that waives the one-time setup fee in full (${setupFeeRangeLabel()} depending on the package). It applies when you start from this link within ${COHORT_SETUP_CREDIT.validDays} days: ${site.url}/get-started?lead=${lead.id}\n\n` +
      `Thanks for trying it.` +
      footer(lead),
  },
];

/** The touch a lead is due right now, or null. At most one per run. */
export function dueTouch(lead: Lead, now: Date): Touch | null {
  const touch = TOUCHES[lead.nurtureStep];
  if (!touch || !lead.consentAt) return null;
  const dueAt = lead.consentAt.getTime() + touch.afterHours * 60 * 60 * 1000;
  return now.getTime() >= dueAt ? touch : null;
}

/**
 * P7, "still open": one message, 24 hours after the latest Checkout Session
 * expired unpaid (Annex X5; the webhook records the expiry), re-checked at
 * send time against the purchase's own records (lib/email/run-nurture.ts).
 * It replaced, on 14 October 2026, the "checkout not finished" email, which
 * went an hour after a Session was created, said the setup was "saved where
 * you left it" (nothing is saved: the answers live in the buyer's tab), named
 * the Business Associate Agreement whichever agreement the practice signed,
 * and carried no setup link (X6).
 *
 * Commercial mail (X1.10): the opt-out, the postal address and the footer
 * every email carries. Relationship eligibility (lib/leads.ts `canEmail`):
 * they started a purchase, so no consent box is needed, and it stops on
 * unsubscribe, bounce and purchase.
 */
export const STILL_OPEN_AFTER_MS = 24 * 60 * 60 * 1000;
/** A P7 not sent within a week of the expiry is not sent at all. */
export const STILL_OPEN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/** What P7 says, read from the purchase at send time. */
export type StillOpenFacts = {
  /** The practice's name as the purchase gave it, or the lead's. */
  clinicName: string | null;
  /** The agreement the buyer signed for this purchase, or null when it cannot be read. */
  agreementKind: AgreementKind | null;
  /** The setup link, re-signed from the request's stored expiry, while it still works. */
  setupLink: { url: string; expiresAt: Date } | null;
};

/** "AYA Voice for Radiance Med Spa": a clinic name cut so a subject stays within 70 characters (X4). */
export function nameForSubject(name: string, room: number): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length <= room ? clean : `${clean.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
}

const AGREEMENT_NOUN: Readonly<Record<AgreementKind, string>> = {
  baa: "business associate agreement",
  dpa: "data protection agreement",
};

export function stillOpenEmail(lead: Lead, facts: StillOpenFacts): { subject: string; text: string } {
  const clinic = facts.clinicName?.trim() || null;
  const agreement = facts.agreementKind ? `the ${AGREEMENT_NOUN[facts.agreementKind]}` : "the data agreement your practice needs";
  const subject = facts.setupLink
    ? `Your setup link for ${nameForSubject(clinic ?? "your clinic", 70 - "Your setup link for  is still open".length)} is still open`
    : clinic
      ? `Your purchase for ${nameForSubject(clinic, 70 - "Your purchase for  is not finished".length)} is not finished`
      : "Your healdesk purchase is not finished";
  const next = facts.setupLink
    ? `Your setup link still works, until ${longDate(facts.setupLink.expiresAt)}:\n\n${facts.setupLink.url}\n\n` +
      `It opens the purchase again: choose your package, tell us about your clinic, sign ${agreement} and pay the setup fee.`
    : `To finish, start again at ${site.url}/get-started: choose your package, tell us about your clinic, sign ${agreement} and pay the setup fee.`;
  return {
    subject,
    text:
      `Hi ${firstName(lead)},\n\n` +
      `You got as far as payment${clinic ? ` for ${clinic}` : ""} on ${site.domain} and stopped. Nothing has been charged.\n\n` +
      `${next}\n\n` +
      `If you signed ${agreement}, it is on file and belongs to no account: it attaches to yours only if you finish, and if you'd rather we voided it, reply and say so.\n\n` +
      `If a question stopped you, about price, your booking system or the agreement, reply and a person answers.` +
      "\n" +
      commercialFooter(
        `You're getting this because you started a purchase${clinic ? ` for ${clinic}` : ""} at ${site.domain}.`,
        unsubscribeUrl(lead.id),
      ),
  };
}
