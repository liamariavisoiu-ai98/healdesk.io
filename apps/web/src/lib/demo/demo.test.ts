import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionRequestFromMetadata } from "@/app/api/webhooks/stripe/route";
import { cspDirectives, permissionsPolicy, PERMISSIONS_POLICY, RETELL_CALL_ORIGINS } from "@/lib/security-headers";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests, DEMO_SESSIONS } from "@/lib/sheets/schema";

import { demoSlugFromCookieHeader } from "./attribution";
import { demoEmail } from "./build";
import { buildClinicChatPrompt, CLINIC_VOICE_GENERAL_PROMPT, clinicVoiceVariables, demoModeLine } from "./clinic-prompts";
import { isUsableProfile, normalizeProfile, profileToKnowledge, type ClinicProfile } from "./profile";
import { assertPublicUrl, dominantColour, htmlToText, parseWebsiteUrl, prioritiseLinks, stripBoilerplate } from "./scrape";
import {
  __resetDemoCacheForTests,
  createDemoSession,
  getDemoSession,
  isDemoActive,
  isDemoSlug,
  makeDemoSlug,
  markDemoClaimed,
  purgeExpiredDemoSessions,
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

  it("claims once, however often Stripe redelivers", async () => {
    const created = await createDemoSession({ clinicName: "Smith Dental", websiteUrl: "https://smithdental.com/" });
    expect((await markDemoClaimed(created.slug, "voice"))?.newly).toBe(true);
    const again = await markDemoClaimed(created.slug, "voice");
    expect(again?.newly).toBe(false);
    expect(again?.session.claimed).toBe(true);
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
    for (const mode of ["browser", "phone"] as const) {
      const opening = clinicVoiceVariables(PROFILE, mode, "Sam").opening_line!;
      expect(opening).toContain("AI assistant");
      expect(opening).toContain("transcribed");
    }
    expect(clinicVoiceVariables(PROFILE, "phone", "Sam").opening_line).toContain("You asked for this demo call");
    expect(clinicVoiceVariables(PROFILE, "browser").clinic_knowledge!.length).toBeLessThanOrEqual(6_000);
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
});

describe("where the slug may go", () => {
  it("rides on the Stripe Session but never reaches apps/app", () => {
    const request = provisionRequestFromMetadata({ app: "healdesk", plan: "voice", demo: "smith-dental-k7q2mz9xwa" });
    expect(request).not.toHaveProperty("demo");
  });

  it("is read from the onboarding cookie, shape-checked", () => {
    expect(demoSlugFromCookieHeader("a=1; hd_demo=smith-dental-k7q2mz9xwa")).toBe("smith-dental-k7q2mz9xwa");
    expect(demoSlugFromCookieHeader("hd_demo=../../x")).toBeUndefined();
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
