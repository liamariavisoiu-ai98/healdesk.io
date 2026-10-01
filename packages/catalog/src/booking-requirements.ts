import { isSpecialtyId, type SpecialtyId } from "./specialties";

/**
 * The closed catalogue of what the assistant may ask for when someone wants
 * to book, and which of it each practice has switched on.
 *
 * Every field must be something the front desk needs to decide or place the
 * booking. No contact channel healdesk does not use, no marketing
 * attribution, nothing clinical.
 *
 * That sentence is the whole admission test, and it is why two fields that
 * used to exist are gone: `email` (healdesk sends patients no confirmation —
 * no patient email exists anywhere in the product) and `referral_source`
 * ("how did you hear about us" is marketing attribution, not booking
 * information). Both exceed the BAA's minimum-necessary clause.
 *
 * Four fields are `locked`: they are what a booking request IS, and every
 * channel asks for them whatever the practice chose. The rest are opt-in per
 * practice, pre-selected by specialty on the setup link and confirmed by the
 * practice, by the operator on the call, or by the defaults when the link
 * expires (`clinics.booking_requirements`; NULL means the defaults apply).
 *
 * `metaEligible` is exactly the locked four. A surname or a patient status on
 * a Meta thread that also carries a booking request identifies the person as
 * a patient of a named provider — health information on a vendor that signs
 * no BAA — so nothing beyond the four is ever asked there; `service` stays
 * voice-only as it is today.
 *
 * `ask` is the phrase the agent uses when listing what it still needs
 * ("I just need … and …"). It names the thing asked for and promises nothing:
 * no message, link or confirmation, because none is sent. A test enforces it.
 */

export type BookingFieldId =
  | "first_name"
  | "phone"
  | "preferred_window"
  | "alternative_windows"
  | "last_name"
  | "service"
  | "new_or_existing"
  | "consult_or_treatment"
  | "preferred_provider";

/**
 * Where a field may be asked for. Inbound only: the 23 September 2026
 * `callback` channel (a consented outbound call) was removed for v1, which
 * places no calls.
 */
export type BookingChannel = "voice" | "meta";

export type BookingField = {
  id: BookingFieldId;
  /** Shown to the practice on the setup link and in the console. */
  label: string;
  /** Spoken or written by the agent when asking for it. Names a thing; promises nothing. */
  ask: string;
  /** Always collected; the practice cannot switch it off. */
  locked: boolean;
  channels: BookingChannel[];
  /** May be asked on a Meta thread. Exactly the locked four. */
  metaEligible: boolean;
};

export const BOOKING_FIELDS: readonly BookingField[] = [
  { id: "first_name", label: "First name", ask: "your first name", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "phone", label: "Phone number the practice can call", ask: "a number the practice can call", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "preferred_window", label: "Preferred day or time", ask: "a day or time that works best", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "alternative_windows", label: "Two other times that could work", ask: "one or two other times that could work", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "last_name", label: "Last name", ask: "your last name", locked: false, channels: ["voice"], metaEligible: false },
  // = the `treatment` column at creation; `collected_fields.service` when collected afterwards.
  { id: "service", label: "Service asked about", ask: "which service you're asking about", locked: false, channels: ["voice"], metaEligible: false },
  { id: "new_or_existing", label: "New or returning patient", ask: "whether you've been to the practice before", locked: false, channels: ["voice"], metaEligible: false },
  { id: "consult_or_treatment", label: "Consultation or treatment visit", ask: "whether this is a consultation or a treatment visit", locked: false, channels: ["voice"], metaEligible: false },
  { id: "preferred_provider", label: "Preferred practitioner, if any", ask: "whether there's a particular practitioner you'd like to see", locked: false, channels: ["voice"], metaEligible: false },
];

/**
 * Never in the catalogue; listed so the console and the setup page can say
 * so, and so a test can assert no id resembles them.
 */
export const EXCLUDED_FIELDS = [
  "Date of birth",
  "Insurance or member id",
  "Medical history, conditions, medications",
  "Pregnancy or breastfeeding",
  "Reason for visit beyond the service name",
  "Photos",
  "Payment card details",
  "Home address",
  "Email address",
  "How they heard about the practice",
] as const;

/**
 * What each specialty's practices are pre-selected to collect, beyond the
 * locked four. Keyed by the real SpecialtyId so a renamed specialty fails to
 * compile here rather than silently falling back to the locked four.
 */
export const SPECIALTY_BOOKING_DEFAULTS: Record<SpecialtyId, BookingFieldId[]> = {
  "med-spa": ["service"],
  "plastic-surgery": ["last_name", "service", "consult_or_treatment"],
  fertility: ["last_name", "new_or_existing"],
  dental: ["last_name", "new_or_existing", "consult_or_treatment"],
  glp1: ["last_name", "new_or_existing"],
  "hair-restoration": ["service", "consult_or_treatment"],
  veterinary: ["last_name", "service"],
  "massage-chiro": ["service"],
};

/**
 * The fields a practice collects: the locked four, plus what it stored, or —
 * when it stored nothing (`clinics.booking_requirements` is NULL) — the
 * specialty defaults. Catalogue order; ids the catalogue does not know are
 * dropped rather than thrown on, so a stale stored list cannot take the
 * request page down. An unknown specialty gets the locked four only.
 */
export function resolveBookingRequirements(
  specialty: string,
  stored: readonly string[] | null,
): BookingField[] {
  const chosen = new Set<string>(
    stored ?? (isSpecialtyId(specialty) ? SPECIALTY_BOOKING_DEFAULTS[specialty] : []),
  );
  return BOOKING_FIELDS.filter((field) => field.locked || chosen.has(field.id));
}

/** The subset a Meta thread may ask for. */
export function metaEligible(fields: readonly BookingField[]): BookingField[] {
  return fields.filter((field) => field.metaEligible);
}

export function isBookingFieldId(value: unknown): value is BookingFieldId {
  return typeof value === "string" && BOOKING_FIELDS.some((field) => field.id === value);
}
