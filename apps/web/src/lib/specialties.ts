/**
 * The eight specialties the site leads with.
 *
 * Ported from the original hero prototype. Selection rationale and the full
 * tiering live in docs/icp-niches.md, these six are the intersection of
 * "Tier 1 ROI" and "demoable in a 30-second conversation".
 *
 * `context` is injected into the chat demo's system prompt, so the pricing here
 * is what the model quotes. Figures are approximate industry ranges, NOT quotes,
 * firm them up before they carry any weight in a sale.
 *
 * Adding another specialty is one entry in this array PLUS one in
 * packages/catalog/src/specialties.ts. Both are required: the catalog id is
 * what apps/app validates a paid provisioning request against, so a specialty
 * that existed only here would take a customer's money and then be rejected
 * as unknown once the card had been charged.
 *
 * Each entry used to carry its own greeting, suggested chips, a scripted call
 * and a one-line hint. Nothing had rendered them since the specialty picker
 * went (lib/demo-agent.ts explains why), and several promised texted intake
 * forms and secure links, which v1 never sends. They were removed on 30
 * September 2026. Any script revived here must be inbound, send nothing, and
 * open with the AI-assistant line.
 */

export type Specialty = {
  id: string;
  name: string;
  /**
   * The credibility line, revealed under the name in the niche carousel.
   *
   * The job of this string is narrow: prove in one breath that we have looked
   * at this specialty's phone rather than at "healthcare" in general. So each
   * one carries a real number and a real operational detail from
   * docs/icp-niches.md, the ticket, and the thing that actually goes wrong at
   * the front desk. Generic benefit copy here would be worse than nothing,
   * because the whole section is an expertise claim.
   *
   * Every figure is an approximate industry range; the contact page says so.
   * Nothing here may assert a capability the product does not have.
   */
  expertise: string;
  /**
   * One short line for the specialty's tile in the mosaic (owner, 9 October
   * 2026). `expertise` is a paragraph, too long for a tile a quarter of the
   * section wide; this is its point in a sentence. Same rule: nothing here
   * may assert a capability the product does not have.
   */
  hook: string;
  /** Domain pricing + norms handed to the model as system context. */
  context: string;
  /** Drives the "what a missed call costs you" calculator. */
  economics: {
    /** Revenue at risk from a single converted inquiry, in USD. */
    valuePerBooking: number;
    /** Share of inbound inquiries that become a booking with a good front desk. */
    bookingRate: number;
    /** Human-readable basis for the number above. */
    basis: string;
  };
};

export const specialties: readonly Specialty[] = [
  {
    id: "med-spa",
    name: "Med Spas, Dermatology & Aesthetics",
    hook: "Answers first, while they still have three tabs open.",
    expertise:
      "Your client has three tabs open and is working down the list. " +
      "Whoever answers takes the $350 to $550 booking. Medical and " +
      "cosmetic come down the same line, so a changing mole goes straight " +
      "to a provider and nothing on the call is ever a diagnosis.",
    context:
      "Covers med spa, aesthetics and dermatology, medical and cosmetic. Example US pricing: Botox $12-16/unit ($350-550 per treatment), lip and dermal filler $650-900/syringe, monthly memberships common ($99-199/mo), cosmetic derm visits around $450. Consults are often free; deposits are used to cut no-shows. Medical dermatology often involves insurance; insurance and verification questions are noted for the front desk, and nothing is sent to the caller. Urgent concerns such as a changing mole are prioritised for a skin check and routed to a provider. Never diagnose.",
    economics: {
      valuePerBooking: 550,
      bookingRate: 0.35,
      basis: "One injectable or cosmetic derm visit",
    },
  },
  {
    id: "plastic-surgery",
    name: "Plastic & Cosmetic Surgery",
    hook: "The after-hours consult call, answered instead of lost to voicemail.",
    expertise:
      "The $20,000 call comes in just after the phones roll to " +
      "voicemail, while you're still closing. Almost nobody leaves " +
      "one. An empty voicemail box in the morning is not a quiet " +
      "night, so we answer and book them in.",
    context:
      "Example US ranges: rhinoplasty $8,000-15,000, breast augmentation $8,000-12,000, tummy tuck $10,000-14,000, facelift $15,000-30,000. A consult fee (~$100-200) is often credited toward surgery. Surgeons value qualifying serious consults from tire-kickers.",
    economics: {
      valuePerBooking: 12000,
      bookingRate: 0.18,
      basis: "One surgical case, $8k-18k",
    },
  },
  {
    id: "fertility",
    name: "Fertility & IVF",
    hook: "Unhurried with patients who have researched for weeks.",
    expertise:
      "One cycle is $15k to $25k, and most patients need two or " +
      "three. They research for weeks. By the time they dial they " +
      "already know your success rates, and we keep that call warm " +
      "and unhurried, and book the consult before they hang up.",
    context:
      "Example US ranges: one IVF cycle ~$15,000-20,000 before medication; medication $3,000-6,000; egg freezing ~$10,000+. Financing and shared-risk programs are common. The first step is a new-patient consult. Callers are often anxious first-timers, answers should be warm and gentle.",
    economics: {
      valuePerBooking: 18000,
      bookingRate: 0.22,
      basis: "One IVF cycle, $15k-20k",
    },
  },
  {
    id: "dental",
    name: "Dental & Orthodontics",
    hook: "Tells the chipped tooth at 7pm from the implant quote at noon.",
    expertise:
      "A single implant is $3k to $5k and a full arch $20k to $50k. " +
      "The chipped tooth at 7pm and the implant quote at noon are " +
      "completely different calls, and both of them get answered and " +
      "booked.",
    context:
      "Example US ranges: single implant $3,000-5,000 (crown included), All-on-4 $20,000-50,000/arch, Invisalign $4,000-6,000. Financing is common. Emergencies (chipped or broken tooth) need same-day handling. Insurance verification is a frequent question.",
    economics: {
      valuePerBooking: 4000,
      bookingRate: 0.4,
      basis: "One implant case, $3k-5k",
    },
  },
  {
    id: "glp1",
    name: "Weight Loss & GLP-1",
    hook: "Books the eligibility visit while the lead is still warm.",
    expertise:
      "Around 40% of GLP-1 patients are new to the practice and " +
      "arrive cold from ads, so speed-to-lead is the entire game. The " +
      "eligibility visit gets booked first, while they are still on " +
      "the line.",
    context:
      "GLP-1 program requires a medical eligibility visit first. Example price ~$249-349/mo including medication and check-ins; visits are often virtual. Around 40% of patients are brand-new, arriving from ads, so speed-to-lead matters. Revenue is recurring.",
    economics: {
      // Recurring, so the number that matters is annualised, not first-month.
      valuePerBooking: 3600,
      bookingRate: 0.3,
      basis: "12 months at ~$300/mo",
    },
  },
  {
    id: "hair-restoration",
    name: "Hair Restoration",
    hook: "Patient with a caller who has hung up twice before.",
    expertise:
      "This caller has been reading about it for eight months and has " +
      "picked up the phone twice before without dialling. The work is " +
      "$3,000 to $9,000. One wrong question in the first minute and they " +
      "go back to reading.",
    context:
      "Example US ranges: FUE or FUT transplant $3,000-9,000 depending on graft count, PRP and maintenance therapy recurring every 4-6 weeks, and consults commonly free and often done from photos. Results take 9-12 months, so setting that expectation early matters. GLP-1 related shedding has pushed enquiry volume up. Callers are frequently self-conscious and have deliberated for a long time, so discretion and an unhurried tone matter more than speed.",
    economics: {
      // Consult-heavy with a long deliberation, so the booking rate sits near
      // surgery rather than near dental. Maintenance recurs every 4-6 weeks
      // and is deliberately NOT counted here; this is the case value alone.
      valuePerBooking: 5500,
      bookingRate: 0.2,
      basis: "One transplant case, $3k-9k",
    },
  },
  {
    id: "veterinary",
    name: "Veterinary & Pet Spas",
    hook: "Says the pet's name before the owner's.",
    /**
     * The one card on the site that leads with feeling rather than a figure.
     *
     * Every other niche is a purchase decision, so a price does the proving.
     * Nobody rings a vet to buy something. They ring because an animal they
     * love is unwell, and the detail that gives it away is that they use the
     * animal's name with a stranger, as though you already know him.
     *
     * The last sentence is the compliance boundary said as care rather than as
     * policy. "It is probably fine" is the exact phrase the practice layer
     * forbids, because it is the one a frightened owner is fishing for and the
     * one that gets an animal killed. Saying we will not offer it is both the
     * warmest line on the card and the most defensible.
     */
    expertise:
      "She says Bailey's name before she says her own, because to her " +
      "you already know him. She has been awake since four, and she has " +
      "already looked it up and frightened herself. We pick up. We do not " +
      "tell her it is probably fine.",
    context:
      "Covers small-animal veterinary practice and pet grooming, often on one phone line. Example US pricing: routine exam $60-100, wellness visit with vaccines $150-300, dental under anaesthesia $500-1,200, spay or neuter $250-600. Full groom $60-120 by breed and coat, and no firm price can be given over the phone because matting changes it. Proof of rabies vaccination is usually required before a groom. NEVER assess a sick or injured animal, never comment on symptoms, and never say whether something can wait until morning, including by implication. Take the details, say a person will come back to them, and do not promise when. Out of hours, read the practice's own emergency referral number. Do not choose which appointment type an unwell animal needs; offer what the practice's rules allow and let them confirm.",
    economics: {
      // UNSOURCED. Unlike every other entry in this file, these are not from
      // docs/icp-niches.md, which does not cover veterinary at all. They are a
      // build-up of a new client's first year: an exam, a vaccine visit,
      // preventatives and one sick visit. Firm them up before they carry any
      // weight, because the calculator turns them into a dollar figure a
      // prospect reads as ours.
      valuePerBooking: 400,
      bookingRate: 0.5,
      basis: "New client, first year",
    },
  },
  {
    id: "massage-chiro",
    name: "Massage & Chiropractic",
    hook: "Answers “can you see me today?” before they call the next clinic.",
    expertise:
      "Someone whose back went out at six this morning asks one " +
      "question, which is whether you can see them today. If nobody picks " +
      "up they call the next clinic on the map. The calls you miss are the " +
      "ones between eight and ten.",
    context:
      "Covers massage therapy and chiropractic, frequently in one building and one booking system. Example US pricing: chiropractic initial exam $100-200, subsequent adjustments $50-75, a course of care commonly 8-12 visits; massage $80-120 an hour with packages and memberships common. Cancellation windows are usually 24 hours and no-shows are the practice's biggest leak. On insurance: a chiropractor billing electronically is usually a HIPAA covered entity, a cash-only massage practice usually is not, so never assume which one you are on. Never say what is causing someone's pain, never say whether treatment is appropriate for them, and never state what a plan will cover. Insurance questions are noted for the front desk; nothing is sent to the caller. Clinical questions go to the practitioner.",
    economics: {
      // UNSOURCED, as above. Built from a chiropractic initial exam plus a
      // short course of care, which is the realistic first-year value of a
      // new patient rather than the price of one visit. Note this is by far
      // the smallest ticket on the site.
      valuePerBooking: 450,
      bookingRate: 0.5,
      basis: "New patient, first course of care",
    },
  },
] as const;

export function getSpecialty(id: string): Specialty | undefined {
  return specialties.find((s) => s.id === id);
}
