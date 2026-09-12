import { describe, expect, test } from "vitest";

import {
  BOOKING_PLATFORMS,
  detectBooking,
  platformNameFor,
} from "../src/enrich/booking.ts";
import { CNAME_SIGNATURES, SPF_SIGNATURES } from "../src/enrich/dns-probe.ts";

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
    // Real tenant booking URLs. Note what these are NOT: bare `vagaro.com` and
    // `booksy.com/en-us/` both match the vendors' own marketing sites, so
    // neither is evidence that the linking clinic books there. Adversarial
    // verification refuted both, and these fixtures use what replaced them.
    expect(
      detectBooking(["https://www.vagaro.com/us04/radiancemedspa"]).supported,
    ).toBe(true);
    expect(
      detectBooking(["https://booksy.com/en-us/dl/show-business/12345"]).supported,
    ).toBe(false);
  });

  test("prefers the supported platform when a clinic matches two", () => {
    // Mid-migration clinics genuinely run both. The supported one is the more
    // useful answer because it is the one that changes what we can sell.
    const result = detectBooking([
      "https://booksy.com/dl/show-business/12345",
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

  test("a vendor's own marketing URL is not evidence the clinic uses it", () => {
    // Every one of these matched the hand-written table before adversarial
    // verification tightened it. Each is a clinic linking to a vendor's
    // marketing, directory or trial page — a comparison article, a footer
    // credit, an affiliate link — while booking somewhere else entirely.
    for (const marketing of [
      "https://www.vagaro.com/pricing",
      "https://booksy.com/en-us/",
      "https://www.mindbodyonline.com/explore/",
      "https://secure.acuityscheduling.com/signup.php",
      "https://www.zenoti.com/platform/online-booking",
      "https://joinblvd.com/pricing",
    ]) {
      expect(detectBooking([marketing]).platform, marketing).toBeNull();
    }
  });

  test("a GoHighLevel contact form is not a booking widget", () => {
    // The sharpest false positive of the lot. form_embed.js loads for
    // lead-capture forms exactly as it does for calendars, and GoHighLevel is
    // the dominant white-label CRM for med spa marketing agencies — so this
    // would mark a phone-booking clinic running a "Request Info" form as
    // already-bookable, dropping the exact prospect the campaign wants.
    expect(
      detectBooking(["https://link.msgsndr.com/js/form_embed.js"]).hasOnlineBooking,
    ).toBe(false);
    expect(
      detectBooking(["https://api.leadconnectorhq.com/widget/booking/abc123"])
        .platform,
    ).toBe("gohighlevel");
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

  test("every id the DNS probe can report has a display name", () => {
    // The DNS probe reports ids; the reporting column wants names. An id with
    // no entry here falls back to itself, which is how `zenoti` and `Zenoti`
    // ended up as two rows in all-leads.csv, splitting one platform's real
    // footprint across two lines and understating it in every coverage count.
    const probeIds = [...CNAME_SIGNATURES, ...SPF_SIGNATURES].map(([id]) => id);

    for (const id of probeIds) {
      expect(platformNameFor(id), `no display name for "${id}"`).not.toBe(id);
    }
  });
});

describe("regressions the pre-spend audit caught", () => {
  test("every widget-script signature survives the crawler's asset filter", async () => {
    // Uses the crawler's REAL filter, not a copy of it. An earlier version of
    // this test reimplemented the regexes, which meant it could pass while the
    // shipped filter deleted the very URLs these signatures match.
    const { __keepableForTests } = await import("../src/enrich/crawl.ts");

    for (const platform of BOOKING_PLATFORMS) {
      for (const sig of platform.signatures) {
        if (!sig.endsWith(".js")) continue;
        const url = `https://${sig.replace(/^\/+/, "")}`;
        expect(__keepableForTests(url), `${platform.id}: ${sig} filtered out`).toBe(
          true,
        );
      }
    }
  });
});

describe("phone extraction", () => {
  test("prefers tel: links, falls back to text, and drops 555 placeholders", async () => {
    const { __phonesInForTests } = await import("../src/enrich/crawl.ts");

    // A tel: link is what the site says to dial — unambiguous, already
    // normalised by whoever built the page.
    expect(
      __phonesInForTests('<a href="tel:+1 (512) 555-0100">call</a>', ""),
    ).toEqual([]);
    expect(__phonesInForTests('<a href="tel:5124430199">x</a>', "")).toEqual([
      "5124430199",
    ]);

    // Text is the fallback, consulted only when the markup offered nothing, so
    // the noisier source never outranks the explicit one.
    expect(__phonesInForTests("", "Call us at (512) 443-0199 today")).toEqual([
      "5124430199",
    ]);
    expect(
      __phonesInForTests('<a href="tel:5124430199">x</a>', "or (737) 222-3344"),
    ).toEqual(["5124430199"]);

    // 555 is the reserved fictional exchange — a template placeholder, never a
    // clinic, and shipping one into a call-forwarding product would be worse
    // than shipping none.
    expect(__phonesInForTests("", "(555) 123-4567")).toEqual([]);

    // The same number written three ways is one clinic.
    expect(
      __phonesInForTests(
        '<a href="tel:+15124430199">a</a><a href="tel:512.443.0199">b</a>',
        "",
      ),
    ).toEqual(["5124430199"]);
  });
});
