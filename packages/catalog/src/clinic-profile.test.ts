import { describe, expect, test } from "vitest";

import {
  CLINIC_PROFILE_LIMITS,
  SERVICE_PRICE_KINDS,
  cleanProfileText,
  parseClinicProfile,
  screenClinicProfile,
  summarizeClinicProfile,
  type ClinicProfile,
  type ProfileService,
} from "./clinic-profile";

/**
 * The profile crosses a browser between apps/web and apps/app, so the parser
 * is the contract: exact keys, hard caps, consistent prices, nothing repaired.
 */

const WEEKDAYS = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [
    ["09:00", "12:30"],
    ["13:30", "18:00"],
  ],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "19:00"]],
  fri: [["09:00", "17:00"]],
  sat: [["10:00", "14:00"]],
} as const;

function service(overrides: Partial<ProfileService> = {}): ProfileService {
  return {
    name: "Signature facial",
    priceKind: "exact",
    priceUsd: 199,
    maxUsd: null,
    unit: null,
    durationMinutes: 60,
    ...overrides,
  };
}

function profile(overrides: Partial<ClinicProfile> = {}): ClinicProfile {
  return {
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-10-06T09:30:00.000Z",
    pages: 5,
    locations: [
      {
        label: "Glow Med Spa",
        address: "12 Main St, Austin, TX 78701",
        phone: "(512) 555-0100",
        hours: WEEKDAYS,
      },
    ],
    services: [
      service(),
      service({
        name: "Botox",
        priceKind: "per_unit",
        priceUsd: 14,
        unit: "unit",
        durationMinutes: null,
      }),
      service({ name: "Lip filler", priceKind: "from", priceUsd: 650, durationMinutes: 45 }),
      service({ name: "Chemical peel", priceKind: "range", priceUsd: 150, maxUsd: 300.5 }),
      service({ name: "Consultation", priceKind: null, priceUsd: null, durationMinutes: 30 }),
    ],
    providers: [
      { name: "Dr. Maya Patel", title: "Medical Director" },
      { name: "Sam Ortiz", title: null },
    ],
    policies: ["A $50 deposit holds your appointment."],
    faqs: [{ question: "Is there parking?", answer: "Yes, free parking behind the building." }],
    acceptsInsurance: "no",
    practiceKind: "med-spa",
    dropped: 0,
    ...overrides,
  };
}

/** A deep copy with one change made by `edit`, so each refusal names exactly one broken rule. */
function broken(edit: (p: Record<string, any>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(profile())) as Record<string, any>;
  edit(copy);
  return copy;
}

describe("parseClinicProfile", () => {
  test("accepts a well-formed profile and returns the same data", () => {
    const valid = profile();
    expect(parseClinicProfile(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  test("accepts the empty lists and nulls a sparse site produces", () => {
    const sparse = profile({
      locations: [{ label: "Paws & Claws", address: null, phone: null, hours: null }],
      services: [],
      providers: [],
      policies: [],
      faqs: [],
      acceptsInsurance: "unknown",
      practiceKind: null,
      pages: 1,
    });
    expect(parseClinicProfile(sparse)).toEqual(sparse);
  });

  test("the price kinds are the plan's four", () => {
    expect(SERVICE_PRICE_KINDS).toEqual(["exact", "from", "range", "per_unit"]);
  });

  test.each<[string, (p: Record<string, any>) => void]>([
    ["an extra top-level key", (p) => (p.notes = "hello")],
    ["a missing top-level key", (p) => delete p.dropped],
    ["another version", (p) => (p.version = 2)],
    ["a website with a scheme", (p) => (p.website = "https://glowmedspa.com")],
    ["a website that is not a host", (p) => (p.website = "localhost")],
    ["a website past the cap", (p) => (p.website = `glow.com/${"a".repeat(200)}`)],
    ["a readAt that is not an ISO instant", (p) => (p.readAt = "6 October 2026")],
    ["a readAt that is not a real date", (p) => (p.readAt = "2026-02-30T09:30:00.000Z")],
    ["no pages", (p) => (p.pages = 0)],
    ["more pages than the read fetches", (p) => (p.pages = 9)],
    ["a fractional page count", (p) => (p.pages = 2.5)],
    ["an unknown practice kind", (p) => (p.practiceKind = "astrology")],
    ["an unknown insurance answer", (p) => (p.acceptsInsurance = "maybe")],
    ["a negative dropped count", (p) => (p.dropped = -1)],
    ["an extra key in a service", (p) => (p.services[0].depositUsd = 50)],
    ["an extra key in a location", (p) => (p.locations[0].email = "info@glow.com")],
    ["an extra key in a provider", (p) => (p.providers[0].photo = "x.jpg")],
    ["an extra key in a question", (p) => (p.faqs[0].votes = 3)],
    ["an empty service name", (p) => (p.services[0].name = "")],
    [
      "a name past the cap",
      (p) => (p.services[0].name = "a".repeat(CLINIC_PROFILE_LIMITS.text + 1)),
    ],
    [
      "a phone past its cap",
      (p) => (p.locations[0].phone = "1".repeat(CLINIC_PROFILE_LIMITS.phone + 1)),
    ],
    ["untrimmed text", (p) => (p.providers[0].name = " Dr. Maya Patel")],
    ["a line break in text", (p) => (p.policies[0] = "Deposits\nare required.")],
    ["a control character in text", (p) => (p.faqs[0].answer = "Yes\u0007")],
    [
      "a bidirectional override in text",
      (p) => (p.locations[0].label = `Glow ${String.fromCharCode(0x202e)}aps`),
    ],
    [
      "a lone surrogate in text",
      (p) => (p.services[0].name = `Facial ${String.fromCharCode(0xd83d)}`),
    ],
    ["a number where text belongs", (p) => (p.policies[0] = 50)],
    ["an exact price with no amount", (p) => (p.services[0].priceUsd = null)],
    ["a price with no kind", (p) => (p.services[4].priceUsd = 100)],
    ["a range with no high end", (p) => (p.services[3].maxUsd = null)],
    ["a range whose high end is not higher", (p) => (p.services[3].maxUsd = 150)],
    ["a high end on a price that is not a range", (p) => (p.services[0].maxUsd = 250)],
    ["a per-unit price with no unit", (p) => (p.services[1].unit = null)],
    ["a unit on a price that is not per unit", (p) => (p.services[0].unit = "session")],
    ["a negative price", (p) => (p.services[0].priceUsd = -1)],
    ["a price above the cap", (p) => (p.services[0].priceUsd = CLINIC_PROFILE_LIMITS.priceUsd + 1)],
    ["a price in fractions of a cent", (p) => (p.services[0].priceUsd = 19.999)],
    ["a price that is not a number", (p) => (p.services[0].priceUsd = "199")],
    ["a duration of zero", (p) => (p.services[0].durationMinutes = 0)],
    ["a duration longer than a day", (p) => (p.services[0].durationMinutes = 1441)],
    ["a fractional duration", (p) => (p.services[0].durationMinutes = 37.5)],
    ["hours missing a day", (p) => delete p.locations[0].hours.sun],
    ["hours with an extra day", (p) => (p.locations[0].hours.holiday = [])],
    ["hours that are not HH:MM", (p) => (p.locations[0].hours.mon = [["9:00", "17:00"]])],
    ["hours past 23:59", (p) => (p.locations[0].hours.mon = [["09:00", "24:00"]])],
    [
      "a range that is not a pair",
      (p) => (p.locations[0].hours.mon = [["09:00", "12:00", "17:00"]]),
    ],
    [
      "more ranges in a day than the cap",
      (p) => (p.locations[0].hours.mon = Array(5).fill(["09:00", "10:00"])),
    ],
    ["a day that is not a list", (p) => (p.locations[0].hours.mon = "closed")],
  ])("refuses %s", (_name, edit) => {
    expect(parseClinicProfile(broken(edit))).toBeNull();
  });

  test.each<[string, keyof typeof CLINIC_PROFILE_LIMITS, string]>([
    ["services", "services", "services"],
    ["locations", "locations", "locations"],
    ["providers", "providers", "providers"],
    ["policies", "policies", "policies"],
    ["questions", "faqs", "faqs"],
  ])("refuses more %s than the cap", (_name, limit, key) => {
    const over = broken((p) => {
      const first = p[key][0];
      p[key] = Array.from({ length: (CLINIC_PROFILE_LIMITS[limit] as number) + 1 }, () => first);
    });
    expect(parseClinicProfile(over)).toBeNull();
    const at = broken((p) => {
      const first = p[key][0];
      p[key] = Array.from({ length: CLINIC_PROFILE_LIMITS[limit] as number }, () => first);
    });
    expect(parseClinicProfile(at)).not.toBeNull();
  });

  test.each([null, undefined, "profile", 42, [], new Date(), new (class Profile {})()])(
    "refuses %j, which is not a plain object",
    (value) => {
      expect(parseClinicProfile(value)).toBeNull();
    },
  );
});

describe("cleanProfileText", () => {
  test("collapses whitespace, drops control and bidirectional characters, trims", () => {
    const rtl = String.fromCharCode(0x202e);
    expect(cleanProfileText(`  Glow\t\tMed \n Spa${rtl}\u0000  `, 300)).toBe("Glow Med Spa");
  });

  test("cuts at the cap without splitting a character in two", () => {
    const face = String.fromCodePoint(0x1f600);
    const cut = cleanProfileText(`abcd${face}`, 5);
    expect(cut).toBe("abcd");
    expect(cleanProfileText(`abc${face}`, 5)).toBe(`abc${face}`);
  });

  test("what it returns, the parser accepts", () => {
    const name = cleanProfileText(`  ${"x".repeat(400)}  `, CLINIC_PROFILE_LIMITS.text);
    expect(parseClinicProfile(profile({ services: [service({ name })] }))).not.toBeNull();
  });
});

describe("screenClinicProfile", () => {
  test("a med spa's clinical items are dropped and counted", () => {
    const screened = screenClinicProfile(
      profile({
        services: [
          service({ name: "Botox", priceKind: "per_unit", priceUsd: 14, unit: "unit" }),
          service({ name: "Dysport, typical dose 50 units" }),
          service({ name: "Lip filler", priceKind: "per_unit", priceUsd: 650, unit: "ml" }),
          service({
            name: "Neurotoxin touch-up",
            priceKind: "per_unit",
            priceUsd: 12,
            unit: "dose",
          }),
          service({ name: "Hydrafacial" }),
        ],
        policies: [
          "A $50 deposit holds your appointment.",
          "We cannot treat clients who are pregnant or breastfeeding.",
        ],
        faqs: [
          { question: "Is there parking?", answer: "Yes, behind the building." },
          { question: "Is Botox safe?", answer: "It is FDA-approved." },
          { question: "How long is the downtime?", answer: "Most clients have none." },
        ],
      }),
      "med-spa",
    );
    expect(screened.services.map((s) => s.name)).toEqual(["Botox", "Lip filler", "Hydrafacial"]);
    expect(screened.policies).toEqual(["A $50 deposit holds your appointment."]);
    expect(screened.faqs.map((f) => f.question)).toEqual(["Is there parking?"]);
    expect(screened.dropped).toBe(2 + 1 + 2);
    expect(parseClinicProfile(screened)).toEqual(screened);
  });

  test("a vet's service names keep the vocabulary of its menu, but not a claim", () => {
    const vet = profile({
      practiceKind: "veterinary",
      services: [
        service({ name: "Allergy testing" }),
        service({ name: "Senior pet diagnostics" }),
        service({ name: "Post-op check" }),
        service({ name: "Heartworm medication" }),
        service({ name: "Pregnancy ultrasound" }),
        service({ name: "Rabies vaccine", priceKind: "per_unit", priceUsd: 25, unit: "dose" }),
        service({ name: "Guaranteed results flea treatment" }),
        service({ name: "FDA-approved dental sealant" }),
      ],
      policies: ["Every surgery patient goes home with aftercare instructions."],
      faqs: [{ question: "Is anesthesia safe for older dogs?", answer: "Ask us at the exam." }],
    });
    const screened = screenClinicProfile(vet, "veterinary");
    expect(screened.services.map((s) => s.name)).toEqual([
      "Allergy testing",
      "Senior pet diagnostics",
      "Post-op check",
      "Heartworm medication",
      "Pregnancy ultrasound",
      "Rabies vaccine",
    ]);
    // Only the names are spared: a vet's policies and answers are screened in full.
    expect(screened.policies).toEqual([]);
    expect(screened.faqs).toEqual([]);
    expect(screened.dropped).toBe(4);
  });

  test("the same names under a human specialty are screened in full", () => {
    const names = ["Allergy testing", "Senior pet diagnostics", "Post-op check", "Hydrafacial"];
    const screened = screenClinicProfile(
      profile({ services: names.map((name) => service({ name })) }),
      "med-spa",
    );
    expect(screened.services.map((s) => s.name)).toEqual(["Hydrafacial"]);
    // And so with no specialty at all: unknown is screened in full.
    const unknown = screenClinicProfile(
      profile({ services: names.map((name) => service({ name })) }),
      null,
    );
    expect(unknown.services.map((s) => s.name)).toEqual(["Hydrafacial"]);
  });

  test("a second screening adds to the count, up to the cap", () => {
    const once = screenClinicProfile(profile({ policies: ["No aftercare is needed."] }), "med-spa");
    expect(once.dropped).toBe(1);
    const again = screenClinicProfile(
      { ...once, policies: ["Results are guaranteed."] },
      "med-spa",
    );
    expect(again.dropped).toBe(2);
    const capped = screenClinicProfile(
      { ...once, dropped: CLINIC_PROFILE_LIMITS.dropped, policies: ["Results are guaranteed."] },
      "med-spa",
    );
    expect(capped.dropped).toBe(CLINIC_PROFILE_LIMITS.dropped);
  });
});

describe("summarizeClinicProfile", () => {
  test("counts what the Review & pay line names", () => {
    expect(summarizeClinicProfile(profile())).toEqual({ services: 5, hours: true, providers: 2 });
    const noHours = profile({
      locations: [{ label: "Glow", address: null, phone: null, hours: null }],
      providers: [],
    });
    expect(summarizeClinicProfile(noHours)).toEqual({ services: 5, hours: false, providers: 0 });
  });
});
