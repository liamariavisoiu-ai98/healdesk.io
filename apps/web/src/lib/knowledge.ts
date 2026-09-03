import { SEGMENTS, type Segment } from "@healdesk/catalog";

/**
 * The chat agent's knowledge tree.
 *
 * One agent, three layers of knowledge composed at request time:
 *
 *                       ┌─────────────┐
 *                       │    ROOT     │  how a front desk loses money,
 *                       │  (always)   │  what healdesk does, the hard
 *                       └──────┬──────┘  boundaries it never crosses
 *                       ┌──────┴──────┐
 *                 ┌─────┤  SPECIALTY  ├─────┐   med spa · dental · fertility
 *                 │     └─────────────┘     │   pricing norms, who calls
 *           ┌─────┴─────┐             ┌─────┴─────┐
 *           │   NICHE   │             │   NICHE   │  injectables · GLP-1 ·
 *           └───────────┘             └───────────┘  body contouring · laser
 *
 * ## Why a tree rather than N separate agents
 *
 * A visitor does not arrive pre-sorted. They land from a cold email, click a
 * specialty, then say "actually we mostly do weight loss" — and with separate
 * agents that is a dead end, because the one that knows GLP-1 is a different
 * bot with a different conversation. Here it is a deeper branch of the same
 * conversation, and nothing is lost.
 *
 * It also keeps the expert layer in ONE place. The economics of a missed call,
 * the recovery mechanic, and the compliance boundaries are identical for every
 * clinic on earth. Duplicating them per niche means six copies drifting apart,
 * and the day one copy gets the deflection rule wrong is the day the demo
 * gives medical advice.
 *
 * ## The niche layer is deliberately thin
 *
 * Each niche adds only what a generalist would get WRONG: the vocabulary, the
 * price points, the qualifying question, and the specific reason those callers
 * defect. Everything else is inherited. If a niche entry starts restating the
 * root, that knowledge belongs in the root.
 *
 * Niche ids match the segment enum the prospecting pipeline classifies against
 * (packages/catalog), so the segment a cold email was sent to is the same
 * string that selects the branch when they land. One vocabulary, end to end.
 */

export type NicheKnowledge = {
  id: Segment;
  label: string;
  /** What the agent must say correctly that a generalist would fumble. */
  vocabulary: string;
  /** Approximate US ranges. NOT quotes — see the warning in specialties.ts. */
  pricing: string;
  /** The one question that qualifies this caller. */
  qualifier: string;
  /**
   * Why an unanswered call in THIS niche is lost rather than deferred.
   *
   * The load-bearing field. healdesk only recovers revenue where the caller
   * would otherwise have gone elsewhere, and that varies far more across niches
   * than ticket size does — so this is what the agent should lean on when a
   * prospect asks "does this actually make me money".
   */
  defection: string;
};

/**
 * Shared expert knowledge. Applies to every conversation, whatever the niche.
 *
 * This is the "advanced generic" layer — the reasoning a good salesperson for
 * this product would have regardless of who they were talking to.
 */
export const ROOT_KNOWLEDGE = `
HOW A CLINIC FRONT DESK LOSES MONEY
  A front desk cannot answer while it is checking someone in, on another call,
  or gone for the day. Those calls do not queue — the caller rings the next
  clinic. The loss is invisible in the clinic's own numbers, because a call that
  never became a booking leaves no row anywhere.

WHAT HEALDESK ACTUALLY DOES
  The clinic's published number keeps ringing at the clinic. Only when nobody
  picks up, or the line is engaged, does it forward to the agent. So the agent
  answers exactly the calls the front desk missed — never instead of a human who
  was available. It books into the clinic's own calendar and texts a
  confirmation.

  Setup is a call-forwarding setting the clinic can undo in one step. There is
  no number to port, no phone system to replace, no hardware.

WHAT MAKES THE REPORTING DIFFERENT
  Most vendors report calls answered. healdesk reports calls RECOVERED — the
  ones nobody at the clinic picked up — and, where the clinic connects its
  booking system read-only, the revenue those specific calls collected.
  Estimated figures are always labelled as estimates. Never present an estimate
  as a measurement; that dishonesty is the thing the product exists to replace.

HARD BOUNDARIES — never cross these, in the demo or in the product
  · No clinical advice, candidacy assessment, dosing, triage or symptom
    interpretation. Ever. Offer to have a clinician call back instead.
  · Never confirm whether someone is a patient, and never repeat back a
    condition they mention.
  · Say plainly that you are an AI if asked, and at the start of a voice call.

HOW TO HANDLE THE COMMON OBJECTIONS
  "We never miss calls."   Ask what happens at 6pm, or when two people ring at
                           once. Nobody misses calls they know about.
  "It'll sound robotic."   Agree that a bad one does, and offer the recording.
  "We already have an
   answering service."     Ask whether it books into their calendar, or takes a
                           message someone calls back tomorrow.
  "Is this HIPAA safe?"    We sign a BAA with every clinic. Say that plainly and
                           do not oversell beyond it.
`.trim();

export const NICHES: Record<string, NicheKnowledge> = {
  injectables: {
    id: "injectables",
    label: "Injectables",
    vocabulary:
      "Botox, Dysport, Xeomin, Jeuveau, Daxxify; dermal fillers — Juvéderm, Restylane, RHA, Sculptra. Units for neurotoxin, syringes for filler. Areas: glabella, forehead, crow's feet, lips, cheeks, jawline. Treatments last 3–4 months, so patients return.",
    pricing:
      "Neurotoxin $10–20 per unit, typical treatment 20–60 units ($200–900). Filler $600–1,200 per syringe. Average injectable visit lands around $400–750.",
    qualifier:
      "Have you had injectables before, and are you looking for a specific area or a consultation first?",
    defection:
      "A returning patient will call back tomorrow — she has an injector she likes. The money is in the FIRST-TIME caller, who is ringing three med spas and books whoever answers. Lead with new-patient capture, not with 'never miss a call'.",
  },

  "weight-loss-glp1": {
    id: "weight-loss-glp1",
    label: "Medical weight loss / GLP-1",
    vocabulary:
      "Semaglutide, tirzepatide, GLP-1 programmes, monthly membership, titration schedule, labs and baseline bloodwork, BMI eligibility, provider consult.",
    pricing:
      "$300–500 a month typically, often sold as a 3–6 month programme, so a single new patient is worth $1,800–2,400 over the course.",
    qualifier:
      "Are you asking about starting a programme, or continuing one you're already on elsewhere?",
    defection:
      "Almost all of these callers are new to the practice and arrived from an ad. They are comparison shopping on price and start date, and they book whoever picks up. Defection on an unanswered call is close to total.",
  },

  "body-contouring": {
    id: "body-contouring",
    label: "Body contouring",
    vocabulary:
      "CoolSculpting (cryolipolysis), Emsculpt NEO, truSculpt, Morpheus8, SculpSure. Sold as a package of sessions per area, not single treatments. Almost always consultation-gated.",
    pricing:
      "$700–1,500 per session, packages $1,700–3,200. Free consultation is the normal first step.",
    qualifier:
      "Which area are you thinking about, and have you had a consultation anywhere yet?",
    defection:
      "High-consideration, high-ticket, and nearly all new patients. They book consultations at two or three places. An unanswered call here is usually gone for good.",
  },

  "laser-skin": {
    id: "laser-skin",
    label: "Laser and skin",
    vocabulary:
      "Laser hair removal (usually a package of 6–8 sessions), IPL/photofacial, fractional resurfacing, microneedling with or without RF, chemical peels, HydraFacial.",
    pricing:
      "Small area laser hair removal $75–150 a session, packages $400–900. Resurfacing $500–1,500 a session.",
    qualifier:
      "Are you looking at a single treatment or a package, and is this your first time?",
    defection:
      "Lower ticket and often chain-dominated, so the ROI story is weaker here than elsewhere. Be honest about that rather than inflating it — if the caller is comparing on price, say so.",
  },

  "wellness-iv": {
    id: "wellness-iv",
    label: "IV therapy and wellness",
    vocabulary:
      "IV drips (Myers' cocktail, NAD+, hydration), vitamin injections, hormone therapy and TRT, peptides, functional and longevity medicine, membership models.",
    pricing:
      "IV drips $150–400 a visit; hormone and longevity programmes $200–500 a month on membership.",
    qualifier:
      "Are you after a one-off drip, or a programme with lab work behind it?",
    defection:
      "Mixed. Membership patients are loyal, walk-in drip callers are not. Ask which the clinic mostly sells before claiming a number.",
  },

  "hair-restoration": {
    id: "hair-restoration",
    label: "Hair restoration",
    vocabulary:
      "PRP and PRF for hair, transplants (FUE/FUT), topical and oral programmes, graft counts, consultation and scalp assessment.",
    pricing:
      "PRP $500–1,000 a session, usually a series of 3. Transplants $4,000–15,000.",
    qualifier:
      "Are you looking at a surgical option or something non-surgical to start?",
    defection:
      "Very high consideration and heavily researched, so callers are shopping several clinics. High ticket and high defection — a strong fit.",
  },
};

/**
 * Compose the knowledge for one conversation.
 *
 * Root always, specialty always, niche only when we know it. An unknown or
 * absent niche returns the first two layers rather than guessing — a generalist
 * answer is fine, whereas confidently quoting GLP-1 prices to a dermatology
 * practice is not.
 */
export function composeKnowledge(
  specialtyContext: string,
  niche?: string,
): string {
  const layers = [ROOT_KNOWLEDGE, `THIS SPECIALTY\n${specialtyContext}`];

  const branch = niche ? NICHES[niche] : undefined;
  if (branch) {
    layers.push(
      [
        `THIS NICHE — ${branch.label}`,
        `  Vocabulary: ${branch.vocabulary}`,
        `  Typical pricing: ${branch.pricing}`,
        `  Qualifying question: ${branch.qualifier}`,
        `  Why these callers are lost if unanswered: ${branch.defection}`,
      ].join("\n"),
    );
  }

  return layers.join("\n\n");
}

/** Niche ids the chat route will accept, so an arbitrary string cannot be injected. */
export function isNiche(value: unknown): value is Segment {
  return typeof value === "string" && value in NICHES;
}

/** Every niche the tree can branch to, for the picker. */
export const NICHE_OPTIONS = Object.values(NICHES).map((n) => ({
  id: n.id,
  label: n.label,
}));

// Compile-time check: every niche id is a real segment from the shared enum, so
// the string a cold campaign targeted is the same string that selects a branch.
const _ids: readonly Segment[] = Object.keys(NICHES) as Segment[];
void _ids;
void SEGMENTS;
