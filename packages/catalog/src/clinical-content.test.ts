import { describe, expect, test } from "vitest";

import { findClinicalContent } from "./clinical-content";

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
