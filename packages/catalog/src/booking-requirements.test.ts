import { describe, expect, test } from "vitest";

import {
  ANIMAL_SPECIES,
  BOOKING_FIELDS,
  bookingFieldLabel,
  bookingFieldsFor,
  cleanAnimalName,
  cleanAnimalSpecies,
  cleanBookingFieldValue,
  collectedFieldRows,
  EXCLUDED_FIELDS,
  isBookingFieldId,
  metaEligible,
  resolveBookingRequirements,
  SPECIALTY_BOOKING_DEFAULTS,
  type BookingFieldId,
} from "./booking-requirements";
import { audienceFor } from "./audience";
import { findClinicalContent } from "./clinical-content";
import { isSpecialtyId, specialties } from "./specialties";

const LOCKED: BookingFieldId[] = ["first_name", "phone", "preferred_window", "alternative_windows"];
const ids = (fields: { id: string }[]) => fields.map((f) => f.id);

describe("the booking-requirements catalogue", () => {
  test("the locked four are always present, in catalogue order, whatever was stored", () => {
    for (const [specialty, stored] of [
      ["med-spa", null],
      ["med-spa", []],
      ["dental", ["last_name"]],
      ["not-a-specialty", null],
      ["not-a-specialty", ["service"]],
    ] as const) {
      const resolved = ids(resolveBookingRequirements(specialty, stored ? [...stored] : null));
      expect(resolved.slice(0, 4), `${specialty} / ${JSON.stringify(stored)}`).toEqual(LOCKED);
    }
    // An empty stored list means "the locked four and nothing else".
    expect(ids(resolveBookingRequirements("med-spa", []))).toEqual(LOCKED);
    // An unknown specialty has no defaults to fall back on.
    expect(ids(resolveBookingRequirements("not-a-specialty", null))).toEqual(LOCKED);
  });

  test("unknown ids are dropped, not thrown on, and cannot smuggle an excluded field in", () => {
    const resolved = ids(resolveBookingRequirements("med-spa", ["email", "date_of_birth", "service", "referral_source"]));
    expect(resolved).toEqual([...LOCKED, "service"]);
  });

  test("a stored list replaces the specialty defaults rather than adding to them", () => {
    expect(ids(resolveBookingRequirements("dental", null))).toEqual([
      ...LOCKED,
      "last_name",
      "new_or_existing",
      "consult_or_treatment",
    ]);
    expect(ids(resolveBookingRequirements("dental", ["service"]))).toEqual([...LOCKED, "service"]);
  });

  test("every defaults key is a real SpecialtyId, every specialty has defaults, and every default is an optional catalogue id", () => {
    const keys = Object.keys(SPECIALTY_BOOKING_DEFAULTS);
    for (const key of keys) expect(isSpecialtyId(key), key).toBe(true);
    for (const s of specialties) expect(keys, s.id).toContain(s.id);
    for (const [specialty, defaults] of Object.entries(SPECIALTY_BOOKING_DEFAULTS)) {
      for (const id of defaults) {
        const field = BOOKING_FIELDS.find((f) => f.id === id);
        expect(field, `${specialty}: ${id}`).toBeDefined();
        // The locked four are implied; listing one would suggest it is optional.
        expect(field!.locked, `${specialty}: ${id} is locked and need not be a default`).toBe(false);
        // And it is a field the specialty may collect at all: no animal field
        // in the defaults of a practice whose patients are people.
        expect(ids(bookingFieldsFor(specialty)), `${specialty}: ${id} is not offered to it`).toContain(id);
      }
    }
  });

  test("no `ask` promises a message, link or confirmation — nothing is sent to the person", () => {
    const promise = /\b(text|texts|sms|message|messages|link|email|e-mail|confirm\w*|remind\w*|call you|we'll|we will|send)\b/i;
    for (const field of BOOKING_FIELDS) {
      expect(field.ask, field.id).not.toMatch(promise);
    }
  });

  test("no field id or label resembles an excluded term", () => {
    // Stems of EXCLUDED_FIELDS, plus the aliases a well-meaning edit would reach for.
    const stems = [
      "birth", "dob", "age", "insurance", "member", "medical", "history", "condition", "medication",
      "pregnan", "breastfeed", "reason", "photo", "image", "payment", "card", "address", "email", "e-mail",
      "heard", "referral", "source", "marketing",
    ];
    for (const field of BOOKING_FIELDS) {
      const haystacks = [field.id.replace(/_/g, " "), field.label.toLowerCase()];
      for (const stem of stems) {
        for (const text of haystacks) {
          expect(new RegExp(`\\b${stem}`).test(text), `${field.id}: "${text}" resembles "${stem}"`).toBe(false);
        }
      }
    }
    // The list itself is what the setup page prints; keep it non-empty and distinct.
    expect(new Set(EXCLUDED_FIELDS).size).toBe(EXCLUDED_FIELDS.length);
    expect(EXCLUDED_FIELDS.length).toBeGreaterThan(0);
  });

  test("nothing in the catalogue trips the clinical-content guard", () => {
    const fields: Record<string, string> = {};
    for (const f of BOOKING_FIELDS) {
      fields[`${f.id}.label`] = f.label;
      fields[`${f.id}.ask`] = f.ask;
    }
    expect(findClinicalContent(fields)).toEqual([]);
  });

  test("the Meta-eligible set is exactly the locked four, and channels agree", () => {
    expect(ids(metaEligible([...BOOKING_FIELDS]))).toEqual(LOCKED);
    for (const field of BOOKING_FIELDS) {
      expect(field.metaEligible, field.id).toBe(field.locked);
      expect(field.channels.includes("meta"), field.id).toBe(field.metaEligible);
      expect(field.channels, field.id).toContain("voice");
      // Inbound only: no field is asked on a call healdesk places.
      expect(field.channels as string[], field.id).not.toContain("callback");
    }
    expect(ids(metaEligible(resolveBookingRequirements("dental", null)))).toEqual(LOCKED);
  });

  test("ids are unique and isBookingFieldId is the catalogue's membership test", () => {
    expect(new Set(ids([...BOOKING_FIELDS])).size).toBe(BOOKING_FIELDS.length);
    expect(BOOKING_FIELDS).toHaveLength(11);
    for (const field of BOOKING_FIELDS) expect(isBookingFieldId(field.id)).toBe(true);
    expect(isBookingFieldId("email")).toBe(false);
    expect(isBookingFieldId("referral_source")).toBe(false);
    expect(isBookingFieldId(42)).toBe(false);
    expect(isBookingFieldId(null)).toBe(false);
  });
});

const ANIMAL: BookingFieldId[] = ["animal_name", "animal_species"];

describe("the animal's name and species (a veterinary booking, 6 October 2026)", () => {
  test("the veterinary defaults include both, and provisioning's NULL resolves to them", () => {
    expect(SPECIALTY_BOOKING_DEFAULTS.veterinary).toEqual(expect.arrayContaining(ANIMAL));
    // seed.ts stamps booking_requirements = NULL at provisioning: the defaults.
    expect(ids(resolveBookingRequirements("veterinary", null))).toEqual([...LOCKED, "last_name", "service", ...ANIMAL]);
  });

  test("only a practice that cares for animals is offered them, resolves them, or keeps them from a stored list", () => {
    for (const s of specialties) {
      const offered = ids(bookingFieldsFor(s.id));
      const resolved = ids(resolveBookingRequirements(s.id, [...ANIMAL, "service"]));
      const vet = audienceFor(s.id) === "clients";
      for (const id of ANIMAL) {
        expect(offered.includes(id), `${s.id} offered ${id}`).toBe(vet);
        expect(resolved.includes(id), `${s.id} resolved ${id}`).toBe(vet);
      }
      if (!vet) expect(ids(resolveBookingRequirements(s.id, null)).some((id) => ANIMAL.includes(id as BookingFieldId))).toBe(false);
    }
    expect(ids(bookingFieldsFor("not-a-specialty")).some((id) => ANIMAL.includes(id as BookingFieldId))).toBe(false);
    expect(ids(bookingFieldsFor(null))).toHaveLength(9);
  });

  test("neither is Meta-eligible: a vet's Meta thread asks for the locked four and nothing else", () => {
    for (const id of ANIMAL) {
      const field = BOOKING_FIELDS.find((f) => f.id === id)!;
      expect(field.metaEligible, id).toBe(false);
      expect(field.channels, id).not.toContain("meta");
      expect(field.forAnimals, id).toBe(true);
    }
    expect(ids(metaEligible(resolveBookingRequirements("veterinary", null)))).toEqual(LOCKED);
    expect(ids(metaEligible(resolveBookingRequirements("veterinary", [...ANIMAL])))).toEqual(LOCKED);
  });

  test("a name is letters, spaces, apostrophes and hyphens, at most 40 characters", () => {
    for (const name of ["Biscuit", "Mr Whiskers", "D'Artagnan", "Jean-Luc", "Señor Pickles", "  Rex  "]) {
      expect(cleanAnimalName(name), name).toBe(name.trim());
    }
    expect(cleanAnimalName("Sir   Barks")).toBe("Sir Barks");
    expect(cleanAnimalName("A".repeat(40))).toBe("A".repeat(40));
    for (const bad of ["A".repeat(41), "Rex2", "415 555 0192", "Rex, my dog", "Max!", "-Max", "", "   ", 7, null, undefined]) {
      expect(cleanAnimalName(bad), String(bad)).toBeNull();
    }
  });

  test("a clinical word in the name is refused by the default screen", () => {
    for (const name of ["Max allergic", "Bella pregnant", "Rex has an infection", "Milo symptoms", "Luna medication"]) {
      expect(findClinicalContent({ name }).length, name).toBeGreaterThan(0);
      expect(cleanAnimalName(name), name).toBeNull();
    }
  });

  test("a species is one of the closed list, or other with one short screened word", () => {
    for (const species of ANIMAL_SPECIES) expect(cleanAnimalSpecies(species), species).toBe(species);
    expect(cleanAnimalSpecies("Dog")).toBe("dog");
    expect(cleanAnimalSpecies("  CAT ")).toBe("cat");
    expect(cleanAnimalSpecies("Small-Mammal")).toBe("small mammal");
    expect(cleanAnimalSpecies("small_mammal")).toBe("small mammal");
    for (const other of ["other: ferret", "Other - ferret", "other (ferret)", "other, ferret", "other ferret"]) {
      expect(cleanAnimalSpecies(other), other).toBe("other: ferret");
    }
    expect(cleanAnimalSpecies("other: guinea-pig")).toBe("other: guinea-pig");
    // A listed animal written as "other" is kept as the list's own.
    expect(cleanAnimalSpecies("other: dog")).toBe("dog");
  });

  test("an unknown species, a sentence, a long word or a clinical word is refused", () => {
    for (const bad of [
      "dragon",
      "ferret",
      "my dog Rex",
      "dog with an infection",
      "other: two words",
      "other: " + "x".repeat(21),
      "other: allergic",
      "other: 42",
      "other:",
      "",
      42,
      null,
    ]) {
      expect(cleanAnimalSpecies(bad), String(bad)).toBeNull();
    }
  });

  test("cleanBookingFieldValue applies each field's own rule and leaves the others as given", () => {
    expect(cleanBookingFieldValue("animal_name", "Biscuit")).toBe("Biscuit");
    expect(cleanBookingFieldValue("animal_name", "Max allergic")).toBeNull();
    expect(cleanBookingFieldValue("animal_species", "Rabbit")).toBe("rabbit");
    expect(cleanBookingFieldValue("animal_species", "dragon")).toBeNull();
    expect(cleanBookingFieldValue("last_name", "O'Brien 2nd")).toBe("O'Brien 2nd");
  });

  test("the display: catalogue order, the practice's own words, a species capitalised", () => {
    const rows = collectedFieldRows(
      { animal_species: "small mammal", new_or_existing: "returning", animal_name: "Biscuit", legacy_field: "x" },
      "clients",
    );
    expect(rows).toEqual([
      { id: "new_or_existing", label: "New or returning client", value: "returning" },
      { id: "animal_name", label: "Animal's name", value: "Biscuit" },
      { id: "animal_species", label: "Species", value: "Small mammal" },
      { id: "legacy_field", label: "legacy field", value: "x" },
    ]);
    expect(collectedFieldRows({ animal_species: "other: ferret" }, "clients")).toEqual([
      { id: "animal_species", label: "Species", value: "Other: ferret" },
    ]);
    const returning = BOOKING_FIELDS.find((f) => f.id === "new_or_existing")!;
    expect(bookingFieldLabel(returning, "patients")).toBe("New or returning patient");
    expect(bookingFieldLabel(returning, "clients")).toBe("New or returning client");
    // No label a vet reads calls its customers patients.
    for (const field of bookingFieldsFor("veterinary")) {
      expect(bookingFieldLabel(field, "clients"), field.id).not.toMatch(/patient/i);
    }
  });
});
