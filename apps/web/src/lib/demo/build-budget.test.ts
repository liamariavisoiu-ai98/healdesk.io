import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DemoNotFound } from "@/components/demo/DemoNotFound";

import { runActorUntil } from "./apify";
import { demoFingerprint } from "./audit";
import { withListing } from "./build";
import { buildClinicChatPrompt } from "./clinic-prompts";
import { createBy, FAST_MODE_BETA } from "./fast";
import { demoGaps, gapLabel, listInWords } from "./gaps";
import { cleanClinicName, groundProfile } from "./ground";
import { normalizeProfile, profileToKnowledge } from "./profile";

/**
 * The one-minute build and what it adds (owner, 29 October 2026): reading
 * that keeps what it had when its time ran out, the deterministic check of
 * every figure against the pages, the Google listing filling the website's
 * gaps, the "couldn't find" list in code, and fast mode that falls back to
 * standard speed. The model and Apify are fakes; nothing here spends money.
 */

const PAGES = [
  {
    url: "https://glowmedspa.com/",
    title: "Glow Med Spa",
    text: "Glow Med Spa. Botox from $12/unit. Lip filler $650 per syringe. Invisalign from $1,200. Call (512) 555-0142. Free consultation.",
  },
];

function profile(raw: Record<string, unknown>) {
  return normalizeProfile({ clinic_name: "Glow Med Spa", ...raw }, "Glow Med Spa");
}

describe("reading within the deadline", () => {
  function apify(status: string, items: unknown[] | null) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/runs?")) return Response.json({ data: { id: "run1", status, defaultDatasetId: "ds1" } }, { status: 201 });
      if (u.includes("/datasets/ds1/items")) return Response.json(items ?? []);
      return Response.json({});
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("keeps what a finished run found, and aborts nothing", async () => {
    const { fetchImpl, calls } = apify("SUCCEEDED", [{ url: "a" }, { url: "b" }]);
    const result = await runActorUntil("apify~website-content-crawler", {}, { token: "t", deadline: Date.now() + 20_000, what: "Rendering crawl", fetchImpl });
    expect(result).toEqual({ items: [{ url: "a" }, { url: "b" }], finished: true });
    expect(calls.some((c) => c.includes("/abort"))).toBe(false);
    // The wait never outlasts the window it was given.
    const wait = Number(/waitForFinish=(\d+)/.exec(calls[0]!)?.[1]);
    expect(wait).toBeLessThanOrEqual(18);
  });

  it("keeps the pages a run had finished when the deadline came, and stops the run", async () => {
    const { fetchImpl, calls } = apify("RUNNING", [{ url: "a" }]);
    const result = await runActorUntil("apify~website-content-crawler", {}, { token: "t", deadline: Date.now() + 5_000, what: "Rendering crawl", fetchImpl });
    expect(result).toEqual({ items: [{ url: "a" }], finished: false });
    expect(calls.some((c) => c.endsWith("/actor-runs/run1/abort"))).toBe(true);
  });

  it("says what Apify said when the run cannot start", async () => {
    const fetchImpl = (async () => Response.json({ error: { message: "Not enough credit" } }, { status: 402 })) as unknown as typeof fetch;
    await expect(runActorUntil("x~y", {}, { token: "t", deadline: Date.now() + 5_000, what: "Google listing lookup", fetchImpl })).rejects.toThrow(
      "Google listing lookup: Apify HTTP 402: Not enough credit",
    );
  });
});

describe("the profile, checked against the pages", () => {
  it("drops a price whose figure is not on the pages, keeping the service and every price that is", () => {
    const { profile: grounded, dropped } = groundProfile(
      profile({
        phone: "(512) 555-0142",
        services: [
          { name: "Botox", price: "from $12/unit" },
          { name: "Lip filler", price: "$650" },
          { name: "Invisalign", price: "from $1200" },
          { name: "Consultation", price: "Free" },
          { name: "Hydrafacial", price: "$199" },
        ],
      }),
      PAGES,
    );
    expect(grounded.services.map((s) => [s.name, s.price])).toEqual([
      ["Botox", "from $12/unit"],
      ["Lip filler", "$650"],
      ["Invisalign", "from $1200"],
      ["Consultation", "Free"],
      ["Hydrafacial", null],
    ]);
    expect(dropped).toEqual(['price "$199" for Hydrafacial']);
    expect(grounded.phone).toBe("(512) 555-0142");
  });

  it("drops a phone number the pages never print, but not one from the Google listing", () => {
    expect(groundProfile(profile({ phone: "(512) 555-9999" }), PAGES).profile.phone).toBeNull();
    const fromGoogle = groundProfile(profile({ phone: "(512) 555-9999", phoneSource: "google" }), PAGES).profile;
    expect(fromGoogle.phone).toBe("(512) 555-9999");
    expect(fromGoogle.phoneSource).toBe("google");
  });

  it("takes an SEO tagline off the name and a service listed twice", () => {
    expect(cleanClinicName("Glow Med Spa | Best Botox in Austin")).toBe("Glow Med Spa");
    expect(cleanClinicName("Glow Med Spa - Austin")).toBe("Glow Med Spa");
    expect(cleanClinicName("Smith-Jones Dental")).toBe("Smith-Jones Dental");
    const grounded = groundProfile(profile({ services: [{ name: "Botox" }, { name: "botox " }, { name: "Filler" }] }), PAGES).profile;
    expect(grounded.services.map((s) => s.name)).toEqual(["Botox", "Filler"]);
  });
});

describe("the Google listing on top of the website", () => {
  const listing = {
    place: "Glow Med Spa Austin",
    hours: [{ days: "Monday", hours: "9 AM to 6 PM" }],
    phone: "(512) 555-0000",
    address: "100 Congress Ave, Austin, TX",
    about: ["Parking: free parking lot"],
  };

  it("takes Google's hours, fills the phone and address only where the website gave none, and adds the about lines", () => {
    const merged = withListing(profile({ phone: "(512) 555-0142", hours: [{ days: "Mon", hours: "10-4" }] }), listing, "Glow Med Spa");
    expect(merged.hours).toEqual(listing.hours);
    expect(merged.hoursSource).toBe("google");
    expect(merged.phone).toBe("(512) 555-0142");
    expect(merged.phoneSource).toBe("website");
    expect(merged.address).toBe("100 Congress Ave, Austin, TX");
    expect(merged.addressSource).toBe("google");
    expect(merged.listingFacts).toEqual(["Parking: free parking lot"]);
  });

  it("labels what came from Google, so neither the assistant nor the audit looks for it on the website", () => {
    const text = profileToKnowledge(withListing(profile({}), listing, "Glow Med Spa"));
    expect(text).toContain("Address (from the clinic's Google listing): 100 Congress Ave");
    expect(text).toContain("Front-desk phone (from the clinic's Google listing): (512) 555-0000");
    expect(text).toContain("Opening hours (from the clinic's Google listing):");
    expect(text).toContain("From the clinic's Google listing:\n- Parking: free parking lot");
  });

  it("leaves the website's profile as it was when there is no listing", () => {
    const merged = withListing(profile({ hours: [{ days: "Mon", hours: "10-4" }] }), null, "Glow Med Spa");
    expect(merged.hoursSource).toBe("website");
    expect(merged.listingFacts).toEqual([]);
  });
});

describe("what the demo could not find", () => {
  it("lists only what is missing, in a fixed order", () => {
    const full = profile({
      phone: "1",
      address: "a",
      booking: "Online",
      hours: [{ days: "Mon", hours: "9-5" }],
      services: [{ name: "Botox", price: "$12/unit" }],
      providers: [{ name: "Dr. Lee" }],
      policies: ["48 hours' notice to cancel."],
    });
    expect(demoGaps(full)).toEqual([]);
    expect(demoGaps(profile({ services: [{ name: "Botox", price: "$12" }, { name: "Filler" }] }))).toEqual([
      "some-prices",
      "hours",
      "address",
      "phone",
      "team",
      "booking",
      "policy",
    ]);
    expect(demoGaps(profile({ services: [{ name: "Botox" }] }))[0]).toBe("prices");
    expect(demoGaps(profile({}))[0]).toBe("treatments");
  });

  it("finds a deposit rule in the FAQs too", () => {
    const p = profile({ faqs: [{ question: "Do you take a deposit?", answer: "Yes, $50 when booking." }] });
    expect(demoGaps(p)).not.toContain("policy");
  });

  it("speaks to a vet in its own words", () => {
    expect(gapLabel("treatments", "clients")).toBe("your services");
    expect(gapLabel("booking", "clients")).toBe("how clients book");
    expect(listInWords(["your prices", "your team", "your address"])).toBe("your prices, your team and your address");
  });

  it("is in the clinic information, near the top, so even the voice agent's tight budget keeps it", () => {
    const p = profile({ services: Array.from({ length: 40 }, (_, i) => ({ name: `Treatment ${i}`, description: "x".repeat(250) })) });
    const tight = profileToKnowledge(p, 6_000);
    expect(tight).toContain("Not found on the clinic's website or Google listing (this demo does not know them): prices; opening hours;");
  });

  it("tells the chat to add one short demo note, and never to invent", () => {
    const prompt = buildClinicChatPrompt(profile({}));
    expect(prompt).toContain("(Demo note: I couldn't find this on Glow Med Spa's website or Google listing.");
    expect(prompt).toContain("never invent it");
  });

  it("is a note on the page saying only what was not found, and nothing when nothing is missing", () => {
    const html = renderToStaticMarkup(DemoNotFound({ profile: profile({ services: [{ name: "Botox" }] }), audience: "patients" })!);
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|’/g, "'").replace(/\s+/g, " ");
    expect(text).toContain("What your demo couldn't find");
    expect(text).toContain("couldn't find your prices, your opening hours");
    expect(text).not.toMatch(/found:/i);
    const full = profile({
      phone: "1",
      address: "a",
      booking: "Online",
      hours: [{ days: "Mon", hours: "9-5" }],
      services: [{ name: "Botox", price: "$12/unit" }],
      providers: [{ name: "Dr. Lee" }],
      policies: ["No-show fee $50."],
    });
    expect(DemoNotFound({ profile: full, audience: "patients" })).toBeNull();
  });
});

describe("a demo audited before the new fields", () => {
  it("hashes as it did, so its link can still be mailed", () => {
    const old = {
      clinicName: "Glow Med Spa",
      summary: null,
      specialty: null,
      phone: "(512) 555-0142",
      address: null,
      hours: [],
      hoursSource: null,
      hoursPlace: null,
      services: [],
      providers: [],
      faqs: [],
      policies: [],
      booking: null,
      highlights: [],
    };
    const before = createHash("sha256").update(JSON.stringify(old)).digest("hex").slice(0, 16);
    expect(demoFingerprint(normalizeProfile(old, "Glow Med Spa"))).toBe(before);
    expect(demoFingerprint(normalizeProfile({ ...old, listingFacts: ["Parking: street"] }, "Glow Med Spa"))).not.toBe(before);
  });
});

describe("fast mode, inside a deadline", () => {
  const message = { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" };
  const base = { model: "claude-opus-5-5", max_tokens: 100, betas: ["server-side-fallback-2026-07-01"], messages: [{ role: "user" as const, content: "hi" }] };

  it("asks in fast mode first, beside the request's own betas", async () => {
    const stream = vi.fn((_params: Record<string, unknown>) => ({ finalMessage: async () => message }));
    await createBy({ beta: { messages: { stream } } } as never, base, Date.now() + 10_000);
    expect(stream.mock.calls[0]![0]).toMatchObject({ speed: "fast", betas: ["server-side-fallback-2026-07-01", FAST_MODE_BETA] });
  });

  it("asks once more at standard speed when fast mode is refused or busy", async () => {
    const busy = new Anthropic.RateLimitError(429, { error: { message: "fast mode busy" } }, "busy", new Headers());
    const stream = vi
      .fn()
      .mockImplementationOnce(() => ({ finalMessage: async () => Promise.reject(busy) }))
      .mockImplementationOnce(() => ({ finalMessage: async () => message }));
    const reply = await createBy({ beta: { messages: { stream } } } as never, base, Date.now() + 10_000);
    expect(reply).toBe(message);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[1]![0]).not.toHaveProperty("speed");
    expect(stream.mock.calls[1]![0].betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("does not ask again once the deadline has come", async () => {
    const timeout = new Anthropic.APIConnectionTimeoutError();
    const stream = vi.fn(() => ({ finalMessage: async () => Promise.reject(timeout) }));
    await expect(createBy({ beta: { messages: { stream } } } as never, base, Date.now() + 10_000)).rejects.toBe(timeout);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
