import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Stripe webhook: where a paid purchase becomes an account.
 *
 * What must hold, from the header of route.ts and plan Part C1:
 * - only a verified event does anything, and a missing secret asks Stripe to
 *   retry rather than acknowledging real sales into the void;
 * - a completed Checkout Session creates nothing: it closes the funnel in the
 *   lead store and spends the setup link;
 * - the FIRST paid invoice provisions from the intent apps/app stored at Pay,
 *   keyed by the subscription id, and the event goes on only once the account
 *   exists. A failure a retry can fix answers 500 and forwards nothing; one it
 *   cannot is logged loudly and forwarded, so the event parks against the
 *   subscription;
 * - refunds go to apps/app with no marker, and one Stripe account's other
 *   app's traffic is skipped.
 *
 * Signatures are made with Stripe's own test signer and verified by the real
 * library, so the test covers the verification the route really runs.
 */

const mocks = vi.hoisted(() => ({
  markConverted: vi.fn(async (_input: unknown) => {}),
  markCheckoutAbandoned: vi.fn(async (_email: string) => {}),
  updateSetupRequest: vi.fn(async (_id: string, _patch: unknown) => {}),
}));

vi.mock("@/lib/leads", () => ({
  markConverted: mocks.markConverted,
  markCheckoutAbandoned: mocks.markCheckoutAbandoned,
}));
vi.mock("@/lib/setup-requests", () => ({ updateSetupRequest: mocks.updateSetupRequest }));

const { POST } = await import("./route");

const WEBHOOK_SECRET = "whsec_test_route";
const PROVISION_SECRET = "provision-test-secret";
const APP = "https://app.internal.test";

type Call = { url: string; body: string; headers: Headers };

let calls: Call[];
let answers: Record<string, () => Response | Promise<Response>>;

function signed(event: Record<string, unknown>): Request {
  const payload = JSON.stringify(event);
  const header = new Stripe("sk_test_route").webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return new Request("https://healdesk.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

function event(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    api_version: "2026-09-30.preview",
    created: 1_791_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

function firstInvoice(metadata: Record<string, string>, billingReason = "subscription_create") {
  return event("invoice.paid", {
    id: "in_1",
    object: "invoice",
    billing_reason: billingReason,
    customer: "cus_1",
    metadata: {},
    parent: {
      type: "subscription_details",
      subscription_details: { metadata, subscription: "sub_1" },
    },
  });
}

/** A healdesk subscription's metadata, as createCheckout writes it. */
const PAID = { app: "healdesk", ref: "ref_1", plan: "web-voice", billingInterval: "year", attempt: "2" };

const SAVED: Record<string, string | undefined> = {};
const ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "HEALDESK_APP_URL",
  "HEALDESK_PROVISION_SECRET",
] as const;

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.STRIPE_SECRET_KEY = "sk_test_route";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.HEALDESK_APP_URL = APP;
  process.env.HEALDESK_PROVISION_SECRET = PROVISION_SECRET;

  calls = [];
  answers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      const answer = answers[new URL(url).pathname];
      return answer ? answer() : Response.json({ ok: true });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const mock of Object.values(mocks)) mock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV) {
    const value = SAVED[key];
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

const paths = () => calls.map((c) => new URL(c.url).pathname);

describe("verification", () => {
  test("a forged or unsigned event is refused, and nothing reaches apps/app", async () => {
    const body = JSON.stringify(firstInvoice({ app: "healdesk", ref: "ref_1" }));
    const forged = await POST(
      new Request("https://healdesk.test/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef" },
        body,
      }),
    );
    expect(forged.status).toBe(400);
    const unsigned = await POST(
      new Request("https://healdesk.test/api/webhooks/stripe", { method: "POST", body }),
    );
    expect(unsigned.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("with the webhook unconfigured, Stripe is asked to retry rather than told it was handled", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const response = await POST(signed(firstInvoice({ app: "healdesk", ref: "ref_1" })));
    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
  });
});

describe("the first paid invoice makes the account", () => {
  test("provisions from the intent, keyed by the subscription, signed, then forwards the event", async () => {
    const response = await POST(signed(firstInvoice(PAID)));
    expect(response.status).toBe(200);
    expect(paths()).toEqual(["/api/provision", "/api/billing/events"]);

    const provision = calls[0]!;
    // With what was paid for, from the subscription's own metadata: apps/app
    // provisions only if the intent still names that press and those terms.
    expect(JSON.parse(provision.body)).toEqual({
      ref: "ref_1",
      idempotencyKey: "sub_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      attempt: 2,
      plan: "web-voice",
      billingInterval: "year",
    });
    const timestamp = provision.headers.get(TIMESTAMP_HEADER)!;
    expect(provision.headers.get(SIGNATURE_HEADER)).toBe(
      sign(provision.body, timestamp, PROVISION_SECRET),
    );
    expect(JSON.parse(calls[1]!.body).type).toBe("invoice.paid");
  });

  test.each([
    ["unreachable", () => Promise.reject(new Error("connect ECONNREFUSED"))],
    ["failing with a 503", () => new Response("down", { status: 503 })],
    ["refusing the signature (a secret mid-rotation)", () => new Response("no", { status: 401 })],
  ])(
    "with apps/app %s, answers 500 and forwards nothing, so Stripe redelivers",
    async (_label, answer) => {
      answers["/api/provision"] = answer;
      const response = await POST(signed(firstInvoice({ app: "healdesk", ref: "ref_1" })));
      expect(response.status).toBe(500);
      expect(paths()).toEqual(["/api/provision"]);
    },
  );

  test("a refusal no retry can fix is logged loudly and the event still goes on", async () => {
    answers["/api/provision"] = () => new Response("bad intent", { status: 422 });
    const response = await POST(signed(firstInvoice({ app: "healdesk", ref: "ref_1" })));
    expect(response.status).toBe(200);
    expect(paths()).toEqual(["/api/provision", "/api/billing/events"]);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain("PROVISIONING REJECTED");
  });

  test("attribution on the subscription never reaches apps/app: provisioning carries the ref, the Stripe ids and the terms paid", async () => {
    await POST(signed(firstInvoice({ ...PAID, demo: "smith-dental-k7q2mz9xwa", leadId: "lead_1" })));
    expect(JSON.parse(calls[0]!.body)).toEqual({
      ref: "ref_1",
      idempotencyKey: "sub_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      attempt: 2,
      plan: "web-voice",
      billingInterval: "year",
    });
  });

  test("a subscription without a press of Pay on it is still relayed, with nulls apps/app refuses loudly", async () => {
    await POST(signed(firstInvoice({ app: "healdesk", ref: "ref_1", attempt: "two" })));
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ attempt: null, plan: null, billingInterval: null });
  });

  test("a renewal invoice, or one with no intent ref, provisions nothing and is forwarded", async () => {
    await POST(signed(firstInvoice({ app: "healdesk", ref: "ref_1" }, "subscription_cycle")));
    await POST(signed(firstInvoice({ app: "healdesk" })));
    expect(paths()).toEqual(["/api/billing/events", "/api/billing/events"]);
  });

  test("another app's first invoice on the shared account touches nothing", async () => {
    const response = await POST(signed(firstInvoice({ app: "scalabid", ref: "ref_1" })));
    expect(await response.json()).toEqual({ received: true, skipped: "not-healdesk" });
    expect(calls).toEqual([]);
  });
});

describe("a completed checkout", () => {
  const session = (overrides: Record<string, unknown> = {}) =>
    event("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      customer_email: "owner@glowspa.test",
      metadata: {
        app: "healdesk",
        ref: "ref_1",
        plan: "web-voice",
        billingInterval: "month",
        setupRequest: "req_1",
      },
      ...overrides,
    });

  test("closes the funnel in the lead store, spends the setup link, and creates nothing", async () => {
    const response = await POST(signed(session()));
    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
    expect(mocks.markConverted).toHaveBeenCalledWith({
      email: "owner@glowspa.test",
      plan: "web-voice",
      mrrUsd: 897,
    });
    expect(mocks.updateSetupRequest).toHaveBeenCalledWith(
      "req_1",
      expect.objectContaining({ status: "paid" }),
    );
  });

  test("an unfinished or foreign Session records nothing", async () => {
    await POST(signed(session({ status: "open" })));
    await POST(signed(session({ metadata: { app: "scalabid" } })));
    expect(mocks.markConverted).not.toHaveBeenCalled();
    expect(mocks.updateSetupRequest).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("a Session completed with its payment still pending spends nothing until the payment succeeds", async () => {
    // A delayed method completes the Session before any money moves. If the
    // payment then failed, a spent link would leave the buyer unable to retry.
    const pending = await POST(signed(session({ payment_status: "unpaid" })));
    expect(await pending.json()).toEqual({ received: true, skipped: "awaiting-payment" });
    expect(mocks.markConverted).not.toHaveBeenCalled();
    expect(mocks.updateSetupRequest).not.toHaveBeenCalled();

    const succeeded = event("checkout.session.async_payment_succeeded", {
      id: "cs_1",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      customer_email: "owner@glowspa.test",
      metadata: { app: "healdesk", ref: "ref_1", plan: "web-voice", billingInterval: "month", setupRequest: "req_1" },
    });
    expect((await POST(signed(succeeded))).status).toBe(200);
    expect(mocks.markConverted).toHaveBeenCalledTimes(1);
    expect(mocks.updateSetupRequest).toHaveBeenCalledWith("req_1", expect.objectContaining({ status: "paid" }));
  });

  test("a setup credit's $0 Session has nothing to pay, and counts as paid", async () => {
    await POST(signed(session({ payment_status: "no_payment_required" })));
    expect(mocks.markConverted).toHaveBeenCalledTimes(1);
    expect(mocks.updateSetupRequest).toHaveBeenCalledTimes(1);
  });
});

describe("refunds", () => {
  const refund = (metadata: Record<string, string>) =>
    event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_1", metadata });

  test("go to apps/app with no marker, quietly, because a charge never carries one", async () => {
    const response = await POST(signed(refund({})));
    expect(response.status).toBe(200);
    expect(paths()).toEqual(["/api/billing/events"]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("another app's refund is skipped", async () => {
    await POST(signed(refund({ app: "scalabid" })));
    expect(calls).toEqual([]);
  });
});
