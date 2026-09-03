import { describe, expect, test } from "vitest";

import { BOOKING_PLATFORMS, detectBooking } from "../src/enrich/booking.ts";

/**
 * The asymmetry that shapes every test here.
 *
 * A false negative costs one clinic: it looks phone-only, gets a slightly wrong
 * pitch, and stays in the campaign. A false positive is worse — it marks a
 * phone-dependent clinic as already-bookable and drops it out of the exact
 * segment this pipeline exists to find, silently and with no error anywhere.
 *
 * So the bias throughout is: refuse to claim a platform unless the URL really
 * says so.
 */

describe("platform detection", () => {
  test("reads the platform off a booking link", () => {
    const result = detectBooking([
      "https://radiancemedspa.com/services",
      "https://clients.mindbodyonline.com/classic/ws?studioid=12345",
    ]);

    expect(result.hasOnlineBooking).toBe(true);
    expect(result.platform).toBe("mindbody");
    expect(result.confidence).toBe("high");
    // The URL itself, so a human can check the finding in one click.
    expect(result.bookingUrl).toContain("mindbodyonline.com");
  });

  test("reports whether healdesk can actually connect to it", () => {
    // This is the field that changes the pitch: a supported platform can be
    // offered verified attribution, everything else gets estimates.
    expect(detectBooking(["https://booking.vagaro.com/x"]).supported).toBe(true);
    expect(detectBooking(["https://booksy.com/en-us/x"]).supported).toBe(false);
  });

  test("prefers the supported platform when a clinic matches two", () => {
    // Mid-migration clinics genuinely run both. The supported one is the more
    // useful answer because it is the one that changes what we can sell.
    const result = detectBooking([
      "https://booksy.com/en-us/12345",
      "https://boulevard.io/x",
      "https://blvd.app/book/radiance",
    ]);

    expect(result.supported).toBe(true);
    expect(result.platform).toBe("boulevard");
    expect(result.allPlatforms).toContain("booksy");
  });
});

describe("what must NOT count as online booking", () => {
  test("a contact form is not booking", () => {
    // The distinction the whole field turns on. A form that emails the clinic
    // still leaves a call for the front desk to make.
    const result = detectBooking([
      "https://clinic.com/contact",
      "https://clinic.com/consultation-request",
    ]);

    expect(result.hasOnlineBooking).toBe(false);
    expect(result.platform).toBeNull();
  });

  test("phone and email links are not booking", () => {
    const result = detectBooking(["tel:+15125551234", "mailto:hi@clinic.com"]);
    expect(result.hasOnlineBooking).toBe(false);
  });

  test("a street address does not make a clinic a Boulevard customer", () => {
    // The canonical false positive, and the reason signatures are domains
    // rather than vendor names.
    const result = detectBooking([
      "https://clinic.com/locations/1200-sunset-boulevard",
      "https://clinic.com/about",
    ]);

    expect(result.platform).toBeNull();
    expect(result.hasOnlineBooking).toBe(false);
  });

  test("an empty crawl reports nothing rather than guessing", () => {
    const result = detectBooking([]);
    expect(result.hasOnlineBooking).toBe(false);
    expect(result.confidence).toBe("none");
    expect(result.bookingUrl).toBeNull();
  });
});

describe("self-hosted booking", () => {
  test("a booking path on their own domain counts, at lower confidence", () => {
    // Real, but weaker: plenty of /booking pages hold only a phone number.
    const result = detectBooking(["https://clinic.com/book-online"]);

    expect(result.hasOnlineBooking).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.platform).toBeNull();
    expect(result.supported).toBe(false);
  });

  test("/contact never becomes self-hosted booking", () => {
    expect(detectBooking(["https://clinic.com/contact-booking"]).hasOnlineBooking)
      .toBe(false);
  });
});

describe("the signature table itself", () => {
  test("no signature is short enough to match by accident", () => {
    // A signature under 6 characters will collide with ordinary URL text.
    for (const platform of BOOKING_PLATFORMS) {
      for (const sig of platform.signatures) {
        expect(sig.length, `${platform.id}: "${sig}"`).toBeGreaterThan(5);
      }
    }
  });

  test("every signature is lowercase, since matching lowercases the URL", () => {
    // An uppercase character here is a signature that can never fire — a silent
    // false negative with no symptom.
    for (const platform of BOOKING_PLATFORMS) {
      for (const sig of platform.signatures) {
        expect(sig, `${platform.id}`).toBe(sig.toLowerCase());
      }
    }
  });

  test("platform ids are unique", () => {
    const ids = BOOKING_PLATFORMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
