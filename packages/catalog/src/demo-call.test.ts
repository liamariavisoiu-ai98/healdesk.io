import { describe, expect, test } from "vitest";

import { demoFirstName, openDemoCallContext, sealDemoCallContext, type DemoCallContext } from "./demo-call";

const SECRET = "x".repeat(40);
const CONTEXT: DemoCallContext = {
  v: 1,
  slug: "lumen-aesthetics-ab12",
  mode: "browser",
  firstName: "John",
  issuedAt: 1_800_000_000_000,
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

  test("cannot be sealed without a secret", () => {
    expect(() => sealDemoCallContext(CONTEXT, "")).toThrow();
  });
});
