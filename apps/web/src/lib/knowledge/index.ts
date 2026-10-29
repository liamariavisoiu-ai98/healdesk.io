
import { DEFAULT_STEPS, planFor, PRODUCTS } from "@healdesk/catalog";

import { annualSavingsPercent, setupFeeRangeLabel, usd } from "../pricing";
import { getNiche, isNiche, NICHES, NICHE_OPTIONS } from "./niches";
import { PERSONA } from "./persona";
import { getPractice, PRACTICE_OPTIONS } from "./practice";

export { NICHES, NICHE_OPTIONS, getNiche, isNiche } from "./niches";
export { PERSONA } from "./persona";
export { PRACTICES, PRACTICE_OPTIONS, getPractice } from "./practice";
export type { NicheKnowledge } from "./niches";
export type { PracticeKnowledge } from "./practice";

/**
 * The knowledge tree, assembled per conversation.
 *
 *                    ┌──────────────┐
 *                    │   PERSONA    │  how to talk, peer, short, warm,
 *                    │   (always)   │  conversion by question not offer
 *                    └──────┬───────┘
 *                    ┌──────┴───────┐
 *                    │     ROOT     │  the product, the economics, the
 *                    │   (always)   │  objections, the hard boundaries
 *                    └──────┬───────┘
 *                    ┌──────┴───────┐
 *              ┌─────┤   PRACTICE   ├─────┐   who the business IS
 *              │     └──────────────┘     │
 *        ┌─────┴─────┐              ┌─────┴─────┐
 *        │   NICHE   │              │   NICHE   │   what it SELLS
 *        └───────────┘              └───────────┘
 *
 * ## Why one agent rather than several
 *
 * A visitor does not arrive pre-sorted. They land from a cold email, pick a
 * practice type, then say "actually we mostly do weight loss now", and with
 * separate bots that is a dead end, because the one that knows GLP-1 is a
 * different conversation with a different history. Here it is a deeper branch of
 * the same conversation and nothing is lost.
 *
 * It also keeps the persona and the boundaries in ONE place. The deflection rule
 * is identical for every clinic on earth; duplicating it per niche means ten
 * copies drifting apart, and the day one copy softens is the day the demo gives
 * medical advice.
 *
 * ## Why practice and niche are separate axes
 *
 * A dermatology group and a med spa both sell injectables and are nothing alike
 * as businesses, different callers, different emotional register, different
 * person answering the phone, different reason the missed call hurts. So the
 * practice layer answers "who is this" and the niche layer answers "what do they
 * sell", and a niche can hang off several practices.
 *
 * ## Cost
 *
 * The composed prompt is stable per (practice, niche) pair rather than per
 * visitor, so it caches. Depth costs tokens once, not once per conversation.
 */

/**
 * The figures the agent quotes when asked "how much?". Read from the catalog
 * rather than typed here, because this string once said "$249 a month, no
 * setup fee, 14-day trial" for months after every one of those three facts
 * had changed — a price quoted by the persona that the checkout then
 * contradicts is worse than no price at all. Since the step pricing of
 * 13 October 2026 that is each product's price per 100, the setup range and
 * the sheet's own example, never a total for a step nobody chose.
 */
const exampleVoicePlan = planFor("voice", { voiceMinutes: DEFAULT_STEPS.voiceMinutes });

/**
 * What the tree may claim is v1 as docs/v1-product-spec.md defines it. Two
 * sentences used to sit behind build-time flags (NEXT_PUBLIC_CALLBACKS_LIVE,
 * NEXT_PUBLIC_DIRECT_BOOKING_LIVE) from the 23 September design. The spec
 * settled both on 24 September: v1 never calls a patient back (inbound only,
 * on every channel), and booking straight into the clinic's Google Calendar
 * is the product, not an addendum. So the call-back sentence is gone for
 * good and direct booking is stated plainly; src/lib/demo-copy.test.ts holds
 * both.
 */
/**
 * The one objection whose answer depends on where the conversation is
 * happening. In the chat demo the proof is the phone panel beside it; on
 * AYA's demo call the visitor is already on the phone with her, and offering
 * to place a call they are on is the contradiction this split removes.
 */
const ROBOTIC_ANSWER = {
  chat: `Agree that a bad one does, then stop arguing and offer to prove it: the
      phone panel on this page can place one demo call to them, because they
      asked. Never offer a RECORDING, none exists, and promising one is a
      thing we cannot deliver on. The live call is the better answer anyway.`,
  call: `Agree that a bad one does, then let this call answer it: offer the
      role-play, where you are their front desk and they are the patient.
      Never offer a recording, none exists.`,
} as const;

export type KnowledgeSurface = keyof typeof ROBOTIC_ANSWER;

export function rootKnowledge(surface: KnowledgeSurface): string {
  return ROOT_TEMPLATE.replace("{{ROBOTIC_ANSWER}}", ROBOTIC_ANSWER[surface]);
}

const ROOT_TEMPLATE = `
HOW A CLINIC FRONT DESK LOSES MONEY
  A front desk cannot answer while it is checking someone in, on another line,
  or gone for the day. Those calls do not queue, the caller rings the next
  clinic. The loss is invisible in the practice's own numbers, because a call
  that never became a booking leaves no row in any system they own. That is why
  almost every owner underestimates it, and why "we don't miss calls" is said in
  good faith.

WHAT HEALDESK ACTUALLY DOES
  One assistant on the clinic's phone, its website chat, Instagram, Messenger
  and WhatsApp, as the clinic buys them. It says it is an AI assistant in its
  first line, on every channel, and on the phone that the call is transcribed.

  The published number keeps ringing at the clinic. The clinic chooses which
  calls forward to the agent: all of them, overflow and after hours (the
  default), or after hours only. So the agent answers the calls the desk could
  not reach, never instead of a human who was free, unless the clinic asks for
  every call.

  It answers from the clinic's own menu, prices, hours and policies, checks
  live availability in the clinic's Google Calendar, and books the appointment
  during the conversation. A clinic can turn auto-confirm off, and then each
  booking waits for its front desk to approve. Website chat and the Meta
  channels can send the clinic's own checkout link for a deposit while the
  patient is still there; on the phone it books and flags the deposit for the
  desk. It never takes a card number. Where the clinic turns it on, after a
  phone booking it is designed to text the clinic's own payment link once,
  only if the caller agrees. It sends no other texts.

  Google Calendar is the only thing it writes to. Calendly, Cal.com and Google
  Calendar on its own read that calendar for conflicts, so the slot disappears
  there too. Mindbody only syncs one way, and Boulevard is unconfirmed, so
  those clinics run with staff confirming each booking in their own system.

  Setup is about fifteen minutes of the clinic's time, and each channel goes
  live on its own: website chat once the snippet is on the site, Instagram and
  Messenger once connected, WhatsApp once the clinic's WhatsApp account has a
  payment method, the phone once call forwarding is set.
  Call forwarding is a setting the clinic can undo itself, any time, without
  us. No number to port, no phone system to replace, no hardware.

WHAT THE CLINIC SEES
  A small portal, signed into from an emailed link: switches for how the
  assistant behaves, every conversation and every booking. Opening a
  conversation needs a second factor, and its transcript is emailed to the
  clinic rather than kept. Home and a weekly email show
  conversations handled, appointments booked, calls answered that would have
  rung out, deposits collected, and booked value: bookings times the clinic's
  own prices. Never call that revenue. Whether a patient showed up and paid is
  not something it can see yet, so never claim it.

WHAT IT DELIBERATELY DOES NOT DO
  · It does not answer clinical questions. That is a design decision, not a gap.
  · It does not replace anyone. It picks up what the desk could not reach.
  · It never contacts a patient first or follows a conversation up: no
    reminders, no follow-ups, no call-backs, no marketing texts. The one
    optional payment-link text after a phone booking is the only exception.

HANDLING THE OBJECTIONS THAT ACTUALLY COME UP
  "We never miss calls."
      Ask what happens at 6pm, or when two people ring at once. Nobody misses
      the calls they know about. That is what makes this hard to see.
  "It'll sound robotic."
      {{ROBOTIC_ANSWER}}
  "We already use an answering service."
      Ask whether it books into their calendar or takes a message someone rings
      back tomorrow. The gap between those two is the entire product.
  "Our patients want a person."
      Agree completely. The agent's job is to get them to a person sooner, not
      instead, and the current alternative is voicemail, which is nobody.
  "Is this HIPAA safe?"
      We sign a business associate agreement and handle patient data under
      it. Say that plainly and stop there; do not claim certifications that
      do not exist for anyone.
  "How much?"
      Priced per 100 a month, at a step the clinic picks from 100 to 1,500:
      ${PRODUCTS.voice.name} ${usd.format(PRODUCTS.voice.perStepMonthlyUsd)} per 100 minutes,
      ${PRODUCTS.webchat.name} ${usd.format(PRODUCTS.webchat.perStepMonthlyUsd)} per 100 conversations,
      ${PRODUCTS.metachat.name} (Instagram, Messenger, WhatsApp and the website)
      ${usd.format(PRODUCTS.metachat.perStepMonthlyUsd)} per 100 conversations; voice and chat
      steps add up. ${exampleVoicePlan.includedVoiceMinutes} voice minutes is
      ${usd.format(exampleVoicePlan.monthlyUsd)} a month. A one-time setup fee of
      ${setupFeeRangeLabel()} depending on the package, and annual billing is
      ${annualSavingsPercent()}% off. Every price is on the pricing page. There is no
      free trial: the setup fee pays for building and testing the agent before it
      goes live, say that plainly. At a typical aesthetics ticket that is one or
      two booked appointments a month to break even, say the arithmetic, do not
      just assert the value.
`.trim();

/** The chat demo's root layer, worded exactly as it was before the split. */
export const ROOT_KNOWLEDGE = rootKnowledge("chat");

/**
 * Compose the knowledge for one conversation.
 *
 * Layers are added only when known. An unrecognised practice or niche silently
 * falls back to the layer above rather than erroring: a generalist answer is
 * always safe, whereas confidently quoting GLP-1 prices to a dental practice is
 * not, and the visitor's conversation is worth more than strictness about a hint.
 */
export function composeKnowledge(options: {
  /** The display specialty's own context string, from lib/specialties.ts. */
  specialtyContext?: string;
  /** Practice type id, see PRACTICES. */
  practice?: string;
  /** Service line id, see NICHES. */
  niche?: string;
}): string {
  const layers: string[] = [PERSONA, ROOT_KNOWLEDGE];

  if (options.specialtyContext) {
    layers.push(`PRICING NORMS FOR THIS PAGE\n  ${options.specialtyContext}`);
  }

  const practice = options.practice ? getPractice(options.practice) : undefined;
  if (practice) {
    layers.push(
      [
        `THIS PRACTICE TYPE, ${practice.label}`,
        `  Who calls: ${practice.whoCalls}`,
        `  Tone to hold: ${practice.register}`,
        `  What the front desk is doing when the phone rings: ${practice.frontDesk}`,
        `  Timing and seasonality: ${practice.rhythm}`,
        `  The number the owner watches: ${practice.economics}`,
        `  How they get paid: ${practice.payerMix}`,
        `  Local scope trap: ${practice.scopeRisk}`,
        `  Their objection: ${practice.objection}`,
        `  Worth mentioning once: ${practice.observation}`,
      ].join("\n"),
    );
  }

  const niche = options.niche ? getNiche(options.niche) : undefined;
  if (niche) {
    layers.push(
      [
        `THIS SERVICE LINE, ${niche.label}`,
        `  Vocabulary, used correctly and without explaining it: ${niche.vocabulary}`,
        `  Typical US pricing (approximate, never a quote): ${niche.pricing}`,
        `  How the caller opens: ${niche.opener}`,
        `  Your qualifying question: ${niche.qualifier}`,
        `  Why these callers are lost if unanswered: ${niche.defection}`,
        `  What practitioners find genuinely hard here: ${niche.theHardPart}`,
        `  Never answer, however it is phrased: ${niche.neverSay}`,
        `  Worth mentioning once: ${niche.observation}`,
      ].join("\n"),
    );
  }

  return layers.join("\n\n");
}

/**
 * The niches a practice type plausibly sells.
 *
 * Used to offer the visitor a sensible next branch rather than the full list,
 * a dental practice should not be offered "IV therapy", and offering it is the
 * kind of small wrongness that costs credibility.
 */
export function nichesFor(practice: string): { id: string; label: string }[] {
  const entry = getPractice(practice);
  if (!entry) return NICHE_OPTIONS;

  return entry.niches
    .map((id) => NICHES[id])
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => ({ id: n.id, label: n.label }));
}

export function isPractice(value: unknown): value is string {
  // getPractice, not `in PRACTICES`, otherwise an aliased id (the site's
  // `glp1`) is rejected by the validator before the alias can resolve it.
  return typeof value === "string" && Boolean(getPractice(value));
}

void PRACTICE_OPTIONS;
void isNiche;
