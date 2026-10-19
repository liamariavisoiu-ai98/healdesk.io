import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";

import { markIntentFailed, type StoredIntent } from "./intents";
import { sendOrderConfirmedDelayed } from "./order-delayed";

/**
 * A paid purchase that provisioning has not finished, as /api/provision sees
 * it (WP5; Annex X5's I1 list and B3).
 *
 * Provisioning runs inside the Stripe relay's request (apps/web's
 * api/webhooks/stripe → /api/provision), so its retries are Stripe's
 * redeliveries of the first paid invoice, for up to three days. Two facts
 * are kept on the purchase's own row, each in a statement of its own so a
 * provisioning that fails cannot roll it back:
 *
 *   - `paid_seen_at`, the first time a paid relay reached this host for the
 *     purchase. Ten minutes later with no account, the ops watch raises
 *     `paid_intent_without_clinic` (lib/ops/watch.ts). That is the relay's
 *     job and not a signed ops call from apps/web: the relay is already the
 *     one signed request that carries a verified payment here, at the moment
 *     it is made, so nothing new has to cross and apps/web keeps no state for
 *     it. What the relay cannot see is a payment that never reaches this host
 *     at all: the host in standby (apps/web's host wake emails the
 *     administrator, lib/host/wake.ts), or a Sheet apps/web cannot read
 *     (Stripe redelivers, and the first delivery that arrives is seen).
 *   - `provision_failures`, each attempt that ended in a 500 a redelivery
 *     could fix. At PROVISION_DEAD_LETTER_AT the purchase is dead-lettered,
 *     the way a billing event is after its third failure (lib/billing/events.ts
 *     MAX_FAILURES): ops is told (`provisioning_dead_lettered`), the buyer gets
 *     B3 ("one step on our side", with the day we will write by), and /welcome
 *     stops waiting, all through markIntentFailed, whose conditional UPDATE
 *     lets exactly one attempt do it. Unlike a billing event it is not parked:
 *     the route still answers 500, so Stripe keeps redelivering, and a
 *     redelivery that finds the fault gone makes the account and sends B1 as
 *     usual. The account is what was paid for, and provisioning is
 *     idempotent per subscription.
 *
 * A refused purchase (a 422) is not counted here: refuseIntent marks it,
 * tells ops and sends B3 already.
 */

/** Retryable failures before a paid purchase is dead-lettered: billing events' MAX_FAILURES. */
export const PROVISION_DEAD_LETTER_AT = 3;

/** Stamp the first paid relay for a purchase, once. Never throws: provisioning must still run. */
export async function markIntentPaidSeen(ref: string): Promise<void> {
  try {
    await unsafeDb
      .update(checkoutIntents)
      .set({ paidSeenAt: sql`now()` })
      .where(and(eq(checkoutIntents.ref, ref), isNull(checkoutIntents.paidSeenAt)));
  } catch (error) {
    log.error("could not stamp a paid purchase as seen", { error: describeError(error) });
  }
}

export type ProvisionFailure =
  /** Counted; this many failures so far. */
  | { status: "counted"; failures: number }
  /** This failure dead-lettered the purchase: run `afterResponse` once the 500 has gone. */
  | { status: "dead_lettered"; failures: number; intent: StoredIntent }
  /** No unprovisioned purchase with that ref, or the count could not be written. */
  | { status: "not_counted" };

/**
 * Count one retryable failure for a purchase still without an account, and
 * dead-letter it when it reaches PROVISION_DEAD_LETTER_AT. Never throws: it
 * runs on the way out of a failure, and the 500 still has to go.
 */
export async function recordProvisionFailure(ref: string): Promise<ProvisionFailure> {
  try {
    const [row] = await unsafeDb
      .update(checkoutIntents)
      .set({ provisionFailures: sql`${checkoutIntents.provisionFailures} + 1` })
      .where(and(eq(checkoutIntents.ref, ref), isNull(checkoutIntents.consumedAt)))
      .returning({ failures: checkoutIntents.provisionFailures });
    if (!row) return { status: "not_counted" };
    if (row.failures < PROVISION_DEAD_LETTER_AT)
      return { status: "counted", failures: row.failures };
    // Only the attempt that marks it failed tells anyone: a fourth or fifth
    // failure finds it marked, and a purchase refused earlier was told then.
    const intent = await markIntentFailed(ref);
    return intent
      ? { status: "dead_lettered", failures: row.failures, intent }
      : { status: "counted", failures: row.failures };
  } catch (error) {
    log.error("could not count a provisioning failure", { error: describeError(error) });
    return { status: "not_counted" };
  }
}

/**
 * What a dead letter owes, once: ops (`provisioning_dead_lettered`, with the
 * purchase's ref as its request id) and the buyer (B3). Never throws.
 */
export async function announceDeadLetter(intent: StoredIntent, failures: number): Promise<void> {
  await notifyOps("provisioning_dead_lettered", { requestId: intent.ref, attempts: failures });
  try {
    await sendOrderConfirmedDelayed(intent);
  } catch (error) {
    // sendOrderConfirmedDelayed never throws; this is belt and braces.
    log.error("order confirmation not sent", { error: describeError(error) });
  }
}
