import { describe, expect, test } from "vitest";

import { selectBookingPage } from "../src/enrich/booking-page.ts";

const crawl = (links: string[], domain = "clinic.com") =>
  ({
    clinicId: "c1",
    domain,
    text: "x",
    links,
    pagesFetched: 1,
  }) as never;

describe("what we refuse to fetch", () => {
  test("never a patient portal or login", () => {
    // This is the guardrail that matters most. An unauthenticated burst against
    // /patient-portal-login across hundreds of US medical practices is the
    // traffic signature of credential-stuffing recon, and under 45 CFR
    // 164.308(a)(6) it can make a covered entity open a documented security
    // incident naming your IP — two weeks before you cold-email them.
    for (const url of [
      "https://clinic.com/patient-portal/",
      "https://clinic.com/about/patient-portal-login/",
      "https://clinic.com/portal",
      "https://clinic.com/new-patient/",
      "https://clinic.com/patient-resources/paperwork/",
      "https://clinic.com/account/login",
      "https://clinic.com/intake",
      "https://clinic.com/billing",
    ]) {
      expect(selectBookingPage(crawl([url])), url).toBeNull();
    }
  });

  test("never a competitor's endpoint", () => {
    // HighLevel's terms bar competitors from using the platform and healdesk is
    // one. Reading the URL out of HTML is not using it; issuing a GET is. The
    // URL is still read and still identifies the vendor, and DNS finds these
    // clinics through their CNAME anyway, so only the request is given up.
    for (const url of [
      "https://api.leadconnectorhq.com/widget/booking/abc",
      "https://link.msgsndr.com/book/xyz",
      "https://sites.ludicrous.cloud/booking",
      "https://bookingbee.ai/schedule-a-demo",
    ]) {
      expect(selectBookingPage(crawl([url])), url).toBeNull();
    }
  });

  test("never another site's page", () => {
    // An off-site booking link is already a vendor hostname, which the
    // signature table has either matched or deliberately not.
    expect(
      selectBookingPage(crawl(["https://someone-else.com/book"], "clinic.com")),
    ).toBeNull();
  });

  test("never when the homepage already answered", () => {
    // Fetching adds nothing once the platform is known, and every avoided
    // request is avoided cost and avoided exposure.
    expect(
      selectBookingPage(
        crawl([
          "https://clients.mindbodyonline.com/x",
          "https://clinic.com/book/",
        ]),
      ),
    ).toBeNull();
  });
});

describe("what we do fetch", () => {
  test("a same-origin booking path, once", () => {
    const t = selectBookingPage(
      crawl([
        "https://clinic.com/about",
        "https://clinic.com/book-online/",
        "https://clinic.com/schedule/",
      ]),
    );
    // One page per clinic. A second doubles cost and exposure for a marginal
    // chance of a different answer.
    expect(t?.url).toBe("https://clinic.com/book-online/");
  });

  test("consultation pages count, since that is how surgical practices book", () => {
    const t = selectBookingPage(crawl(["https://clinic.com/consultation/"]));
    expect(t?.url).toBe("https://clinic.com/consultation/");
  });

  test("nothing to fetch is a valid answer", () => {
    expect(selectBookingPage(crawl(["https://clinic.com/about"]))).toBeNull();
  });
});
