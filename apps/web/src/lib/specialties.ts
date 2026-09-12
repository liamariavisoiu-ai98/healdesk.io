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
 */

export type VoiceLine = {
  /** true = the healdesk agent speaking, false = the caller */
  agent: boolean;
  text: string;
};

export type Specialty = {
  id: string;
  name: string;
  /** One line on the pain, shown on the panel when it expands. */
  hint: string;
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
   * Every figure is an approximate industry range, and the footer says so.
   * Nothing here may assert a capability the product does not have.
   */
  expertise: string;
  /** First message the chat demo shows before the visitor types. */
  greeting: string;
  /** Suggested prompts, two patient questions, one product question. */
  chips: readonly [string, string, string];
  /** Domain pricing + norms handed to the model as system context. */
  context: string;
  /** Scripted inbound call, played back as a transcript. */
  voice: readonly VoiceLine[];
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
    hint: "Price-shoppers and skin concerns on the same line.",
    expertise:
      "Your client has three tabs open and is working down the list. " +
      "Whoever answers takes the $350 to $550 booking. Medical and " +
      "cosmetic come down the same line, so a changing mole goes straight " +
      "to a provider and nothing on the call is ever a diagnosis.",
    greeting:
      "Hi. I'm the front desk for our med spa and dermatology practice, running on healdesk. Ask me about treatments, skin concerns and pricing, or how healdesk would handle your clinic's calls.",
    chips: [
      "How much is Botox?",
      "How fast can I be seen for a skin check?",
      // Deliberately "how do you handle patient data", not "are you HIPAA
      // compliant". No body certifies HIPAA compliance, so the second question
      // invites an answer that asserts a verification nobody performed, the
      // theory the FTC charged as a standalone deception count in SkyMed.
      // This phrasing gets the same reassurance from things we can evidence.
      "How do you handle patient data?",
    ],
    context:
      "Covers med spa, aesthetics and dermatology, medical and cosmetic. Example US pricing: Botox $12-16/unit ($350-550 per treatment), lip and dermal filler $650-900/syringe, monthly memberships common ($99-199/mo), cosmetic derm visits around $450. Consults are often free; deposits are used to cut no-shows. Medical dermatology often involves insurance, so verification details go to a secure link rather than being taken on the call. Urgent concerns such as a changing mole are prioritised for a skin check and routed to a provider. Never diagnose.",
    voice: [
      { agent: false, text: "Hi, how much is lip filler?" },
      {
        agent: true,
        text: "Lip filler starts at $650 a syringe. Would you like to book a consult first, or come in for treatment?",
      },
      { agent: false, text: "A consult first, I think." },
      {
        agent: true,
        text: "I have Tuesday at 4:00. Can I get your name and number to confirm?",
      },
    ],
    economics: {
      valuePerBooking: 550,
      bookingRate: 0.35,
      basis: "One injectable or cosmetic derm visit",
    },
  },
  {
    id: "plastic-surgery",
    name: "Plastic & Cosmetic Surgery",
    hint: "High-ticket consults lost while the surgeon is in the OR.",
    expertise:
      "The $20,000 call comes in just after the phones roll to " +
      "voicemail, while you're still closing. Almost nobody leaves " +
      "one. An empty voicemail box in the morning is not a quiet " +
      "night, so we answer and book them in.",
    greeting:
      "Hi. I'm the front desk for our surgical practice, running on healdesk. Ask about procedures and consults, or how healdesk would work for your clinic.",
    chips: [
      "What does a rhinoplasty cost?",
      "How do consults work?",
      "Can it qualify serious leads?",
    ],
    context:
      "Example US ranges: rhinoplasty $8,000-15,000, breast augmentation $8,000-12,000, tummy tuck $10,000-14,000, facelift $15,000-30,000. A consult fee (~$100-200) is often credited toward surgery. Surgeons value qualifying serious consults from tire-kickers.",
    voice: [
      { agent: false, text: "I'm looking into a rhinoplasty, what's the range?" },
      {
        agent: true,
        text: "Rhinoplasty typically runs $8,000 to $15,000 depending on complexity. The surgeon confirms exact pricing at consult. Would you like me to book one?",
      },
      { agent: false, text: "Can I get in this month?" },
      {
        agent: true,
        text: "Of course. I have next Thursday at 1:00. What's the best number to reach you?",
      },
    ],
    economics: {
      valuePerBooking: 12000,
      bookingRate: 0.18,
      basis: "One surgical case, $8k-18k",
    },
  },
  {
    id: "fertility",
    name: "Fertility & IVF",
    hint: "First-time patients who research for weeks before calling.",
    expertise:
      "One cycle is $15k to $25k, and most patients need two or " +
      "three. They research for weeks. By the time they dial they " +
      "already know your success rates, and we keep that call warm " +
      "and unhurried. The paperwork goes out by secure link.",
    greeting:
      "Hi. I'm the front desk for our fertility practice, running on healdesk. I can walk you through getting started, or show how healdesk would support your clinic.",
    chips: [
      "How much is IVF?",
      "How do we get started?",
      "Does it handle intake & follow-up?",
    ],
    context:
      "Example US ranges: one IVF cycle ~$15,000-20,000 before medication; medication $3,000-6,000; egg freezing ~$10,000+. Financing and shared-risk programs are common. The first step is a new-patient consult. Callers are often anxious first-timers, answers should be warm and gentle.",
    voice: [
      { agent: false, text: "How much is one round of IVF here?" },
      {
        agent: true,
        text: "A full IVF cycle is around $18,000 before medication. We also have financing and a shared-risk program. Would you like a consult to walk through your options?",
      },
      { agent: false, text: "Yes, please." },
      {
        agent: true,
        text: "I can see you Monday at 9:30. I'll text your new-patient paperwork right after this call.",
      },
    ],
    economics: {
      valuePerBooking: 18000,
      bookingRate: 0.22,
      basis: "One IVF cycle, $15k-20k",
    },
  },
  {
    id: "dental",
    name: "Dental & Orthodontics",
    hint: "Emergencies and implant quotes, all day, every day.",
    expertise:
      "A single implant is $3k to $5k and a full arch $20k to $50k. " +
      "The chipped tooth at 7pm and the implant quote at noon are " +
      "completely different calls, and both of them get answered and " +
      "booked.",
    greeting:
      "Hi. I'm the front desk for our dental practice, running on healdesk. Ask about treatments and emergencies, or how healdesk would run your phones.",
    chips: [
      "How much are implants?",
      "Do you take my insurance?",
      "Can it handle emergencies 24/7?",
    ],
    context:
      "Example US ranges: single implant $3,000-5,000 (crown included), All-on-4 $20,000-50,000/arch, Invisalign $4,000-6,000. Financing is common. Emergencies (chipped or broken tooth) need same-day handling. Insurance verification is a frequent question.",
    voice: [
      { agent: false, text: "I chipped a tooth, can I get in today?" },
      {
        agent: true,
        text: "Let me check. Yes, we have an emergency slot at 3:15 this afternoon. Is this your first visit with us?",
      },
      { agent: false, text: "First time." },
      {
        agent: true,
        text: "No problem. I'll register you now and text the intake link. See you at 3:15.",
      },
    ],
    economics: {
      valuePerBooking: 4000,
      bookingRate: 0.4,
      basis: "One implant case, $3k-5k",
    },
  },
  {
    id: "glp1",
    name: "Weight Loss & GLP-1",
    hint: "Cold ad leads that never call back if they miss you once.",
    expertise:
      "Around 40% of GLP-1 patients are new to the practice and " +
      "arrive cold from ads, so speed-to-lead is the entire game. The " +
      "eligibility visit gets booked first, and every message we send " +
      "carries STOP.",
    greeting:
      "Hi. I'm the front desk for our weight-loss program, running on healdesk. Ask how the program works, or how healdesk would convert your ad leads.",
    chips: [
      "Do you prescribe semaglutide?",
      "What does the program cost?",
      "How do you handle new leads?",
    ],
    context:
      "GLP-1 program requires a medical eligibility visit first. Example price ~$249-349/mo including medication and check-ins; visits are often virtual. Around 40% of patients are brand-new, arriving from ads, so speed-to-lead matters. Revenue is recurring.",
    voice: [
      { agent: false, text: "I saw your ad for weight loss. How does it work?" },
      {
        agent: true,
        text: "It starts with a medical visit to confirm you're a fit, then we ship your medication monthly with regular check-ins. Would you like to book that first visit?",
      },
      { agent: false, text: "Yeah, I would." },
      {
        agent: true,
        text: "I have Thursday at noon. I'll text you the intake form to fill out first.",
      },
    ],
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
    hint: "Callers who took months to work up to dialling.",
    expertise:
      "This caller has been reading about it for eight months and has " +
      "picked up the phone twice before without dialling. The work is " +
      "$3,000 to $9,000. One wrong question in the first minute and they " +
      "go back to reading.",
    greeting:
      "Hi. I'm the front desk for our hair restoration practice, running on healdesk. Ask about the procedure, results and pricing, or how healdesk would handle your clinic's calls.",
    chips: [
      "How much is a transplant?",
      "How long until I see results?",
      "Can it handle discreet enquiries?",
    ],
    context:
      "Example US ranges: FUE or FUT transplant $3,000-9,000 depending on graft count, PRP and maintenance therapy recurring every 4-6 weeks, and consults commonly free and often done from photos. Results take 9-12 months, so setting that expectation early matters. GLP-1 related shedding has pushed enquiry volume up. Callers are frequently self-conscious and have deliberated for a long time, so discretion and an unhurried tone matter more than speed.",
    voice: [
      {
        agent: false,
        text: "Hi, I wanted to ask about a hair transplant. Is the consultation free?",
      },
      {
        agent: true,
        text: "It is, and you can do it from photos if that's easier to start with. Most cases run $3,000 to $9,000 depending on how much area we're covering. Would you like me to book one?",
      },
      { agent: false, text: "Yes, but nothing during work hours if possible." },
      {
        agent: true,
        text: "Of course. I have Thursday at 6:30 or Saturday morning. Can I take your name and the best number to reach you?",
      },
    ],
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
    hint: "Frightened owners, and a groom line ringing behind them.",
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
    greeting:
      "Hi. I'm the front desk for our animal hospital and grooming salon, running on healdesk. I can take booking requests for appointments and grooms, or show you how healdesk would handle your practice's phones. If your pet is unwell, tell me and I'll take the details straight to the practice.",
    chips: [
      "How much is a full groom?",
      "My dog has been sick since last night",
      "What happens on an after-hours call?",
    ],
    context:
      "Covers small-animal veterinary practice and pet grooming, often on one phone line. Example US pricing: routine exam $60-100, wellness visit with vaccines $150-300, dental under anaesthesia $500-1,200, spay or neuter $250-600. Full groom $60-120 by breed and coat, and no firm price can be given over the phone because matting changes it. Proof of rabies vaccination is usually required before a groom. NEVER assess a sick or injured animal, never comment on symptoms, and never say whether something can wait until morning, including by implication. Take the details, say a person will come back to them, and do not promise when. Out of hours, read the practice's own emergency referral number. Do not choose which appointment type an unwell animal needs; offer what the practice's rules allow and let them confirm.",
    voice: [
      {
        agent: false,
        text: "Hi, my dog got into the bin overnight and he's been sick twice this morning.",
      },
      {
        agent: true,
        text: "I'm not able to say anything about that myself, so I'm taking the details to the practice now. Can I get his name and the best number to reach you?",
      },
      { agent: false, text: "It's Bailey, the beagle. This number is fine." },
      {
        agent: true,
        text: "Thank you. I've passed Bailey's details through and someone from the practice will call you back on this number.",
      },
    ],
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
    hint: "The phone rings while both hands are on a client.",
    expertise:
      "Someone whose back went out at six this morning asks one " +
      "question, which is whether you can see them today. If nobody picks " +
      "up they call the next clinic on the map. The calls you miss are the " +
      "ones between eight and ten.",
    greeting:
      "Hi. I'm the front desk for our massage and chiropractic clinic, running on healdesk. Ask about availability, treatments and pricing, or how healdesk would cover your phones while you're in a room.",
    chips: [
      "Can someone see me today?",
      "How much is an adjustment?",
      "Do you take my insurance?",
    ],
    context:
      "Covers massage therapy and chiropractic, frequently in one building and one booking system. Example US pricing: chiropractic initial exam $100-200, subsequent adjustments $50-75, a course of care commonly 8-12 visits; massage $80-120 an hour with packages and memberships common. Cancellation windows are usually 24 hours and no-shows are the practice's biggest leak. On insurance: a chiropractor billing electronically is usually a HIPAA covered entity, a cash-only massage practice usually is not, so never assume which one you are on. Never say what is causing someone's pain, never say whether treatment is appropriate for them, and never state what a plan will cover. Insurance details go to a secure link and clinical questions go to the practitioner.",
    voice: [
      {
        agent: false,
        text: "My back went out this morning. Is there any chance of getting in today?",
      },
      {
        agent: true,
        text: "There's a 4:15 with Dr Reyes today, or 8:30 tomorrow morning if that's easier. Which would you like?",
      },
      { agent: false, text: "Today, please. Do you take my insurance?" },
      {
        agent: true,
        text: "I'll text you a secure link to add your details and the front desk will check it before you come in. 4:15 today, and can I take your name?",
      },
    ],
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
