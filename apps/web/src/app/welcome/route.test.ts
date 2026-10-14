import { createHash } from "node:crypto";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordTestPurchase, signTestAgreement } from "@/lib/checkout/records.testing";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * GET /welcome on this site, where Stripe returns the paying browser since
 * 14 October 2026 (docs/design/checkout-records-on-vercel-2026-10-14.md):
 *
 * - a Session Stripe does not call paid, or not this purchase's, gets the
 *   404 page and nothing about any purchase;
 * - a paid one while apps/app is unreachable (in standby) or not ready gets
 *   the waiting page, naming the address the link will go to, masked, only
 *   to the browser that holds the purchase's nonce, and looking again every
 *   15 seconds for 10 minutes;
 * - a paid one apps/app has an answer for is sent on, 303, to the URL apps/app
 *   composed, asked over the signed ops channel.
 */

const fake = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  retrieveFails: false,
  nonce: null as string | null,
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        retrieve: async (id: string) => {
          if (fake.retrieveFails) throw new Error("Stripe did not answer");
          return { id, ...fake.session };
        },
      },
    };
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "hd_welcome" && fake.nonce ? { name, value: fake.nonce } : undefined),
  }),
  headers: async () => new Headers(),
}));

const { GET } = await import("./route");

const REF = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION = "cs_test_paid1";
const NONCE = "the-paying-browsers-nonce";
const PROVISION_SECRET = "test-provision-secret";
const APP_WELCOME = `https://app.healdesk.test/welcome?h=${REF}&cs=${SESSION}`;

type OpsCall = { url: string; body: string; headers: Headers };
let opsCalls: OpsCall[];
let opsAnswer: () => Response | Promise<Response>;

beforeEach(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", PROVISION_SECRET);
  vi.stubEnv("HEALDESK_APP_URL", "https://app-internal.healdesk.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
  fake.session = { status: "complete", payment_status: "paid", metadata: { app: "healdesk", ref: REF, attempt: "1" } };
  fake.retrieveFails = false;
  fake.nonce = NONCE;
  opsCalls = [];
  opsAnswer = () => Promise.reject(new Error("connect ECONNREFUSED"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      opsCalls.push({ url: String(input), body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      return opsAnswer();
    }),
  );

  const agreement = await signTestAgreement({
    clinicName: "Radiance Med Spa LLC",
    specialty: "med-spa",
    covered: "no",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    contactName: "Laura Owner",
    contactEmail: "laura@glowspa.test",
  });
  await recordTestPurchase(agreement, {
    ref: REF,
    attempt: 1,
    sessionId: SESSION,
    nonceHash: createHash("sha256").update(NONCE).digest("hex"),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

function visit(query = `h=${REF}&cs=${SESSION}`): Promise<Response> {
  return GET(new Request(`https://healdesk.test/welcome?${query}`));
}

describe("a payment Stripe does not vouch for", () => {
  test("an unpaid Session is refused, and nothing about the purchase is said or asked", async () => {
    fake.session = { status: "open", payment_status: "unpaid", metadata: { app: "healdesk", ref: REF } };
    const response = await visit();
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("We couldn't find this payment");
    expect(html).not.toContain("glowspa");
    expect(opsCalls).toEqual([]);
  });

  test("a paid Session of another purchase is refused the same way, as is a malformed one", async () => {
    fake.session = { status: "complete", payment_status: "paid", metadata: { app: "healdesk", ref: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" } };
    expect((await visit()).status).toBe(404);
    expect((await visit(`h=${REF}&cs=not-a-session`)).status).toBe(404);
    expect((await visit(`h=nope&cs=${SESSION}`)).status).toBe(404);
    expect(opsCalls).toEqual([]);
  });
});

describe("a paid purchase", () => {
  test("with the host unreachable: the waiting page, the address masked for the paying browser, and a refresh", async () => {
    const response = await visit();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("Payment received. Your account is being set up.");
    expect(html).toContain("l•••@glowspa.test");
    expect(html).not.toContain("laura@glowspa.test");
    expect(html).toMatch(new RegExp(`<meta http-equiv="refresh" content="15;url=/welcome\\?h=${REF}&amp;cs=${SESSION}&amp;t=\\d+">`));
    // It asked apps/app, signed, and only for whether it is ready.
    expect(opsCalls).toHaveLength(1);
    const call = opsCalls[0]!;
    expect(call.url).toBe("https://app-internal.healdesk.test/api/ops");
    expect(JSON.parse(call.body)).toEqual({ op: "welcomeHandoff", args: { ref: REF, sessionId: SESSION } });
    expect(call.headers.get(SIGNATURE_HEADER)).toBe(sign(call.body, call.headers.get(TIMESTAMP_HEADER)!, PROVISION_SECRET));
  });

  test("a browser without the purchase's nonce is not shown whose purchase it is", async () => {
    fake.nonce = "someone-elses";
    const html = await (await visit()).text();
    expect(html).toContain("the address you used at checkout");
    expect(html).not.toContain("glowspa");
  });

  test("apps/app not ready yet is the same waiting page", async () => {
    opsAnswer = () => Response.json({ data: { ready: false } });
    const html = await (await visit()).text();
    expect(html).toContain("Your account is being set up.");
  });

  test("after ten minutes it stops looking and says the link will come by email", async () => {
    const elevenMinutesAgo = Math.floor(Date.now() / 1000) - 11 * 60;
    const html = await (await visit(`h=${REF}&cs=${SESSION}&t=${elevenMinutesAgo}`)).text();
    expect(html).toContain("taking longer than usual");
    expect(html).toContain("l•••@glowspa.test");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("with apps/app ready: 303 to the page apps/app composed", async () => {
    opsAnswer = () => Response.json({ data: { ready: true, url: APP_WELCOME } });
    const response = await visit();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(APP_WELCOME);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("Stripe not answering is not a refusal: the page says it is confirming, and looks again", async () => {
    fake.retrieveFails = true;
    const response = await visit();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("We're confirming your payment.");
    expect(html).toContain('http-equiv="refresh"');
    expect(opsCalls).toEqual([]);
  });
});
