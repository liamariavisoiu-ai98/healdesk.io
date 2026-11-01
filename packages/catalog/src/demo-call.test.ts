import { describe, expect, test } from "vitest";

import { demoFirstName, openDemoCallContext, parseDemoCallOffer, sealDemoCallContext, type DemoCallContext } from "./demo-call";

const SECRET = "x".repeat(40);
const CONTEXT: DemoCallContext = {
  v: 1,
  slug: "lumen-aesthetics-ab12",
  mode: "browser",
  firstName: "John",
  issuedAt: 1_800_000_000_000,
  offer: { percentOfSetupFee: 50, endsAt: 1_800_000_000_000 + 48 * 60 * 60_000 },
  test: false,
  buyButton: "Book Onboarding",
  clinic: {
    clinicName: "Lumen Aesthetics",
    summary: "A med spa in Austin.",
    specialty: "med-spa",
    phone: "(512) 555-0100",
    address: "1 Main St, Austin, TX",
    hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
    services: [{ name: "HydraFacial", description: "A deep-cleansing facial.", price: "$199", duration: "45 min" }],
    providers: [{ name: "Dr. Chen", title: "Medical director" }],
    faqs: [{ question: "Do you have parking?", answer: "Yes, free parking behind the building." }],
    policies: ["A $50 deposit holds a booking."],
    booking: "Online or by phone.",
    highlights: ["Voted best med spa in Austin."],
  },
};

describe("the demo call context (owner, 24 October 2026)", () => {
  test("opens what was sealed, and nothing else", () => {
    const sealed = sealDemoCallContext(CONTEXT, SECRET);
    expect(openDemoCallContext(sealed, SECRET, CONTEXT.issuedAt + 1_000)).toEqual(CONTEXT);
    expect(openDemoCallContext(sealed, "y".repeat(40), CONTEXT.issuedAt)).toBeNull();
    const [body, mac] = sealed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...CONTEXT, firstName: "Eve" })).toString("base64url");
    expect(openDemoCallContext(`${forged}.${mac}`, SECRET, CONTEXT.issuedAt)).toBeNull();
    expect(openDemoCallContext(`${body}.`, SECRET, CONTEXT.issuedAt)).toBeNull();
    expect(openDemoCallContext(42, SECRET)).toBeNull();
  });

  test("is refused when stale or from the future", () => {
    const sealed = sealDemoCallContext(CONTEXT, SECRET);
    expect(openDemoCallContext(sealed, SECRET, CONTEXT.issuedAt + 3 * 60 * 60_000)).toBeNull();
    expect(openDemoCallContext(sealed, SECRET, CONTEXT.issuedAt - 5 * 60_000)).toBeNull();
  });

  test("a first name is one typed word, or nothing", () => {
    expect(demoFirstName("  john  doe ")).toBe("john");
    expect(demoFirstName("Zoë")).toBe("Zoë");
    expect(demoFirstName("O'Neil")).toBe("O'Neil");
    expect(demoFirstName("{{caller}}")).toBeNull();
    expect(demoFirstName("1234")).toBeNull();
    expect(demoFirstName("")).toBeNull();
  });

  test("carries which values the demo made up, cleaned, and leaves it out of a context sealed without it", () => {
    const sampled = { prices: ["HydraFacial"], menu: false, hours: true, deposit: false };
    const withSampled: DemoCallContext = { ...CONTEXT, clinic: { ...CONTEXT.clinic, sampled } };
    const opened = openDemoCallContext(sealDemoCallContext(withSampled, SECRET), SECRET, CONTEXT.issuedAt);
    expect(opened).toEqual(withSampled);
    expect(opened!.clinic.sampled).toEqual(sampled);
    expect(openDemoCallContext(sealDemoCallContext(CONTEXT, SECRET), SECRET, CONTEXT.issuedAt)!.clinic).not.toHaveProperty("sampled");
    // A malformed part reads as nothing made up, never as a crash or a stray value.
    const odd = { ...CONTEXT, clinic: { ...CONTEXT.clinic, sampled: { prices: ["Botox", 7, null], menu: "yes", hours: true } } } as unknown as DemoCallContext;
    expect(openDemoCallContext(sealDemoCallContext(odd, SECRET), SECRET, CONTEXT.issuedAt)!.clinic.sampled).toEqual({ prices: ["Botox"], menu: false, hours: true, deposit: false });
  });

  test("cannot be sealed without a secret", () => {
    expect(() => sealDemoCallContext(CONTEXT, "")).toThrow();
  });

  test("a demo without a live discount carries none, and a forged one does not open", () => {
    const sealed = sealDemoCallContext({ ...CONTEXT, offer: null }, SECRET);
    expect(openDemoCallContext(sealed, SECRET, CONTEXT.issuedAt)?.offer).toBeNull();
  });

  test("an operator's test call is marked only when it was sealed so, and only with true", () => {
    expect(openDemoCallContext(sealDemoCallContext({ ...CONTEXT, test: true }, SECRET), SECRET, CONTEXT.issuedAt)?.test).toBe(true);
    expect(openDemoCallContext(sealDemoCallContext(CONTEXT, SECRET), SECRET, CONTEXT.issuedAt)?.test).toBe(false);
    // Anything but the boolean true is not a test call.
    const loose = sealDemoCallContext({ ...CONTEXT, test: "yes" as unknown as boolean }, SECRET);
    expect(openDemoCallContext(loose, SECRET, CONTEXT.issuedAt)?.test).toBe(false);
  });

  test("an offer is a whole percent from 1 to 100 with a real end time, or none", () => {
    expect(parseDemoCallOffer({ percentOfSetupFee: 50, endsAt: 1_000 })).toEqual({ percentOfSetupFee: 50, endsAt: 1_000 });
    expect(parseDemoCallOffer({ percentOfSetupFee: 49.6, endsAt: 1_000 })).toEqual({ percentOfSetupFee: 50, endsAt: 1_000 });
    expect(parseDemoCallOffer({ percentOfSetupFee: 0, endsAt: 1_000 })).toBeNull();
    expect(parseDemoCallOffer({ percentOfSetupFee: 101, endsAt: 1_000 })).toBeNull();
    expect(parseDemoCallOffer({ percentOfSetupFee: 50, endsAt: "soon" })).toBeNull();
    expect(parseDemoCallOffer({ percentOfSetupFee: 50 })).toBeNull();
    expect(parseDemoCallOffer(null)).toBeNull();
    expect(parseDemoCallOffer("50%")).toBeNull();
  });
});
