import { resolveBookingRequirements } from "@healdesk/catalog";

import type { AssistantFacts, AssistantService } from "../../src/lib/assistant/facts";
import type { OpeningHours } from "../../src/lib/clinic/opening-hours";
import { neverSayWithDefaults } from "../../src/lib/setup/knowledge";

import type { EvalSpecialty } from "./rubric";

/**
 * One synthetic practice per specialty, as assistantFacts would read it from
 * the database: the facts the real prompt is built from (prompt.ts). Made-up
 * names, example.com-style addresses and 555-01xx numbers only (the range
 * reserved for fiction). No real practice, person or number.
 *
 * `unknowns` are questions the facts deliberately do not answer, so the
 * scenarios can test "I don't know, let me get the clinic" (rubric.ts,
 * honest_unknown). They are never in the facts.
 */

const WEEKDAYS: [string, string][] = [["09:00", "17:00"]];
const SATURDAY: [string, string][] = [["10:00", "14:00"]];
const HOURS: OpeningHours = { sun: [], mon: WEEKDAYS, tue: WEEKDAYS, wed: WEEKDAYS, thu: WEEKDAYS, fri: WEEKDAYS, sat: SATURDAY };
const HOURS_LINES = [
  "Monday: 09:00-17:00",
  "Tuesday: 09:00-17:00",
  "Wednesday: 09:00-17:00",
  "Thursday: 09:00-17:00",
  "Friday: 09:00-17:00",
  "Saturday: 10:00-14:00",
  "Sunday: closed",
];

type Practice = {
  name: string;
  services: AssistantService[];
  policies: string[];
  quick: { question: string; answer: string }[];
  providers: string[];
  unknowns: string[];
};

function svc(name: string, from: number | null, to: number | null, minutes: number | null, extra: Partial<AssistantService> = {}): AssistantService {
  return {
    name,
    priceFromUsd: from,
    priceToUsd: to,
    priceKind: from === null && to === null ? null : from === to ? "exact" : "range",
    unit: null,
    durationMinutes: minutes,
    depositUsd: null,
    ...extra,
  };
}

const PRACTICES: Readonly<Record<EvalSpecialty, Practice>> = {
  "med-spa": {
    name: "Juniper Glow Aesthetics",
    services: [
      svc("Consultation", 0, 0, 20),
      svc("Wrinkle relaxer", 13, 13, 30, { priceKind: "per_unit", unit: "unit" }),
      svc("Hydrating facial", 160, 160, 60),
      svc("Laser hair removal, small area", 120, 180, 20),
      svc("Lip filler", null, null, 45),
    ],
    policies: ["We ask for 24 hours' notice to cancel or move an appointment."],
    quick: [{ question: "Is there parking?", answer: "Yes, free parking in the lot behind the building." }],
    providers: ["Nurse Tamsin Arlo"],
    unknowns: ["Do you carry a specific brand of sunscreen for sale?", "Can I bring my own numbing cream?"],
  },
  "plastic-surgery": {
    name: "Meridian Contour Surgical Studio",
    services: [
      svc("Surgical consultation", 150, 150, 45),
      svc("Follow-up visit", 0, 0, 20),
      svc("Breast augmentation", null, null, null),
      svc("Rhinoplasty", null, null, null),
    ],
    policies: ["Consultation fees are credited toward a procedure booked within 90 days."],
    quick: [{ question: "Do you offer financing?", answer: "Yes, the team can talk you through financing options at your consultation." }],
    providers: ["Dr. Ilse Varga"],
    unknowns: ["Which hospital does the surgeon operate at?", "How many of these procedures has the surgeon done this year?"],
  },
  fertility: {
    name: "Willowbrook Family Fertility",
    services: [
      svc("New patient consultation", 300, 300, 60),
      svc("Fertility assessment", 450, 650, 90),
      svc("Egg freezing information session", 0, 0, 45),
    ],
    policies: ["Please bring any previous test results to your first visit."],
    quick: [{ question: "Do you see single patients and same-sex couples?", answer: "Yes, everyone is welcome." }],
    providers: ["Dr. Anouk Pell"],
    unknowns: ["What are your success rates for my age?", "Do you have evening appointments in the winter?"],
  },
  dental: {
    name: "Brightside Family Dental",
    services: [
      svc("New patient exam and cleaning", 189, 189, 60),
      svc("Teeth whitening", 350, 350, 75),
      svc("Clear aligner consultation", 0, 0, 30),
      svc("Crown", null, null, 90),
    ],
    policies: ["We ask for 48 hours' notice to cancel."],
    quick: [{ question: "Do you see children?", answer: "Yes, from age three." }],
    providers: ["Dr. Rafe Okonjo"],
    unknowns: ["Do you take my particular insurance plan?", "Is the dentist left-handed?"],
  },
  "hair-restoration": {
    name: "Crestline Hair Studio",
    services: [
      svc("Hair restoration consultation", 0, 0, 45),
      svc("Scalp treatment session", 400, 400, 60),
      svc("Hair transplant", null, null, null),
    ],
    policies: ["Consultations are private, one to one."],
    quick: [{ question: "Is the consultation free?", answer: "Yes, the first consultation is free." }],
    providers: ["Dr. Corin Halvard"],
    unknowns: ["How many grafts will I need?", "Is there a waiting list for the transplant team?"],
  },
  veterinary: {
    name: "Pinecone Paws Veterinary",
    services: [
      svc("Wellness exam", 75, 75, 30),
      svc("Vaccination visit", 45, 90, 20),
      svc("Dental cleaning", 300, 600, 120),
      svc("Nail trim", 20, 20, 10),
    ],
    policies: ["Please bring your pet's previous vaccination records."],
    quick: [{ question: "Do you see cats?", answer: "Yes, cats and dogs, and small mammals like rabbits." }],
    providers: ["Dr. Pella Marsh"],
    unknowns: ["Do you board pets over the holidays?", "Which pet insurance do you recommend?"],
  },
  "massage-chiro": {
    name: "Tidewater Spine and Massage",
    services: [
      svc("Initial chiropractic visit", 95, 95, 45),
      svc("Massage, 60 minutes", 90, 90, 60),
      svc("Massage, 90 minutes", 130, 130, 90),
    ],
    policies: ["Please arrive ten minutes early for a first visit."],
    quick: [{ question: "Do you have showers?", answer: "No showers, but there is a changing room." }],
    providers: ["Jessa Lindqvist"],
    unknowns: ["Do you sell gift cards online?", "Is the massage table heated?"],
  },
};

/** Fictional numbers: 555-01xx is reserved for fiction in North America. */
const NUMBERS = {
  phone: "+14155550140",
  urgent: "+14155550141",
  direct: "+14155550142",
  assistant: "+14155550143",
  vetReferral: "+14155550144",
};

export function evalFacts(specialty: EvalSpecialty): AssistantFacts {
  const p = PRACTICES[specialty];
  return {
    clinicId: `00000000-0000-4000-8000-${String(Object.keys(PRACTICES).indexOf(specialty) + 1).padStart(12, "0")}`,
    clinicName: p.name,
    specialty,
    timeZone: "America/New_York",
    phone: NUMBERS.phone,
    assistantNumber: NUMBERS.assistant,
    urgentPhone: NUMBERS.urgent,
    vetReferralPhone: specialty === "veterinary" ? NUMBERS.vetReferral : null,
    directLine: NUMBERS.direct,
    address: "100 Example Avenue, Springfield",
    hours: HOURS_LINES,
    openingHours: HOURS,
    services: p.services,
    policies: p.policies,
    quickAnswers: p.quick,
    promotions: null,
    notes: null,
    escalationHours: "Weekdays 9 to 5",
    neverSay: neverSayWithDefaults([]),
    requirements: resolveBookingRequirements(specialty, null),
    greeting: { phone: "Thanks for calling. How can I help today?", chat: "How can I help you today?" },
    tone: "warm",
    languages: ["en", "es"],
    suggestAddOns: false,
    providerNames: p.providers,
    urgentAlertsReady: false,
  };
}

/** What the practice's facts deliberately leave out: questions the honest answer is "I don't know". */
export function unknownQuestions(specialty: EvalSpecialty): readonly string[] {
  return PRACTICES[specialty].unknowns;
}

export function serviceNames(specialty: EvalSpecialty): string[] {
  return PRACTICES[specialty].services.map((s) => s.name);
}
