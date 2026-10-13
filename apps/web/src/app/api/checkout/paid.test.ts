import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDemoSession, updateDemoSession, __resetDemoCacheForTests } from "@/lib/demo/sessions";
import { LEGAL_VERSION } from "@/lib/legal";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";
import { SITE_OFFER_COOKIE, siteOfferToken } from "@/lib/site-offer";

/**
 * POST /api/checkout on the paid path, with Stripe faked and apps/app
 * stubbed: what the buyer is sent to, and what is refused.
 *
 * - A Session the intent cannot record is expired and its URL never handed
 *   out: no later press of Pay could expire it, and no webhook could bind its
 *   payment to the intent's latest terms. Two presses at once leave one
 *   payable Session, the latest.
 * - A press of Pay after the previous one was paid creates nothing.
 * - Otherwise the buyer goes to Stripe with the /welcome nonce cookie.
 * - The Session carries at most one setup coupon, the strongest offer the
 *   server can establish (the demo's 50% over the website's 30%), and never
 *   one the browser merely names.
 */

const fake = vi.hoisted(() => ({
  previousStatus: "open",
  created: [] as string[],
  params: [] as Record<string, unknown>[],
  expired: [] as string[],
  sessionAnswer: (): Response => Response.json({ ok: true }),
  intentAnswer: { previousOpenSessionId: null as string | null, attempt: 2 },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          fake.created.push("cs_test_new");
          fake.params.push(params);
          return { id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" };
        },
        retrieve: async (id: string) => ({ id, status: fake.previousStatus }),
        expire: async (id: string) => {
          fake.expired.push(id);
          return { id, status: "expired" };
        },
      },
    };
    prices = { list: async () => ({ data: [{ id: "price_test" }] }) };
  },
}));

const { POST } = await import("./route");

const REF = "11111111-2222-4333-8444-555555555555";

const ORDER = {
  plan: "voice-webchat-500-300",
  interval: "month",
  clinicName: "Radiance Med Spa LLC",
  specialty: "med-spa",
  website: "radiancemedspa.com",
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  contactName: "Alex Chen",
  contactEmail: "alex@example.com",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
  covered: "no",
  profile: null,
  profileStatus: "failed",
  termsAccepted: true,
  termsVersion: LEGAL_VERSION,
};

const appCalls: string[] = [];

async function appAnswers(url: URL | RequestInfo): Promise<Response> {
  const path = new URL(String(url)).pathname;
  appCalls.push(path);
  if (path === "/api/checkout/intents/session") return fake.sessionAnswer();
  return Response.json(
    {
      ref: REF,
      attempt: fake.intentAnswer.attempt,
      previousOpenSessionId: fake.intentAnswer.previousOpenSessionId,
      successUrl: `http://localhost:3001/welcome?h=${REF}&cs={CHECKOUT_SESSION_ID}`,
    },
    { status: 201 },
  );
}

let counter = 0;

function pay(options: { cookie?: string; body?: Record<string, unknown> } = {}): Promise<Response> {
  counter += 1;
  return POST(
    new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `10.9.0.${counter}`,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify({ ...ORDER, ...options.body }),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  vi.stubGlobal("fetch", vi.fn(appAnswers));
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.previousStatus = "open";
  fake.created.length = 0;
  fake.params.length = 0;
  fake.expired.length = 0;
  fake.sessionAnswer = () => Response.json({ ok: true });
  fake.intentAnswer = { previousOpenSessionId: null, attempt: 2 };
  appCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the paid path", () => {
  test("a recorded Session sends the buyer to Stripe, with the /welcome nonce cookie", async () => {
    const response = await pay();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_new",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${WELCOME_NONCE_COOKIE}=`);
    expect(cookie).toContain("Path=/welcome");
    expect(appCalls).toEqual(["/api/checkout/intents", "/api/checkout/intents/session"]);
    expect(fake.expired).toEqual([]);
  });

  test("a Session a newer press recorded first is expired, and this press is refused", async () => {
    fake.sessionAnswer = () =>
      Response.json({ error: "That attempt is no longer the open one." }, { status: 409 });
    const response = await pay();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Another payment page was opened; use the latest one.",
    });
    expect(fake.expired).toEqual(["cs_test_new"]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a Session that could not be recorded at all is expired too, and the press fails", async () => {
    fake.sessionAnswer = () => {
      throw new Error("connect ECONNREFUSED");
    };
    const response = await pay();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Nothing has been charged/,
    );
    expect(fake.expired).toEqual(["cs_test_new"]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a press of Pay after the previous one was paid creates nothing", async () => {
    fake.intentAnswer = { previousOpenSessionId: "cs_test_paid", attempt: 2 };
    fake.previousStatus = "complete";
    const response = await pay();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This purchase is already paid. Check your email.",
    });
    expect(fake.created).toEqual([]);
    expect(appCalls).toEqual(["/api/checkout/intents"]);
  });

  test("an open previous Session is expired before the new one is made", async () => {
    fake.intentAnswer = { previousOpenSessionId: "cs_test_prev", attempt: 2 };
    const response = await pay();
    expect(response.status).toBe(200);
    expect(fake.expired).toEqual(["cs_test_prev"]);
    expect(fake.created).toEqual(["cs_test_new"]);
  });
});

describe("the setup offer on the Session", () => {
  const HOUR = 3_600_000;

  beforeEach(() => {
    __setSheetsClientForTests(new FakeSheets());
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
  });

  afterEach(() => __setSheetsClientForTests(null));

  /** The website's offer cookie, shown `hoursAgo` hours ago. */
  function siteCookie(hoursAgo: number): string {
    return `${SITE_OFFER_COOKIE}=${encodeURIComponent(siteOfferToken(new Date(Date.now() - hoursAgo * HOUR))!)}`;
  }

  /** A built personalised demo, ready `hoursAgo` hours ago, and its cookie. */
  async function demoCookie(hoursAgo: number): Promise<string> {
    const readyAt = new Date(Date.now() - hoursAgo * HOUR);
    const demo = await createDemoSession({ clinicName: "Radiance", websiteUrl: "https://radiancemedspa.com/" }, readyAt);
    await updateDemoSession(demo.slug, { status: "ready", readyAt });
    __resetDemoCacheForTests();
    return `hd_demo=${demo.slug}`;
  }

  function discounts(): unknown {
    return fake.params[0]?.discounts;
  }

  test("none without an offer, and none for an offer the browser only names", async () => {
    expect((await pay({ body: { offer: "cohort-setup", coupon: "healdesk-cohort-setup-voice-webchat-95600" } })).status).toBe(200);
    expect(discounts()).toBeUndefined();
    expect((fake.params[0]!.metadata as Record<string, string>).offer).toBeUndefined();
  });

  test("the website's 30% while its signed cookie is inside 48 hours", async () => {
    await pay({ cookie: siteCookie(47) });
    expect(discounts()).toEqual([{ coupon: "healdesk-site-setup-30-voice-webchat-28600" }]);
    expect((fake.params[0]!.metadata as Record<string, string>).offer).toBe("site-setup-30");

    fake.params.length = 0;
    await pay({ cookie: siteCookie(49) });
    expect(discounts()).toBeUndefined();

    fake.params.length = 0;
    await pay({ cookie: `${SITE_OFFER_COOKIE}=${Date.now() - HOUR}.forged` });
    expect(discounts()).toBeUndefined();
  });

  test("the demo's 50% within 48 hours of the demo being ready, over the website's 30%", async () => {
    const demo = await demoCookie(2);
    await pay({ cookie: `${demo}; ${siteCookie(1)}` });
    expect(discounts()).toEqual([{ coupon: "healdesk-demo-setup-50-voice-webchat-47800" }]);
    expect(fake.params[0]!.metadata).toMatchObject({ offer: "demo-setup-50", demo: demo.slice("hd_demo=".length) });
  });

  test("a demo past its 48 hours gives no 50%, and the website's 30% still applies", async () => {
    const demo = await demoCookie(50);
    await pay({ cookie: `${demo}; ${siteCookie(1)}` });
    expect(discounts()).toEqual([{ coupon: "healdesk-site-setup-30-voice-webchat-28600" }]);
  });
});
