import { describe, expect, test } from "vitest";

import { agreementClaim, BAA_CLAIM, DPA_SAFEGUARDS_LINE } from "./agreement-claim";
import { DPA_EXPLAINER } from "./dpa-explainer";

/**
 * The sentence copy says about the agreement healdesk signs. A practice under
 * the BAA keeps the spec's line; one under the Data Protection Agreement is
 * never told healdesk signs a business associate agreement with it, and a vet
 * is never told its people are patients.
 */
describe("the agreement claim", () => {
  test("a practice under the BAA, or none recorded, gets the spec's line, word for word", () => {
    expect(BAA_CLAIM).toBe("We sign a business associate agreement and handle patient data under it");
    for (const kind of ["baa", null] as const) {
      for (const audience of ["patients", "clients"] as const) {
        expect(agreementClaim(kind, audience)).toBe(BAA_CLAIM);
      }
    }
  });

  test("a practice under the DPA is told of the data protection agreement, in its own word for its people", () => {
    expect(agreementClaim("dpa", "clients")).toBe(
      "We sign a data protection agreement and handle your clients' information under it",
    );
    expect(agreementClaim("dpa", "patients")).toBe(
      "We sign a data protection agreement and handle your patients' information under it",
    );
    expect(agreementClaim("dpa", "clients")).not.toMatch(/patient|business associate|HIPAA/i);
  });

  test("the safeguards line is the DPA explainer's own paraphrase, and claims no compliance", () => {
    const explained = DPA_EXPLAINER.terms.map((t) => t.plain);
    expect(explained).toContain(
      "Protect it with the safeguards healdesk uses where HIPAA does apply, the HIPAA Security Rule's included",
    );
    expect(DPA_SAFEGUARDS_LINE).toContain("the safeguards it uses where HIPAA does apply, the HIPAA Security Rule's included");
    expect(DPA_SAFEGUARDS_LINE).not.toMatch(/compliant|certified/i);
  });
});
