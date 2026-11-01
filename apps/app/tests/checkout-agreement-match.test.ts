import {
  agreementTemplateReleased,
  BAA_TEMPLATES,
  CURRENT_BAA_VERSION,
  DPA_TEMPLATES,
  currentDpaTemplate,
  specialties,
  type AgreementMatchPurchase,
} from "@healdesk/catalog";
import { afterEach, describe, expect, test } from "vitest";

import { agreementTemplateReleased as hostReleased } from "@/lib/agreements/kind";
import { agreementMismatch as mismatchOf } from "@/lib/checkout/intents";

/**
 * Standing in for the go-live floor as it stood before 1.3.0's release, which
 * raised it past 1.2.2 (owner, 12 October 2026): a version in
 * `floor.restored` is one isBaaVersionAcceptable accepts again, so the rule
 * for a document before 1.3.0 can still be read. Every other test reads the
 * real floor, under which a 1.2.2 signature is refused.
 */
const floor = { restored: [] as string[] };

/**
 * agreementMismatch, with the go-live floor as `floor` says. The rule is the
 * catalog's since 14 October 2026, which calls its own release gate, so the
 * stand-in is passed rather than mocked into the module.
 */
function agreementMismatch(version: string, variables: unknown, purchase: AgreementMatchPurchase): string | null {
  return mismatchOf(version, variables, purchase, {
    released: (v) => agreementTemplateReleased(v) || floor.restored.includes(v),
  });
}

afterEach(() => {
  floor.restored = [];
});

test("this host's release gate and the catalog's agree on every version the catalogue knows", () => {
  const versions = [
    ...BAA_TEMPLATES.map((t) => t.version),
    ...DPA_TEMPLATES.map((t) => t.version),
    "9.9.9",
    "dpa/9.9.9",
  ];
  for (const version of versions) {
    expect(hostReleased(version), version).toBe(agreementTemplateReleased(version));
  }
});

/**
 * Whether a signed agreement is the document a purchase describes (plan Part
 * A4), checked by apps/app before anyone pays: the template may be put in
 * force, its kind covers the practice, and every answer that names or
 * selects it is the one signed. The browser compares the same answers to
 * decide whether a signature still holds; this is the comparison a changed
 * request cannot skip. apps/web asks it at Pay, against the agreement record,
 * and tests/checkout-purchase.test.ts runs it through the import against real
 * signatures; this reads each rule on its own.
 */

const nameOf = (id: string) => specialties.find((s) => s.id === id)!.name;

/**
 * A 1.2.2 Business Associate Agreement's variables, as signAgreement stores
 * them: signed before 1.3.0 replaced it, naming the picker's platform and no
 * calendar answer.
 */
const BAA_122 = {
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

/**
 * A current one (1.5.1 since 19 October 2026, 1.5.0, 1.4.0 and 1.3.0 before it): it names the
 * booking system, and carries both calendar answers beside the variant.
 */
const BAA = {
  ...BAA_122,
  connectedPlatform: "Calendly",
  bookingSystem: "calendly",
  calendarAccount: "workspace_baa",
  appliedClauses: ["practice-status", "google-calendar-covered"],
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
    expect(CURRENT_BAA_VERSION).toBe("1.7.0");
    expect(agreementMismatch(CURRENT_BAA_VERSION, BAA, PURCHASE)).toBeNull();
    // 1.2.2 too, while the floor admits it (below, it no longer does).
    floor.restored = ["1.2.2"];
    expect(agreementMismatch("1.2.2", BAA_122, PURCHASE)).toBeNull();
    floor.restored = [];
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
    // Read under the floor as it stood before 1.3.0's release; under the real
    // one a 1.2.2 signature is refused before any answer is compared.
    floor.restored = ["1.2.2"];
    expect(
      agreementMismatch("1.2.2", BAA_122, {
        ...PURCHASE,
        bookingSystem: "mindbody",
        platform: "mindbody",
      }),
    ).toMatch(/different booking system/);
    expect(
      agreementMismatch(
        "1.2.2",
        { ...BAA_122, connectedPlatform: "Mindbody" },
        { ...PURCHASE, bookingSystem: "mindbody", platform: "mindbody" },
      ),
    ).toBeNull();
  });

  test("names another booking system or Google account (1.3.0, which reads both)", () => {
    for (const changed of [
      { bookingSystem: "mindbody", platform: "mindbody" },
      { calendarAccount: "personal" },
    ] as const) {
      expect(
        agreementMismatch(CURRENT_BAA_VERSION, BAA, { ...PURCHASE, ...changed }),
        JSON.stringify(changed),
      ).toMatch(/different booking system or Google account/);
    }
    // A 1.3.0 row without the answers it reads is no match for any purchase.
    expect(agreementMismatch(CURRENT_BAA_VERSION, BAA_122, PURCHASE)).toMatch(
      /different booking system or Google account/,
    );
  });

  test("is of a template that may not be put in force: a draft, a superseded release, or none we know", () => {
    // 1.2.2 among them since 1.3.0 replaced it outright (12 October 2026),
    // 1.3.0 since 1.4.0 replaced it outright (13 October 2026), 1.4.0 since
    // 1.5.0 replaced it outright (14 October 2026), and 1.5.0 since 1.5.1
    // replaced it outright (19 October 2026).
    for (const version of ["1.5.0", "1.4.0", "1.3.0", "1.2.2", "1.2.1", "1.2.0", "1.1.0-draft", "1.0.0", "0.1.0-draft", "9.9.9"]) {
      expect(agreementMismatch(version, BAA_122, PURCHASE), version).toMatch(
        /can no longer be used/,
      );
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

  test("is accepted since its release (20 October 2026), and a DPA version nobody released is refused", () => {
    expect(currentDpaTemplate().approvedByCounsel).toBe(true);
    expect(agreementMismatch("dpa/1.0.0", DPA, PURCHASE)).toBeNull();
    expect(agreementMismatch("dpa/9.9.9", DPA, PURCHASE)).toMatch(/can no longer be used/);
  });

  test("released, the document as signed passes, for a practice outside HIPAA", () => {
    expect(agreementMismatch("dpa/1.0.0", DPA, PURCHASE)).toBeNull();
    expect(
      agreementMismatch(
        "dpa/1.0.0",
        { ...DPA, specialty: "veterinary" },
        { ...PURCHASE, specialty: "veterinary" },
      ),
    ).toBeNull();
  });

  test("released, it names the booking system and the Google account, and both must match", () => {
    expect(
      agreementMismatch("dpa/1.0.0", DPA, { ...PURCHASE, bookingSystem: "google_calendar" }),
    ).toMatch(/different booking system or Google account/);
    expect(
      agreementMismatch("dpa/1.0.0", DPA, { ...PURCHASE, calendarAccount: "personal" }),
    ).toMatch(/different booking system or Google account/);
  });

  test("released, it never covers a practice that bills insurance, or is not sure", () => {
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
