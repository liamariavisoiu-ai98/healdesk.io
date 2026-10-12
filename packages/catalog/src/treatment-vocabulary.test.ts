import { describe, expect, test } from "vitest";

import { META_TREATMENT_VOCABULARY, namesMetaTreatment } from "./treatment-vocabulary";

describe("the Meta treatment vocabulary", () => {
  test("every entry is refused as written, and as a plural", () => {
    for (const entry of META_TREATMENT_VOCABULARY) {
      expect(namesMetaTreatment(`We offer ${entry} here.`), entry).toBe(true);
      expect(namesMetaTreatment(`Ask about our ${entry}s.`), `${entry}s`).toBe(true);
    }
  });

  test.each([
    "Yes, we do Botox.",
    "Our peels start from $120.",
    "We have two lasers.",
    "GLP-1 programs are available.",
    "We offer IV therapy on weekends.",
    "Ozempic and Wegovy are prescribed after a consult.",
    "Microneedling is popular.",
    "Hair restoration with PRP.",
    "Lip filler, cheek filler.",
    "Dysport or Xeomin.",
  ])("%s names a treatment", (text) => {
    expect(namesMetaTreatment(text)).toBe(true);
  });

  test.each([
    "We'd appeal to anyone who wants a quick call.",
    "Our team is happy to help.",
    "A detox from screens is good for everyone.",
    "The practice is open Monday to Friday.",
    "Thanks for reaching out! Call us on 415-555-0100.",
    "We're a friendly, independent clinic.",
    "Prices start from $450.",
    "Parking is available nearby.",
    "Our front desk can answer that.",
  ])("%s names none", (text) => {
    expect(namesMetaTreatment(text)).toBe(false);
  });
});
