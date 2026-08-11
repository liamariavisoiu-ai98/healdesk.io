import { describe, expect, test } from "vitest";

import { selectAngle } from "../angle.ts";
import type { BookingDetection, MapsPlace } from "../types.ts";

import { detectAdSignals, NO_AD_SIGNAL } from "./ads.ts";
import {
  isFrontDeskRole,
  matchPostingsToClinic,
  summariseHiring,
  NO_HIRING_SIGNAL,
  type JobPosting,
} from "./hiring.ts";

const place = (over: Partial<MapsPlace> = {}): MapsPlace => ({
  placeId: "abc",
  title: "Radiance Med Spa",
  website: "https://radiancemedspa.com",
  phone: "+15551234567",
  reviewsCount: 120,
  totalScore: 4.8,
  ...over,
});

const noBooking: BookingDetection = {
  hasOnlineBooking: false,
  method: "phone_only",
  provider: null,
  source: "footprint",
  matchedSignatures: [],
};

const hasBooking: BookingDetection = {
  hasOnlineBooking: true,
  method: "widget",
  provider: "boulevard",
  source: "footprint",
  matchedSignatures: ["boulevard"],
};

describe("ad signal detection", () => {
  test("distinguishes conversion tracking from plain analytics", () => {
    // Analytics alone means "they measure traffic". A conversion pixel means
    // "they are buying it" — only the second justifies the ad-spend pitch.
    const analyticsOnly = detectAdSignals(
      `<script src="https://www.google-analytics.com/analytics.js"></script>`,
    );
    expect(analyticsOnly.platforms).toContain("google");
    expect(analyticsOnly.hasConversionTracking).toBe(false);

    const converting = detectAdSignals(
      `<script>fbq('init','123'); fbq('track','PageView');</script>`,
    );
    expect(converting.platforms).toContain("meta");
    expect(converting.hasConversionTracking).toBe(true);
  });

  test("detects a Google Ads conversion id", () => {
    const signal = detectAdSignals(
      `<script>gtag('config', 'AW-987654321');</script>`,
    );
    expect(signal.platforms).toContain("google");
    expect(signal.hasConversionTracking).toBe(true);
  });

  test("detects landing-page builders as paid-funnel evidence", () => {
    const signal = detectAdSignals(
      `<div class="ub-container">…</div><script src="//unbounce.com/x.js">`,
    );
    expect(signal.funnelTools).toContain("unbounce");
  });

  test("reports nothing for an ordinary site", () => {
    const signal = detectAdSignals(
      `<html><body><h1>Welcome to our clinic</h1></body></html>`,
    );
    expect(signal.platforms).toEqual([]);
    expect(signal.hasConversionTracking).toBe(false);
  });
});

describe("hiring signal", () => {
  test("recognises front-desk titles", () => {
    for (const title of [
      "Patient Care Coordinator",
      "Front Desk Associate",
      "Medical Receptionist",
      "Scheduling Coordinator",
    ]) {
      expect(isFrontDeskRole(title), title).toBe(true);
    }
  });

  test("excludes clinical and unrelated roles that share keywords", () => {
    // "Patient care technician" is clinical; hotel front desk is a different
    // industry entirely and will appear in any keyword search.
    for (const title of [
      "Patient Care Technician",
      "Medical Assistant",
      "Registered Nurse",
      "Hotel Front Desk Agent",
    ]) {
      expect(isFrontDeskRole(title), title).toBe(false);
    }
  });

  test("treats an old posting as stale", () => {
    // A filled role is worse than no signal — leading with it says we haven't
    // looked at them recently.
    const now = new Date("2026-08-11T00:00:00Z");
    const posting: JobPosting = {
      title: "Front Desk Coordinator",
      company: "Radiance Med Spa",
      location: "Austin, TX",
      url: null,
      postedAt: new Date("2026-05-01T00:00:00Z"),
      source: "indeed",
    };

    expect(summariseHiring([posting], now).isStale).toBe(true);

    const fresh = { ...posting, postedAt: new Date("2026-08-01T00:00:00Z") };
    expect(summariseHiring([fresh], now).isStale).toBe(false);
  });

  test("treats an undated posting as stale", () => {
    const posting: JobPosting = {
      title: "Receptionist",
      company: "Radiance Med Spa",
      location: null,
      url: null,
      postedAt: null,
      source: "indeed",
    };
    // A signal we cannot date is one we should not open an email with.
    expect(summariseHiring([posting]).isStale).toBe(true);
  });

  test("matches company names conservatively", () => {
    const posting = (company: string): JobPosting => ({
      title: "Receptionist",
      company,
      location: null,
      url: null,
      postedAt: new Date(),
      source: "indeed",
    });

    expect(
      matchPostingsToClinic("Radiance Med Spa", [posting("Radiance Medical Spa LLC")]),
    ).toHaveLength(1);

    // A false positive tells an owner we saw them hiring when they weren't,
    // which destroys the credibility the signal was meant to buy.
    expect(
      matchPostingsToClinic("Radiance Med Spa", [posting("Glow Aesthetics")]),
    ).toHaveLength(0);

    // Generic words are stripped, so two unrelated "Med Spa"s must not match.
    expect(
      matchPostingsToClinic("Radiance Med Spa", [posting("Elite Med Spa")]),
    ).toHaveLength(0);
  });
});

describe("outreach angle", () => {
  test("leads with paid traffic when they advertise and cannot be booked online", () => {
    const angle = selectAngle({
      place: place(),
      detection: noBooking,
      ads: detectAdSignals(`<script>fbq('track','Lead')</script>`),
      hiring: NO_HIRING_SIGNAL,
    });

    expect(angle.id).toBe("paid-traffic-leak");
    expect(angle.headline).toMatch(/buying traffic/i);
    // The pitch only works if we can show them something.
    expect(angle.proofLinks.some((l) => l.includes("facebook.com/ads/library"))).toBe(
      true,
    );
  });

  test("still leads with paid traffic when they are bookable, reframed", () => {
    const angle = selectAngle({
      place: place(),
      detection: hasBooking,
      ads: detectAdSignals(`<script>fbq('track','Lead')</script>`),
      hiring: NO_HIRING_SIGNAL,
    });

    expect(angle.id).toBe("paid-traffic-leak");
    expect(angle.headline).toMatch(/by phone/i);
  });

  test("prefers a live hiring signal over a booking gap", () => {
    const angle = selectAngle({
      place: place(),
      detection: noBooking,
      ads: NO_AD_SIGNAL,
      hiring: summariseHiring([
        {
          title: "Patient Care Coordinator",
          company: "Radiance Med Spa",
          location: "Austin, TX",
          url: "https://example.test/job/1",
          postedAt: new Date(),
          source: "indeed",
        },
      ]),
    });

    expect(angle.id).toBe("hiring-front-desk");
    expect(angle.evidence.join(" ")).toMatch(/\$47,000/);
  });

  test("ignores a stale hiring signal", () => {
    const angle = selectAngle({
      place: place(),
      detection: noBooking,
      ads: NO_AD_SIGNAL,
      hiring: summariseHiring(
        [
          {
            title: "Receptionist",
            company: "Radiance Med Spa",
            location: null,
            url: null,
            postedAt: new Date("2026-01-01T00:00:00Z"),
            source: "indeed",
          },
        ],
        new Date("2026-08-11T00:00:00Z"),
      ),
    });

    expect(angle.id).not.toBe("hiring-front-desk");
  });

  test("falls back to a low-confidence angle that says so", () => {
    const angle = selectAngle({
      place: place({ reviewsCount: 3, totalScore: 3.9 }),
      detection: hasBooking,
      ads: NO_AD_SIGNAL,
      hiring: NO_HIRING_SIGNAL,
    });

    expect(angle.id).toBe("generic-leakage");
    expect(angle.evidence.join(" ")).toMatch(/low-confidence/i);
  });
});
