import type { Lead } from "@/lib/db/schema";
import { ENTITY, entityDisplayName } from "@/lib/legal";
import { site } from "@/lib/site";

import { unsubscribeUrl } from "./index";

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
 * The abandonment message is separate (below) and is `relationship` mail: it
 * goes to someone who started a checkout, whether or not they ticked the box.
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

function footer(lead: Lead): string {
  const address = ENTITY.postalAddress ? `\n${entityDisplayName()}, ${ENTITY.postalAddress}` : `\n${entityDisplayName()}`;
  return (
    `\n\n—\nYou're getting this because you ticked "email me about ${site.agent}" on ${site.domain}. ` +
    `One click stops it: ${unsubscribeUrl(lead.id)}${address}`
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
      `The number worth knowing is yours, not ours. The calculator at ${site.url}/#leak lets you set your own call volume, your own miss rate, and your own guess at what an answered call recovers. We deliberately do not fill that last one in.\n\n` +
      `If you want to hear it on a real call, the demo line on the same page will ring you back with ${site.agent} on it — with your permission, once, and never again unless you ask.\n\n` +
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
      `1. It does not give medical advice. Ask it whether a treatment is safe during pregnancy and it says it can't answer that and offers to have your team call. That is the product, not a limitation — it is the reason it is insurable.\n\n` +
      `2. It does not pretend to be a person. Every call opens by saying it is an AI and that the call is recorded. You cannot switch that off, because we would be the co-defendant.\n\n` +
      `What it does do: answer every call and chat, qualify, book into your calendar or booking system, and show you which recovered contacts actually became revenue. Packages and prices are on one page, with the setup fee shown: ${site.url}/pricing\n\n` +
      `Reply with your booking system and I'll tell you honestly whether we connect to it yet.` +
      footer(lead),
  },
  {
    step: 2,
    afterHours: 120,
    subject: `Your front desk, forwarded — how the first week goes`,
    text: (lead) =>
      `Hi ${firstName(lead)},\n\n` +
      `The question I hear at this point is "what does setup actually involve". Here it is, without the brochure:\n\n` +
      `- You keep your phone number. You forward it to ${site.agent} — on no-answer, on busy, or always — and you can remove the forwarding yourself at any time.\n` +
      `- We build the agent from your services, prices and hours, and you approve every line before it answers a real call.\n` +
      `- You sign the Business Associate Agreement at checkout, before payment. The full text and what each clause does is at ${site.url}/trust.\n` +
      `- The first month's report shows recovered contacts and, if you connect your booking system, which ones collected.\n\n` +
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
 * Abandoned checkout: one message, an hour after the Stripe Session was
 * created with no completion. Relationship mail — they started this — so it
 * carries no marketing footer, but the unsubscribe link is still there.
 */
export const ABANDONMENT_AFTER_MS = 60 * 60 * 1000;

export function abandonmentEmail(lead: Lead): { subject: string; text: string } {
  return {
    subject: `Your ${site.name} setup is saved where you left it`,
    text:
      `Hi ${firstName(lead)},\n\n` +
      `You got as far as payment on ${site.domain} and stopped — which is fine, and usually means a question came up.\n\n` +
      `Nothing has been charged. If you signed the Business Associate Agreement, it is on file and unbound: it attaches to your account only if you finish, and if you'd rather we voided it, reply and say so.\n\n` +
      `To pick up where you left off: ${site.url}/get-started\n\n` +
      `If the question was about price, the booking system, or whether a cash-pay practice needs this at all, reply and I'll answer it directly.\n\n` +
      `${entityDisplayName()}${ENTITY.postalAddress ? `, ${ENTITY.postalAddress}` : ""}\n` +
      `Stop these emails: ${unsubscribeUrl(lead.id)}`,
  };
}
