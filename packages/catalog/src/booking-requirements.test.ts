import { describe, expect, test } from "vitest";

import {
  BOOKING_FIELDS,
  EXCLUDED_FIELDS,
  isBookingFieldId,
  metaEligible,
  resolveBookingRequirements,
  SPECIALTY_BOOKING_DEFAULTS,
  type BookingFieldId,
} from "./booking-requirements";
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
      expect(field.channels, field.id).toContain("callback");
    }
    expect(ids(metaEligible(resolveBookingRequirements("dental", null)))).toEqual(LOCKED);
  });

  test("ids are unique and isBookingFieldId is the catalogue's membership test", () => {
    expect(new Set(ids([...BOOKING_FIELDS])).size).toBe(BOOKING_FIELDS.length);
    expect(BOOKING_FIELDS).toHaveLength(9);
    for (const field of BOOKING_FIELDS) expect(isBookingFieldId(field.id)).toBe(true);
    expect(isBookingFieldId("email")).toBe(false);
    expect(isBookingFieldId("referral_source")).toBe(false);
    expect(isBookingFieldId(42)).toBe(false);
    expect(isBookingFieldId(null)).toBe(false);
  });
});
