import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  cardExpiry,
  cardMasked,
  checkExpiringCards,
  runCardExpiringJob,
} from "@/lib/billing/card-expiring";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { JOB_CARD_EXPIRING } from "@/lib/scheduler/jobs";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeedEntitledOptions } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

/**
 * The daily card-expiry check (build spec BD16, R16, R22): the card renewals
 * will use is the customer's default, else the subscription's; a notice goes
 * when that card stops working before a renewal due within 30 days, once per
 * card, expiry and renewal; nothing is asked of Stripe for a clinic with no
 * renewal coming.
 */

vi.setConfig({ testTimeout: 30_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-11-02T07:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe("cards, read for the email", () => {
  test("a card works through the last day of its expiry month", () => {
    expect(cardExpiry(11, 2026)).toEqual({
      lastDayOn: "2026-11-30",
      endsAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    expect(cardExpiry(12, 2026).lastDayOn).toBe("2026-12-31");
    expect(cardExpiry(2, 2028).lastDayOn).toBe("2028-02-29");
  });

  test("brand and last four only, masked", () => {
    expect(cardMasked("visa", "4242")).toBe("Visa •••• 4242");
    expect(cardMasked("american_express", "0005")).toBe("American Express •••• 0005");
    expect(cardMasked("unknown", "1234")).toBe("Card •••• 1234");
    expect(cardMasked(null, "1234")).toBe("Card •••• 1234");
  });
});

type Card = { brand: string; exp_month: number; exp_year: number; last4: string };

/** Stripe for several clinics at once, keyed by their ids. */
function stripeFor(
  accounts: {
    [subscriptionId: string]: {
      customer: string;
      subscriptionCard: string | null;
      customerCard: string | null;
    };
  },
  cards: Record<string, Card>,
) {
  const byCustomer = new Map(
    Object.values(accounts).map((account) => [account.customer, account.customerCard]),
  );
  return createStripeFake({
    "subscriptions.retrieve": (id) => ({
      id,
      object: "subscription",
      default_payment_method: accounts[String(id)]!.subscriptionCard,
    }),
    "customers.retrieve": (id) => ({
      id,
      object: "customer",
      invoice_settings: { default_payment_method: byCustomer.get(String(id)) ?? null },
    }),
    "paymentMethods.retrieve": (id) => ({
      id,
      object: "payment_method",
      type: "card",
      card: { ...cards[String(id)]!, display_brand: null },
    }),
  });
}

async function noticesOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices where clinic_id = $1 and kind = 'card_expiring'`,
      [clinicId],
    );
    return rows;
  });
}

/** Started, renewing at `renewsAt`. */
async function seedRenewing(label: string, renewsAt: Date, options: SeedEntitledOptions = {}) {
  const clinic = await seedClinic(label);
  const ids = await seedEntitled(clinic.clinicId, {
    planStartAppliedAt: at(-20 * DAY),
    ...options,
  });
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update entitlements set paid_through = $2 where clinic_id = $1`, [
      clinic.clinicId,
      renewsAt,
    ]),
  );
  return {
    clinicId: clinic.clinicId,
    customer: ids.stripeCustomerId!,
    subscription: ids.stripeSubscriptionId!,
  };
}

describeDb("the card-expiring job (BD16)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(closePools);
  beforeEach(async () => {
    await truncateAll();
  });

  test("queues the notice once, for the card renewals will use, when it lapses before a renewal within 30 days", async () => {
    const renewsAt = at(29 * DAY); // 2026-12-01T07:00Z
    // The customer's default lapses at the end of November; the old card
    // still on the subscription would not, and must not be what is checked.
    const lapsing = await seedRenewing("card-lapsing", renewsAt);
    // No customer default: the subscription's card is the one charged.
    const subscriptionOnly = await seedRenewing("card-sub", renewsAt);
    // Valid past the renewal.
    const fine = await seedRenewing("card-fine", renewsAt);
    // Nothing to check: renewal too far out, not started, cancellation set.
    const far = await seedRenewing("card-far", at(40 * DAY));
    const unstarted = await seedClinic("card-unstarted");
    await seedEntitled(unstarted.clinicId);
    const ending = await seedRenewing("card-ending", renewsAt);
    await inTenant(ending.clinicId, (c) =>
      c.query(`update entitlements set cancel_at = $2 where clinic_id = $1`, [
        ending.clinicId,
        renewsAt,
      ]),
    );

    const fake = stripeFor(
      {
        [lapsing.subscription]: {
          customer: lapsing.customer,
          subscriptionCard: "pm_old_on_subscription",
          customerCard: "pm_customer_default",
        },
        [subscriptionOnly.subscription]: {
          customer: subscriptionOnly.customer,
          subscriptionCard: "pm_subscription_card",
          customerCard: null,
        },
        [fine.subscription]: {
          customer: fine.customer,
          subscriptionCard: null,
          customerCard: "pm_fine",
        },
      },
      {
        pm_customer_default: { brand: "mastercard", exp_month: 11, exp_year: 2026, last4: "4444" },
        pm_old_on_subscription: { brand: "visa", exp_month: 1, exp_year: 2030, last4: "1111" },
        pm_subscription_card: { brand: "visa", exp_month: 10, exp_year: 2026, last4: "4242" },
        pm_fine: { brand: "visa", exp_month: 1, exp_year: 2027, last4: "0001" },
      },
    );

    expect(await checkExpiringCards(NOW, { stripe: fake.stripe })).toEqual({
      considered: 3,
      queued: 2,
      failures: 0,
    });

    // Only the three with a renewal inside the 30 days touched Stripe.
    expect(
      fake
        .callsTo("subscriptions.retrieve")
        .map((call) => call.args[0])
        .sort(),
    ).toEqual([lapsing.subscription, subscriptionOnly.subscription, fine.subscription].sort());
    expect(fake.callsTo("paymentMethods.retrieve").map((call) => call.args[0])).not.toContain(
      "pm_old_on_subscription",
    );
    expect(fake.callsTo("paymentMethods.retrieve")[0]!.args[2]).toEqual({
      timeout: 20_000,
      maxNetworkRetries: 1,
    });

    const lapsingNotices = await noticesOf(lapsing.clinicId);
    expect(lapsingNotices).toEqual([
      {
        dedupe_key: "pm_customer_default:2026-11-30:2026-12-01",
        payload: {
          cardMasked: "Mastercard •••• 4444",
          cardExpiresOn: "2026-11-30",
          renewsOn: "2026-12-01",
        },
      },
    ]);
    expect(() => assertPayloadAllowed(lapsingNotices[0]!.payload, "card_expiring")).not.toThrow();
    expect(await noticesOf(subscriptionOnly.clinicId)).toEqual([
      expect.objectContaining({ dedupe_key: "pm_subscription_card:2026-10-31:2026-12-01" }),
    ]);
    for (const clinicId of [fine.clinicId, far.clinicId, unstarted.clinicId, ending.clinicId]) {
      expect(await noticesOf(clinicId)).toEqual([]);
    }

    // The next day's run finds the same card, expiry and renewal: no second notice.
    expect(await checkExpiringCards(at(DAY), { stripe: fake.stripe })).toMatchObject({ queued: 0 });
    expect(await noticesOf(lapsing.clinicId)).toHaveLength(1);
  });

  test("runs behind its switch and records its run", async () => {
    expect(await runCardExpiringJob({ now: NOW })).toEqual({ status: "disabled" });
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [
      JOB_CARD_EXPIRING,
    ]);
    expect(await runCardExpiringJob({ now: NOW, stripe: createStripeFake().stripe })).toEqual({
      status: "ok",
      note: "0 renewals within 30 days checked, 0 card-expiring notices queued.",
    });
  });
});
