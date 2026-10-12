import { CURRENT_BAA_VERSION, currentDpaTemplate, specialties } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { agreementMismatch } from "@/lib/checkout/intents";

/**
 * Whether a signed agreement is the document a purchase describes (plan Part
 * A4), checked by apps/app before anyone pays: the template may be put in
 * force, its kind covers the practice, and every answer that names or
 * selects it is the one signed. The browser compares the same answers to
 * decide whether a signature still holds; this is the comparison a changed
 * request cannot skip. tests/checkout-purchase.test.ts runs it through the
 * intents route against real signatures; this reads each rule on its own.
 */

const nameOf = (id: string) => specialties.find((s) => s.id === id)!.name;

/** A 1.2.2 Business Associate Agreement's variables, as signAgreement stores them. */
const BAA = {
  clinicLegalName: "Glow Med Spa LLC",
  signatoryName: "Laura Owner",
  signatoryEmail: "info@glowspa.test",
  effectiveDate: "2026-10-06",
  specialty: nameOf("med-spa"),
  isCoveredEntity: false,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: false,
  bookingMode: "desk_confirms",
  calendarWrite: null,
  appliedClauses: ["covered-entity-status"],
  displayedHashVerified: true,
};

/** The purchase that agreement was signed for. */
const PURCHASE = {
  clinicName: "Glow Med Spa LLC",
  specialty: "med-spa",
  platform: "none",
  isCoveredEntity: false,
  bookingSystem: "calendly",
  calendarAccount: "workspace_baa",
} as const;

describe("a Business Associate Agreement", () => {
  test("the document as signed, under the version being signed, passes", () => {
    expect(CURRENT_BAA_VERSION).toBe("1.2.2");
    expect(agreementMismatch(CURRENT_BAA_VERSION, BAA, PURCHASE)).toBeNull();
    // The name as signed: trimmed on both sides.
    expect(
      agreementMismatch(CURRENT_BAA_VERSION, BAA, {
        ...PURCHASE,
        clinicName: " Glow Med Spa LLC ",
      }),
    ).toBeNull();
  });

  test("names another practice", () => {
    expect(
      agreementMismatch(CURRENT_BAA_VERSION, BAA, { ...PURCHASE, clinicName: "Other Spa LLC" }),
    ).toMatch(/names a different practice/);
  });

  test("is for another specialty", () => {
    expect(
      agreementMismatch(CURRENT_BAA_VERSION, BAA, { ...PURCHASE, specialty: "dental" }),
    ).toMatch(/different kind of practice/);
  });

  test('records another covered-entity answer, "Not sure" included', () => {
    for (const isCoveredEntity of [true, null]) {
      expect(
        agreementMismatch(CURRENT_BAA_VERSION, BAA, { ...PURCHASE, isCoveredEntity }),
        String(isCoveredEntity),
      ).toMatch(/different answer about billing insurance/);
    }
    expect(
      agreementMismatch(
        CURRENT_BAA_VERSION,
        { ...BAA, isCoveredEntity: null },
        { ...PURCHASE, isCoveredEntity: null },
      ),
    ).toBeNull();
  });

  test("names another booking platform (before 1.3.0, the one the booking system implies)", () => {
    expect(
      agreementMismatch(CURRENT_BAA_VERSION, BAA, {
        ...PURCHASE,
        bookingSystem: "mindbody",
        platform: "mindbody",
      }),
    ).toMatch(/different booking system/);
    expect(
      agreementMismatch(
        CURRENT_BAA_VERSION,
        { ...BAA, connectedPlatform: "Mindbody" },
        { ...PURCHASE, bookingSystem: "mindbody", platform: "mindbody" },
      ),
    ).toBeNull();
  });

  test("is of a template that may not be put in force: a draft, a superseded release, or none we know", () => {
    for (const version of ["1.3.0", "1.2.0", "1.0.0", "0.1.0-draft", "9.9.9"]) {
      expect(agreementMismatch(version, BAA, PURCHASE), version).toMatch(/can no longer be used/);
    }
  });

  test("never covers a veterinary practice, which signs the data protection agreement", () => {
    expect(
      agreementMismatch(
        CURRENT_BAA_VERSION,
        { ...BAA, specialty: nameOf("veterinary") },
        { ...PURCHASE, specialty: "veterinary" },
      ),
    ).toMatch(/doesn't cover this practice/);
  });
});

describe("a Data Protection Agreement", () => {
  /** A dpa/1.0.0 acceptance's variables: the specialty by id, the calendar answers, no covered answer. */
  const DPA = {
    clinicLegalName: "Glow Med Spa LLC",
    signatoryName: "Laura Owner",
    signatoryEmail: "info@glowspa.test",
    effectiveDate: "2026-10-06",
    specialty: "med-spa",
    bookingSystem: "calendly",
    calendarAccount: "workspace_baa",
  };

  test("is refused while it is unreleased, whatever it says", () => {
    expect(currentDpaTemplate().approvedByCounsel).toBe(false);
    expect(agreementMismatch("dpa/1.0.0", DPA, PURCHASE)).toMatch(/can no longer be used/);
  });

  /**
   * Released (Gate A, the template's own flag), set here for this file's
   * module instance only and put back: what the checks do from the day the
   * owner releases it, which is also the first version to name the booking
   * system and the Google account.
   */
  function released(run: () => void) {
    const template = currentDpaTemplate() as { approvedByCounsel: boolean };
    template.approvedByCounsel = true;
    try {
      run();
    } finally {
      template.approvedByCounsel = false;
    }
  }

  test("once released, the document as signed passes, for a practice outside HIPAA", () => {
    released(() => {
      expect(agreementMismatch("dpa/1.0.0", DPA, PURCHASE)).toBeNull();
      expect(
        agreementMismatch(
          "dpa/1.0.0",
          { ...DPA, specialty: "veterinary" },
          { ...PURCHASE, specialty: "veterinary" },
        ),
      ).toBeNull();
    });
  });

  test("once released, names the booking system and the Google account, and both must match", () => {
    released(() => {
      expect(
        agreementMismatch("dpa/1.0.0", DPA, { ...PURCHASE, bookingSystem: "google_calendar" }),
      ).toMatch(/different booking system or Google account/);
      expect(
        agreementMismatch("dpa/1.0.0", DPA, { ...PURCHASE, calendarAccount: "personal" }),
      ).toMatch(/different booking system or Google account/);
    });
  });

  test("once released, never covers a practice that bills insurance, or is not sure", () => {
    released(() => {
      for (const isCoveredEntity of [true, null]) {
        expect(
          agreementMismatch("dpa/1.0.0", DPA, { ...PURCHASE, isCoveredEntity }),
          String(isCoveredEntity),
        ).toMatch(/doesn't cover this practice/);
      }
      // Nor a specialty HIPAA always reaches.
      expect(
        agreementMismatch(
          "dpa/1.0.0",
          { ...DPA, specialty: "dental" },
          { ...PURCHASE, specialty: "dental" },
        ),
      ).toMatch(/doesn't cover this practice/);
    });
  });
});
