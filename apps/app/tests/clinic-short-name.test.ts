import { shortClinicName } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { clinicOwnWords, guardAssistantReply, ownShortName } from "@/lib/assistant/guard";
import { buildAssistantPrompt, callName } from "@/lib/assistant/prompt";
import { buildFrontDoorPrompt, guardContextFor, guardReply } from "@/lib/meta/front-door";

/**
 * What patients call the clinic (owner, 26 October 2026: "build it", from
 * docs/design/clinic-nickname-2026-10-26.md). The assistant says the full
 * name once and the short one after it, on every channel. The guards read a
 * short name as the clinic's own words only when it is a part of the full
 * name, so a name typed into Settings can never excuse a word the full name
 * did not already (the patient-screening rule: nothing here may weaken a
 * guard for a real patient).
 */

const FACTS: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-000000000002",
  clinicName: "Painless Laser Studio",
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  vetReferralPhone: null,
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Monday: 09:00-17:00"],
  openingHours: null,
  services: [{ name: "Consultation", priceFromUsd: 150, priceToUsd: 150, priceKind: "exact", unit: null, durationMinutes: 30, depositUsd: null }],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: ["painless", "guaranteed results"],
  requirements: [],
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};

describe("the short name the guards read past", () => {
  test("only a part of the full name counts as the clinic's own words", () => {
    expect(ownShortName({ clinicName: "Painless Laser Studio", shortName: "Painless Laser" })).toBe("Painless Laser");
    expect(ownShortName({ clinicName: "Painless Laser Studio", shortName: "painless laser" })).toBe("painless laser");
    expect(ownShortName({ clinicName: "Painless Laser Studio", shortName: "Painless Glow" })).toBeNull();
    expect(ownShortName({ clinicName: "Painless Laser Studio", shortName: null })).toBeNull();
    expect(clinicOwnWords({ clinicName: "Painless Laser Studio", shortName: "Painless Glow" })).toEqual(["Painless Laser Studio"]);
  });

  test("a never-say entry is excused inside a short name that is part of the name, and nowhere else", () => {
    const part = { ...FACTS, shortName: "Painless Laser" };
    expect(guardAssistantReply("Painless Laser can book that for you.", part)).toMatchObject({ ok: true });
    // Not part of the name: read like any word of a reply.
    expect(guardAssistantReply("Painless Glow can book that for you.", { ...FACTS, shortName: "Painless Glow" })).toEqual({
      ok: false,
      reason: "never_say",
    });
    // The entry on its own is still refused, short name or not.
    expect(guardAssistantReply("The treatment is painless.", part)).toEqual({ ok: false, reason: "never_say" });
  });

  test("clinical screening reads every word around the short name", () => {
    const glow = { ...FACTS, clinicName: "Glow Clinic", neverSay: [], shortName: "Glow" };
    for (const reply of ["Glow says swelling is normal for a few days.", "At Glow, results last about 4 months.", "Glow recommends 400mg of ibuprofen."]) {
      expect(guardAssistantReply(reply, glow), reply).toMatchObject({ ok: false, reason: "clinical" });
    }
  });
});

describe("the prompt", () => {
  test("names the short name to use after the opening, the clinic's own first", () => {
    const prompt = buildAssistantPrompt({ ...FACTS, clinicName: "Lumen Aesthetics & Wellness", shortName: "Lumen Spa" }, "voice");
    expect(prompt).toContain("- What patients call it: Lumen Spa.");
    expect(prompt).toContain('after it, say "Lumen Spa"');
  });

  test("falls back to the one worked out from the name, and says nothing when that is the name itself", () => {
    expect(callName({ clinicName: "Lumen Aesthetics & Wellness", shortName: null })).toBe(shortClinicName("Lumen Aesthetics & Wellness"));
    expect(callName({ clinicName: "Lumen Aesthetics & Wellness", shortName: "  " })).toBe("Lumen");
    expect(buildAssistantPrompt({ ...FACTS, clinicName: "Lumen Aesthetics & Wellness" }, "web_chat")).toContain('say "Lumen"');
    expect(buildAssistantPrompt({ ...FACTS, clinicName: "Radiance" }, "voice")).not.toContain("What patients call it");
  });

  test("works a name out word by word, in linear time on a name full of spaces (CodeQL, polynomial regex)", () => {
    expect(shortClinicName("Glow Med Spa of Austin")).toBe("Glow");
    expect(shortClinicName("The Skin Deep Med Spa - Round Rock")).toBe("Skin Deep");
    expect(shortClinicName("Radiance Aesthetics, Austin TX")).toBe("Radiance");
    expect(shortClinicName("Of Course Aesthetics")).toBe("Of Course");
    const started = Date.now();
    expect(shortClinicName(`Glow${" \t".repeat(50_000)}x`)).toBe("Glow x");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("the Meta front door", () => {
  const meta = {
    clinicName: "Botox Bar Austin",
    phone: "+1 415 555 0199",
    websiteHint: null,
    services: [{ name: "Consultation", priceFromUsd: 150, priceToUsd: 150 }],
    notes: null,
    escalationHours: null,
    requirements: [],
    deferredRequirements: [],
    neverSay: [],
  };

  test("uses a short name only when its guard reads it as the name, never one that names a treatment", () => {
    expect(buildFrontDoorPrompt({ ...meta, clinicName: "Lumen Aesthetics & Wellness" })).toContain("What people call it: Lumen.");
    expect(buildFrontDoorPrompt({ ...meta, clinicName: "Lumen Aesthetics & Wellness", shortName: "Glowy" })).not.toContain("What people call it");
    expect(buildFrontDoorPrompt({ ...meta, shortName: "Botox Bar" })).not.toContain("What people call it");
    expect(guardContextFor({ ...meta, shortName: "Botox Bar" }).shortName).toBeUndefined();
  });

  test("a treatment name stays refused whatever the clinic typed as its short name", () => {
    const context = guardContextFor({ ...meta, shortName: "Botox" });
    expect(guardReply("Botox is popular here.", { ...context, shortName: "Botox" })).toMatchObject({ ok: false, reason: "a treatment name" });
    expect(guardReply("Thanks for messaging Lumen! Call us to book.", guardContextFor({ ...meta, clinicName: "Lumen Aesthetics & Wellness" }))).toMatchObject({
      ok: true,
    });
  });
});
