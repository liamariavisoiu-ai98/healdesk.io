import { randomUUID } from "node:crypto";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST } from "@/app/api/billing/events/route";
import { __setStripeForTests } from "@/lib/billing/stripe-client";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

/**
 * POST /api/billing/events delivers a critical notice after the event's
 * transaction has committed, through `after()`, and only when the event
 * queued one (build spec §11). The sender itself is the email platform's and
 * is replaced here by a spy: what this route owes is the call, its clinic and
 * its moment, never an email.
 */

const deliver = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/email/outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/outbox")>()),
  deliverCriticalAfterCommit: deliver,
}));

const SECRET = "billing-events-route-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;

const describeDb = hasTestDatabase ? describe : describe.skip;

function letters(): string {
  return randomUUID().replace(/-/g, "").replace(/\d/g, "x");
}

function signed(body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request("http://localhost/api/billing/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(raw, timestamp, secret),
    },
    body: raw,
  });
}

function stripeEvent(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_${letters()}`,
    object: "event",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  };
}

describeDb("POST /api/billing/events", () => {
  let clinicId: string;
  const ids = { customer: `cus_${letters()}`, subscription: `sub_${letters()}` };
  const liveInvoices = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinicId = (await seedClinic("route")).clinicId;
    await seedEntitled(clinicId, {
      planStartedAt: new Date(Date.now() - 20 * 24 * 3600_000),
      stripe: { customerId: ids.customer, subscriptionId: ids.subscription },
    });
  }, 60_000);

  beforeEach(() => {
    deliver.mockClear();
    const fake = createStripeFake({
      "invoices.retrieve": (id) => liveInvoices.get(id as string),
      "refunds.list": () => ({ object: "list", has_more: false, data: [] }),
    });
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  function failedInvoice(): Record<string, unknown> {
    const id = `in_${letters()}`;
    const now = Math.floor(Date.now() / 1000);
    const object = {
      id,
      object: "invoice",
      customer: ids.customer,
      billing_reason: "subscription_cycle",
      amount_due: 119_700,
      amount_paid: 0,
      hosted_invoice_url: `https://invoice.stripe.com/i/acct_fixture/${id}`,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: ids.subscription, metadata: { app: "healdesk" } },
      },
      lines: {
        object: "list",
        data: [
          {
            id: `il_${letters()}`,
            amount: 119_700,
            period: { start: now, end: now + 30 * 24 * 3600 },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
            pricing: { type: "price_details", price_details: { price: `price_${letters()}` } },
          },
        ],
      },
    };
    liveInvoices.set(id, { ...object, status: "open" });
    return object;
  }

  test("an event that queued a critical notice hands its billing clinic to the sender, after the commit", async () => {
    const response = await POST(signed(stripeEvent("invoice.payment_failed", failedInvoice())));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      outcome: "processed",
      duplicate: false,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(clinicId, { after: expect.any(Function) });
  });

  test("an event that queued nothing critical calls nothing, and neither does a duplicate", async () => {
    const refund = stripeEvent("charge.refunded", {
      id: `ch_${letters()}`,
      object: "charge",
      customer: ids.customer,
      metadata: {},
    });
    const first = await POST(signed(refund));
    expect(first.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();

    const failed = stripeEvent("invoice.payment_failed", failedInvoice());
    await POST(signed(failed));
    deliver.mockClear();
    const again = await POST(signed(failed));
    expect(await again.json()).toEqual({ received: true, outcome: "processed", duplicate: true });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a request apps/web did not sign is refused before any work", async () => {
    const response = await POST(
      signed(stripeEvent("invoice.payment_failed", failedInvoice()), "not-the-secret"),
    );
    expect(response.status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("an event that failed answers 500 for Stripe's retry, and delivers nothing", async () => {
    // Our marker, and no clinic yet: retryable by design.
    const response = await POST(
      signed(
        stripeEvent("invoice.paid", {
          id: `in_${letters()}`,
          object: "invoice",
          customer: `cus_${letters()}`,
          billing_reason: "subscription_create",
          parent: {
            type: "subscription_details",
            subscription_details: {
              subscription: `sub_${letters()}`,
              metadata: { app: "healdesk" },
            },
          },
          lines: { object: "list", data: [] },
        }),
      ),
    );
    expect(response.status).toBe(500);
    expect(deliver).not.toHaveBeenCalled();
  });
});
