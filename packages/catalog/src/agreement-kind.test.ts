import { describe, expect, test } from "vitest";

import {
  agreementKindFor,
  asksCoveredQuestion,
  agreementKindOfVersion,
  COVERED_ANSWERS,
  DPA_VERSION_PREFIX,
  isAgreementKind,
  isCoveredAnswer,
  isDpaReleased,
  specialtyOffered,
  VETERINARY_READINESS,
  VETERINARY_READY,
  type CoveredAnswer,
} from "./agreement-kind";
import { audienceFor } from "./audience";
import { BAA_TEMPLATES } from "./baa";
import { currentDpaTemplate, DPA_TEMPLATES } from "./dpa";
import { specialties } from "./specialties";
import { findUrgentContent, URGENT_FAMILY_COUNT, urgentSetFor } from "./urgent-content";
import { fixedUrgentReply } from "./urgent-replies";

/**
 * Which agreement each practice signs, for every specialty and every answer,
 * before and after the owner releases the DPA (plan Part L).
 */

const ANSWERS: (CoveredAnswer | null)[] = [...COVERED_ANSWERS, null];

describe("agreementKindFor", () => {
  test("the DPA is released (owner, 20 October 2026), and its template's own flag is what says so", () => {
    expect(currentDpaTemplate().approvedByCounsel).toBe(true);
    expect(isDpaReleased()).toBe(currentDpaTemplate().approvedByCounsel);
    // Released, the defaults nothing overrides give a "No" practice and a vet the DPA.
    expect(agreementKindFor({ specialty: "med-spa", covered: "no" })).toEqual({
      ok: true,
      kind: "dpa",
      isCoveredEntity: false,
    });
    expect(agreementKindFor({ specialty: "veterinary", covered: null })).toEqual({
      ok: true,
      kind: "dpa",
      isCoveredEntity: false,
    });
    expect(specialtyOffered("veterinary")).toBe(true);
    // "Yes" and "Not sure" still sign the BAA.
    expect(agreementKindFor({ specialty: "med-spa", covered: "yes" })).toMatchObject({ kind: "baa" });
    expect(agreementKindFor({ specialty: "med-spa", covered: "not_sure" })).toMatchObject({ kind: "baa" });
  });

  test("a specialty HIPAA always reaches signs the BAA, whatever it answers", () => {
    for (const id of ["plastic-surgery", "fertility", "dental", "glp1"]) {
      for (const covered of ANSWERS) {
        for (const dpaReleased of [false, true]) {
          const choice = agreementKindFor({ specialty: id, covered, dpaReleased });
          expect(choice, `${id} ${covered}`).toMatchObject({ ok: true, kind: "baa" });
        }
      }
    }
  });

  test("a practice HIPAA reaches only if covered signs the DPA on No, once it is released", () => {
    for (const id of ["med-spa", "hair-restoration", "massage-chiro"]) {
      expect(agreementKindFor({ specialty: id, covered: "yes", dpaReleased: true })).toEqual({
        ok: true,
        kind: "baa",
        isCoveredEntity: true,
      });
      // "Not sure" signs the BAA: the safe default until it is determined.
      expect(agreementKindFor({ specialty: id, covered: "not_sure", dpaReleased: true })).toEqual({
        ok: true,
        kind: "baa",
        isCoveredEntity: null,
      });
      expect(agreementKindFor({ specialty: id, covered: "no", dpaReleased: true })).toEqual({
        ok: true,
        kind: "dpa",
        isCoveredEntity: false,
      });
      // Before the release, No signs the BAA, as it always has.
      expect(agreementKindFor({ specialty: id, covered: "no", dpaReleased: false })).toEqual({
        ok: true,
        kind: "baa",
        isCoveredEntity: false,
      });
    }
  });

  test("a veterinary practice signs the DPA unasked, and cannot buy before it is released", () => {
    expect(asksCoveredQuestion("veterinary")).toBe(false);
    for (const covered of ANSWERS) {
      expect(agreementKindFor({ specialty: "veterinary", covered, dpaReleased: true })).toEqual({
        ok: true,
        kind: "dpa",
        isCoveredEntity: false,
      });
      expect(agreementKindFor({ specialty: "veterinary", covered, dpaReleased: false })).toEqual({
        ok: false,
        reason: "dpa_not_released",
      });
    }
    expect(specialtyOffered("veterinary", false)).toBe(false);
    // Released, a vet is offered once the product is ready for it (VETERINARY_READY), which it now is.
    expect(specialtyOffered("veterinary", true)).toBe(true);
    expect(specialtyOffered("veterinary", true, false)).toBe(false);
    expect(specialtyOffered("veterinary", true, true)).toBe(true);
  });

  test("a veterinary practice is offered only with the DPA released AND the product ready for it", () => {
    expect(specialtyOffered("veterinary", true, true)).toBe(true);
    expect(specialtyOffered("veterinary", true, false)).toBe(false);
    expect(specialtyOffered("veterinary", false, true)).toBe(false);
    // Readiness never gates a practice HIPAA can reach.
    for (const s of specialties.filter((s) => s.id !== "veterinary")) {
      expect(specialtyOffered(s.id, false, false), s.id).toBe(true);
    }
  });

  test("every other specialty is asked the question and offered", () => {
    for (const s of specialties.filter((s) => s.id !== "veterinary")) {
      expect(asksCoveredQuestion(s.id), s.id).toBe(true);
      expect(specialtyOffered(s.id, false), s.id).toBe(true);
    }
  });

  test("a stored version says which kind it is: dpa/ is a DPA, anything else a BAA", () => {
    for (const t of DPA_TEMPLATES) {
      expect(t.version.startsWith(DPA_VERSION_PREFIX), t.version).toBe(true);
      expect(agreementKindOfVersion(t.version)).toBe("dpa");
    }
    for (const t of BAA_TEMPLATES) {
      expect(agreementKindOfVersion(t.version), t.version).toBe("baa");
    }
    expect(isAgreementKind("dpa")).toBe(true);
    expect(isAgreementKind("DPA")).toBe(false);
  });

  test("an unknown specialty is refused, never defaulted", () => {
    expect(agreementKindFor({ specialty: "astrology", covered: "yes" })).toEqual({
      ok: false,
      reason: "unknown_specialty",
    });
    expect(isCoveredAnswer("maybe")).toBe(false);
    expect(isCoveredAnswer("not_sure")).toBe(true);
  });
});

describe("veterinary readiness", () => {
  // Each item names the thing that must exist before a vet can buy, and is
  // true only because it does: these hold each one to its substance.
  test("the gate is exactly these items, all in place since package B's vet practice cases; the DPA's release decides with them", () => {
    expect(VETERINARY_READINESS).toEqual({
      urgentSet: true,
      referralNumber: true,
      clientWording: true,
      vetPracticeCases: true,
    });
    expect(VETERINARY_READY).toBe(true);
    // The DPA's flag stays the owner's, who released it on 20 October 2026:
    // with the readiness above, a vet is offered; without the release, none is.
    expect(isDpaReleased()).toBe(true);
    expect(specialtyOffered("veterinary")).toBe(true);
    expect(specialtyOffered("veterinary", false)).toBe(false);
    expect(specialtyOffered("veterinary", true)).toBe(true);
  });

  test("urgentSet: a veterinary practice is screened with its own set, which an animal's emergency trips", () => {
    expect(urgentSetFor("veterinary")).toBe("veterinary");
    expect(URGENT_FAMILY_COUNT.veterinary).toBeGreaterThan(0);
    expect(findUrgentContent("my dog ate a whole bar of chocolate", "veterinary")).toMatchObject({ emergency: "veterinary" });
    // And it tells a person's emergency from an animal's.
    expect(findUrgentContent("my husband collapsed", "veterinary")).toMatchObject({ emergency: "911" });
    expect(findUrgentContent("my dog ate a whole bar of chocolate")).toBeNull();
  });

  test("referralNumber: the veterinary reply gives the emergency referral number first, and 911 only for a person", () => {
    const reply = fixedUrgentReply({
      channel: "web_chat",
      emergency: "veterinary",
      clinicName: "Paws",
      clinicNumber: "(415) 555-0123",
      referralNumber: "(415) 555-0911",
      clinicOpen: false,
      teamAlerted: false,
    });
    expect(reply).toContain("(415) 555-0911");
    expect(reply.indexOf("(415) 555-0911")).toBeLessThan(reply.indexOf("If a person is hurt or in danger, call 911 now."));
  });

  test("clientWording: a veterinary practice's people are clients", () => {
    expect(audienceFor("veterinary")).toBe("clients");
  });
});
