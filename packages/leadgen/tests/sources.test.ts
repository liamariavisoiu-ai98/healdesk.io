import { describe, expect, test } from "vitest";

import { dedupe, type LeadRow } from "../src/enrich/dedupe.ts";
import { detectSourceFormat, normaliseRow, normaliseRows } from "../src/enrich/sources.ts";

/**
 * Two lists, two headers, one clinic table.
 *
 * The failure these guard against is silent: an Apollo export fed to a
 * dedupe() written for the first list's columns produces zero clinics and no
 * error, and a second --input against a cached clinic file was skipped
 * outright. Neither shows up anywhere except as a batch that never arrives.
 */

const CANONICAL_HEADER = [
  "website", "phone", "companyName", "city", "state", "Email",
  "first_name", "Last Name", "jobTitle", "linkedIn", "category",
];

const APOLLO_HEADER = [
  "First Name", "Last Name", "Title", "Company Name", "Company Name for Emails",
  "Email", "Email Status", "Seniority", "Corporate Phone", "Website",
  "Person Linkedin Url", "City", "State", "Company City", "Company State",
  "Company Phone", "Industry", "Apollo Contact Id",
];

function apolloRow(overrides: Partial<Record<string, string>> = {}): LeadRow {
  return {
    "First Name": "Angie",
    "Last Name": "Deangelo",
    Title: "Practice Manager",
    "Company Name": "Richmond Aesthetic Surgery",
    "Company Name for Emails": "Richmond Aesthetic Surgery",
    Email: "adeangelo@drzemmel.com",
    "Email Status": "Verified",
    Seniority: "Manager",
    "Corporate Phone": "'+1 804-464-3801",
    Website: "https://richmondplasticsurgery.com",
    "Person Linkedin Url": "http://www.linkedin.com/in/angie",
    City: "Henrico",
    State: "Virginia",
    "Company City": "Richmond",
    "Company State": "Virginia",
    "Company Phone": "'+1 804-464-3801",
    Industry: "medical practice",
    "Apollo Contact Id": "6aa03bcfc7a8bd00018fb760",
    ...overrides,
  };
}

function canonicalRow(overrides: Partial<Record<string, string>> = {}): LeadRow {
  return {
    website: "https://www.richmondplasticsurgery.com/",
    phone: "",
    companyName: "Richmond Aesthetic Surgery & Dermlounge",
    city: "Richmond",
    state: "VA",
    Email: "dr@drzemmel.com",
    first_name: "Neil",
    "Last Name": "Zemmel",
    jobTitle: "Owner",
    linkedIn: "",
    category: "",
    ...overrides,
  };
}

describe("detectSourceFormat", () => {
  test("recognises the original list by its lowercase columns", () => {
    expect(detectSourceFormat(CANONICAL_HEADER)).toBe("canonical");
  });

  test("recognises an Apollo export", () => {
    expect(detectSourceFormat(APOLLO_HEADER)).toBe("apollo");
  });

  test("recognises an Apollo export even without the Apollo id column", () => {
    const stripped = APOLLO_HEADER.filter((h) => h !== "Apollo Contact Id");
    expect(detectSourceFormat(stripped)).toBe("apollo");
  });

  test("refuses a header it does not know, rather than guessing", () => {
    expect(detectSourceFormat(["Name", "URL", "Contact"])).toBeNull();
    expect(detectSourceFormat([])).toBeNull();
  });
});

describe("normaliseRow — Apollo", () => {
  test("maps every column dedupe() reads", () => {
    const out = normaliseRow(apolloRow(), "apollo");
    expect(out).toMatchObject({
      website: "https://richmondplasticsurgery.com",
      companyName: "Richmond Aesthetic Surgery",
      city: "Richmond",
      state: "Virginia",
      Email: "adeangelo@drzemmel.com",
      first_name: "Angie",
      "Last Name": "Deangelo",
      jobTitle: "Practice Manager",
      linkedIn: "http://www.linkedin.com/in/angie",
      category: "medical practice",
    });
  });

  test("strips the spreadsheet apostrophe from the phone", () => {
    expect(normaliseRow(apolloRow(), "apollo").phone).toBe("+1 804-464-3801");
  });

  test("prefers the company's city over the contact's own", () => {
    const out = normaliseRow(apolloRow({ City: "Henrico", "Company City": "Richmond" }), "apollo");
    expect(out.city).toBe("Richmond");
  });

  test("falls back to the contact's city when the company has none", () => {
    const out = normaliseRow(apolloRow({ "Company City": "" }), "apollo");
    expect(out.city).toBe("Henrico");
  });

  test("falls back through the phone columns", () => {
    const out = normaliseRow(
      apolloRow({ "Company Phone": "", "Corporate Phone": "'+1 555-000-1111" }),
      "apollo",
    );
    expect(out.phone).toBe("+1 555-000-1111");
  });
});

describe("normaliseRow — canonical", () => {
  test("passes the row through untouched apart from the phone", () => {
    const row = canonicalRow({ phone: "'+1 804 464 3801", extra: "kept" });
    const out = normaliseRow(row, "canonical");
    expect(out.phone).toBe("+1 804 464 3801");
    expect(out.extra).toBe("kept");
    expect(out.Email).toBe("dr@drzemmel.com");
  });
});

describe("dedupe across two sources", () => {
  const batch1 = normaliseRows([canonicalRow()], "canonical", "healdesk_leads.csv");
  const batch2 = normaliseRows(
    [
      apolloRow(),
      apolloRow({
        "First Name": "Yvette",
        Email: "yvette@orthograce.com",
        "Company Name": "OrthoGrace Dental",
        Website: "https://orthograce.com",
        "Company City": "Los Angeles",
        "Company State": "California",
        "Company Phone": "'+1 818-280-5596",
      }),
    ],
    "apollo",
    "leads_batch2.csv",
  );

  test("a clinic keeps the same id whether it is deduped alone or with a second list", () => {
    const alone = dedupe(batch1);
    const together = dedupe([...batch1, ...batch2]);
    const richmondAlone = alone.clinics[0]!;
    const richmondTogether = together.clinics.find((c) => c.domain === "richmondplasticsurgery.com")!;
    expect(richmondTogether.id).toBe(richmondAlone.id);
  });

  test("an overlapping clinic gains the second list's contact, and is counted once", () => {
    const { clinics, report } = dedupe([...batch1, ...batch2]);
    expect(clinics).toHaveLength(2);
    expect(report.overlap).toBe(1);

    const richmond = clinics.find((c) => c.domain === "richmondplasticsurgery.com")!;
    expect(richmond.contacts.map((c) => c.email)).toEqual([
      "dr@drzemmel.com",
      "adeangelo@drzemmel.com",
    ]);
    expect(richmond.sources).toEqual(["healdesk_leads.csv", "leads_batch2.csv"]);
    expect(richmond.contacts.map((c) => c.source)).toEqual([
      "healdesk_leads.csv",
      "leads_batch2.csv",
    ]);
  });

  test("the owner stays the primary contact when the second list adds a manager", () => {
    const { clinics } = dedupe([...batch2, ...batch1]);
    const richmond = clinics.find((c) => c.domain === "richmondplasticsurgery.com")!;
    expect(richmond.contacts[0]!.jobTitle).toBe("Owner");
  });

  test("the report says what each file added", () => {
    const { report } = dedupe([...batch1, ...batch2]);
    expect(report.bySource).toEqual({
      "healdesk_leads.csv": { rows: 1, newClinics: 1 },
      "leads_batch2.csv": { rows: 2, newClinics: 1 },
    });
  });

  test("blanks in the first list are filled from the second", () => {
    const { clinics } = dedupe([
      ...normaliseRows([canonicalRow({ phone: "", city: "" })], "canonical", "a.csv"),
      ...batch2,
    ]);
    const richmond = clinics.find((c) => c.domain === "richmondplasticsurgery.com")!;
    expect(richmond.phone).toBe("+1 804-464-3801");
    expect(richmond.city).toBe("Richmond");
  });

  test("an Apollo file fed in raw would have produced nothing — the mapping is load-bearing", () => {
    const raw = dedupe([apolloRow(), apolloRow()]);
    expect(raw.clinics).toHaveLength(0);
    expect(raw.report.unusable).toBe(2);

    const mapped = dedupe(normaliseRows([apolloRow(), apolloRow()], "apollo", "b.csv"));
    expect(mapped.clinics).toHaveLength(1);
  });
});
