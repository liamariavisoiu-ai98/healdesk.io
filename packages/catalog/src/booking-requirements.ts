import type { Audience } from "./audience";
import { findClinicalContent } from "./clinical-content";
import { isSpecialtyId, regimeFor, type SpecialtyId } from "./specialties";

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
 *
 * Two fields are `forAnimals`: the animal's name and its species, which the
 * owner allowed a veterinary booking to record on 6 October 2026 (the spec's
 * "A veterinary booking may record the animal's name and species"; the DPA's
 * minimum-necessary clause names them as part of its ceiling). They exist
 * only where the patients are animals (caresForAnimals): never offered on a
 * setup page, resolved into a requirement set, asked or kept anywhere else,
 * so no practice under the BAA, whose clause 11 lists what it may collect,
 * can collect them. Like every field but the locked four they are not
 * `metaEligible`: Meta signs neither agreement, and its channels keep only
 * the locked four. Each has its own validation (cleanAnimalName,
 * cleanAnimalSpecies), applied after the length cap and the clinical screen
 * every collected field gets (apps/app lib/meta/booking-requests.ts,
 * cleanCollectedFields).
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
  | "preferred_provider"
  | "animal_name"
  | "animal_species";

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
  /**
   * The label where the practice's customers are "clients" (audienceFor): a
   * label that says "patient" carries the vet's words here. Absent, `label`
   * is used everywhere.
   */
  clientLabel?: string;
  /** Only where the patients are animals (caresForAnimals); never anywhere else. */
  forAnimals?: true;
  /**
   * How the model writes the value, for a field whose value is a closed form.
   * Shown to the model beside `ask`, never said to the person.
   */
  answer?: string;
};

export const BOOKING_FIELDS: readonly BookingField[] = [
  { id: "first_name", label: "First name", ask: "your first name", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "phone", label: "Phone number the practice can call", ask: "a number the practice can call", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "preferred_window", label: "Preferred day or time", ask: "a day or time that works best", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "alternative_windows", label: "Two other times that could work", ask: "one or two other times that could work", locked: true, channels: ["voice", "meta"], metaEligible: true },
  { id: "last_name", label: "Last name", ask: "your last name", locked: false, channels: ["voice"], metaEligible: false },
  // = the `treatment` column at creation; `collected_fields.service` when collected afterwards.
  { id: "service", label: "Service asked about", ask: "which service you're asking about", locked: false, channels: ["voice"], metaEligible: false },
  { id: "new_or_existing", label: "New or returning patient", clientLabel: "New or returning client", ask: "whether you've been to the practice before", locked: false, channels: ["voice"], metaEligible: false },
  { id: "consult_or_treatment", label: "Consultation or treatment visit", ask: "whether this is a consultation or a treatment visit", locked: false, channels: ["voice"], metaEligible: false },
  { id: "preferred_provider", label: "Preferred practitioner, if any", ask: "whether there's a particular practitioner you'd like to see", locked: false, channels: ["voice"], metaEligible: false },
  { id: "animal_name", label: "Animal's name", ask: "the animal's name", locked: false, channels: ["voice"], metaEligible: false, forAnimals: true, answer: "the animal's name only" },
  {
    id: "animal_species",
    label: "Species",
    ask: "what kind of animal it is",
    locked: false,
    channels: ["voice"],
    metaEligible: false,
    forAnimals: true,
    answer: 'one of: dog, cat, rabbit, bird, reptile, small mammal, horse; for any other animal, "other: " and one word, such as "other: ferret"',
  },
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
  veterinary: ["last_name", "service", "animal_name", "animal_species"],
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
  // An animal field stored for a practice whose patients are people (a
  // specialty changed, a hand-edited row) is dropped here, so no collector
  // asks for it and no request keeps it.
  return bookingFieldsFor(specialty).filter((field) => field.locked || chosen.has(field.id));
}

/**
 * Whether a practice's patients are animals: the specialty's regime, the
 * test audienceFor ("clients") and the DPA's isVeterinaryPractice use, so a
 * second animal specialty needs no change here. Unknown is false.
 */
export function caresForAnimals(specialty: string | null | undefined): boolean {
  return isSpecialtyId(specialty) && regimeFor(specialty) === "non-hipaa";
}

/** The catalogue as one practice's setup page and operator console offer it: the animal fields only at a practice that cares for animals. */
export function bookingFieldsFor(specialty: string | null | undefined): BookingField[] {
  const animals = caresForAnimals(specialty);
  return BOOKING_FIELDS.filter((field) => !field.forAnimals || animals);
}

/** A field's label in the practice's own words: "client" for a practice whose customers own the animals it cares for. */
export function bookingFieldLabel(field: BookingField, audience: Audience): string {
  return audience === "clients" ? (field.clientLabel ?? field.label) : field.label;
}

/** The subset a Meta thread may ask for. */
export function metaEligible(fields: readonly BookingField[]): BookingField[] {
  return fields.filter((field) => field.metaEligible);
}

export function isBookingFieldId(value: unknown): value is BookingFieldId {
  return typeof value === "string" && BOOKING_FIELDS.some((field) => field.id === value);
}

// -----------------------------------------------------------------------------
// The animal fields' own validation
// -----------------------------------------------------------------------------

/** The closed list a species is one of. "other" may carry one short word ("other: ferret"). */
export const ANIMAL_SPECIES = ["dog", "cat", "rabbit", "bird", "reptile", "small mammal", "horse", "other"] as const;

export type AnimalSpecies = (typeof ANIMAL_SPECIES)[number];

export const MAX_ANIMAL_NAME = 40;
const MAX_OTHER_SPECIES = 20;

const ANIMAL_NAME = /^[\p{L}][\p{L}'’ -]*$/u;

/**
 * An animal's name, made safe to keep: letters, spaces, apostrophes and
 * hyphens only ("Biscuit", "Mr Whiskers", "D'Artagnan", "Jean-Luc"), at most
 * 40 characters, and nothing the clinical screen catches (findClinicalContent's
 * default screen: "Max allergic", "Bella pregnant"). No digits, so no number
 * can be kept in it. Anything else is null, and the field is not kept.
 */
export function cleanAnimalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_ANIMAL_NAME || !ANIMAL_NAME.test(name)) return null;
  if (findClinicalContent({ animal_name: name }).length > 0) return null;
  return name;
}

const OTHER_SPECIES = /^other(?:\s*[:(,–—-]\s*|\s+)([\p{L}][\p{L}'’-]*)\)?$/u;

/**
 * A species from the closed list (ANIMAL_SPECIES), as it is kept: "dog",
 * "small mammal", "other", or "other: " and one word of letters, apostrophes
 * and hyphens, at most 20 characters, screened as a name is ("other:
 * ferret"). Case, and "small-mammal" or "small_mammal", are forgiven; a word
 * that is on the list is kept as the list's own ("other: dog" is "dog"). An
 * unknown species ("dragon"), a sentence, or a word the clinical screen
 * catches is null, and the field is not kept.
 */
export function cleanAnimalSpecies(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  const listed = (word: string) => {
    const key = word.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return (ANIMAL_SPECIES as readonly string[]).includes(key) ? key : null;
  };
  const plain = listed(text);
  if (plain) return plain;
  const other = OTHER_SPECIES.exec(text);
  if (!other) return null;
  const word = other[1]!;
  const known = listed(word);
  if (known) return known;
  if (word.length > MAX_OTHER_SPECIES) return null;
  if (findClinicalContent({ animal_species: word }).length > 0) return null;
  return `other: ${word}`;
}

/**
 * A collected value as the field's own validation keeps it, or null when it
 * fails. A field with none keeps its value as given: the caller's length cap
 * and clinical screen are the whole of its validation.
 */
export function cleanBookingFieldValue(id: BookingFieldId, value: string): string | null {
  switch (id) {
    case "animal_name":
      return cleanAnimalName(value);
    case "animal_species":
      return cleanAnimalSpecies(value);
    default:
      return value;
  }
}

/** A kept value as the practice reads it: a species capitalised ("Small mammal", "Other: ferret"), anything else as kept. */
export function bookingFieldValueLabel(id: string, value: string): string {
  return id === "animal_species" && value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export type CollectedFieldRow = { id: string; label: string; value: string };

/**
 * A request's collected fields as the practice reads them: catalogue order,
 * each under its label in the practice's words (bookingFieldLabel), and a
 * species capitalised. An id the catalogue no longer knows keeps its value
 * under its own id, spaced out, after the rest, so a stale row still shows
 * what was collected. The desk page uses it, and the portal's Bookings
 * screen should.
 */
export function collectedFieldRows(
  collected: Readonly<Record<string, string>>,
  audience: Audience,
): CollectedFieldRow[] {
  const known: CollectedFieldRow[] = [];
  for (const field of BOOKING_FIELDS) {
    const value = collected[field.id];
    if (typeof value !== "string" || !value) continue;
    known.push({ id: field.id, label: bookingFieldLabel(field, audience), value: bookingFieldValueLabel(field.id, value) });
  }
  const rest = Object.entries(collected)
    .filter(([id, value]) => !isBookingFieldId(id) && typeof value === "string" && value)
    .map(([id, value]) => ({ id, label: id.replace(/_/g, " "), value }));
  return [...known, ...rest];
}
