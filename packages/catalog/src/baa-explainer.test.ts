import { describe, expect, test } from "vitest";

import { currentBaaTemplate, getBaaTemplate } from "./baa";
import { BAA_CLAUSE_EXPLAINERS } from "./baa-explainer";

/**
 * The notes the signing screen shows beside a clause, looked up by clause id
 * (AgreementStep in apps/web). A note whose id the current template lacks is
 * never shown, and a clause reworded without one leaves the signer only the
 * legal text for exactly the sentences that changed. Whether each note is
 * true to its clause is read, not tested; these pin that the two line up.
 */
describe("the clause notes", () => {
  test("every note belongs to a clause of the current version", () => {
    const ids = currentBaaTemplate().clauses.map((clause) => clause.id);
    for (const id of Object.keys(BAA_CLAUSE_EXPLAINERS)) {
      expect(ids, id).toContain(id);
    }
  });

  test("every clause 1.3.0 added or reworded has one", () => {
    // 1.3.0 reuses 1.2.1's clause objects by lookup; a new object is a new
    // or reworded clause.
    const previous = getBaaTemplate("1.2.1")!.clauses;
    const changed = getBaaTemplate("1.3.0")!
      .clauses.filter((clause) => !previous.includes(clause))
      .map((clause) => clause.id);
    expect(changed).toEqual([
      "data-sources-none",
      "payments",
      "own-use",
      "safeguards",
      "acting-in-your-place",
      "term",
      "state-privacy-law",
    ]);
    for (const id of changed) {
      expect(Object.keys(BAA_CLAUSE_EXPLAINERS), id).toContain(id);
    }
  });

  test("each note reads as one plain passage with a citation that fits a phone", () => {
    for (const [id, note] of Object.entries(BAA_CLAUSE_EXPLAINERS)) {
      expect(note.plain.length, id).toBeGreaterThan(40);
      // The screen renders "Heading: note citation", so no closing full stop.
      expect(note.plain, id).not.toMatch(/\.$/);
      // The citation is drawn as one unbreakable run (whitespace-nowrap), so a
      // long one would push the page sideways at phone width.
      expect(note.citation.length, id).toBeLessThanOrEqual(45);
    }
  });
});
