import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY } from "./agreement-copy";
import { agreementKindFor, COVERED_ANSWERS, type CoveredAnswer } from "./agreement-kind";
import { audienceFor, audienceSingular } from "./audience";
import { assentSentence, BAA_ACTION_LABEL, BAA_ASSENT_LABEL, CURRENT_BAA_VERSION } from "./baa";
import {
  BAA_CLAUSE_EXPLAINERS,
  BAA_EXPLAINER,
  baaExplainerTerms,
  clauseExplainer,
} from "./baa-explainer";
import { CALENDAR_CLAUSE_IDS } from "./calendar-terms";
import {
  CURRENT_DPA_VERSION,
  currentDpaTemplate,
  DPA_ACTION_LABEL,
  DPA_ASSENT_LABEL,
  dpaAssentSentence,
  prepareDpa,
} from "./dpa";
import { DPA_CLAUSE_EXPLAINERS, DPA_EXPLAINER, dpaClauseExplainer } from "./dpa-explainer";
import { specialties } from "./specialties";

/** Every string a copy object holds, flattened, for "never says" checks. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("AGREEMENT_COPY", () => {
  test("the BAA's copy is exactly what the signing screen shows today", () => {
    const baa = AGREEMENT_COPY.baa;
    expect(baa.kind).toBe("baa");
    expect(baa.title).toBe("Business Associate Agreement");
    expect(baa.currentVersion).toBe(CURRENT_BAA_VERSION);
    // 1.2.2, the version signed until 1.3.0's release, shows BAA_EXPLAINER, bullets and all, as 1.2.1 did.
    expect(baa.explainer("1.2.2")).toBe(BAA_EXPLAINER);
    expect(baa.explainer("1.2.2").terms).toBe(BAA_EXPLAINER.terms);
    expect(baa.explainer("1.2.1")).toBe(BAA_EXPLAINER);
    // 1.5.1, the current version since its release on 19 October 2026, shows
    // 1.3.0's own bullets (the next test), as 1.4.0 and 1.5.0 did: its Term clause is 1.3.0's.
    expect(baa.currentVersion).toBe("1.5.1");
    expect(baa.explainer(baa.currentVersion).terms).toBe(baa.explainer("1.3.0").terms);
    expect(baa.explainer(baa.currentVersion)).not.toBe(BAA_EXPLAINER);
    expect(baa.clauseNote).toBe(clauseExplainer);
    expect(baa.assentLabel).toBe(BAA_ASSENT_LABEL);
    expect(baa.assentSentence).toBe(assentSentence);
    expect(baa.actionLabel).toBe(BAA_ACTION_LABEL);
  });

  test("the explainer is read by the version rendered: 1.3.0's bullets above 1.3.0 (gate 11)", () => {
    const baa = AGREEMENT_COPY.baa;
    const explainer = baa.explainer("1.3.0");
    expect(explainer.terms).toBe(baaExplainerTerms("1.3.0"));
    expect(explainer.terms).not.toEqual(BAA_EXPLAINER.terms);
    const { terms: _shared, ...frame } = BAA_EXPLAINER;
    const { terms: _own, ...own } = explainer;
    expect(own).toEqual(frame);
    // The two bullets the audit found narrower than 1.3.0's clause (HRC-03, HRC-07).
    const plain = explainer.terms.map((t) => t.plain).join("\n");
    expect(plain).not.toMatch(/use it only|materially breach/);
    expect(plain).toContain("limit its use and disclosure");
    expect(plain).toContain("if you determine that we have violated a material term of it");
  });

  test("the DPA's copy is its own, and BAA_EXPLAINER never appears beside a DPA", () => {
    const dpa = AGREEMENT_COPY.dpa;
    expect(dpa.kind).toBe("dpa");
    expect(dpa.title).toBe("Data Protection Agreement");
    expect(dpa.currentVersion).toBe(CURRENT_DPA_VERSION);
    expect(dpa.explainer(CURRENT_DPA_VERSION)).toBe(DPA_EXPLAINER);
    for (const version of [CURRENT_DPA_VERSION, "1.2.1", "1.3.0"]) {
      expect(dpa.explainer(version), version).not.toBe(BAA_EXPLAINER);
    }
    expect(dpa.assentLabel).toBe(DPA_ASSENT_LABEL);
    expect(dpa.assentSentence).toBe(dpaAssentSentence);
    expect(dpa.actionLabel).toBe(DPA_ACTION_LABEL);

    // The heading is the same three words; everything said under it is the DPA's own.
    expect(DPA_EXPLAINER.heading).toBe(BAA_EXPLAINER.heading);
    const { heading: _baaHeading, ...baaBody } = BAA_EXPLAINER;
    const { heading: _dpaHeading, ...dpaBody } = DPA_EXPLAINER;
    const baaWords = new Set(strings(baaBody));
    for (const text of strings(dpaBody)) {
      expect(baaWords.has(text), text).toBe(false);
      // Nothing cited to the rule that requires a BAA, and no person called a patient.
      expect(text, text).not.toMatch(/164\.5\d\d|Business Associate Agreement|\bpatients?\b/);
    }
    expect(dpa.assentSentence("Golden Paws LLC")).not.toMatch(/Business Associate/);
  });

  test("a DPA clause note is the DPA's, cites the DPA, and exists only for a clause the version carries", () => {
    const template = currentDpaTemplate();
    for (const clause of template.clauses) {
      const note = AGREEMENT_COPY.dpa.clauseNote(CURRENT_DPA_VERSION, clause.id);
      if (!note) continue;
      expect(note, clause.id).toBe(DPA_CLAUSE_EXPLAINERS[clause.id]);
      expect(note.citation, clause.id).toMatch(/^“.+”$/);
      expect(note.citation, clause.id).not.toMatch(/164\./);
      expect(note.plain, clause.id).not.toMatch(/\bpatients?\b/);
    }
    for (const id of Object.keys(DPA_CLAUSE_EXPLAINERS)) {
      expect(
        template.clauses.some((c) => c.id === id),
        id,
      ).toBe(true);
    }
    // The calendar notes are the BAA's words about the same clause.
    for (const id of Object.values(CALENDAR_CLAUSE_IDS)) {
      expect(dpaClauseExplainer(CURRENT_DPA_VERSION, id)?.plain).toBe(
        BAA_CLAUSE_EXPLAINERS[id].plain,
      );
    }
    expect(dpaClauseExplainer(CURRENT_DPA_VERSION, "toString")).toBeUndefined();
    expect(dpaClauseExplainer("1.2.1", "subcontractors")).toBeUndefined();
    expect(dpaClauseExplainer(CURRENT_DPA_VERSION, "subcontractors")?.plain).toContain(
      "at least 24 hours",
    );
  });

  test("every DPA note and bullet cites a heading the DPA prints, and says what its clause says", () => {
    const template = currentDpaTemplate();
    const headings = new Set(template.clauses.map((c) => `“${c.heading}”`));
    // A note cites the very clause it sits beside, by the heading that clause prints.
    for (const [id, note] of Object.entries(DPA_CLAUSE_EXPLAINERS)) {
      const clause = template.clauses.find((c) => c.id === id)!;
      expect(note.citation, id).toBe(`“${clause.heading}”`);
    }
    // A bullet cites one or more clauses, each by a heading the DPA prints.
    for (const term of DPA_EXPLAINER.terms) {
      const cited = term.citation.match(/“[^”]+”/g) ?? [];
      expect(cited.length, term.plain).toBeGreaterThan(0);
      for (const heading of cited) {
        expect(headings.has(heading), `${term.plain}: ${heading}`).toBe(true);
      }
    }
    const bullets = DPA_EXPLAINER.terms.map((t) => t.plain).join("\n");
    // The spec's 60-day rule and "without penalty", as the clauses now state them.
    expect(bullets).toContain(
      "Tell you of any misuse, security incident or breach without unreasonable delay, and in no case later than 60 calendar days after discovery",
    );
    expect(bullets).not.toMatch(/24 hours at most|immediately/);
    expect(bullets).not.toMatch(/five (business|calendar) days/);
    expect(bullets).toContain("so you can end the agreement without penalty if you object");
    expect(dpaClauseExplainer(CURRENT_DPA_VERSION, "subcontractors")?.plain).toContain(
      "the service ends with it, and fees you paid for the time after are refunded",
    );
    expect(dpaClauseExplainer(CURRENT_DPA_VERSION, "data-sources")?.plain).toContain(
      "the calendar clause, or a calendar election, describes",
    );
  });

  test("every practice the DPA would be chosen for can be given one", () => {
    for (const s of specialties) {
      for (const covered of [...COVERED_ANSWERS, null] as (CoveredAnswer | null)[]) {
        const choice = agreementKindFor({ specialty: s.id, covered, dpaReleased: true });
        if (!choice.ok || choice.kind !== "dpa") continue;
        expect(choice.isCoveredEntity, `${s.id} ${covered}`).toBe(false);
        expect(() =>
          prepareDpa(currentDpaTemplate(), {
            clinicLegalName: "A Practice LLC",
            signatoryName: "Alex Chen",
            signatoryEmail: "alex@practice.test",
            effectiveDate: "2026-10-06",
            specialty: s.id,
            bookingSystem: "none",
            calendarAccount: "personal",
          }),
        ).not.toThrow();
      }
    }
  });
});

describe("audienceFor", () => {
  test("clients at a veterinary practice, patients everywhere else", () => {
    expect(audienceFor("veterinary")).toBe("clients");
    for (const s of specialties.filter((s) => s.id !== "veterinary")) {
      expect(audienceFor(s.id), s.id).toBe("patients");
    }
    expect(audienceFor(null)).toBe("patients");
    expect(audienceFor(undefined)).toBe("patients");
    expect(audienceFor("astrology")).toBe("patients");
    expect(audienceFor("toString")).toBe("patients");
    expect(audienceSingular("clients")).toBe("client");
    expect(audienceSingular("patients")).toBe("patient");
  });
});
