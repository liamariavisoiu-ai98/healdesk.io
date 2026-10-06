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
  type CoveredAnswer,
} from "./agreement-kind";
import { BAA_TEMPLATES } from "./baa";
import { currentDpaTemplate, DPA_TEMPLATES } from "./dpa";
import { specialties } from "./specialties";

/**
 * Which agreement each practice signs, for every specialty and every answer,
 * before and after the owner releases the DPA (plan Part L).
 */

const ANSWERS: (CoveredAnswer | null)[] = [...COVERED_ANSWERS, null];

describe("agreementKindFor", () => {
  test("the DPA is not released yet, and its template's own flag is what says so", () => {
    expect(currentDpaTemplate().approvedByCounsel).toBe(false);
    expect(isDpaReleased()).toBe(currentDpaTemplate().approvedByCounsel);
    // Unreleased, the defaults nothing overrides offer no DPA to anyone.
    expect(agreementKindFor({ specialty: "med-spa", covered: "no" })).toMatchObject({ kind: "baa" });
    expect(agreementKindFor({ specialty: "veterinary", covered: null })).toEqual({
      ok: false,
      reason: "dpa_not_released",
    });
    expect(specialtyOffered("veterinary")).toBe(false);
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
    expect(specialtyOffered("veterinary", true)).toBe(true);
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
