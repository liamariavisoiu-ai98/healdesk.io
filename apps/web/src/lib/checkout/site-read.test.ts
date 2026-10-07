import type { ClinicProfile } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  parseStoredSiteRead,
  profileForPurchase,
  type SiteRead,
  siteReadFromAnswer,
  siteReadLine,
} from "./site-read";

/**
 * The website read, from /api/clinic-site's answer to the Review and pay line
 * and the purchase (plan Part B).
 */

function profile(overrides: Partial<ClinicProfile> = {}): ClinicProfile {
  return {
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-10-06T09:30:00.000Z",
    pages: 4,
    locations: [
      {
        label: "Glow Med Spa",
        address: null,
        phone: null,
        hours: { sun: [], mon: [["09:00", "17:00"]], tue: [], wed: [], thu: [], fri: [], sat: [] },
      },
    ],
    services: Array.from({ length: 14 }, (_, i) => ({
      name: `Service ${i + 1}`,
      priceKind: null,
      priceUsd: null,
      maxUsd: null,
      unit: null,
      durationMinutes: null,
    })),
    providers: [
      { name: "Dr. Maya Patel", title: null },
      { name: "Sam Ortiz", title: null },
      { name: "Jo Lee", title: null },
    ],
    policies: [],
    faqs: [],
    acceptsInsurance: "unknown",
    practiceKind: null,
    dropped: 0,
    ...overrides,
  };
}

const read = (p: ClinicProfile = profile()): SiteRead => ({
  status: "read",
  website: p.website,
  profile: p,
});

describe("the Review and pay line", () => {
  test("says what was read, in the plan's words", () => {
    expect(siteReadLine(read(), "glowmedspa.com")).toEqual({
      kind: "read",
      text: "We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup.",
    });
  });

  test("leaves out what was not found, and counts one as one", () => {
    const sparse = profile({
      services: profile().services.slice(0, 1),
      providers: [],
      locations: [{ label: "Glow", address: null, phone: null, hours: null }],
    });
    expect(siteReadLine(read(sparse), "glowmedspa.com").text).toBe(
      "We read glowmedspa.com: 1 service. You'll confirm them in setup.",
    );
  });

  test("is the fallback when nothing usable was found, the read failed, or there is no website", () => {
    const fallback = { kind: "questions", text: "Setup starts with three quick questions." };
    expect(siteReadLine(read(profile({ services: [] })), "glowmedspa.com")).toEqual(fallback);
    expect(siteReadLine({ status: "failed", website: "glowmedspa.com" }, "glowmedspa.com")).toEqual(
      fallback,
    );
    expect(siteReadLine(null, null)).toEqual(fallback);
    expect(siteReadLine(null, "glowmedspa.com")).toEqual(fallback);
  });

  test("a read of another website is not this clinic's", () => {
    expect(siteReadLine(read(), "otherspa.com").kind).toBe("questions");
  });

  test("while the read runs, it says so", () => {
    expect(
      siteReadLine({ status: "pending", website: "glowmedspa.com" }, "glowmedspa.com").kind,
    ).toBe("pending");
  });
});

describe("what the purchase sends", () => {
  test("the profile, only for the website it read", () => {
    expect(profileForPurchase(read(), "glowmedspa.com")).toEqual({
      profile: profile(),
      profileStatus: "read",
    });
    expect(profileForPurchase(read(), "otherspa.com")).toEqual({
      profile: null,
      profileStatus: "failed",
    });
    expect(
      profileForPurchase({ status: "pending", website: "glowmedspa.com" }, "glowmedspa.com"),
    ).toEqual({
      profile: null,
      profileStatus: "failed",
    });
    expect(profileForPurchase(null, null)).toEqual({ profile: null, profileStatus: "none" });
    expect(profileForPurchase(read(), null)).toEqual({ profile: null, profileStatus: "none" });
  });
});

describe("the route's answer", () => {
  test("is a read only when the profile parses and names this website", () => {
    expect(
      siteReadFromAnswer("glowmedspa.com", 200, { status: "read", profile: profile() }),
    ).toEqual(read());
    expect(
      siteReadFromAnswer("otherspa.com", 200, { status: "read", profile: profile() }).status,
    ).toBe("failed");
    expect(
      siteReadFromAnswer("glowmedspa.com", 200, {
        status: "read",
        profile: { ...profile(), extra: 1 },
      }).status,
    ).toBe("failed");
    expect(siteReadFromAnswer("glowmedspa.com", 200, { status: "failed" }).status).toBe("failed");
    expect(siteReadFromAnswer("glowmedspa.com", 429, null).status).toBe("failed");
  });

  test("a stored read is believed only whole", () => {
    expect(parseStoredSiteRead(JSON.parse(JSON.stringify(read())))).toEqual(read());
    expect(
      parseStoredSiteRead({ status: "read", website: "otherspa.com", profile: profile() }),
    ).toBeNull();
    expect(parseStoredSiteRead({ status: "pending", website: "glowmedspa.com" })).toEqual({
      status: "pending",
      website: "glowmedspa.com",
    });
    expect(parseStoredSiteRead({ status: "done" })).toBeNull();
  });
});
