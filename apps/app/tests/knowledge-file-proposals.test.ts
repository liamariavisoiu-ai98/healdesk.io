import type { ClinicProfile, ProfileHours } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { fileRows, type PageKnowledge } from "@/lib/knowledge-file/proposals";

/**
 * What a file adds to Your practice: only what the page does not already
 * say, never the address, the phone, providers or the never-say list.
 */

const WEEKDAYS: ProfileHours = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
};

function profile(over: Partial<ClinicProfile> = {}): ClinicProfile {
  return {
    version: 1,
    website: "file.healdesk.io",
    readAt: "2026-11-01T12:00:00.000Z",
    pages: 1,
    locations: [],
    services: [],
    providers: [],
    policies: [],
    faqs: [],
    acceptsInsurance: "unknown",
    practiceKind: null,
    dropped: 0,
    ...over,
  } as ClinicProfile;
}

const page: PageKnowledge = {
  services: [
    { name: "Botox, 1 area", priceKind: "exact", priceFromUsd: 279, priceToUsd: 279, durationMinutes: 30, depositUsd: 50 },
    { name: "Chemical peel", priceKind: "exact", priceFromUsd: 200, priceToUsd: 200, durationMinutes: null },
  ],
  policies: ["24 hours' notice to cancel."],
  quickAnswers: [{ question: "Where do I park?", answer: "Behind the building." }],
  mostAsked: { question: "Do you take walk-ins?", answer: "By appointment only." },
  hours: WEEKDAYS,
};

const svc = (name: string, priceUsd: number | null, durationMinutes: number | null = null) => ({
  name,
  priceKind: priceUsd === null ? null : ("exact" as const),
  priceUsd,
  maxUsd: null,
  unit: null,
  durationMinutes,
});

describe("fileRows", () => {
  test("a new treatment, a changed price, and one the page already has the same", () => {
    const rows = fileRows(
      profile({
        services: [svc("HydraFacial", 199, 45), svc("botox,  1 AREA", 299), svc("Chemical peel", 200)],
      }),
      page,
    );
    expect(rows.map((r) => [r.id, r.kind, r.text, r.was])).toEqual([
      ["prices:hydrafacial", "new", "HydraFacial · $199, 45 minutes", null],
      ["prices:botox, 1 area", "changed", "botox,  1 AREA · $299", "Your page says $279, 30 minutes"],
    ]);
  });

  test("a treatment the page has, which the file gives no price for, is not offered", () => {
    expect(fileRows(profile({ services: [svc("Chemical peel", null)] }), page)).toEqual([]);
  });

  test("a new treatment with no price is offered as a consultation", () => {
    const [row] = fileRows(profile({ services: [svc("Microneedling", null)] }), page);
    expect(row).toMatchObject({ kind: "new", text: "Microneedling · no price listed" });
  });

  test("a longer appointment for the same price is a change", () => {
    const [row] = fileRows(profile({ services: [svc("Botox, 1 area", 279, 45)] }), page);
    expect(row).toMatchObject({ kind: "changed", was: "Your page says $279, 30 minutes" });
  });

  test("hours: offered when they differ, and only then", () => {
    const sameHours = profile({ locations: [{ label: "L", address: null, phone: null, hours: WEEKDAYS }] });
    expect(fileRows(sameHours, page)).toEqual([]);
    const saturday = { ...WEEKDAYS, sat: [["10:00", "14:00"]] as [string, string][] };
    const [row] = fileRows(profile({ locations: [{ label: "L", address: null, phone: null, hours: saturday }] }), page);
    expect(row).toMatchObject({ id: "hours:weekly", kind: "changed" });
    expect(row?.text).toContain("Sat 10:00–14:00");
    const [first] = fileRows(profile({ locations: [{ label: "L", address: null, phone: null, hours: saturday }] }), {
      ...page,
      hours: null,
    });
    expect(first).toMatchObject({ kind: "new", was: null });
  });

  test("a policy or question the page has, in any case or spacing, is not offered again; the most-asked question counts", () => {
    const rows = fileRows(
      profile({
        policies: ["24 HOURS' notice  to cancel.", "Deposits are kept for no-shows."],
        faqs: [
          { question: "where do I park?", answer: "Out back." },
          { question: "Do you take walk-ins?", answer: "Yes." },
          { question: "What should I wear?", answer: "Something comfortable." },
        ],
      }),
      page,
    );
    expect(rows.map((r) => r.id)).toEqual([
      "policies:deposits are kept for no-shows.",
      "quick_answers:what should i wear?",
    ]);
  });

  test("the address, the phone and providers are never offered", () => {
    const rows = fileRows(
      profile({
        locations: [{ label: "L", address: "1 Main St", phone: "+1 512 555 0100", hours: null }],
        providers: [{ name: "Dr Someone", title: "MD" }],
      }),
      page,
    );
    expect(rows).toEqual([]);
  });
});
