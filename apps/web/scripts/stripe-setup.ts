/**
 * Create the Stripe products and prices for the plan catalog.
 *
 * Run once per Stripe environment (test, then live):
 *
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx apps/web/scripts/stripe-setup.ts
 *
 * ## Why a script rather than the Dashboard
 *
 * The prices exist in two places — packages/catalog/src/plans.ts and Stripe —
 * and a clinic that is shown $249 and charged $449 is the kind of mistake that
 * ends a company. Creating them from the catalog means the two cannot disagree
 * at creation time, and re-running the script reports any drift that appeared
 * afterwards.
 *
 * ## Idempotent by lookup_key, not by name
 *
 * Every price carries a `lookup_key` derived from the plan id and the amount
 * (`healdesk_core_24900`). Re-running finds the existing price by that key and
 * leaves it alone. Prices in Stripe are immutable, so a price CHANGE cannot be
 * an update — it is a new price with a new key, and the old one is deactivated
 * so historical subscriptions keep billing correctly. That is Stripe's model,
 * and fighting it produces silent mis-billing.
 *
 * Nothing here is destructive: products and prices are archived, never deleted.
 */

import { plans, TRIAL_DAYS } from "@healdesk/catalog";
import Stripe from "stripe";

/**
 * What a clinic sees on their card statement.
 *
 * Set explicitly because one Stripe account serves both healdesk and scalabid.
 * Without this a med spa's bank statement reads SCALABID, which generates a
 * support ticket at best and a chargeback at worst — the customer genuinely
 * does not recognise the charge.
 *
 * Stripe allows 5–22 characters, letters/numbers/spaces only.
 */
const STATEMENT_DESCRIPTOR = "HEALDESK";

function lookupKey(planId: string, amountCents: number): string {
  return `healdesk_${planId}_${amountCents}`;
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }

  const live = key.startsWith("sk_live_");
  const stripe = new Stripe(key);

  console.log(
    `\nhealdesk → Stripe (${live ? "LIVE" : "test"} mode)\n` +
      `${plans.length} plans, ${TRIAL_DAYS}-day trial\n`,
  );

  for (const plan of plans) {
    const amountCents = plan.monthlyUsd * 100;
    const key = lookupKey(plan.id, amountCents);

    // Prices carry the lookup_key, so search prices — not products — to decide
    // whether this plan is already set up at this amount.
    const existing = await stripe.prices.list({
      lookup_keys: [key],
      active: true,
      expand: ["data.product"],
      limit: 1,
    });

    if (existing.data[0]) {
      const price = existing.data[0];
      const ok = price.unit_amount === amountCents;
      console.log(
        `  ${ok ? "✓" : "✗"} ${plan.name.padEnd(16)} ${key}` +
          (ok
            ? `  $${plan.monthlyUsd}/mo`
            : `  DRIFT: Stripe has ${(price.unit_amount ?? 0) / 100}, catalog says ${plan.monthlyUsd}`),
      );
      continue;
    }

    // Find or create the product. Products are keyed by metadata rather than
    // name so renaming a plan in the catalog doesn't orphan its Stripe product.
    const products = await stripe.products.search({
      query: `metadata['healdesk_plan_id']:'${plan.id}'`,
      limit: 1,
    });

    const product =
      products.data[0] ??
      (await stripe.products.create({
        name: `healdesk ${plan.name}`,
        description:
          `${plan.includedMinutes.toLocaleString()} voice minutes included, ` +
          `${plan.locations} location${plan.locations === 1 ? "" : "s"}. ` +
          `$${plan.overagePerMinuteUsd.toFixed(2)}/min thereafter.`,
        metadata: { healdesk_plan_id: plan.id },
      }));

    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amountCents,
      recurring: { interval: "month" },
      lookup_key: key,
      metadata: { healdesk_plan_id: plan.id },
    });

    console.log(
      `  + ${plan.name.padEnd(16)} ${key}  $${plan.monthlyUsd}/mo  ${price.id}`,
    );
  }

  // Account-wide default. A per-price descriptor would be better but Stripe
  // sets statement descriptors on the product/account rather than the price for
  // subscriptions, so this is the correct level.
  console.log(
    `\nStatement descriptor should read "${STATEMENT_DESCRIPTOR}".\n` +
      `Set it at dashboard.stripe.com → Settings → Business → ` +
      `Public details → Statement descriptor.\n` +
      `Verify it is NOT the scalabid descriptor — one account serves both.\n`,
  );

  console.log(
    `Next:\n` +
      `  1. Add a webhook endpoint at dashboard.stripe.com → Developers → Webhooks\n` +
      `     URL:    https://<your-domain>/api/webhooks/stripe\n` +
      `     Events: checkout.session.completed, checkout.session.async_payment_succeeded,\n` +
      `             checkout.session.expired\n` +
      `  2. Copy its signing secret into STRIPE_WEBHOOK_SECRET.\n` +
      `  3. Locally: stripe listen --forward-to localhost:3000/api/webhooks/stripe\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
