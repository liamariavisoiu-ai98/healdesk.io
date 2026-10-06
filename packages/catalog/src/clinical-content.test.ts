import { describe, expect, test } from "vitest";

import { findClinicalContent, serviceNameScreen } from "./clinical-content";

describe("findClinicalContent and per-unit prices", () => {
  // The spec wants a menu price quoted exactly, and injectables are priced by
  // the unit or the ml. Those phrases must be storable.
  test.each([
    "Botox (per unit)",
    "$14 per unit",
    "Filler $650/ml",
    "Promotion: $2 off per unit this month",
  ])("lets the price notation %j through", (text) => {
    expect(findClinicalContent({ price: text })).toEqual([]);
  });

  // Only the "per" and "/" forms are exempt. A count of units is still dosing.
  test.each([
    "Dysport - 50 units",
    "20 units per area",
    "Lip filler 1 ml",
    "$14 per unit, typical dose 20 units",
  ])("still refuses dosing in %j", (text) => {
    const findings = findClinicalContent({ price: text });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ field: "price", label: "dosing" });
  });

  test("the exemption is for dosing only: a safety claim next to a unit price is caught", () => {
    const findings = findClinicalContent({ price: "$14 per unit, safe for everyone" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.label).toBe("a safety claim");
  });

  test("the excerpt quotes the original text, not the blanked copy", () => {
    const findings = findClinicalContent({ price: "$14 per unit, typical dose 20 units" });
    expect(findings[0]!.excerpt).toContain("dose");
    expect(findings[0]!.excerpt).toContain("per unit");
  });
});

describe("the claims screen, for a veterinary practice's service names", () => {
  // A vet's menu is written in the vocabulary of medicine, so the full screen
  // would refuse the menu itself.
  test.each([
    "Allergy testing",
    "Senior diagnostics",
    "Post-op check",
    "Heartworm medication",
    "Ear infection treatment",
    "Pregnancy ultrasound",
    "Vaccines, per dose",
  ])("lets %j through", (name) => {
    expect(findClinicalContent({ name }, "claims")).toEqual([]);
    expect(findClinicalContent({ name })).not.toEqual([]);
  });

  // A promise is the same promise whoever the patient is.
  test.each([
    ["Safe sedation dentistry", "a safety claim"],
    ["Guaranteed results flea program", "a results guarantee"],
    ["FDA-approved dental sealant", "an efficacy claim"],
  ])("still catches the claim in %j", (name, label) => {
    expect(findClinicalContent({ name }, "claims")).toEqual([expect.objectContaining({ field: "name", label })]);
  });

  test("the full screen is still the default", () => {
    expect(findClinicalContent({ name: "Allergy testing" })).toHaveLength(1);
    expect(findClinicalContent({ name: "Allergy testing" }, "clinical")).toHaveLength(1);
  });

  test("only a veterinary specialty gets the claims screen for its service names", () => {
    expect(serviceNameScreen("veterinary")).toBe("claims");
    for (const specialty of ["med-spa", "dental", "plastic-surgery", "fertility", "glp1", "hair-restoration", "massage-chiro"] as const) {
      expect(serviceNameScreen(specialty), specialty).toBe("clinical");
    }
    expect(serviceNameScreen(null)).toBe("clinical");
    expect(serviceNameScreen(undefined)).toBe("clinical");
    // A value that is not a specialty, from a browser or a model, is screened in full.
    expect(serviceNameScreen("vet" as never)).toBe("clinical");
  });
});
