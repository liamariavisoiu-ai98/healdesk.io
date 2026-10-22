import type { Segment } from "@healdesk/catalog";

/**
 * Which one thing healdesk should offer this clinic.
 *
 * The product does several things. An email that lists them all is a brochure
 * and gets skimmed; an email that names the one thing this clinic is short of
 * gets a reply. So the pain point is derived from what the pipeline actually
 * knows — the unanswered gap, whether they can be booked online, and what they
 * sell — and exactly one capability is proposed.
 *
 * The segment mappings are not guesses. They come from the per-niche research
 * in apps/web/src/lib/knowledge/niches.ts, where each niche carries the thing
 * practitioners in it find genuinely hard. Matching the offer to that is the
 * difference between a vendor and someone who has worked in the field.
 *
 * Every capability here is something v1 does inside a conversation the patient
 * started (docs/v1-product-spec.md → "Scope and locked decisions"). v1 is
 * inbound only, so there is no win-back, reactivation, check-in, review
 * request, reminder or follow-up to offer, and an email that offers one sells
 * the clinic something it cannot have. tests/copy-guard.test.ts fails the
 * build if one comes back.
 */

export type Capability =
  | "around-the-clock"
  | "calendar-booking"
  | "deposits"
  | "lead-qualification"
  | "upselling";

export type CapabilityPitch = {
  capability: Capability;
  /** Why THIS clinic, in one clause. Sits after the observed pain. */
  because: string;
};

/**
 * The segment's own hard problem, and the capability that answers it.
 *
 * Each entry names something the practitioner already recognises about the
 * people who ring them, which is what stops the offer reading as generic.
 */
/**
 * Chosen on how each segment's PATIENTS behave, not on what the clinic sells.
 *
 * The distinction decides the offer. Two clinics can both take appointments by
 * phone and need different things, because in one the caller is loyal and in
 * the other they are shopping.
 *
 * Injectables is the case that proves it. A returning Botox patient is not
 * shopping: she has an injector she trusts and will happily ring back
 * tomorrow. The money is in the first-time caller, so injectables gets
 * capture.
 *
 * Every reason is about the patient who is getting in touch now. An earlier
 * version offered GLP-1 and laser clinics a way to bring lapsed patients back.
 * That is outbound, which v1 does not do (docs/v1-product-spec.md → "What v1
 * cannot do"), so both segments now get capture too, on why their new
 * patients go to whoever answers first.
 */
const BY_SEGMENT: Partial<Record<Segment, CapabilityPitch>> = {
  injectables: {
    // NOT the price-shopping claim. docs/marketing-voice-demo-context.md:203
    // asserts first-timers "ring three med spas in one sitting and book
    // whoever picks up"; the founder says that is not true of this market,
    // and they know it and I do not.
    //
    // This rests on who is in the room instead, which is structural: in a med
    // spa the person who would answer is usually the person treating, unlike a
    // dental practice with a dedicated front desk.
    capability: "around-the-clock",
    because:
      "even while you're with a client",
  },
  "weight-loss-glp1": {
    // Almost all new to the practice, comparing on price and start date. The
    // first answer they get is usually the clinic they start with.
    capability: "around-the-clock",
    because:
      "since new patients book whoever answers first",
  },
  "body-contouring": {
    // Free consult, four-figure package, and the consult no-show is the leak.
    // The deposit is taken in chat, through a payment link. The phone agent
    // books and flags the deposit for staff; it never takes one on a call.
    capability: "deposits",
    because:
      "so a four-figure inquiry books with you",
  },
  "plastic-surgery": {
    // The call is an interview and the coordinator is in consults all day.
    capability: "lead-qualification",
    because:
      "even while your surgeon is operating",
  },
  "laser-skin": {
    // A first course is a price-led decision, and it usually goes to the
    // clinic that answered the price question.
    capability: "around-the-clock",
    because:
      "since a first course goes to whoever answers first",
  },
  "wellness-iv": {
    // Same-day intent. They are asking about the next two hours.
    capability: "around-the-clock",
    because:
      "since IV clients often want a same-day visit",
  },
  "hair-restoration": {
    // Months of working up to the call, and they will not leave a message.
    capability: "lead-qualification",
    because:
      "so months of thinking turn into your consult",
  },
  dental: {
    // A new patient ringing round books with the first practice that answers.
    // Not pitched on pain: a caller reporting an urgent symptom is caught
    // before the model and escalated to the clinic, not booked by the
    // assistant, so the copy must not promise to book them.
    capability: "around-the-clock",
    because:
      "so after-hours new patients get a time from you",
  },
  dermatology: {
    // Two different callers on one line, and the cosmetic one leaves quietly.
    capability: "lead-qualification",
    because:
      "so medical and cosmetic callers get the right answer",
  },
  chiropractic: {
    // A new patient is ringing down a list and stops at the first clinic that
    // says "come in at two". Pitched on the new patient rather than on acute
    // pain, for the same reason as dental: a symptom report is escalated to
    // the clinic, not booked by the assistant.
    capability: "around-the-clock",
    because:
      "since new patients book the first clinic that answers",
  },
  "physical-therapy": {
    // The leak is between the referral and the first appointment. The patient
    // already has a script; they just never got round to ringing back, or rang
    // once and got the machine.
    capability: "calendar-booking",
    because:
      "so your referrals actually book",
  },
  acupuncture: {
    // First visit is high-consideration and question-heavy — does it hurt, how
    // many sessions, is it covered. Regulars book without thinking.
    capability: "lead-qualification",
    because:
      "since a first-timer's questions decide where they book",
  },
  vision: {
    // Two businesses under one roof. Routine exams are habit; LASIK is a
    // four-figure decision that is shopped hard and gated behind a consult, so
    // the consult booking is the event worth protecting.
    capability: "calendar-booking",
    because:
      "since LASIK usually goes to whoever answers first",
  },
  hearing: {
    // The most phone-dependent population in the whole list. Older patients
    // and the adult children ringing on their behalf do not fill in web forms,
    // so an unanswered call is not deferred, it is lost.
    capability: "around-the-clock",
    because:
      "since most callers won't use a form instead",
  },
  "mental-health": {
    // Somebody ringing about psychiatry or ketamine has usually spent a while
    // working up to it. They will not leave a voicemail and they will not ring
    // twice.
    capability: "around-the-clock",
    because:
      "since someone who worked up to calling won't leave a voicemail",
  },
  "other-medical": {
    capability: "lead-qualification",
    because:
      "even while your desk is on a long call",
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
        "while the interest is fresh",
    };
  }

  if (!pain.hasOnlineBooking) {
    return {
      capability: "calendar-booking",
      because:
        reason ??
        "so every answered call can become a booking",
    };
  }

  if (pain.closesEarly) {
    return {
      capability: "around-the-clock",
      because: reason ?? "since most people call after work",
    };
  }

  return (
    BY_SEGMENT[pain.segment] ?? {
      capability: "lead-qualification",
      // The honest fallback: true of any clinic, claims nothing specific.
      because: "since the calls that slip past are often the ready ones",
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
 */
/**
 * The opening clause of the offer, continued by the reason.
 *
 * Phrased as what the clinic gets, not what it is currently failing at. "Answers
 * the calls your team cannot" is accurate and is still a stranger pointing at a
 * shortcoming; "picks those up and books them in" is the same capability
 * described by its result.
 */
/**
 * The opening clause of the offer, continued by the reason.
 *
 * {surfaces} is where the channels land — "your calls", or "your calls and your
 * Instagram messages", or all three. Naming them inside this sentence is what
 * replaced three separate lines about channels, which read as a capability list
 * with the bullets taken off.
 *
 * Each clause names AYA, the product, rather than "our {smart|virtual}
 * assistant": the sequences it lands in (docs/outreach/sequences.md) call her
 * AYA in every email, and a different name in the merged line reads as two
 * writers. Kept short on purpose, because the sequences are four lines each
 * and a merged sentence that wraps three times is the one the reader skips.
 */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "around-the-clock": "AYA answers {surfaces} around the clock, then books them in",
  "calendar-booking": "AYA answers {surfaces}, then books straight into your calendar",
  // In chat, through a payment link. Never "before they ring off": the phone
  // agent cannot collect a deposit, it books and flags it for staff.
  deposits: "AYA answers {surfaces}, and can send a deposit link in chat",
  "lead-qualification": "AYA answers {surfaces}, then sorts them before they reach your desk",
  // Unmapped: no segment selects it. Suggesting add-ons is a portal switch
  // that ships off, so the copy says it is the clinic's choice.
  upselling: "AYA answers {surfaces}, and can suggest an add-on if you switch that on",
};

/**
 * Whether a booking the assistant makes is seen as taken by the clinic's own
 * booking system.
 *
 * v1 writes every booking into the clinic's Google Calendar and nowhere else
 * (docs/v1-product-spec.md → "Where bookings are written"). The clinic's own
 * system blocks that slot only if it reads Google for conflicts:
 *
 *   live        No online booking at all, so the phone is the booking
 *               system, or a platform that reads Google (Calendly, Cal.com).
 *               The assistant books, and where there is a booking page the
 *               slot is gone from it.
 *   manual      Mindbody, and Booker, which is Mindbody's. Sync runs one way,
 *               Mindbody to Google, so the clinic runs manual booking mode:
 *               the assistant takes the preferred time and alerts the desk,
 *               who confirm in Mindbody.
 *   unverified  Boulevard (unverified, treated as no until confirmed in
 *               writing), every other platform, and online booking on a
 *               system we did not recognise. Nobody has checked their sync
 *               direction. Onboarding checks it per clinic, so the copy
 *               promises booking only where their system reads Google.
 *
 * The spec's rule: do not sell live calendar booking to a one-way clinic
 * without saying which of these applies.
 */
export type BookingMode = "live" | "manual" | "unverified";

const READS_GOOGLE = new Set(["calendly", "calcom"]);
const ONE_WAY = new Set(["mindbody", "booker"]);

export function bookingModeFor(
  platform: string | null | undefined,
  hasBookingSystem: boolean,
): BookingMode {
  if (platform && READS_GOOGLE.has(platform)) return "live";
  if (platform && ONE_WAY.has(platform)) return "manual";
  if (platform || hasBookingSystem) return "unverified";
  return "live";
}

/**
 * The opening clause where the assistant cannot simply book.
 *
 * Replaces any label that promises a booking or a deposit. A label that
 * promises neither (lead-qualification) is kept, because it is as true for a
 * Mindbody clinic as for any other.
 */
// {system} is the clinic's own booking system by name when we found one
// ("Boulevard", "Zenoti"), and "your booking system" when we did not. Naming
// the one they use is the proof the sender looked; guessing a name is not.
//
// "Unverified" no longer explains Google sync in the email (owner's brief, 22
// October 2026). "If your system reads Google" is a sentence a clinic owner
// has to stop and decode, and it is the longest clause in the sequence. A cold
// email promises the conservative case, every request passed to the desk,
// which is true for every one of these clinics; onboarding checks the sync and
// may turn it into live booking.
export const BOOKING_MODE_LABEL: Record<Exclude<BookingMode, "live">, string> = {
  manual: "AYA answers {surfaces}, then passes each booking request to your desk to confirm in {system}",
  unverified: "AYA answers {surfaces}, then passes each booking request to your desk to confirm in {system}",
};

const BOOKS_OR_COLLECTS: ReadonlySet<Capability> = new Set<Capability>(["around-the-clock", "calendar-booking", "deposits"]);

/** The opening clause for this capability, given how this clinic can be booked. */
export function offerLabel(capability: Capability, mode: BookingMode, system = "your booking system"): string {
  if (mode !== "live" && BOOKS_OR_COLLECTS.has(capability)) return BOOKING_MODE_LABEL[mode].replace("{system}", system);
  return CAPABILITY_LABEL[capability];
}
