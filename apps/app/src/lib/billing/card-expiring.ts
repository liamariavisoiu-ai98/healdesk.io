import { sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import { getEntitlements, hasPlanStarted } from "@/lib/billing/entitlements";
import { enqueueNotice } from "@/lib/billing/notices";
import { getStripe } from "@/lib/billing/stripe-client";
import { effectivePaymentMethod, WORKER_STRIPE_OPTIONS } from "@/lib/billing/stripe-helpers";
import { describeError, log } from "@/lib/log";
import { JOB_CARD_EXPIRING, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

/**
 * The daily card-expiry check (BD16, R16), at 07 UTC: for each started
 * billing clinic with a subscription, read the card renewals will use and
 * queue `card_expiring` when it stops working before a renewal due within
 * 30 days.
 *
 * Why a job: Stripe's own `customer.source.expiring` never fires for cards
 * saved as PaymentMethods, which is how Checkout saves them, so nothing
 * tells us a card is about to lapse unless we look.
 *
 * The card is the one Stripe will charge (R16): the customer's invoice
 * default, else the subscription's own. The plan start moves the card to the
 * customer and clears the subscription's, so a card replaced in the portal is
 * the one checked here from then on. Stripe is called outside any
 * transaction; the notice is queued in the billing clinic's own, once per
 * card, expiry and renewal.
 */

const ACTOR = { type: "service", serviceName: "card-expiring" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead of a renewal the check looks (BD16). */
export const CARD_EXPIRY_LOOKAHEAD_DAYS = 30;

/** No renewal is coming: the plan is ending or over, so a lapsing card does not matter. */
const NO_RENEWAL: ReadonlySet<string> = new Set(["canceling", "canceled", "purged"]);

/** Card networks by Stripe's `brand` and `display_brand` values. */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  american_express: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  diners_club: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  union_pay: "UnionPay",
  cartes_bancaires: "Cartes Bancaires",
  eftpos_au: "eftpos",
  eftpos_australia: "eftpos",
  interac: "Interac",
};

/** Brand and last four only, which is all the payload allowlist lets an email carry. */
export function cardMasked(brand: string | null | undefined, last4: string): string {
  return `${(brand && BRAND_NAMES[brand]) || "Card"} •••• ${last4}`;
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A card works through the last day of its expiry month. Returns that day
 * (the payload's `cardExpiresOn`) and the first instant it no longer works.
 * `expMonth` is Stripe's, 1 to 12, so `Date.UTC(year, expMonth, 1)` is the
 * first of the following month.
 */
export function cardExpiry(expMonth: number, expYear: number): { lastDayOn: string; endsAt: Date } {
  const endsAt = new Date(Date.UTC(expYear, expMonth, 1));
  return { lastDayOn: isoDate(new Date(endsAt.getTime() - DAY_MS)), endsAt };
}

/** Every billing clinic, through the 0008 enumeration definer (ids only). */
async function billingClinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where billing_clinic_id is null`,
  );
  return result.rows.map((row) => String(row.id));
}

export type CardExpiringSummary = { considered: number; queued: number; failures: number };

/** One pass. Exported without the job wrapper so tests drive it at a chosen `now`. */
export async function checkExpiringCards(
  now: Date,
  options: { stripe?: Stripe } = {},
): Promise<CardExpiringSummary> {
  const summary: CardExpiringSummary = { considered: 0, queued: 0, failures: 0 };
  const horizon = now.getTime() + CARD_EXPIRY_LOOKAHEAD_DAYS * DAY_MS;

  for (const clinicId of await billingClinicIds()) {
    try {
      const row = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        getEntitlements(tx.db, clinicId),
      );
      if (!row || !hasPlanStarted(row)) continue;
      if (!row.stripeSubscriptionId || !row.stripeCustomerId || !row.paidThrough) continue;
      if (row.cancelAt !== null || NO_RENEWAL.has(row.status)) continue;
      const renewsAt = row.paidThrough;
      if (renewsAt.getTime() <= now.getTime() || renewsAt.getTime() > horizon) continue;
      summary.considered += 1;

      // Resolved here, not up front: a run in which no clinic is due needs no key.
      const stripe = options.stripe ?? getStripe();
      const subscription = await stripe.subscriptions.retrieve(
        row.stripeSubscriptionId,
        {},
        WORKER_STRIPE_OPTIONS,
      );
      const paymentMethodId = await effectivePaymentMethod(
        stripe,
        { customerId: row.stripeCustomerId, subscription },
        WORKER_STRIPE_OPTIONS,
      );
      if (!paymentMethodId) continue;
      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentMethodId,
        {},
        WORKER_STRIPE_OPTIONS,
      );
      // A bank debit or a wallet has no expiry month to lapse.
      const card = paymentMethod.card;
      if (!card) continue;
      const expiry = cardExpiry(card.exp_month, card.exp_year);
      if (renewsAt.getTime() < expiry.endsAt.getTime()) continue;

      const renewsOn = isoDate(renewsAt);
      const queued = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        enqueueNotice(tx, "card_expiring", `${paymentMethodId}:${expiry.lastDayOn}:${renewsOn}`, {
          cardMasked: cardMasked(card.display_brand ?? card.brand, card.last4),
          cardExpiresOn: expiry.lastDayOn,
          renewsOn,
        }),
      );
      if (queued) summary.queued += 1;
    } catch (error) {
      // One clinic's failure (Stripe down, a deleted customer) must not stop
      // the check for the rest; tomorrow's run tries it again.
      summary.failures += 1;
      log.warn("card expiry check failed for a clinic", { clinicId, error: describeError(error) });
    }
  }
  return summary;
}

/** The `card-expiring` job, daily at 07 UTC from the tick, behind its switch. */
export async function runCardExpiringJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_CARD_EXPIRING,
    async () => {
      const s = await checkExpiringCards(now, { stripe: options.stripe });
      return (
        `${s.considered} renewals within ${CARD_EXPIRY_LOOKAHEAD_DAYS} days checked, ` +
        `${s.queued} card-expiring notices queued` +
        (s.failures ? `, ${s.failures} failed` : "") +
        "."
      );
    },
    now,
  );
}
