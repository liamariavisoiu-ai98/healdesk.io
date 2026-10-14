import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cspDirectives, permissionsPolicy, PERMISSIONS_POLICY, RETELL_CALL_ORIGINS } from "@/lib/security-headers";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests, DEMO_SESSIONS } from "@/lib/sheets/schema";

import { demoSlugFromCookieHeader } from "./attribution";
import { demoEmail } from "./build";
import { buildClinicChatPrompt, CLINIC_VOICE_GENERAL_PROMPT, clinicVoiceVariables, demoModeLine, spokenName } from "./clinic-prompts";
import { SLOANE_AGENT, SLOANE_PHONE_STYLE } from "./sloane-voice";
import { isUsableProfile, normalizeProfile, profileToKnowledge, type ClinicProfile } from "./profile";
import { assertPublicUrl, dominantColour, htmlToText, parseWebsiteUrl, prioritiseLinks, scrapeBrandForTests, stripBoilerplate } from "./scrape";
import {
  __resetDemoCacheForTests,
  createDemoSession,
  demoOfferEndsAt,
  getDemoSession,
  isDemoActive,
  isDemoSlug,
  makeDemoSlug,
  markDemoClaimed,
  purgeExpiredDemoSessions,
  SELF_SERVE_DEMO,
  updateDemoSession,
} from "./sessions";

/**
 * The personalised demo (src/lib/demo, app/demo/[slug]).
 *
 * What these pin, in order: the profile cannot grow past what a Sheet cell
 * holds and never carries a blank; the scraper refuses private addresses and
 * picks the pages a receptionist would want; the register round-trips through
 * the Sheet, claims once and purges only what it should; the prompts behave
 * like v1 (AI disclosure, the demo-mode disclaimer, no invented prices, no
 * "HIPAA compliant"); and the slug never reaches apps/app or a URL that
 * analytics would record.
 */

const PROFILE: ClinicProfile = normalizeProfile(
  {
    clinic_name: "Smith Dental",
    summary: "Family and cosmetic dentistry in Austin.",
    specialty: "dental",
    phone: "(512) 555-0100",
    address: "1 Congress Ave, Austin, TX",
    hours: [{ days: "Mon–Fri", hours: "8am–5pm" }],
    services: [
      { name: "Teeth whitening", description: "In-office whitening", price: "$399", duration: "60 min" },
      { name: "New patient exam", description: "", price: "", duration: "" },
    ],
    providers: [{ name: "Dr. Jane Smith", title: "DDS" }],
    faqs: [{ question: "Do you have parking?", answer: "Yes, free parking behind the building." }],
    policies: ["24 hours' notice to cancel."],
    booking: "Online booking through the website.",
    highlights: [],
  },
  "Smith Dental",
);

describe("the clinic profile", () => {
  it("turns blanks into nulls and drops entries without a name", () => {
    const p = normalizeProfile(
      { clinic_name: "", services: [{ name: "", price: "$1" }, { name: "Botox", price: "", description: "  " }], specialty: "nope" },
      "Fallback Clinic",
    );
    expect(p.clinicName).toBe("Fallback Clinic");
    expect(p.specialty).toBeNull();
    expect(p.services).toEqual([{ name: "Botox", description: null, price: null, duration: null }]);
  });

  it("caps every list, so a huge menu cannot overflow a Sheet cell", () => {
    const services = Array.from({ length: 500 }, (_, i) => ({ name: `Service ${i}`, description: "x".repeat(2000), price: "$1", duration: "" }));
    const p = normalizeProfile({ clinic_name: "Big", services }, "Big");
    expect(p.services.length).toBe(40);
    expect(JSON.stringify(p).length).toBeLessThan(45_000);
  });

  it("is usable only with services, FAQs or hours", () => {
    expect(isUsableProfile(PROFILE)).toBe(true);
    expect(isUsableProfile(normalizeProfile({ clinic_name: "Empty" }, "Empty"))).toBe(false);
  });

  it("renders prices as listed and fits the voice budget", () => {
    const text = profileToKnowledge(PROFILE);
    expect(text).toContain("Teeth whitening — $399 (60 min)");
    expect(text).toContain("- New patient exam");
    expect(profileToKnowledge({ ...PROFILE, faqs: Array(20).fill(PROFILE.faqs[0]) }, 600).length).toBeLessThanOrEqual(600);
  });
});

describe("the scraper", () => {
  it("normalises what an operator pastes", () => {
    expect(parseWebsiteUrl("smithdental.com").href).toBe("https://smithdental.com/");
    expect(parseWebsiteUrl(" http://smithdental.com/#top ").href).toBe("http://smithdental.com/");
    for (const bad of ["", "ftp://x.com", "https://user:pw@x.com", "https://x.com:8080", "localhost", "intranet.local"]) {
      expect(() => parseWebsiteUrl(bad)).toThrow();
    }
  });

  it("refuses hosts that are private addresses", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "[::1]"]) {
      await expect(assertPublicUrl(new URL(`http://${host}/`))).rejects.toThrow();
    }
  });

  it("reads visible text and skips scripts and styles", () => {
    const text = htmlToText("<head><title>x</title></head><body><script>evil()</script><h1>Services</h1><p>Botox &amp; filler</p><ul><li>One</li></ul></body>");
    expect(text).toContain("Services");
    expect(text).toContain("Botox & filler");
    expect(text).toContain("- One");
    expect(text).not.toContain("evil");
  });

  it("puts pricing and services ahead of the blog, and stays on the site", () => {
    const home = new URL("https://smithdental.com/");
    const link = (href: string, text = "") => ({ url: new URL(href, home), text });
    const picked = prioritiseLinks(
      [
        link("/blog/2024/why-floss", "Why floss"),
        link("https://facebook.com/smith", "Facebook"),
        link("/pricing", "Prices"),
        link("/services", "Our services"),
        link("/about", "About us"),
        link("/menu.pdf", "Menu"),
      ],
      home,
      3,
    ).map((u) => u.pathname);
    expect(picked).toEqual(["/pricing", "/services", "/about"]);
  });

  it("keeps the menu once, on the homepage, not on every page", () => {
    const nav = "Home\nServices\nBook now";
    const pages = ["Welcome", "Botox $12/unit", "Filler $700", "Parking is free"].map((body, i) => ({
      url: `https://x.com/${i}`,
      title: "",
      text: `${nav}\n${body}`,
    }));
    const out = stripBoilerplate(pages);
    expect(out[0]!.text).toBe(`${nav}\nWelcome`);
    expect(out[1]!.text).toBe("Botox $12/unit");
    expect(out[3]!.text).toBe("Parking is free");
  });

  it("takes the clinic's inline SVG logo over a review badge, and strips script from it", () => {
    const html =
      '<img src="/google-logo.png" width="16" alt="Google logo">' +
      '<div class="site-logo"><a href="/"><svg viewBox="0 0 10 10" onload="x()"><script>evil()</script><title>Peachy</title><path d="M0 0h10v10z"/></svg></a></div>';
    const logo = scrapeBrandForTests.logo(html, new URL("https://peachystudio.com/"));
    expect(logo).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(logo!.split(",")[1]!, "base64").toString();
    expect(svg).toContain("<title>Peachy</title>");
    expect(svg).not.toMatch(/script|onload/);
    expect(scrapeBrandForTests.logo('<img src="/google-logo.png" width="16" alt="Google logo">', new URL("https://x.com/"))).toBeNull();
  });

  it("picks the colour somebody chose, not the greys", () => {
    expect(dominantColour("a{color:#333}b{color:#ffffff}c{background:#0a7cff}d{border-color:#0a7cff}")).toBe("#0a7cff");
    expect(dominantColour("a{color:#000}")).toBeNull();
  });
});

describe("the demo register", () => {
  let sheets: FakeSheets;
  beforeEach(() => {
    sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
  });
  afterEach(() => __setSheetsClientForTests(null));

  it("makes unguessable slugs that still read as the clinic", () => {
    const a = makeDemoSlug("Smith Dental & Ortho");
    expect(a).toMatch(/^smith-dental-ortho-[a-z2-9]{10}$/);
    expect(isDemoSlug(a)).toBe(true);
    expect(makeDemoSlug("Smith Dental & Ortho")).not.toBe(a);
    expect(isDemoSlug("smith-dental-demo")).toBe(false);
    expect(isDemoSlug("../../etc")).toBe(false);
  });

  it("round-trips a demo through the Sheet and expires after a week", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const created = await createDemoSession(
      { clinicName: "Smith Dental", websiteUrl: "https://smithdental.com/", leadEmail: "Owner@Smith.com", niche: "dental" },
      now,
    );
    expect(sheets.tabs.get(DEMO_SESSIONS.title)?.length).toBe(2);
    __resetDemoCacheForTests();
    await updateDemoSession(created.slug, { status: "ready", profile: PROFILE as unknown as Record<string, unknown> });
    __resetDemoCacheForTests();

    const read = await getDemoSession(created.slug);
    expect(read?.leadEmail).toBe("owner@smith.com");
    expect(read?.specialty).toBe("dental");
    expect(read?.status).toBe("ready");
    expect(read?.expiresAt.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(isDemoActive(read!, now.getTime())).toBe(true);
    expect(isDemoActive(read!, new Date("2026-10-13T12:00:01Z").getTime())).toBe(false);
  });

  it("holds the demo's 50% off setup for 48 hours from the demo being ready, never past its expiry", async () => {
    const asked = new Date("2026-10-06T12:00:00Z");
    const ready = new Date("2026-10-06T12:20:00Z");
    const HOUR = 3_600_000;
    const created = await createDemoSession({ clinicName: "Smith Dental", websiteUrl: "https://smithdental.com/" }, asked);
    // Still building: nothing to buy from, so no offer.
    expect(demoOfferEndsAt(created, ready.getTime())).toBeNull();

    const built = (await updateDemoSession(created.slug, { status: "ready", readyAt: ready }))!;
    // From when it was ready, not from when it was asked for: a slow build
    // does not eat into the clinic's two days.
    expect(demoOfferEndsAt(built, ready.getTime() + HOUR)?.toISOString()).toBe("2026-10-08T12:20:00.000Z");
    expect(demoOfferEndsAt(built, ready.getTime() + 48 * HOUR - 1)).not.toBeNull();
    expect(demoOfferEndsAt(built, ready.getTime() + 48 * HOUR)).toBeNull();

    // A row from before readyAt was kept counts from its creation.
    expect(demoOfferEndsAt({ ...built, readyAt: null }, asked.getTime() + HOUR)?.toISOString()).toBe(
      "2026-10-08T12:00:00.000Z",
    );
    // A demo that stops opening first ends the offer with it.
    const early = new Date("2026-10-07T00:00:00Z");
    expect(demoOfferEndsAt({ ...built, expiresAt: early }, ready.getTime() + HOUR)?.toISOString()).toBe(
      early.toISOString(),
    );
    expect(demoOfferEndsAt({ ...built, expiresAt: early }, early.getTime())).toBeNull();
  });

  it("claims once, however often Stripe redelivers", async () => {
    const created = await createDemoSession({ clinicName: "Smith Dental", websiteUrl: "https://smithdental.com/" });
    expect((await markDemoClaimed(created.slug, "voice-500"))?.newly).toBe(true);
    const again = await markDemoClaimed(created.slug, "voice-500");
    expect(again?.newly).toBe(false);
    expect(again?.session.claimed).toBe(true);
  });

  it("lets a built, unbought demo open the purchase, and nothing else", async () => {
    const { demoInvitation } = await import("@/lib/setup-gate");
    const demo = await createDemoSession({ clinicName: "Peachy", websiteUrl: "https://peachystudio.com/" });
    const cookie = `a=1; hd_demo_ref=${demo.slug}`;
    expect(await demoInvitation(cookie)).toBeNull(); // still building
    await updateDemoSession(demo.slug, { status: "ready" });
    expect((await demoInvitation(cookie))?.slug).toBe(demo.slug);
    await markDemoClaimed(demo.slug, "voice-500");
    __resetDemoCacheForTests();
    expect(await demoInvitation(cookie)).toBeNull(); // already bought
    expect(await demoInvitation("hd_demo_ref=peachy-zzzzzzzzzz")).toBeNull();
    expect(await demoInvitation(null)).toBeNull();
  });

  it("never lets a demo the visitor asked for on the homepage open the purchase", async () => {
    const { demoInvitation } = await import("@/lib/setup-gate");
    const operators = await createDemoSession({ clinicName: "Smith", websiteUrl: "https://smith.com/", createdBy: "webhook" });
    const visitors = await createDemoSession({ clinicName: "Peachy", websiteUrl: "https://peachystudio.com/", createdBy: "homepage" });
    await updateDemoSession(operators.slug, { status: "ready" });
    await updateDemoSession(visitors.slug, { status: "ready" });
    expect((await demoInvitation(`hd_demo_ref=${operators.slug}`))?.slug).toBe(operators.slug);
    expect(await demoInvitation(`hd_demo_ref=${visitors.slug}`)).toBeNull();
  });

  it("purges demos a month past expiry, and never a claimed one", async () => {
    const old = new Date("2026-08-01T00:00:00Z");
    const stale = await createDemoSession({ clinicName: "Stale", websiteUrl: "https://a.com/" }, old);
    const sold = await createDemoSession({ clinicName: "Sold", websiteUrl: "https://b.com/" }, old);
    await markDemoClaimed(sold.slug, "bundle");
    const fresh = await createDemoSession({ clinicName: "Fresh", websiteUrl: "https://c.com/" }, new Date("2026-10-01T00:00:00Z"));

    expect(await purgeExpiredDemoSessions(30, new Date("2026-10-06T00:00:00Z"))).toBe(1);
    expect(await getDemoSession(stale.slug, { fresh: true })).toBeNull();
    expect(await getDemoSession(sold.slug, { fresh: true })).not.toBeNull();
    expect(await getDemoSession(fresh.slug, { fresh: true })).not.toBeNull();
  });
});

describe("what the demo says", () => {
  const chat = buildClinicChatPrompt(PROFILE);

  it("answers as the clinic, from the clinic's site, as an AI", () => {
    expect(chat).toContain("You are the AI assistant on Smith Dental's website");
    expect(chat).toContain("Never claim to be human.");
    expect(chat).toContain("Teeth whitening — $399");
  });

  it("says the demo-mode line instead of pretending to book or quote", () => {
    expect(demoModeLine("Smith Dental")).toBe(
      "I'm currently operating in demo mode and don't have access to Smith Dental's live pricing or booking calendar yet! In a live environment, I would quote the exact price and instantly book that slot for you. Ready to connect my brain to your systems?",
    );
    expect(chat).toContain(demoModeLine("Smith Dental"));
    expect(chat).toContain("Never say an appointment was booked, held, confirmed or paid for");
    expect(chat).toContain("Never invent, estimate or average a price.");
  });

  it("keeps v1's claims and boundaries, and never says HIPAA compliant", () => {
    expect(chat).toContain("It is inbound only.");
    expect(chat).toContain("Never diagnose, prescribe");
    expect(chat).not.toMatch(/approximate range/);
    // No generic industry prices: only what this clinic published.
    expect(chat).not.toContain("Example US");
    for (const text of [chat, CLINIC_VOICE_GENERAL_PROMPT]) {
      expect(text).not.toMatch(/we are HIPAA compliant|is HIPAA compliant\./i);
      expect(text).not.toMatch(/recovered revenue|revenue report|which call became revenue/i);
    }
  });

  it("opens every voice call with the AI and transcription disclosure", () => {
    for (const mode of ["browser", "inbound", "phone"] as const) {
      const opening = clinicVoiceVariables(PROFILE, mode, "Sam").opening_line!;
      expect(opening).toContain("AI assistant");
      expect(opening).toContain("transcribed");
    }
    expect(clinicVoiceVariables(PROFILE, "phone", "Sam").opening_line).toContain("You asked for this demo call");
    expect(clinicVoiceVariables(PROFILE, "browser").clinic_knowledge!.length).toBeLessThanOrEqual(6_000);
  });

  it("books on the phone as if live, and says it was a demo if asked", () => {
    expect(CLINIC_VOICE_GENERAL_PROMPT).toContain("FOR THIS DEMO YOU HAVE FULL ACCESS TO THE CLINIC'S CALENDAR");
    expect(CLINIC_VOICE_GENERAL_PROMPT).toContain("This is a demo, so nothing went into your real");
    expect(CLINIC_VOICE_GENERAL_PROMPT).not.toContain("demo mode and don't have access");
    // Trained and voiced as AYA is: Sloane's phone style and voice.
    expect(CLINIC_VOICE_GENERAL_PROMPT).toContain(SLOANE_PHONE_STYLE);
    expect(SLOANE_AGENT.voice_id).toBe("retell-Sloane");
  });

  it("says the clinic's name without trademark marks", () => {
    expect(spokenName("Westlake Dermatology & Cosmetic Surgery®")).toBe("Westlake Dermatology & Cosmetic Surgery");
    const opening = clinicVoiceVariables({ ...PROFILE, clinicName: "Glow™ Med Spa" }, "browser").opening_line!;
    expect(opening).toContain("Thank you for calling Glow Med Spa.");
  });

  it("emails the link with the expiry date and a postal address", () => {
    const session = {
      slug: "smith-dental-k7q2mz9xwa",
      clinicName: "Smith Dental",
      brandName: null,
      profile: PROFILE as unknown as Record<string, unknown>,
      expiresAt: new Date("2026-10-13T12:00:00Z"),
    } as Parameters<typeof demoEmail>[0];
    const { subject, text } = demoEmail(session);
    expect(subject).toBe("Custom demo instance ready for Smith Dental");
    expect(text).toContain("/demo/smith-dental-k7q2mz9xwa");
    expect(text).toContain("Tuesday, October 13");
    expect(text).toMatch(/Wilmington, DE/);
  });

  it("offers half off setup until 48 hours after the demo was ready, and never after", () => {
    const readyAt = new Date("2026-10-13T16:00:00Z");
    const session = {
      slug: "smith-dental-k7q2mz9xwa",
      clinicName: "Smith Dental",
      brandName: null,
      status: "ready",
      profile: PROFILE as unknown as Record<string, unknown>,
      createdAt: readyAt,
      readyAt,
      expiresAt: new Date("2026-10-20T16:00:00Z"),
    } as Parameters<typeof demoEmail>[0];
    const fresh = demoEmail(session, readyAt.getTime()).text;
    expect(fresh).toContain("the setup fee is 50% off when you start from the demo page before Thursday, October 15");
    const late = demoEmail(session, readyAt.getTime() + 48 * 3_600_000).text;
    expect(late).not.toMatch(/50%|setup fee/);
    // A demo the visitor asked for on the homepage carries 30%, not half.
    const homepage = demoEmail({ ...session, createdBy: SELF_SERVE_DEMO }, readyAt.getTime()).text;
    expect(homepage).toContain("the setup fee is 30% off");
  });
});

describe("where the slug may go", () => {
  // It rides on the Stripe Session for the lead store and never reaches
  // apps/app: provisioning is relayed as the intent's ref and Stripe ids
  // only, pinned in app/api/webhooks/stripe/route.test.ts.

  it("is read from the onboarding cookie, shape-checked", () => {
    expect(demoSlugFromCookieHeader("a=1; hd_demo_ref=smith-dental-k7q2mz9xwa")).toBe("smith-dental-k7q2mz9xwa");
    expect(demoSlugFromCookieHeader("hd_demo_ref=../../x")).toBeUndefined();
    expect(demoSlugFromCookieHeader(null)).toBeUndefined();
  });
});

describe("the /demo security headers", () => {
  const env = { nodeEnv: "production" } as Parameters<typeof cspDirectives>[0];

  it("open the microphone and Retell's call origins on /demo only", () => {
    const demo = cspDirectives(env, { connectSources: RETELL_CALL_ORIGINS, imageSources: ["https:"], microphone: true });
    expect(demo["connect-src"]).toEqual(expect.arrayContaining([...RETELL_CALL_ORIGINS]));
    expect(demo["img-src"]).toContain("https:");
    expect(permissionsPolicy({ microphone: true })).toContain("microphone=(self)");

    const everywhereElse = cspDirectives(env);
    expect(everywhereElse["connect-src"]).not.toContain("https://api.retellai.com");
    expect(everywhereElse["img-src"]).not.toContain("https:");
    expect(permissionsPolicy()).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toContain("microphone=()");
  });
});

describe("opening hours, for reachable-now vs with AYA", () => {
  it("reads the shapes clinic sites use", async () => {
    const { parseDays, parseSpan, weeklyOpenHours } = await import("./opening-hours");
    expect([...parseDays("Mon–Fri")!]).toEqual([0, 1, 2, 3, 4]);
    expect([...parseDays("Sat & Sun")!]).toEqual([5, 6]);
    expect(parseDays("Daily")!.size).toBe(7);
    expect(parseSpan("9am–6pm")).toBe(9);
    expect(parseSpan("9-5pm")).toBe(8);
    expect(parseSpan("10:00 AM - 4:30 PM")).toBe(6.5);
    expect(parseSpan("10-4")).toBe(6);
    expect(parseSpan("Closed")).toBe(0);
    expect(
      weeklyOpenHours([
        { days: "Mon–Fri", hours: "9am–6pm" },
        { days: "Saturday", hours: "10am–4pm" },
        { days: "Sunday", hours: "Closed" },
      ]),
    ).toEqual({ hours: 51, listed: true });
  });

  it("falls back to a stated assumption rather than a wrong total", async () => {
    const { weeklyOpenHours, ASSUMED_WEEKLY_HOURS } = await import("./opening-hours");
    expect(weeklyOpenHours([])).toEqual({ hours: ASSUMED_WEEKLY_HOURS, listed: false });
    expect(weeklyOpenHours([{ days: "Mon–Fri", hours: "by arrangement with your stylist" }])).toEqual({
      hours: ASSUMED_WEEKLY_HOURS,
      listed: false,
    });
  });
});

describe("Google hours", () => {
  it("takes only a listing on the clinic's own domain, and drops holiday notes", async () => {
    const { pickListing } = await import("./google-hours");
    const items = [
      { title: "Peachy Bakery", website: "https://peachybakes.com", openingHours: [{ day: "Monday", hours: "6 AM to 2 PM" }] },
      {
        title: "Peachy West SoHo",
        website: "https://www.peachystudio.com/pages/soho",
        openingHours: [
          { day: "Monday (Columbus Day)", hours: "9 AM to 7 PM" },
          { day: "Saturday", hours: "9 AM to 5 PM" },
        ],
      },
    ];
    expect(pickListing(items, "https://peachystudio.com/")).toEqual({
      place: "Peachy West SoHo",
      hours: [
        { days: "Monday", hours: "9 AM to 7 PM" },
        { days: "Saturday", hours: "9 AM to 5 PM" },
      ],
    });
    expect(pickListing(items.slice(0, 1), "https://peachystudio.com/")).toBeNull();
  });

  it("reads Google's hours as a weekly total", async () => {
    const { weeklyOpenHours } = await import("./opening-hours");
    const day = (d: string, h: string) => ({ days: d, hours: h });
    expect(
      weeklyOpenHours([
        ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => day(d, "9 AM to 7 PM")),
        day("Saturday", "9 AM to 5 PM"),
        day("Sunday", "9 AM to 5 PM"),
      ]),
    ).toEqual({ hours: 66, listed: true });
  });
});

describe("what each package could book", () => {
  it("takes the middle whole-visit price from the site, skipping free, per-unit and subscription prices", async () => {
    const { typicalVisit, priceFigure } = await import("./roi");
    expect(priceFigure("$425 flat fee")).toBe(425);
    expect(priceFigure("$1,125 (Save $150)")).toBe(1125);
    expect(priceFigure("complimentary")).toBeNull();
    const profile = normalizeProfile(
      {
        clinic_name: "Peachy",
        services: [
          { name: "Complimentary Consultation", price: "complimentary" },
          { name: "Wrinkle Treatment", price: "$425 flat fee" },
          { name: "Masseter Treatment", price: "$525 flat fee" },
          { name: "Botox Facial", price: "$375 flat fee" },
          { name: "Bundle", price: "$1,125" },
          { name: "Retinoids", price: "$80 every 3 months" },
          { name: "Botox by the unit", price: "$14/unit" },
        ],
      },
      "Peachy",
    );
    expect(typicalVisit(profile, { valuePerBooking: 550, basis: "x" })).toEqual({
      priceUsd: 425,
      priceSource: "Wrinkle Treatment, from your website",
    });
    expect(typicalVisit(normalizeProfile({ clinic_name: "A" }, "A"), { valuePerBooking: 550, basis: "One visit" }).priceUsd).toBe(550);
  });

  it("counts only the enquiries a package answers, and does the arithmetic it shows", async () => {
    const { coverage, estimate } = await import("./roi");
    expect(coverage({ channels: { web: false, meta: false, voice: true } })).toEqual({ calls: 1, messages: 0 });
    expect(coverage({ channels: { web: true, meta: false, voice: false } })).toEqual({ calls: 0, messages: 0.5 });
    expect(coverage({ channels: { web: true, meta: true, voice: true } })).toEqual({ calls: 1, messages: 1 });
    const inputs = {
      priceUsd: 425,
      priceSource: "",
      missedCallsPerWeek: 8,
      missedMessagesPerWeek: 4,
      bookingRate: 0.35,
      showRate: 0.85,
      repeat: { visitsPerYear: 3, patient: "Botox and filler patient", why: "" },
    };
    // (8 + 4) × 4.33 × 0.35 × 0.85 = 15.46 patients; × $425 = $6,569 → $6,570.
    expect(estimate({ channels: { web: true, meta: true, voice: true }, monthlyUsd: 1197 }, inputs)).toEqual({
      patientsPerMonth: 15.5,
      bookedValueUsd: 6570,
      multiple: 5.5,
      // 15.46 patients × ($425 × 3 visits) = $19,707 → $19,710.
      yearValueUsd: 19710,
    });
    expect(estimate({ channels: { web: false, meta: false, voice: false }, monthlyUsd: 0 }, inputs).multiple).toBe(0);
  });
});

describe("the site's cookie names", () => {
  // Two cookies with one name and one path are one cookie in the browser: the
  // demo gate and this attribution cookie were both hd_demo until 14 October
  // 2026, so each overwrote the other. Every name this app sets is listed
  // here, and a new one belongs in the list.
  it("are all different, and the attribution cookie is not the demo gate's", async () => {
    const [{ DEMO_COOKIE }, { GATE_COOKIE }, { OPERATOR_COOKIE, STEP_COOKIE }, { SITE_OFFER_COOKIE }, { SETUP_COOKIE }, { DOWNLOAD_COOKIE }, { READ_COOKIE }, { WELCOME_NONCE_COOKIE }] =
      await Promise.all([
        import("./attribution"),
        import("@/lib/gate"),
        import("@/lib/admin/operator"),
        import("@/lib/site-offer"),
        import("@/lib/setup-link"),
        import("@/lib/agreement-download"),
        import("@/app/api/clinic-site/route"),
        import("@healdesk/catalog"),
      ]);
    const names = [DEMO_COOKIE, GATE_COOKIE, OPERATOR_COOKIE, STEP_COOKIE, SITE_OFFER_COOKIE, SETUP_COOKIE, DOWNLOAD_COOKIE, READ_COOKIE, WELCOME_NONCE_COOKIE];
    expect(new Set(names).size).toBe(names.length);
    expect(GATE_COOKIE).toBe("hd_demo"); // the name the Privacy page gives it
    expect(demoSlugFromCookieHeader(`${GATE_COOKIE}=signed.gate.token; ${DEMO_COOKIE}=smith-dental-k7q2mz9xwa`)).toBe("smith-dental-k7q2mz9xwa");
  });
});
