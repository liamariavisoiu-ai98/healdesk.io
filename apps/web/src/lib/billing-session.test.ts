import { getPlan, PLAN_START_PLACEHOLDER_LOOKUP_KEY, stripeLookupKey } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Checkout Session the paid path creates: what the card is charged, what
 * Stripe is told, and what happens to the Session a previous press of Pay
 * opened. Stripe is a fake here (the SDK's surface, recorded), so the exact
 * parameters can be read: two line items, cards only, no trial anywhere, the
 * metadata allowlist that binds the payment to one press of Pay and its
 * terms, and the per-press idempotency key.
 */

const fake = vi.hoisted(() => ({
  /** The status `retrieve` reports for a Session id, in order: the last one sticks. */
  statuses: new Map<string, string[]>(),
  /** Ids whose `expire` Stripe refuses. */
  refuseExpire: new Set<string>(),
  calls: [] as string[],
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  listPrices: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = { sessions: { create: fake.create, retrieve: fake.retrieve, expire: fake.expire } };
    prices = { list: fake.listPrices };
  },
}));

const { createCheckout } = await import("./billing");

const REF = "11111111-2222-4333-8444-555555555555";

function input(overrides: { previousOpenSessionId?: string | null; attempt?: number } = {}) {
  return {
    plan: getPlan("web-voice")!,
    interval: "month" as const,
    contactEmail: "owner@glowspa.test",
    intent: {
      ref: REF,
      attempt: overrides.attempt ?? 3,
      successUrl: `http://localhost:3001/welcome?h=${REF}&cs={CHECKOUT_SESSION_ID}`,
      previousOpenSessionId: overrides.previousOpenSessionId ?? null,
    },
    attribution: {
      campaign: "spring-medspa",
      leadId: null,
      offer: null,
      demo: null,
      setupRequestId: "req_1",
    },
  };
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  fake.statuses.clear();
  fake.refuseExpire.clear();
  fake.calls.length = 0;
  fake.create.mockReset().mockImplementation(async () => {
    fake.calls.push("create");
    return { id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" };
  });
  fake.retrieve.mockReset().mockImplementation(async (id: string) => {
    fake.calls.push(`retrieve ${id}`);
    const queue = fake.statuses.get(id) ?? ["open"];
    const status = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { id, status };
  });
  fake.expire.mockReset().mockImplementation(async (id: string) => {
    fake.calls.push(`expire ${id}`);
    if (fake.refuseExpire.has(id)) throw new Error("This Checkout Session is not open.");
    return { id, status: "expired" };
  });
  fake.listPrices
    .mockReset()
    .mockImplementation(async ({ lookup_keys }: { lookup_keys: string[] }) => ({
      data: [{ id: `price_for_${lookup_keys[0]}` }],
    }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Session a press of Pay creates", () => {
  test("charges the setup fee and the $0 plan-start line, by card only, with no trial", async () => {
    const result = await createCheckout(input());
    expect(result).toEqual({
      kind: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_test_new",
      sessionId: "cs_test_new",
    });
    expect(fake.create).toHaveBeenCalledTimes(1);
    const [params] = fake.create.mock.calls[0]! as [Record<string, unknown>, unknown];

    expect(params.mode).toBe("subscription");
    // Cards only (contracts §2): a delayed method completes the Session
    // before any money moves.
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.line_items).toEqual([
      { price: `price_for_${stripeLookupKey(getPlan("web-voice")!, "setup")}`, quantity: 1 },
      { price: `price_for_${PLAN_START_PLACEHOLDER_LOOKUP_KEY}`, quantity: 1 },
    ]);
    // The card is collected even on a $0 total: the plan's first period is charged to it.
    expect(params.payment_method_collection).toBe("always");
    // No trial, anywhere: the owner's rule, and Stripe's trial rules would follow it.
    expect(JSON.stringify(params)).not.toMatch(/trial/);
    expect(params.client_reference_id).toBe(REF);
    expect(params.success_url).toBe(
      `http://localhost:3001/welcome?h=${REF}&cs={CHECKOUT_SESSION_ID}`,
    );
  });

  test("tells Stripe the ref, the press of Pay and its terms, and nothing about the buyer", async () => {
    await createCheckout(input());
    const [params] = fake.create.mock.calls[0]! as [Record<string, unknown>, unknown];
    const marker = {
      app: "healdesk",
      ref: REF,
      plan: "web-voice",
      billingInterval: "month",
      attempt: "3",
    };
    // Exactly the marker on the subscription, which every invoice copies.
    expect(params.subscription_data).toEqual({ metadata: marker });
    // The marker and the attribution ids on the Session: no name, no
    // address, no clinic, no service.
    expect(params.metadata).toEqual({
      ...marker,
      campaign: "spring-medspa",
      setupRequest: "req_1",
    });
  });

  test("is keyed to this press of Pay, so a retried request returns the same Session", async () => {
    await createCheckout(input({ attempt: 7 }));
    const [, options] = fake.create.mock.calls[0]! as [unknown, { idempotencyKey: string }];
    expect(options).toEqual({ idempotencyKey: `checkout:${REF}:7` });
  });
});

describe("the Session the previous press of Pay opened", () => {
  test("is expired before the new one is created, so only one can be paid", async () => {
    const result = await createCheckout(input({ previousOpenSessionId: "cs_test_prev" }));
    expect(result.kind).toBe("redirect");
    expect(fake.calls).toEqual(["retrieve cs_test_prev", "expire cs_test_prev", "create"]);
  });

  test("already paid: nothing is created, and the caller says the purchase is paid", async () => {
    fake.statuses.set("cs_test_prev", ["complete"]);
    const result = await createCheckout(input({ previousOpenSessionId: "cs_test_prev" }));
    expect(result).toEqual({ kind: "already-paid" });
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.expire).not.toHaveBeenCalled();
  });

  test("already expired: nothing to expire, and the new one is created", async () => {
    fake.statuses.set("cs_test_prev", ["expired"]);
    expect((await createCheckout(input({ previousOpenSessionId: "cs_test_prev" }))).kind).toBe(
      "redirect",
    );
    expect(fake.expire).not.toHaveBeenCalled();
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  test("paid in the moment between reading it and expiring it: nothing is created", async () => {
    fake.statuses.set("cs_test_prev", ["open", "complete"]);
    fake.refuseExpire.add("cs_test_prev");
    expect(await createCheckout(input({ previousOpenSessionId: "cs_test_prev" }))).toEqual({
      kind: "already-paid",
    });
    expect(fake.create).not.toHaveBeenCalled();
  });

  test("expired in that moment: the new one is created", async () => {
    fake.statuses.set("cs_test_prev", ["open", "expired"]);
    fake.refuseExpire.add("cs_test_prev");
    expect((await createCheckout(input({ previousOpenSessionId: "cs_test_prev" }))).kind).toBe(
      "redirect",
    );
  });

  test("still open after Stripe refused to expire it: the press fails and creates nothing", async () => {
    fake.refuseExpire.add("cs_test_prev");
    await expect(createCheckout(input({ previousOpenSessionId: "cs_test_prev" }))).rejects.toThrow(
      /not open/,
    );
    expect(fake.create).not.toHaveBeenCalled();
  });

  test("unreadable: the press fails and creates nothing", async () => {
    fake.retrieve.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(createCheckout(input({ previousOpenSessionId: "cs_test_prev" }))).rejects.toThrow(
      /Stripe is down/,
    );
    expect(fake.create).not.toHaveBeenCalled();
  });
});
