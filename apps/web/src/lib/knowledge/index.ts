import { getNiche, isNiche, NICHES, NICHE_OPTIONS } from "./niches";
import { PERSONA } from "./persona";
import { getPractice, PRACTICE_OPTIONS, PRACTICES } from "./practice";

export { NICHES, NICHE_OPTIONS, getNiche, isNiche } from "./niches";
export { PERSONA } from "./persona";
export { PRACTICES, PRACTICE_OPTIONS, getPractice } from "./practice";
export type { NicheKnowledge } from "./niches";
export type { PracticeKnowledge } from "./practice";

/**
 * The knowledge tree, assembled per conversation.
 *
 *                    ┌──────────────┐
 *                    │   PERSONA    │  how to talk — peer, short, warm,
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
 * practice type, then say "actually we mostly do weight loss now" — and with
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
 * as businesses — different callers, different emotional register, different
 * person answering the phone, different reason the missed call hurts. So the
 * practice layer answers "who is this" and the niche layer answers "what do they
 * sell", and a niche can hang off several practices.
 *
 * ## Cost
 *
 * The composed prompt is stable per (practice, niche) pair rather than per
 * visitor, so it caches. Depth costs tokens once, not once per conversation.
 */

export const ROOT_KNOWLEDGE = `
HOW A CLINIC FRONT DESK LOSES MONEY
  A front desk cannot answer while it is checking someone in, on another line,
  or gone for the day. Those calls do not queue — the caller rings the next
  clinic. The loss is invisible in the practice's own numbers, because a call
  that never became a booking leaves no row in any system they own. That is why
  almost every owner underestimates it, and why "we don't miss calls" is said in
  good faith.

WHAT HEALDESK ACTUALLY DOES
  Their published number keeps ringing at the clinic. Only when nobody picks up,
  or the line is engaged, does it forward to the agent — so the agent answers
  exactly the calls the front desk missed, never instead of a human who was free.
  It books into the clinic's own calendar and texts a confirmation.

  Setup is a call-forwarding setting the clinic can undo in one step. No number
  to port, no phone system to replace, no hardware, nothing installed.

WHAT MAKES THE REPORTING DIFFERENT
  Most vendors report calls ANSWERED. healdesk reports calls RECOVERED — the
  ones nobody at the practice picked up — and, where the clinic connects its
  booking system read-only, the revenue those specific calls went on to collect.
  Estimated figures are labelled as estimates, every time. Never present an
  estimate as a measurement; that dishonesty is the thing this product exists to
  replace, and claiming it here would be self-defeating.

WHAT IT DELIBERATELY DOES NOT DO
  · It does not answer clinical questions. That is a design decision, not a gap.
  · It does not replace anyone. It picks up what the desk could not reach.
  · It does not cold-call, and it will not text anyone the clinic has not already
    got consent for.

HANDLING THE OBJECTIONS THAT ACTUALLY COME UP
  "We never miss calls."
      Ask what happens at 6pm, or when two people ring at once. Nobody misses
      the calls they know about — that is what makes this hard to see.
  "It'll sound robotic."
      Agree that a bad one does. Offer a recording rather than arguing.
  "We already use an answering service."
      Ask whether it books into their calendar or takes a message someone rings
      back tomorrow. The gap between those two is the entire product.
  "Our patients want a person."
      Agree completely. The agent's job is to get them to a person sooner, not
      instead — and the current alternative is voicemail, which is nobody.
  "Is this HIPAA safe?"
      We sign a BAA with every clinic. Say that plainly and stop there; do not
      claim certifications that do not exist for anyone.
  "How much?"
      $249 a month for the entry plan, no setup fee, 14-day trial. At a typical
      aesthetics ticket that is under one recovered appointment a month to break
      even — say the arithmetic, do not just assert the value.
`.trim();

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
  /** Practice type id — see PRACTICES. */
  practice?: string;
  /** Service line id — see NICHES. */
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
        `THIS PRACTICE TYPE — ${practice.label}`,
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
        `THIS SERVICE LINE — ${niche.label}`,
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
 * Used to offer the visitor a sensible next branch rather than the full list —
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
  return typeof value === "string" && value in PRACTICES;
}

void PRACTICE_OPTIONS;
void isNiche;
