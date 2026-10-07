import { and, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import { depositPayments, stripeConnectEvents, type BillingEventOutcome } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  applyDeauthorization,
  clinicsForStripeAccount,
  stripeKeyMode,
} from "@/lib/billing/connect";
import { recordDepositLapsed, recordDepositPaid } from "@/lib/billing/deposits";
import { getStripe } from "@/lib/billing/stripe-client";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

/**
 * The Connect webhook (BD28, R23): events from clinics' own Stripe accounts,
 * posted by Stripe straight to apps/app (`/api/webhooks/stripe-connect`),
 * never through the marketing site.
 *
 * ## Most of what arrives is not ours, and some of it is a patient's
 *
 * A Standard account's events cover everything on that account, so a clinic
 * that sells on Stripe Checkout itself sends us its own sales, with its
 * patients' details in them. A session is recognised as one of our deposits
 * before any tenant work: our marker (`metadata.hd = "deposit"`), a
 * UUID-shaped `client_reference_id` (the deposit's own id, the only reference
 * we ever give Stripe), and then the stored row's session id. Anything else is
 * `ignored`, with no lookup and no error text. The ledger keeps no payload
 * (`stripe_connect_events`), and its `error` column holds only the closed
 * codes below, never an exception's message, which could quote a value from
 * the event.
 *
 * ## Mode
 *
 * A production Connect endpoint also receives test-mode events, and a
 * Standard account has the same id in both modes. An event whose `livemode`
 * differs from our key's is `ignored` before anything else: a test-mode
 * deauthorization must not disconnect a live clinic, and a test-mode
 * completion must not mark a live deposit paid.
 *
 * ## Which clinic
 *
 * A deposit event finds its clinic through the deposit (the
 * `app_clinic_for_deposit` definer), never through the clinic's current
 * account, so a payment that completes around a disconnect is still recorded;
 * the row's own account must equal `event.account`. A deauthorization applies
 * to every clinic holding the account (`app_clinics_for_stripe_account`), each
 * in its own transaction; one for an account nobody holds any more is
 * `ignored`.
 *
 * ## Retries
 *
 * Like billing_events: claim the id, process, record the outcome. A throw is
 * recorded as `failed` and answered 500 so Stripe retries; the third failure
 * parks it as `dead_letter`, answers 200 and tells ops. Handlers are
 * idempotent by inspection (every write is conditional on the state it
 * expects), because a crash between processing and the ledger update replays
 * the event.
 */

export const CONNECT_MAX_FAILURES = 3;

export const CONNECT_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "account.application.deauthorized",
] as const;

/** What `stripe_connect_events.error` may hold. Never free text. */
export const CONNECT_EVENT_CODES = [
  "livemode_mismatch",
  "unhandled_type",
  "row_not_found",
  "session_mismatch",
  "account_mismatch",
  "amount_mismatch",
  "currency_mismatch",
  "status_conflict",
  "no_clinic",
  "stale_deauthorization",
  "internal_error",
] as const;
export type ConnectEventCode = (typeof CONNECT_EVENT_CODES)[number];

export type ConnectEventResult = {
  outcome: Exclude<BillingEventOutcome, "failed">;
  /** This delivery did nothing because an earlier one had already finished. */
  duplicate: boolean;
  clinicId: string | null;
  code: ConnectEventCode | null;
};

/** A failure worth retrying, then parking, with the code that goes in the ledger. */
class ConnectEventFailure extends Error {
  constructor(readonly code: ConnectEventCode) {
    super(`Connect event failed: ${code}`);
    this.name = "ConnectEventFailure";
  }
}

const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEBHOOK_ACTOR: ActorContext = { type: "service", serviceName: "stripe-connect-webhook" };

function prop(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Apply one verified Connect event. Throws (after recording the failure) when
 * Stripe should retry; returns for everything else, a parked event included.
 */
export async function handleConnectEvent(
  event: Stripe.Event,
  options: { now?: Date } = {},
): Promise<ConnectEventResult> {
  const now = options.now ?? new Date();
  const mode = stripeKeyMode();
  if (!mode) {
    // Without a key we cannot tell live from test. Not recorded: once the key
    // is back, Stripe's retry is processed normally.
    throw new Error("STRIPE_SECRET_KEY is not a live or test key; cannot check event mode.");
  }
  const account = asString(event.account);
  if (!account || !ACCOUNT_ID.test(account)) {
    // A platform event on the Connect endpoint is a misconfiguration, and the
    // ledger needs an account to file it under. Nothing to do.
    return { outcome: "ignored", duplicate: false, clinicId: null, code: null };
  }

  const claimed = await unsafeDb
    .insert(stripeConnectEvents)
    .values({ stripeEventId: event.id, type: event.type, account, receivedAt: now })
    .onConflictDoNothing()
    .returning({ id: stripeConnectEvents.stripeEventId });
  if (claimed.length === 0) {
    const [seen] = await unsafeDb
      .select({
        outcome: stripeConnectEvents.outcome,
        clinicId: stripeConnectEvents.resolvedClinicId,
        error: stripeConnectEvents.error,
      })
      .from(stripeConnectEvents)
      .where(eq(stripeConnectEvents.stripeEventId, event.id))
      .limit(1);
    if (
      seen &&
      (seen.outcome === "processed" || seen.outcome === "ignored" || seen.outcome === "dead_letter")
    ) {
      return {
        outcome: seen.outcome,
        duplicate: true,
        clinicId: seen.clinicId,
        code: (CONNECT_EVENT_CODES as readonly string[]).includes(seen.error ?? "")
          ? (seen.error as ConnectEventCode)
          : null,
      };
    }
    // `failed`, or null (a process died mid-event): this delivery is the retry.
  }

  const context: { clinicId: string | null } = { clinicId: null };
  try {
    if (event.livemode !== (mode === "live")) {
      return await finish(event.id, "ignored", null, "livemode_mismatch", now);
    }
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        return await onDepositSession(event, account, context, now);
      case "account.application.deauthorized":
        return await onDeauthorized(event, account, context, now);
      default:
        return await finish(event.id, "ignored", null, "unhandled_type", now);
    }
  } catch (error) {
    const code = error instanceof ConnectEventFailure ? error.code : "internal_error";
    const failures = await recordFailure(event.id, context.clinicId, code, now);
    if (failures >= CONNECT_MAX_FAILURES) {
      log.error("connect event dead-lettered", {
        eventId: event.id,
        eventType: event.type,
        failures,
        code,
      });
      await notifyOps("connect_event_dead_lettered", {
        eventId: event.id,
        eventType: event.type,
        clinicId: context.clinicId,
        code,
      });
      return { outcome: "dead_letter", duplicate: false, clinicId: context.clinicId, code };
    }
    throw error;
  }
}

/**
 * The four Checkout events on a deposit session. Recognised before any tenant
 * work, resolved through the deposit, verified against the stored row, and
 * applied with writes conditional on the row's state.
 */
async function onDepositSession(
  event: Stripe.Event,
  account: string,
  context: { clinicId: string | null },
  now: Date,
): Promise<ConnectEventResult> {
  const session: unknown = event.data.object;
  const sessionId = asString(prop(session, "id"));
  const ref = asString(prop(session, "client_reference_id"));
  const marker = asString(prop(prop(session, "metadata"), "hd"));
  if (marker !== "deposit" || !ref || !UUID.test(ref) || !sessionId) {
    // The clinic's own Checkout traffic, or anything else we did not create.
    return finish(event.id, "ignored", null, null, now);
  }

  const result = await unsafeDb.execute<{ clinic: string | null }>(
    sql`select app_clinic_for_deposit(${ref}::uuid)::text as clinic`,
  );
  const clinicId = result.rows[0]?.clinic ?? null;
  if (!clinicId) return finish(event.id, "ignored", null, "row_not_found", now);
  context.clinicId = clinicId;

  const applied = await withTenant({ clinicId, actor: WEBHOOK_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({
        id: depositPayments.id,
        status: depositPayments.status,
        sessionId: depositPayments.checkoutSessionId,
        account: depositPayments.stripeAccountId,
        amountCents: depositPayments.amountCents,
        currency: depositPayments.currency,
      })
      .from(depositPayments)
      .where(and(eq(depositPayments.id, ref), eq(depositPayments.clinicId, tx.clinicId)))
      .limit(1)
      .for("update");
    if (!row) throw new ConnectEventFailure("row_not_found");
    // A session we never handed out (one created for a row that then failed)
    // shares the row's reference but not its session id. Nothing to apply.
    if (row.sessionId !== sessionId) return "session_mismatch" as const;
    if (row.account !== account) throw new ConnectEventFailure("account_mismatch");

    if (event.type === "checkout.session.expired") {
      await recordDepositLapsed(tx, {
        depositId: row.id,
        status: "expired",
        from: ["open"],
        eventId: event.id,
        at: now,
      });
      return null;
    }
    if (event.type === "checkout.session.async_payment_failed") {
      await recordDepositLapsed(tx, {
        depositId: row.id,
        status: "failed",
        from: ["open"],
        eventId: event.id,
        at: now,
      });
      return null;
    }
    // completed, or async_payment_succeeded. A completed session whose payment
    // is still settling is not paid yet; the async event follows.
    if (event.type === "checkout.session.completed" && prop(session, "payment_status") !== "paid") {
      return null;
    }
    if (prop(session, "amount_total") !== row.amountCents) {
      throw new ConnectEventFailure("amount_mismatch");
    }
    const currency = asString(prop(session, "currency"));
    if (!currency || currency.toLowerCase() !== row.currency.toLowerCase()) {
      throw new ConnectEventFailure("currency_mismatch");
    }
    if (row.status === "paid" || row.status === "refunded") return null;
    // Money moved on a link we had given up on: a person must look.
    if (row.status !== "open") throw new ConnectEventFailure("status_conflict");
    await recordDepositPaid(tx, { depositId: row.id, eventId: event.id, at: now });
    return null;
  });

  return finish(
    event.id,
    applied === "session_mismatch" ? "ignored" : "processed",
    clinicId,
    applied,
    now,
  );
}

/**
 * Our access to an account was revoked, by the clinic or by our own
 * deauthorize call. Every clinic still holding the account gets the
 * disconnect cascade (lib/billing/connect.ts applyDeauthorization), unless the
 * event predates its current connection.
 */
async function onDeauthorized(
  event: Stripe.Event,
  account: string,
  context: { clinicId: string | null },
  now: Date,
): Promise<ConnectEventResult> {
  const holders = await clinicsForStripeAccount(account);
  if (holders.length === 0) return finish(event.id, "ignored", null, "no_clinic", now);
  const created = new Date(event.created * 1000);
  let applied = 0;
  let stale = 0;
  for (const clinicId of holders) {
    context.clinicId = clinicId;
    const outcome = await applyDeauthorization({
      clinicId,
      accountId: account,
      eventCreatedAt: created,
      now,
    });
    if (outcome === "applied") applied += 1;
    else if (outcome === "stale") stale += 1;
  }
  const first = holders[0] ?? null;
  if (applied === 0) {
    return finish(
      event.id,
      "ignored",
      first,
      stale > 0 ? "stale_deauthorization" : "no_clinic",
      now,
    );
  }
  return finish(event.id, "processed", first, null, now);
}

async function finish(
  eventId: string,
  outcome: "processed" | "ignored",
  clinicId: string | null,
  code: ConnectEventCode | null,
  now: Date,
): Promise<ConnectEventResult> {
  await unsafeDb
    .update(stripeConnectEvents)
    .set({ outcome, resolvedClinicId: clinicId, processedAt: now, error: code })
    .where(eq(stripeConnectEvents.stripeEventId, eventId));
  return { outcome, duplicate: false, clinicId, code };
}

/** One statement, so the count and the outcome it decides cannot disagree under concurrent deliveries. */
async function recordFailure(
  eventId: string,
  clinicId: string | null,
  code: ConnectEventCode,
  now: Date,
): Promise<number> {
  const rows = await unsafeDb
    .update(stripeConnectEvents)
    .set({
      failures: sql`${stripeConnectEvents.failures} + 1`,
      outcome: sql`case when ${stripeConnectEvents.failures} + 1 >= ${CONNECT_MAX_FAILURES} then 'dead_letter' else 'failed' end`,
      error: code,
      resolvedClinicId: clinicId,
      processedAt: now,
    })
    .where(eq(stripeConnectEvents.stripeEventId, eventId))
    .returning({ failures: stripeConnectEvents.failures });
  return rows[0]?.failures ?? CONNECT_MAX_FAILURES;
}

/**
 * Re-run a parked Connect event (E's `replayConnectEvent`). The ledger keeps
 * no payload, so the event is fetched again from the clinic's account
 * (`events.retrieve` with `stripeAccount`), which Stripe allows for 30 days.
 * It is fetched BEFORE the row is reset, so a fetch that fails leaves the row
 * parked rather than looking in flight. Returns null when the id names no
 * failed or parked event.
 */
export async function replayConnectEvent(
  stripeEventId: string,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<ConnectEventResult | null> {
  const [row] = await unsafeDb
    .select({ account: stripeConnectEvents.account })
    .from(stripeConnectEvents)
    .where(
      and(
        eq(stripeConnectEvents.stripeEventId, stripeEventId),
        inArray(stripeConnectEvents.outcome, ["failed", "dead_letter"]),
      ),
    )
    .limit(1);
  if (!row) return null;
  const stripe = options.stripe ?? getStripe();
  const event = await stripe.events.retrieve(
    stripeEventId,
    {},
    { stripeAccount: row.account, timeout: 20_000, maxNetworkRetries: 1 },
  );
  const reset = await unsafeDb
    .update(stripeConnectEvents)
    .set({ outcome: null, failures: 0, error: null, processedAt: null })
    .where(
      and(
        eq(stripeConnectEvents.stripeEventId, stripeEventId),
        inArray(stripeConnectEvents.outcome, ["failed", "dead_letter"]),
      ),
    )
    .returning({ id: stripeConnectEvents.stripeEventId });
  if (reset.length === 0) return null;
  return handleConnectEvent(event, { now: options.now });
}
