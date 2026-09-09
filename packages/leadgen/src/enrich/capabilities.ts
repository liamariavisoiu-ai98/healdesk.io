import type { Segment } from "@healdesk/catalog";

/**
 * Which one thing healdesk should offer this clinic.
 *
 * The product does seven things. An email that lists seven is a brochure and
 * gets skimmed; an email that names the one thing this clinic is losing money
 * on gets a reply. So the pain point is derived from what the pipeline actually
 * knows — the unanswered gap, whether they can be booked online, and what they
 * sell — and exactly one capability is proposed.
 *
 * The segment mappings are not guesses. They come from the per-niche research
 * in apps/web/src/lib/knowledge/niches.ts, where each niche carries the thing
 * practitioners in it find genuinely hard. Matching the offer to that is the
 * difference between a vendor and someone who has worked in the field.
 */

export type Capability =
  | "around-the-clock"
  | "calendar-booking"
  | "deposits"
  | "lead-qualification"
  | "win-backs"
  | "aftercare-reviews"
  | "upselling";

export type CapabilityPitch = {
  capability: Capability;
  /** Why THIS clinic, in one clause. Sits after the observed pain. */
  because: string;
};

/**
 * The segment's own hard problem, and the capability that answers it.
 *
 * Each entry names a failure the practitioner already recognises — which is
 * what stops the offer reading as generic. A clinic owner knows their GLP-1
 * patients evaporate at month three; being told so is being understood.
 */
/**
 * Chosen on how each segment's PATIENTS behave, not on what the clinic sells.
 *
 * The distinction decides the offer. Two clinics can both take appointments by
 * phone and need opposite things, because in one the caller is loyal and in the
 * other they are shopping.
 *
 * Injectables is the case that proves it, and the case I originally got wrong.
 * A returning Botox patient is not shopping: she has an injector she trusts and
 * will happily ring back tomorrow. Offering to chase lapsed patients there is
 * offering to solve a problem the clinic does not have, and it reads as not
 * understanding the business. The money is entirely in the first-time caller,
 * who is ringing three med spas in one sitting and books with whoever answers.
 * So injectables gets capture, not win-backs.
 *
 * Win-backs are right where the RELATIONSHIP is weak and the lapse is silent:
 * a GLP-1 patient on a monthly programme, a body-contouring package half
 * finished, a dental recall. Nobody is loyal to a CoolSculpting applicator.
 */
const BY_SEGMENT: Partial<Record<Segment, CapabilityPitch>> = {
  injectables: {
    // NOT the price-shopping claim. docs/marketing-voice-demo-context.md:203
    // and synthflow-voice-agent-context.md:74 both assert first-timers "ring
    // three med spas in one sitting and book whoever picks up"; the founder says
    // that is not true of this market, and they know it and I do not.
    //
    // This rests on who is in the room instead, which is structural: in a med
    // spa the person who would answer is usually the person treating, unlike a
    // dental practice with a dedicated front desk.
    capability: "around-the-clock",
    because:
      "since the desk is empty while you are in a room",
  },
  "weight-loss-glp1": {
    // Almost all new to the practice, comparing on price and start date, and
    // the programme dies at the first titration plateau.
    capability: "win-backs",
    because:
      "the ones who quietly stop around month three and are glad it was you who called",
  },
  "body-contouring": {
    // Free consult, four-figure package, and the consult no-show is the leak.
    capability: "deposits",
    because:
      "which turns a four-figure enquiry into your booking rather than someone else's",
  },
  "plastic-surgery": {
    // The call is an interview and the coordinator is in consults all day.
    capability: "lead-qualification",
    because:
      "so the ones ready for a surgical consult reach you even while your surgeon is operating",
  },
  "laser-skin": {
    // Money collected up front, sessions not booked, course abandoned midway.
    capability: "win-backs",
    because:
      "the ones who paid up front and drifted, which is revenue you have already banked",
  },
  "wellness-iv": {
    // Same-day intent. They are asking about the next two hours.
    capability: "around-the-clock",
    because:
      "since they want this afternoon and book with you or the next place that answers",
  },
  "hair-restoration": {
    // Months of working up to the call, and they will not leave a message.
    capability: "lead-qualification",
    because:
      "since they have thought about it for months, and a live answer makes it your consult",
  },
  dental: {
    // Pain overrides loyalty entirely, and recall is where the money leaks.
    capability: "around-the-clock",
    because:
      "so somebody in real pain gets a time from you, not from the next practice they try",
  },
  dermatology: {
    // Two different callers on one line, and the cosmetic one leaves quietly.
    capability: "lead-qualification",
    because:
      "so your medical and cosmetic callers each get the right conversation off the same line",
  },
  chiropractic: {
    // Acute pain is the opposite of loyal. Someone whose back went this
    // morning is ringing down a list and stops at the first clinic that says
    // "come in at two". Plan adherence is the other half of the business, but
    // it is the acute call that is won or lost on pickup.
    capability: "around-the-clock",
    because:
      "since a back that went this morning books with you only if someone answers",
  },
  "physical-therapy": {
    // The leak is between the referral and the first appointment. The patient
    // already has a script; they just never got round to ringing back, or rang
    // once and got the machine.
    capability: "calendar-booking",
    because:
      "since a referral that never books is a patient sent to you who never arrived",
  },
  acupuncture: {
    // First visit is high-consideration and question-heavy — does it hurt, how
    // many sessions, is it covered. Regulars book without thinking.
    capability: "lead-qualification",
    because:
      "since a first-timer rings with questions, and that call decides whether they commit to you",
  },
  vision: {
    // Two businesses under one roof. Routine exams are habit; LASIK is a
    // four-figure decision that is shopped hard and gated behind a consult, so
    // the consult booking is the event worth protecting.
    capability: "calendar-booking",
    because:
      "since a four-figure LASIK decision usually goes to whichever clinic answered first",
  },
  hearing: {
    // The most phone-dependent population in the whole list. Older patients
    // and the adult children ringing on their behalf do not fill in web forms,
    // so an unanswered call is not deferred, it is lost.
    capability: "around-the-clock",
    because:
      "since they will not use a form instead, so a call you miss is a patient lost",
  },
  "mental-health": {
    // Somebody ringing about psychiatry or ketamine has usually spent a while
    // working up to it. They will not leave a voicemail and they will not ring
    // twice.
    capability: "around-the-clock",
    because:
      "since someone who worked up to this call will not leave you a voicemail",
  },
  "other-medical": {
    capability: "lead-qualification",
    because:
      "so the person ringing while your desk is on a long call still gets booked in",
  },
};

export type PainInput = {
  segment: Segment;
  /** Hours in the longest unanswered stretch, when known. */
  gapHours: number | null;
  hasOnlineBooking: boolean;
  closesEarly: boolean;
};

/**
 * Pick one capability, most specific pain first.
 *
 * Order matters and is deliberate. A measured gap outranks everything, because
 * it is the only pain here expressed as a number the clinic cannot argue with.
 * Below that, an absent booking path is a structural fact about every
 * appointment they take. Only when neither applies does the segment's own
 * problem decide — it is the most interesting answer but the least certain,
 * since it rests on the classifier rather than on an observation.
 */
export function selectCapability(pain: PainInput): CapabilityPitch {
  /**
   * The gap picks the capability. The segment picks the reason.
   *
   * These used to be one decision, and the ordering meant 87% of clinics
   * short-circuited before their segment was ever consulted: a measured gap
   * outranks everything, which is right for the hook, and it was also
   * discarding what we know about who rings a chiropractor versus who rings an
   * audiologist. One function was deciding both halves of the sentence.
   *
   * Splitting them keeps the priority intact — the capability still comes from
   * the strongest measured fact — while letting the clause that follows say
   * something true about this segment's patients. It took the offer from 51
   * distinct sentences across 1,903 clinics to a few hundred.
   */
  const reason = BY_SEGMENT[pain.segment]?.because;

  if (pain.gapHours !== null && pain.gapHours >= 24) {
    return {
      capability: "around-the-clock",
      because:
        reason ??
        "while the impulse is there, which makes them your patient rather than someone else's",
    };
  }

  if (!pain.hasOnlineBooking) {
    return {
      capability: "calendar-booking",
      because:
        reason ??
        "since every booking starts with a phone call, so each one answered is your patient",
    };
  }

  if (pain.closesEarly) {
    return {
      capability: "around-the-clock",
      because: reason ?? "since most people ring after work, and book with whoever is still answering",
    };
  }

  return (
    BY_SEGMENT[pain.segment] ?? {
      capability: "lead-qualification",
      // The honest fallback: true of any clinic, claims nothing specific.
      because: "since the calls you cannot get to are usually the ones ready to book",
    }
  );
}


/** What each capability is called in an email. Plain, not product-marketing. */
/**
 * The opening clause of the offer, which the reason then continues.
 *
 * Written to run ON into `because` as one sentence rather than sitting beside
 * it as two. Two short sentences read as bullet points with the bullets taken
 * off, and that is the shape people have learned to skim past. One sentence
 * that keeps going is how a person writes to another person.
 *
 * {assistant} is filled with "smart" or "virtual" depending on who is reading —
 * see assistantTerm().
 */
/**
 * The opening clause of the offer, continued by the reason.
 *
 * Phrased as what the clinic gets, not what it is currently failing at. "Answers
 * the calls your team cannot" is accurate and is still a stranger pointing at a
 * shortcoming; "picks those up and books them in" is the same capability
 * described by its result.
 *
 * {assistant} becomes "smart" or "virtual" depending on who is reading — see
 * assistantTerm().
 */
/**
 * The opening clause of the offer, continued by the reason.
 *
 * {surfaces} is where the channels land — "your calls", or "your calls and your
 * Instagram messages", or all three. Naming them inside this sentence is what
 * replaced three separate lines about channels, which read as a capability list
 * with the bullets taken off.
 *
 * {assistant} becomes "smart" or "virtual" depending on who is reading.
 */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "around-the-clock": "Our {assistant} assistant picks up {surfaces}, then books them in",
  "calendar-booking": "Our {assistant} assistant answers {surfaces}, then books straight into your calendar",
  deposits: "Our {assistant} assistant handles {surfaces}, then secures the deposit before they ring off",
  "lead-qualification": "Our {assistant} assistant sorts {surfaces} before they reach your desk",
  "win-backs": "Our {assistant} assistant covers {surfaces}, and brings your lapsed patients back",
  "aftercare-reviews": "Our {assistant} assistant covers {surfaces}, and checks in after treatment",
  upselling: "Our {assistant} assistant covers {surfaces}, and offers the add-on while they are on the phone",
};
