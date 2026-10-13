import { describe, expect, test } from "vitest";

import { BOOKING_SYSTEMS } from "./booking-systems";
import { getPlatform } from "./platforms";
import { allPlans, getPlan } from "./plans";
import { agreementPlatformFor, cleanWebsite, planNeedsWebsite } from "./purchase";

/**
 * The purchase rules apps/web and apps/app both apply. Pinned here so that
 * neither side can drift into accepting what the other refuses.
 */

describe("cleanWebsite", () => {
  test("keeps the host and path a buyer means, without the scheme or a trailing slash", () => {
    expect(cleanWebsite("https://GlowMedSpa.com/")).toBe("GlowMedSpa.com");
    expect(cleanWebsite("  http://glowmedspa.com/services//  ")).toBe("glowmedspa.com/services");
    expect(cleanWebsite("glow-med-spa.co.uk")).toBe("glow-med-spa.co.uk");
  });

  test("anything that is not a website is null, never a guess", () => {
    for (const value of [
      "",
      "   ",
      "glowmedspa",
      "not a site.com",
      "ftp://glow.com",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(cleanWebsite(value), String(value)).toBeNull();
    }
  });

  test("is cut at 200 characters before it is checked", () => {
    const long = `glowmedspa.com/${"a".repeat(400)}`;
    expect(cleanWebsite(long)?.length).toBe(200);
  });
});

describe("the website rule", () => {
  test("exactly the plans whose only chat is website chat need a website", () => {
    const needing = new Set(allPlans().filter(planNeedsWebsite).map((plan) => plan.packageId));
    expect([...needing]).toEqual(["webchat", "voice-webchat"]);
  });

  test("a practice with no website can still buy voice and Meta Chat", () => {
    for (const id of ["voice-500", "metachat-300", "voice-metachat-500-300"]) {
      expect(planNeedsWebsite(getPlan(id)!), id).toBe(false);
    }
  });
});

describe("agreementPlatformFor", () => {
  test("names the phase-two platform where the booking system has one, and none otherwise", () => {
    expect(BOOKING_SYSTEMS.map((system) => [system.id, agreementPlatformFor(system.id)])).toEqual([
      ["google_calendar", "none"],
      ["calendly", "none"],
      ["calcom", "calcom"],
      ["gohighlevel", "gohighlevel"],
      ["mindbody", "mindbody"],
      ["boulevard", "boulevard"],
      ["other", "none"],
      ["none", "none"],
    ]);
  });

  test("every value it returns is a platform the signing path knows", () => {
    for (const system of BOOKING_SYSTEMS) {
      expect(getPlatform(agreementPlatformFor(system.id)), system.id).toBeDefined();
    }
  });
});
