/**
 * The six specialties the site leads with.
 *
 * Ported from the original hero prototype. Selection rationale and the full
 * tiering live in docs/icp-niches.md — these six are the intersection of
 * "Tier 1 ROI" and "demoable in a 30-second conversation".
 *
 * `context` is injected into the chat demo's system prompt, so the pricing here
 * is what the model quotes. Figures are approximate industry ranges, NOT quotes —
 * firm them up before they carry any weight in a sale.
 *
 * Adding a seventh specialty is one entry in this array; every consumer
 * (strip, chat, voice, ROI calculator) is driven by it.
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
  /** First message the chat demo shows before the visitor types. */
  greeting: string;
  /** Suggested prompts — two patient questions, one product question. */
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
    name: "Med Spas & Aesthetics",
    hint: "Price-shoppers calling about Botox and filler.",
    greeting:
      "Hi — I'm the front desk for our med spa, running on healdesk. Ask me about treatments and pricing, or how healdesk would handle your clinic's calls.",
    chips: [
      "How much is Botox?",
      "Do you offer memberships?",
      // Deliberately "how do you handle patient data", not "are you HIPAA
      // compliant". No body certifies HIPAA compliance, so the second question
      // invites an answer that asserts a verification nobody performed — the
      // theory the FTC charged as a standalone deception count in SkyMed.
      // This phrasing gets the same reassurance from things we can evidence.
      "How do you handle patient data?",
    ],
    context:
      "Example US pricing: Botox $12-16/unit ($350-550 per treatment), lip and dermal filler $650-900/syringe, monthly memberships common ($99-199/mo). Consults are often free; deposits are used to cut no-shows.",
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
      basis: "One Botox appointment, $350-550",
    },
  },
  {
    id: "plastic-surgery",
    name: "Plastic & Cosmetic Surgery",
    hint: "High-ticket consults lost while the surgeon is in the OR.",
    greeting:
      "Hi — I'm the front desk for our surgical practice, running on healdesk. Ask about procedures and consults, or how healdesk would work for your clinic.",
    chips: [
      "What does a rhinoplasty cost?",
      "How do consults work?",
      "Can it qualify serious leads?",
    ],
    context:
      "Example US ranges: rhinoplasty $8,000-15,000, breast augmentation $8,000-12,000, tummy tuck $10,000-14,000, facelift $15,000-30,000. A consult fee (~$100-200) is often credited toward surgery. Surgeons value qualifying serious consults from tire-kickers.",
    voice: [
      { agent: false, text: "I'm looking into a rhinoplasty — what's the range?" },
      {
        agent: true,
        text: "Rhinoplasty typically runs $8,000 to $15,000 depending on complexity. The surgeon confirms exact pricing at consult. Would you like me to book one?",
      },
      { agent: false, text: "Can I get in this month?" },
      {
        agent: true,
        text: "Of course — I have next Thursday at 1:00. What's the best number to reach you?",
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
    greeting:
      "Hi — I'm the front desk for our fertility practice, running on healdesk. I can walk you through getting started, or show how healdesk would support your clinic.",
    chips: [
      "How much is IVF?",
      "How do we get started?",
      "Does it handle intake & follow-up?",
    ],
    context:
      "Example US ranges: one IVF cycle ~$15,000-20,000 before medication; medication $3,000-6,000; egg freezing ~$10,000+. Financing and shared-risk programs are common. The first step is a new-patient consult. Callers are often anxious first-timers — answers should be warm and gentle.",
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
    greeting:
      "Hi — I'm the front desk for our dental practice, running on healdesk. Ask about treatments and emergencies, or how healdesk would run your phones.",
    chips: [
      "How much are implants?",
      "Do you take my insurance?",
      "Can it handle emergencies 24/7?",
    ],
    context:
      "Example US ranges: single implant $3,000-5,000 (crown included), All-on-4 $20,000-50,000/arch, Invisalign $4,000-6,000. Financing is common. Emergencies (chipped or broken tooth) need same-day handling. Insurance verification is a frequent question.",
    voice: [
      { agent: false, text: "I chipped a tooth — can I get in today?" },
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
    id: "dermatology",
    name: "Dermatology",
    hint: "Urgent skin concerns that shouldn't wait on hold.",
    greeting:
      "Hi — I'm the front desk for our dermatology practice, running on healdesk. Ask about visits and treatments, or how healdesk would work for you.",
    chips: [
      "Do you treat acne?",
      "How fast can I be seen?",
      "Do you take insurance?",
    ],
    context:
      "A mix of medical and cosmetic dermatology. Urgent concerns like a changing mole are prioritized for a skin check. Cosmetic services include laser, Mohs, and cosmetic derm. Medical visits often involve insurance. Never diagnose — urgent symptoms are routed to a provider.",
    voice: [
      { agent: false, text: "Do you treat acne, and do you take my insurance?" },
      {
        agent: true,
        // Deliberately does NOT take the member ID over the phone. Insurance
        // details, like date of birth and medical history, go to a secure link
        // — the agent collects only what it needs to place a booking. The demo
        // has to show the product we actually ship.
        text: "We treat acne, and we do take most plans. I'll text you a secure link to add your insurance details so the front desk can check it before you come in. Want me to book you this week?",
      },
      { agent: false, text: "Sure." },
      {
        agent: true,
        text: "Friday at 2:00 with the PA. Can I get your name and the best number to reach you?",
      },
    ],
    economics: {
      valuePerBooking: 450,
      bookingRate: 0.45,
      basis: "One cosmetic derm visit",
    },
  },
  {
    id: "glp1",
    name: "Weight Loss & GLP-1",
    hint: "Cold ad leads that never call back if they miss you once.",
    greeting:
      "Hi — I'm the front desk for our weight-loss program, running on healdesk. Ask how the program works, or how healdesk would convert your ad leads.",
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
] as const;

export function getSpecialty(id: string): Specialty | undefined {
  return specialties.find((s) => s.id === id);
}
