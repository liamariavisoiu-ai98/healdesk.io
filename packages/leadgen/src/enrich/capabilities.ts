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
    // First-timers price-shop three clinics in a sitting; regulars are loyal.
    capability: "around-the-clock",
    because:
      "since first-timers ring two or three places in one go and book with whoever answers, while your regulars would have waited for you anyway",
  },
  "weight-loss-glp1": {
    // Almost all new to the practice, comparing on price and start date, and
    // the programme dies at the first titration plateau.
    capability: "win-backs",
    because:
      "the ones who quietly stop around month three and are usually glad to hear from you",
  },
  "body-contouring": {
    // Free consult, four-figure package, and the consult no-show is the leak.
    capability: "deposits",
    because:
      "which is what turns a free consult on a four-figure package into a booking somebody actually keeps",
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
      "the ones who paid up front and drifted, which is revenue already banked and waiting to be finished",
  },
  "wellness-iv": {
    // Same-day intent. They are asking about the next two hours.
    capability: "around-the-clock",
    because:
      "since they are asking about this afternoon and will book with whoever can take them",
  },
  "hair-restoration": {
    // Months of working up to the call, and they will not leave a message.
    capability: "lead-qualification",
    because:
      "since they have thought about it for months before ringing, and a live answer is what turns that into a consult",
  },
  dental: {
    // Pain overrides loyalty entirely, and recall is where the money leaks.
    capability: "around-the-clock",
    because:
      "so somebody in real pain gets a time from you rather than from the next practice they try",
  },
  dermatology: {
    // Two different callers on one line, and the cosmetic one leaves quietly.
    capability: "lead-qualification",
    because:
      "so your medical and cosmetic callers each get the right conversation off the same line",
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
  if (pain.gapHours !== null && pain.gapHours >= 24) {
    return {
      capability: "around-the-clock",
      because:
        "We pick up.",
    };
  }

  if (!pain.hasOnlineBooking) {
    return {
      capability: "calendar-booking",
      because:
        "Every booking you take starts with a phone call.",
    };
  }

  if (pain.closesEarly) {
    return {
      capability: "around-the-clock",
      because:
        "Most people ring after work, once they have finished.",
    };
  }

  return (
    BY_SEGMENT[pain.segment] ?? {
      capability: "lead-qualification",
      // The honest fallback: true of any clinic, claims nothing specific.
      because:
        "The calls you cannot get to are usually the ones ready to book.",
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
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "around-the-clock": "Our {assistant} assistant picks those up and books them in",
  "calendar-booking": "Our {assistant} assistant answers and puts them straight in your calendar",
  deposits: "Our {assistant} assistant secures the deposit while they are still on the call",
  "lead-qualification": "Our {assistant} assistant sorts the callers before they reach your desk",
  "win-backs": "Our {assistant} assistant brings your lapsed patients back",
  "aftercare-reviews": "Our {assistant} assistant checks in after treatment and asks for the review",
  upselling: "Our {assistant} assistant offers the add-on while they are still on the phone",
};
