import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LEGAL_VERSION } from "@/lib/legal";

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
 */

const fake = vi.hoisted(() => ({
  previousStatus: "open",
  created: [] as string[],
  expired: [] as string[],
  sessionAnswer: (): Response => Response.json({ ok: true }),
  intentAnswer: { previousOpenSessionId: null as string | null, attempt: 2 },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async () => {
          fake.created.push("cs_test_new");
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
  plan: "web-voice",
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

function pay(): Promise<Response> {
  counter += 1;
  return POST(
    new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.9.0.${counter}` },
      body: JSON.stringify(ORDER),
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
