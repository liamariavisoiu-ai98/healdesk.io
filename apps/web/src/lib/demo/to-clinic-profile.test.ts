import { cleanWebsite, parseClinicProfile } from "@healdesk/catalog";
import { describe, expect, it } from "vitest";

import type { ClinicProfile } from "./profile";
import type { DemoSession } from "./sessions";
import { demoSiteProfile, readDuration, readPrice } from "./to-clinic-profile";

const PROFILE: ClinicProfile = {
  clinicName: "Peachy Studio",
  summary: "A med spa in SoHo.",
  specialty: "med-spa",
  phone: "(212) 555-0142",
  address: "12 Spring St, New York, NY 10012",
  hours: [
    { days: "Mon–Fri", hours: "10am–7pm" },
    { days: "Sat", hours: "10am–4pm" },
  ],
  hoursSource: "website",
  hoursPlace: null,
  services: [
    { name: "Hydrafacial", description: null, price: "$199", duration: "60 min" },
    { name: "Botox", description: null, price: "from $12/unit", duration: null },
    { name: "Lip filler", description: null, price: "$650 per syringe", duration: "45 minutes" },
    { name: "Microneedling", description: null, price: "$300 – $450", duration: "1.5 hours" },
    { name: "Consultation", description: null, price: "free consult", duration: null },
  ],
  providers: [{ name: "Dana Lee", title: "Nurse injector" }],
  faqs: [{ question: "Do you offer payment plans?", answer: "Yes, through Cherry." }],
  policies: ["A $50 deposit holds your appointment."],
  booking: "Online booking",
  highlights: [],
};

function demo(overrides: Partial<DemoSession> = {}): DemoSession {
  const at = new Date("2026-10-13T09:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "peachy-studio-k7q2mz9xwa",
    status: "ready",
    leadEmail: "owner@peachystudio.com",
    clinicName: "Peachy Studio",
    websiteUrl: "https://peachystudio.com/",
    phoneE164: null,
    niche: null,
    specialty: "med-spa",
    brandName: "Peachy Studio",
    logoUrl: null,
    brandColor: "#f4a07a",
    profile: PROFILE as unknown as Record<string, unknown>,
    scrapeSource: "fetch",
    buildNote: null,
    createdBy: "homepage",
    createdAt: at,
    readyAt: new Date("2026-10-13T09:03:00.000Z"),
    expiresAt: new Date("2026-10-20T09:00:00.000Z"),
    claimed: false,
    claimedAt: null,
    claimedPlan: null,
    emailSentAt: null,
    buildStartedAt: at,
    emailRequested: true,
    auditVerdict: "pass",
    auditScore: 90,
    auditReport: null,
    auditedAt: at,
    auditHash: null,
    retryCount: 0,
    ...overrides,
  };
}

const WEBSITE = cleanWebsite("https://peachystudio.com/")!;

describe("a demo's read, carried into the purchase", () => {
  it("is one the catalog parser accepts, for the very website bought for", () => {
    const read = demoSiteProfile(demo(), WEBSITE);
    expect(read).not.toBeNull();
    expect(parseClinicProfile(read)).toEqual(read);
    expect(read!.website).toBe(WEBSITE);
    expect(read!.readAt).toBe("2026-10-13T09:03:00.000Z");
    expect(read!.practiceKind).toBe("med-spa");
  });

  it("keeps every service, with a price only where the site stated one plainly", () => {
    const services = demoSiteProfile(demo(), WEBSITE)!.services;
    expect(services.map((s) => [s.name, s.priceKind, s.priceUsd, s.maxUsd, s.unit, s.durationMinutes])).toEqual([
      ["Hydrafacial", "exact", 199, null, null, 60],
      // "From" and "per unit" at once is neither kind: the wizard asks.
      ["Botox", null, null, null, null, null],
      ["Lip filler", "per_unit", 650, null, "syringe", 45],
      ["Microneedling", "range", 300, 450, null, 90],
      ["Consultation", null, null, null, null, null],
    ]);
  });

  it("brings the hours, the address, the phone, the people, the policies and the answers", () => {
    const read = demoSiteProfile(demo(), WEBSITE)!;
    expect(read.locations).toHaveLength(1);
    const [location] = read.locations;
    expect(location!.address).toBe(PROFILE.address);
    expect(location!.phone).toBe(PROFILE.phone);
    expect(location!.hours!.mon).toEqual([["10:00", "19:00"]]);
    expect(location!.hours!.sat).toEqual([["10:00", "16:00"]]);
    expect(location!.hours!.sun).toEqual([]);
    expect(read.providers).toEqual([{ name: "Dana Lee", title: "Nurse injector" }]);
    expect(read.policies).toEqual(PROFILE.policies);
    expect(read.faqs).toEqual(PROFILE.faqs);
  });

  it("leaves the hours out rather than assuming 9 to 5 when a row cannot be read", () => {
    const profile = { ...PROFILE, hours: [{ days: "By appointment", hours: "call us" }] };
    const read = demoSiteProfile(demo({ profile: profile as unknown as Record<string, unknown> }), WEBSITE)!;
    expect(read.locations[0]!.hours).toBeNull();
  });

  it("is nothing for another website, or a demo not built and cleared", () => {
    expect(demoSiteProfile(demo(), "someoneelse.com")).toBeNull();
    expect(demoSiteProfile(demo({ status: "held" }), WEBSITE)).toBeNull();
    expect(demoSiteProfile(demo({ status: "building", profile: null }), WEBSITE)).toBeNull();
  });
});

describe("prices and durations, read only when plain", () => {
  it("reads the four kinds", () => {
    expect(readPrice("$1,200")).toEqual({ priceKind: "exact", priceUsd: 1200, maxUsd: null, unit: null });
    expect(readPrice("$99.50")).toMatchObject({ priceKind: "exact", priceUsd: 99.5 });
    expect(readPrice("From $650")).toMatchObject({ priceKind: "from", priceUsd: 650 });
    expect(readPrice("$650+")).toMatchObject({ priceKind: "from", priceUsd: 650 });
    expect(readPrice("$300 to $450")).toMatchObject({ priceKind: "range", priceUsd: 300, maxUsd: 450 });
    expect(readPrice("$14 per unit")).toMatchObject({ priceKind: "per_unit", priceUsd: 14, unit: "unit" });
  });

  it("reads nothing it would have to guess at", () => {
    for (const stated of [null, "", "free consult", "Call for pricing", "$450 – $300", "$12/unit, $10 for members", "€200", "$500,000"]) {
      expect(readPrice(stated)).toEqual({ priceKind: null, priceUsd: null, maxUsd: null, unit: null });
    }
  });

  it("reads minutes and hours, and nothing else", () => {
    expect(readDuration("30 mins")).toBe(30);
    expect(readDuration("2 hrs")).toBe(120);
    expect(readDuration("about an hour")).toBeNull();
    expect(readDuration("0 min")).toBeNull();
  });
});
