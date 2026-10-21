import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import { clinicLocations, opsAlerts } from "@/db/schema";
import { getEntitlements, hasPlanStarted } from "@/lib/billing/entitlements";
import { packageItemOf, stripeErrorCode, type SubscriptionLike } from "@/lib/billing/metered-items";
import { getStripe, stripeConfigured } from "@/lib/billing/stripe-client";
import { WORKER_STRIPE_OPTIONS } from "@/lib/billing/stripe-helpers";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { JOB_LOCATION_QUANTITY, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

/**
 * The hourly location-quantity check (drizzle/0110, its job seeded off).
 *
 * Since the owner's central model of 20 October 2026, an account's locations
 * are rows of clinic_locations, and its subscription's package item carries
 * a quantity: the locations it pays for. Each add moves both (addLocation,
 * lib/billing/stripe-actions.ts), but nothing compared them afterwards. A
 * quantity changed by hand in the Stripe Dashboard, a location retired with
 * the quantity left as it was, or an add whose charge went through while its
 * location was never made active would bill a practice for locations it
 * does not have, or answer for ones it does not pay for, and nobody would
 * hear of it until the practice read its invoice.
 *
 * For every billing clinic with a subscription whose plan has started, the
 * check reads Stripe's quantity on the package item and compares it with
 * what the account should pay for: its active locations, plus the location
 * being added when that add's charge is on record (its row still pending
 * until app_activate_location() runs, and the reconcile finishes it).
 *
 * READ-ONLY. One `subscriptions.retrieve` per account, through the platform
 * client; it never updates a subscription, never charges and never contacts
 * a clinic or a patient. Deciding which side is right is a person's job: a
 * quantity too high may be a refund owed, one too low an add to finish.
 *
 * Accounts it leaves alone, and says so in its summary:
 *   - no subscription, an ended one, or a status that is over;
 *   - a plan not started yet: the subscription carries the $0 placeholder,
 *     and a location added before the start joins the quantity at the start;
 *   - a Stripe change in flight (the mutation lease held), or an add pending
 *     whose charge is not recorded yet: the two sides are allowed to differ
 *     for the minutes that takes, and the next hour reads them again;
 *   - a billing group of the retired model (another clinic billed to this
 *     one), whose locations are not this tenant's rows.
 *
 * ONE ALERT PER EPISODE. A mismatch raises `location_quantity_drift` once,
 * keyed on the clinic and the moment the episode was first seen
 * (`windowStart`); later hours that find it still there raise nothing. The
 * first hour the counts agree again raises `location_quantity_agrees` once
 * for that episode, which ends it, so a later mismatch is a new episode and
 * is told again. The ops log (ops_alerts) is the episode's record: the
 * latest of the two events for the clinic says whether one is open. Ids,
 * counts and times only; no name, no address, no treatment.
 */

const ACTOR = { type: "service", serviceName: "location-quantity" } as const;

export const LOCATION_QUANTITY_DRIFT_EVENT = "location_quantity_drift";
export const LOCATION_QUANTITY_AGREES_EVENT = "location_quantity_agrees";

/** Statuses whose subscription is over or going: nothing left to bill for locations. */
const OVER: ReadonlySet<string> = new Set(["canceled", "purged"]);

export type LocationQuantityOutcome =
  | { status: "agrees"; locations: number }
  | { status: "drift"; locations: number; billed: number }
  | {
      status: "skipped";
      reason:
        | "no_entitlements"
        | "no_subscription"
        | "ended"
        | "not_started"
        | "in_flight"
        | "group"
        | "no_package_item";
    };

export type LocationQuantitySummary = {
  accounts: number;
  agree: number;
  drift: number;
  /** Drift episodes told to ops this run (new ones only). */
  alerted: number;
  /** Episodes that ended this run. */
  cleared: number;
  skipped: number;
  failures: number;
};

/** What the account should pay for: its active locations, and an add whose charge is recorded. */
export function expectedLocations(active: number, pendingCharged: boolean): number {
  return active + (pendingCharged ? 1 : 0);
}

/** Billing clinics (ids only) and which of them bill another clinic, through the 0008 definer. */
async function billingClinics(): Promise<{ id: string; isGroup: boolean }[]> {
  const result = await unsafeDb.execute<{ id: string; billing_clinic_id: string | null }>(
    sql`select id, billing_clinic_id from app_clinics_overview()`,
  );
  const billedToOther = new Set(
    result.rows
      .filter((row) => row.billing_clinic_id !== null)
      .map((row) => String(row.billing_clinic_id)),
  );
  return result.rows
    .filter((row) => row.billing_clinic_id === null)
    .map((row) => ({ id: String(row.id), isGroup: billedToOther.has(String(row.id)) }));
}

type AccountRead =
  | { kind: "skip"; reason: Extract<LocationQuantityOutcome, { status: "skipped" }>["reason"] }
  | { kind: "read"; subscriptionId: string; expected: number };

/** The account's side, in its own tenant: what it should pay for, or why it is left alone. */
async function readAccount(clinicId: string, now: Date): Promise<AccountRead> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx): Promise<AccountRead> => {
    const row = await getEntitlements(tx.db, clinicId);
    if (!row) return { kind: "skip", reason: "no_entitlements" };
    if (!row.stripeSubscriptionId) return { kind: "skip", reason: "no_subscription" };
    if (OVER.has(row.status)) return { kind: "skip", reason: "ended" };
    // A legacy row (no bought package) was billed in full from its first
    // invoice; a deferred-start row has only the placeholder until its start.
    if (row.boughtPlanId !== null && !hasPlanStarted(row)) {
      return { kind: "skip", reason: "not_started" };
    }
    const leaseHeld =
      row.stripeMutationLeaseUntil !== null &&
      row.stripeMutationLeaseUntil.getTime() > now.getTime();
    if (leaseHeld) return { kind: "skip", reason: "in_flight" };
    if (row.pendingLocationRequestId !== null && row.pendingLocationChargedAt === null) {
      return { kind: "skip", reason: "in_flight" };
    }

    const [active] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clinicLocations)
      .where(and(eq(clinicLocations.clinicId, clinicId), eq(clinicLocations.status, "active")));
    let pendingCharged = false;
    if (row.pendingLocationRequestId !== null && row.pendingLocationChargedAt !== null) {
      // Only the add's own row, and only while it is still pending: once
      // active it is already counted above.
      const [pending] = await tx.db
        .select({ id: clinicLocations.id })
        .from(clinicLocations)
        .where(
          and(
            eq(clinicLocations.clinicId, clinicId),
            eq(clinicLocations.status, "pending"),
            sql`${clinicLocations.addRequestId}::text = ${row.pendingLocationRequestId}`,
          ),
        )
        .limit(1);
      pendingCharged = pending !== undefined;
    }
    return {
      kind: "read",
      subscriptionId: row.stripeSubscriptionId,
      expected: expectedLocations(Number(active?.n ?? 0), pendingCharged),
    };
  });
}

/** Stripe's side: the package item's quantity, by a read and nothing else. */
async function billedQuantity(
  stripe: Stripe,
  subscriptionId: string,
): Promise<number | "ended" | "no_package_item"> {
  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId,
    { expand: ["items.data.price"] },
    { ...WORKER_STRIPE_OPTIONS },
  )) as unknown as SubscriptionLike;
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    return "ended";
  }
  const item = packageItemOf(subscription);
  return item ? item.quantity : "no_package_item";
}

/** The clinic's open episode, read from the ops log: its `windowStart`, or null when none is open. */
async function openEpisode(clinicId: string): Promise<string | null> {
  const [latest] = await unsafeDb
    .select({ event: opsAlerts.event, fields: opsAlerts.fields })
    .from(opsAlerts)
    .where(
      and(
        inArray(opsAlerts.event, [LOCATION_QUANTITY_DRIFT_EVENT, LOCATION_QUANTITY_AGREES_EVENT]),
        sql`${opsAlerts.fields}->>'clinicId' = ${clinicId}`,
      ),
    )
    .orderBy(desc(opsAlerts.raisedAt), desc(opsAlerts.lastRaisedAt))
    .limit(1);
  if (!latest || latest.event !== LOCATION_QUANTITY_DRIFT_EVENT) return null;
  const started = latest.fields.windowStart;
  return typeof started === "string" ? started : null;
}

/** Check one billing clinic. Exported for the tests; the job calls it for every account. */
export async function checkLocationQuantity(
  clinicId: string,
  options: { now: Date; stripe: Stripe; isGroup?: boolean },
): Promise<LocationQuantityOutcome> {
  if (options.isGroup) return { status: "skipped", reason: "group" };
  const account = await readAccount(clinicId, options.now);
  if (account.kind === "skip") return { status: "skipped", reason: account.reason };

  const billed = await billedQuantity(options.stripe, account.subscriptionId);
  if (billed === "ended") return { status: "skipped", reason: "ended" };
  if (billed === "no_package_item") return { status: "skipped", reason: "no_package_item" };
  return billed === account.expected
    ? { status: "agrees", locations: account.expected }
    : { status: "drift", locations: account.expected, billed };
}

/**
 * Tell ops what changed: a new episode, or the end of one. Returns which.
 * notifyOpsOnce never throws; an alert it could not record falls back to its
 * memory, and the next hour reads the ops log again.
 */
async function alertOnChange(
  clinicId: string,
  outcome: LocationQuantityOutcome,
  now: Date,
): Promise<"alerted" | "cleared" | null> {
  if (outcome.status === "skipped") return null;
  const open = await openEpisode(clinicId);
  if (outcome.status === "drift") {
    if (open) return null;
    await notifyOpsOnce(LOCATION_QUANTITY_DRIFT_EVENT, {
      clinicId,
      windowStart: now.toISOString(),
      locationCount: outcome.locations,
      billedCount: outcome.billed,
    });
    return "alerted";
  }
  if (!open) return null;
  await notifyOpsOnce(LOCATION_QUANTITY_AGREES_EVENT, {
    clinicId,
    windowStart: open,
    locationCount: outcome.locations,
  });
  return "cleared";
}

/** One pass over every billing clinic. Each account is read and judged on its own. */
export async function checkLocationQuantities(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<LocationQuantitySummary> {
  const now = options.now ?? new Date();
  const stripe = options.stripe ?? getStripe();
  const summary: LocationQuantitySummary = {
    accounts: 0,
    agree: 0,
    drift: 0,
    alerted: 0,
    cleared: 0,
    skipped: 0,
    failures: 0,
  };
  for (const clinic of await billingClinics()) {
    summary.accounts += 1;
    try {
      const outcome = await checkLocationQuantity(clinic.id, {
        now,
        stripe,
        isGroup: clinic.isGroup,
      });
      if (outcome.status === "skipped") summary.skipped += 1;
      else if (outcome.status === "agrees") summary.agree += 1;
      else summary.drift += 1;
      const told = await alertOnChange(clinic.id, outcome, now);
      if (told === "alerted") summary.alerted += 1;
      if (told === "cleared") summary.cleared += 1;
    } catch (error) {
      summary.failures += 1;
      log.warn("location quantity unchecked", {
        clinicId: clinic.id,
        code: stripeErrorCode(error),
        error: describeError(error),
      });
    }
  }
  return summary;
}

/** The job: hourly from the tick, behind its own switch (seeded off by drizzle/0110). */
export async function runLocationQuantityJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_LOCATION_QUANTITY,
    async () => {
      if (!options.stripe && !stripeConfigured()) return "Stripe is not configured; nothing read.";
      const r = await checkLocationQuantities({ now, stripe: options.stripe });
      return `${r.accounts} account(s): ${r.agree} agree, ${r.drift} differ (${r.alerted} told, ${r.cleared} cleared), ${r.skipped} skipped${r.failures ? `, ${r.failures} unread` : ""}.`;
    },
    now,
  );
}
