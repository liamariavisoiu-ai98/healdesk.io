import {
  CHANNELS,
  channelList,
  getPlan,
  isBillingInterval,
  planForChannels,
  recurringUsd,
  setupFeeDeltaUsd,
  stripeLookupKey,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import type { BillingStatus, Entitlements, UsageMeter } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { channelsInService, readChannelStates } from "@/lib/channels/state";
import { anyLocationsReady, locationsReady } from "@/lib/locations";
import { log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { resolveBillingClinicId } from "./billing-clinic";
import { addMonthsUtc, getEntitlements, hasPlanStarted } from "./entitlements";
import {
  expectedMeteredKeys,
  meteredItemChanges,
  meteredItemParams,
  packageItemOf,
  stripeErrorCode,
  type SubscriptionLike,
} from "./metered-items";
import { priceForLookupKey } from "./prices";
import { getStripe, stripeConfigured } from "./stripe-client";
import { WORKER_STRIPE_OPTIONS } from "./stripe-helpers";
import { usageSnapshot } from "./usage";

/**
 * What the portal's Billing screen reads (R30, finding 19), and the checks
 * the billing actions share with their previews.
 *
 * `getBillingSummary` reads the database only, never Stripe, so the screen
 * renders even while Stripe is slow or down and a page view costs no API
 * call; it describes the BILLING clinic of the clinic it is given. The
 * previews ask Stripe what an action would charge before the clinic confirms
 * it, outside any transaction, and refuse exactly what the action would
 * refuse, because both run the same check (`checkPlanChange`,
 * `checkAddLocation`).
 */

const NOT_AVAILABLE = "This isn't available yet.";

const SUMMARY_ACTOR: ActorContext = { type: "service", serviceName: "billing-summary" };

// -----------------------------------------------------------------------------
// The billing group: the billing clinic, its row and its locations' channels
// -----------------------------------------------------------------------------

export type BillingGroup = {
  billingClinicId: string;
  /** The billing clinic's entitlements, or null (a synthetic or demo clinic). */
  row: Entitlements | null;
  /** Every clinic billed on it, the billing clinic first (`app_location_clinics`). */
  locationIds: string[];
  /** Every channel with a first answer at any of them, in the catalog's order. */
  inService: Channel[];
};

/**
 * Read a billing group in SEQUENTIAL tenant transactions, never nested: the
 * given clinic's own row to find its billing clinic, the billing clinic's
 * entitlements, then each location's channels in its own transaction. A
 * transaction opened inside another holds two of the pool's ten connections
 * and can deadlock against itself, and Postgres cannot see that it has.
 *
 * The locations come from the SECURITY DEFINER `app_location_clinics`, which
 * returns ids alone: the runtime role cannot list another tenant's clinics
 * any other way. Channels in service are the union across them, because one
 * package price covers every location (BD13).
 */
export async function readBillingGroup(
  clinicId: string,
  options: { now?: Date; actor?: ActorContext } = {},
): Promise<BillingGroup> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? SUMMARY_ACTOR;
  const billingClinicId = await withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
  const row = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
    getEntitlements(tx.db, billingClinicId),
  );
  const locationIds = await locationClinicIds(billingClinicId);
  const inService = new Set<Channel>();
  for (const locationId of locationIds) {
    const states = await withTenant({ clinicId: locationId, actor }, (tx) =>
      readChannelStates(tx.db, locationId, now),
    );
    for (const channel of channelsInService(states)) inService.add(channel);
  }
  return {
    billingClinicId,
    row,
    locationIds,
    inService: CHANNELS.filter((channel) => inService.has(channel)),
  };
}

/** The billing clinic and every location billed on it, the billing clinic first. */
export async function locationClinicIds(billingClinicId: string): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select app_location_clinics(${billingClinicId}::uuid) as id`,
  );
  const ids = result.rows.map((row) => row.id);
  return ids.length > 0 ? ids : [billingClinicId];
}

// -----------------------------------------------------------------------------
// The checks the actions and their previews share
// -----------------------------------------------------------------------------

/**
 * In good standing for a change that charges the card: active, or past due
 * while grace still runs (BD12, BD13). A suspended, cancelled or cancelling
 * account cannot buy more.
 */
export function inGoodStanding(
  row: Pick<Entitlements, "status" | "graceEndsAt">,
  now: Date,
): boolean {
  if (row.status === "active") return true;
  return (
    row.status === "past_due" &&
    row.graceEndsAt !== null &&
    row.graceEndsAt.getTime() > now.getTime()
  );
}

export type CheckRefusal = { ok: false; status: "refused" | "not_available"; message: string };

function refusal(message: string, status: "refused" | "not_available" = "refused"): CheckRefusal {
  return { ok: false, status, message };
}

const MESSAGES = {
  noAccount: "We couldn't find a billing account for this clinic.",
  noStripe: "Billing isn't set up for this account yet, so nothing can be changed here.",
  legacy:
    "This account was set up before plan changes moved into Billing. Contact us and we'll make the change for you.",
  standing:
    "Plan and location changes need the account to be in good standing. Pay the open invoice first, then try again.",
  canceling: "Turn auto-renew back on before changing your plan.",
} as const;

function standingRefusal(row: Entitlements, now: Date): CheckRefusal | null {
  if (row.status === "canceled" || row.status === "purged") {
    return refusal("This plan has ended, so it can't be changed.");
  }
  if (row.status === "canceling" || row.cancelAt !== null) return refusal(MESSAGES.canceling);
  if (!inGoodStanding(row, now)) return refusal(MESSAGES.standing);
  return null;
}

export type PlanChangeCheck =
  | {
      ok: true;
      row: Entitlements;
      boughtPlan: Plan;
      newPlan: Plan;
      interval: BillingInterval;
      isStarted: boolean;
      /** The new package's setup fee less the bought one's, per location, never negative. */
      deltaPerLocationCents: number;
      locations: number;
      /**
       * The request of a change to this same plan that is already in flight
       * (`entitlements.pending_plan_change_*`), which this one carries on
       * under; null when none is pending.
       */
      pendingRequestId: string | null;
    }
  | CheckRefusal;

/** The plan change in flight on a billing row, or null (review fix of 7 October 2026). */
export function pendingPlanChangeOf(
  row: Pick<
    Entitlements,
    "pendingPlanChangeRequestId" | "pendingPlanChangePlanId" | "pendingPlanChangeInterval"
  >,
): { requestId: string; planId: string; interval: BillingInterval } | null {
  if (!row.pendingPlanChangeRequestId || !row.pendingPlanChangePlanId) return null;
  if (!isBillingInterval(row.pendingPlanChangeInterval)) return null;
  return {
    requestId: row.pendingPlanChangeRequestId,
    planId: row.pendingPlanChangePlanId,
    interval: row.pendingPlanChangeInterval,
  };
}

function inProgressRefusal(pending: { planId: string; interval: BillingInterval }): CheckRefusal {
  const name = getPlan(pending.planId)?.name ?? "another plan";
  const billed = pending.interval === "year" ? "billed annually" : "billed monthly";
  return refusal(
    `A change to ${name}, ${billed}, is still being completed. Choose that plan again to finish it now: nothing is charged twice. A different plan can be chosen once it is done, within the hour.`,
  );
}

/**
 * Whether `changePlan` may go ahead (BD12): a known plan, a row bought under
 * the deferred start (a legacy row has no bought package to change), in good
 * standing, auto-renew on, something actually changing, and, once the plan
 * has started, at least one channel in service kept: a change that dropped
 * every answering channel would leave nothing to bill and every patient
 * passed through.
 *
 * A change already in flight (one whose outcome was lost, so the bought
 * package still reads as before) is taken into account first. A request
 * for the same plan and interval carries it on (`pendingRequestId`), so it
 * finds that change's own charge in Stripe instead of charging the setup-fee
 * difference again; anything else is refused until it is finished. Without
 * this, a fresh request id, which the portal mints per attempt, charged the
 * difference a second time once the first attempt's lease ran out.
 */
export function checkPlanChange(
  row: Entitlements | null,
  input: { planId: string; interval: BillingInterval },
  inService: readonly Channel[],
  now: Date,
): PlanChangeCheck {
  if (!row) return refusal(MESSAGES.noAccount);
  const newPlan = getPlan(input.planId);
  if (!newPlan) return refusal("That isn't one of our plans.");
  if (!isBillingInterval(input.interval)) return refusal("Choose monthly or annual billing.");
  if (!row.boughtPlanId) return refusal(MESSAGES.legacy);
  const boughtPlan = getPlan(row.boughtPlanId);
  if (!boughtPlan) return refusal(MESSAGES.legacy);
  if (!row.stripeSubscriptionId || !row.stripeCustomerId) {
    return refusal(MESSAGES.noStripe, "not_available");
  }
  const standing = standingRefusal(row, now);
  if (standing) return standing;
  const pending = pendingPlanChangeOf(row);
  if (pending && (pending.planId !== newPlan.id || pending.interval !== input.interval)) {
    return inProgressRefusal(pending);
  }
  // Not while that same change is in flight: the webhook may already have
  // moved the interval to it, and the change still has to be finished here.
  if (!pending && newPlan.id === boughtPlan.id && input.interval === row.billingInterval) {
    return refusal("That's already your plan.");
  }
  const isStarted = hasPlanStarted(row);
  if (isStarted && planForChannels(newPlan, inService) === null) {
    return refusal(
      "A plan change can't drop every channel that's already answering. Choose a plan that keeps at least one of them.",
    );
  }
  return {
    ok: true,
    row,
    boughtPlan,
    newPlan,
    interval: input.interval,
    isStarted,
    deltaPerLocationCents: setupFeeDeltaUsd(boughtPlan, newPlan) * 100,
    locations: row.locations,
    pendingRequestId: pending?.requestId ?? null,
  };
}

export type AddLocationCheck =
  | { ok: true; row: Entitlements; boughtPlan: Plan; isStarted: boolean; locations: number }
  | CheckRefusal;

const LOCATIONS_NOT_AVAILABLE =
  "Adding a location from Billing isn't available yet. Nothing was changed and nothing was charged.";

/**
 * Whether `addLocation` may go ahead (BD13, R14): the package bought may add
 * a location (locationsReady; until it may, nothing is charged), a row bought
 * under the deferred start, in good standing and renewing.
 */
export function checkAddLocation(row: Entitlements | null, now: Date): AddLocationCheck {
  if (!anyLocationsReady()) return refusal(LOCATIONS_NOT_AVAILABLE, "not_available");
  if (!row) return refusal(MESSAGES.noAccount);
  if (!row.boughtPlanId) return refusal(MESSAGES.legacy);
  const boughtPlan = getPlan(row.boughtPlanId);
  if (!boughtPlan) return refusal(MESSAGES.legacy);
  if (!locationsReady(boughtPlan)) return refusal(LOCATIONS_NOT_AVAILABLE, "not_available");
  if (!row.stripeSubscriptionId || !row.stripeCustomerId) {
    return refusal(MESSAGES.noStripe, "not_available");
  }
  const standing = standingRefusal(row, now);
  if (standing) return standing;
  return {
    ok: true,
    row,
    boughtPlan,
    isStarted: hasPlanStarted(row),
    locations: row.locations + 1,
  };
}

/** Channels `inService` that `plan` does not include. */
export function channelsDroppedBy(plan: Plan, inService: readonly Channel[]): Channel[] {
  return inService.filter((channel) => !plan.channels[channel]);
}

// -----------------------------------------------------------------------------
// getBillingSummary
// -----------------------------------------------------------------------------

/** One allowance meter, pooled across the billing group's locations. */
export type UsageMeterSummary = {
  meter: UsageMeter;
  used: number;
  /** effectiveIncluded (BD5): the allowance for the window, times the locations. */
  included: number;
  /** Units past the allowance so far this window. */
  overUnits: number;
  /**
   * What those units bill, in cents: started blocks of 100 at the BOUGHT
   * package's rate, 0 under "Stop and fall back" (R19). Worked out here, by
   * usageSnapshot, so the screen never does its own billing maths: units
   * times a per-unit rate shows less than is charged for every part block,
   * and the billed package's rate is not the one that applies.
   */
  overageCents: number;
  /** ISO timestamps of the allowance window; null before the plan starts (BD6). */
  windowStart: string | null;
  windowEnd: string | null;
  /** The window is open now: not before it starts, not after it ends (R20). */
  isWindowOpen: boolean;
};

export type BillingSummary = {
  /** The clinic the subscription belongs to: a location's summary is its billing clinic's. */
  billingClinicId: string;
  status: BillingStatus;
  boughtPlanId: string | null;
  /** The package Stripe bills now; null before the plan starts, while the $0 line stands. */
  billedPlanId: string | null;
  interval: BillingInterval;
  locations: number;
  /** R8: the plan-start update went through, or the first plan invoice was paid. */
  isPlanStarted: boolean;
  /** ISO timestamps from here on. When the first plan invoice was paid. */
  planStartedAt: string | null;
  /** The end of the first plan period: the first renewal. */
  firstPeriodEndsAt: string | null;
  paidThrough: string | null;
  setupDeadlineAt: string | null;
  isAutoRenewOn: boolean;
  /**
   * When the account closes, if it does: Stripe's cancel_at, or before the
   * start the earlier of that and the setup deadline (BD10). Null while it
   * renews.
   */
  closesOn: string | null;
  /** Every channel with a first answer, across the billing group's locations. */
  channelsInService: Channel[];
  /** In service but not yet in the billed package: their price joins at the next step-up. */
  channelsNotYetPriced: Channel[];
  overageMode: "allow" | "hard_cap";
  usageAlertsEnabled: boolean;
  /** The unpaid invoice, while there is one: Stripe's hosted pay page and what it asks for. */
  openInvoice: { url: string | null; amountDueCents: number | null } | null;
  graceEndsAt: string | null;
  usage: UsageMeterSummary[];
};

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** A UTC calendar date, YYYY-MM-DD: what the "…On" fields carry. */
export function isoDay(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** The first plan period's end: a month or a year after the plan started, as Stripe anchors it. */
export function firstPeriodEnd(row: Entitlements): Date | null {
  const start = row.planStartedAt ?? row.planStartAppliedAt;
  if (!start) return null;
  return addMonthsUtc(start, row.billingInterval === "year" ? 12 : 1);
}

/**
 * When the account closes, or null while it renews (BD10): Stripe's
 * `cancel_at` once the plan has started; before the start, the earlier of
 * that and the setup deadline, because a clinic that turned auto-renew off
 * before anything answered is also closed at the end of its setup window.
 */
export function closesAt(
  row: Pick<Entitlements, "cancelAt" | "setupDeadlineAt" | "planStartedAt" | "planStartAppliedAt">,
): Date | null {
  if (!row.cancelAt) return null;
  if (hasPlanStarted(row) || !row.setupDeadlineAt) return row.cancelAt;
  return row.setupDeadlineAt.getTime() < row.cancelAt.getTime()
    ? row.setupDeadlineAt
    : row.cancelAt;
}

/**
 * The meters the bought package sells, from usageSnapshot: the one place the
 * console's panel also reads, so the overage the Billing screen shows is the
 * amount the clinic will be charged.
 */
function meterUsage(row: Entitlements, now: Date): UsageMeterSummary[] {
  const plan = getPlan(row.boughtPlanId ?? row.planCode);
  const sold = (meter: UsageMeter) =>
    !plan ||
    (meter === "voice_minutes" ? plan.channels.voice : plan.channels.web || plan.channels.meta);
  return usageSnapshot(row, now)
    .filter((snapshot) => sold(snapshot.meter))
    .map((snapshot) => ({
      meter: snapshot.meter,
      used: snapshot.used,
      included: snapshot.included,
      overUnits: snapshot.overUnits,
      overageCents: snapshot.overageCents,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      isWindowOpen: snapshot.isWindowOpen,
    }));
}

/**
 * The Billing screen, from the database only. Null when the billing clinic
 * has no entitlements row (a synthetic or demo clinic). `now` is for tests:
 * it decides which channels are in service and whether the window is open.
 */
export async function getBillingSummary(
  clinicId: string,
  options: { now?: Date } = {},
): Promise<BillingSummary | null> {
  const now = options.now ?? new Date();
  const group = await readBillingGroup(clinicId, { now });
  const row = group.row;
  if (!row) return null;
  const isPlanStarted = hasPlanStarted(row);
  const billedPlan = isPlanStarted ? (getPlan(row.planCode) ?? null) : null;
  return {
    billingClinicId: group.billingClinicId,
    status: row.status,
    boughtPlanId: row.boughtPlanId,
    billedPlanId: billedPlan?.id ?? null,
    interval: row.billingInterval,
    locations: row.locations,
    isPlanStarted,
    planStartedAt: iso(row.planStartedAt),
    firstPeriodEndsAt: iso(firstPeriodEnd(row)),
    paidThrough: iso(row.paidThrough),
    setupDeadlineAt: iso(row.setupDeadlineAt),
    isAutoRenewOn:
      row.cancelAt === null &&
      row.status !== "canceling" &&
      row.status !== "canceled" &&
      row.status !== "purged",
    closesOn: iso(closesAt(row)),
    channelsInService: group.inService,
    channelsNotYetPriced: billedPlan
      ? channelsDroppedBy(billedPlan, group.inService)
      : [...group.inService],
    overageMode: row.overageMode,
    usageAlertsEnabled: row.usageAlertsEnabled,
    openInvoice: row.openInvoiceId
      ? { url: row.openInvoiceUrl, amountDueCents: row.openInvoiceAmountCents }
      : null,
    graceEndsAt: iso(row.graceEndsAt),
    usage: meterUsage(row, now),
  };
}

// -----------------------------------------------------------------------------
// The previews (Stripe, outside any transaction)
// -----------------------------------------------------------------------------

export type PreviewNextInvoiceResult =
  | {
      status: "ok";
      amountDueCents: number;
      /** ISO date Stripe will charge it. */
      nextPaymentOn: string | null;
      periodStartsOn: string | null;
      periodEndsOn: string | null;
    }
  | { status: "not_available"; message: string };

type LineLike = {
  amount?: number | null;
  period?: { start?: number | null; end?: number | null } | null;
  parent?: {
    type?: string | null;
    subscription_item_details?: { proration?: boolean | null } | null;
  } | null;
};

function linesOf(invoice: { lines?: { data?: unknown[] | null } | null }): LineLike[] {
  return (invoice.lines?.data ?? []) as LineLike[];
}

/** The proration lines of a previewed invoice, summed: what the change would invoice now. */
export function prorationCentsOf(invoice: { lines?: { data?: unknown[] | null } | null }): number {
  return linesOf(invoice)
    .filter((line) => line.parent?.subscription_item_details?.proration === true)
    .reduce((sum, line) => sum + (typeof line.amount === "number" ? line.amount : 0), 0);
}

function secondsToDay(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? isoDay(new Date(seconds * 1000)) : null;
}

/**
 * What Stripe will charge next: its own preview of the subscription's next
 * invoice. Not available before the plan starts (the next charge is the
 * plan start itself, whose amount follows the channels that answer), on an
 * ended plan, or when Stripe has no next invoice to show (a plan set to end).
 */
export async function previewNextInvoice(
  clinicId: string,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<PreviewNextInvoiceResult> {
  const group = await readBillingGroup(clinicId, { now: options.now });
  const row = group.row;
  if (!row || !row.stripeCustomerId || !row.stripeSubscriptionId) {
    return { status: "not_available", message: NOT_AVAILABLE };
  }
  if (row.status === "canceled" || row.status === "purged") {
    return { status: "not_available", message: "This plan has ended: there is no next invoice." };
  }
  if (!hasPlanStarted(row)) {
    return {
      status: "not_available",
      message:
        "Your plan's first charge is the day AYA first answers, at the price of the channels in service.",
    };
  }
  if (row.cancelAt) {
    return {
      status: "not_available",
      message: `Auto-renew is off: the plan ends on ${isoDay(row.cancelAt)}, with no further invoice.`,
    };
  }
  if (!options.stripe && !stripeConfigured()) {
    return { status: "not_available", message: NOT_AVAILABLE };
  }
  try {
    const stripe = options.stripe ?? getStripe();
    const invoice = await stripe.invoices.createPreview(
      { customer: row.stripeCustomerId, subscription: row.stripeSubscriptionId },
      WORKER_STRIPE_OPTIONS,
    );
    const lines = linesOf(invoice as never);
    const packageLine =
      lines.find(
        (line) =>
          line.parent?.type === "subscription_item_details" &&
          line.parent.subscription_item_details?.proration !== true &&
          (line.amount ?? 0) > 0,
      ) ?? null;
    const nextAttempt = (invoice as { next_payment_attempt?: number | null }).next_payment_attempt;
    const periodEnd = (invoice as { period_end?: number | null }).period_end;
    return {
      status: "ok",
      amountDueCents: (invoice as { amount_due?: number }).amount_due ?? 0,
      nextPaymentOn: secondsToDay(nextAttempt ?? packageLine?.period?.start ?? periodEnd ?? null),
      periodStartsOn: secondsToDay(packageLine?.period?.start ?? null),
      periodEndsOn: secondsToDay(packageLine?.period?.end ?? null),
    };
  } catch (error) {
    log.warn("next invoice preview unavailable", {
      clinicId: group.billingClinicId,
      code: stripeErrorCode(error),
    });
    return {
      status: "not_available",
      message: "Stripe couldn't show the next invoice right now. Try again in a minute.",
    };
  }
}

export type PreviewChangePlanInput = {
  clinicId: string;
  planId: string;
  interval: BillingInterval;
};

export type PreviewChangePlanResult =
  | {
      status: "ok";
      planId: string;
      interval: BillingInterval;
      /** The new package's setup fee less the bought one's, times the locations; never negative. */
      setupFeeDeltaCents: number;
      /** What Stripe would invoice now for the rest of the period. */
      prorationCents: number;
      /** The recurring price afterwards, for every location. */
      recurringCents: number;
      /** Channels in service the new package would drop. */
      droppedChannels: Channel[];
      /**
       * This very change is already in flight: an earlier attempt's outcome
       * was lost. Confirming finishes that attempt; whatever it already
       * charged is found in Stripe and never charged twice, so the amounts
       * above are at most what is still to pay.
       */
      isInProgress: boolean;
    }
  | { status: "refused" | "not_available"; message: string };

/**
 * What `changePlan` would charge: the setup-fee difference, the proration
 * Stripe would invoice at once, and the recurring price afterwards. Refuses
 * exactly what the action refuses, including a different change while one is
 * in flight. After the start the billed package is worked out as the action
 * works it out (R7): from the package Stripe bills now plus the channels in
 * service, kept to the new bought package.
 */
export async function previewChangePlan(
  input: PreviewChangePlanInput,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<PreviewChangePlanResult> {
  const now = options.now ?? new Date();
  const group = await readBillingGroup(input.clinicId, { now });
  const check = checkPlanChange(group.row, input, group.inService, now);
  if (!check.ok) return { status: check.status, message: check.message };
  const { newPlan, interval, locations } = check;
  const isInProgress = check.pendingRequestId !== null;
  const setupFeeDeltaCents = check.deltaPerLocationCents * locations;
  const droppedChannels = channelsDroppedBy(newPlan, group.inService);

  if (!check.isStarted) {
    const billedAtStart = planForChannels(newPlan, group.inService) ?? newPlan;
    return {
      status: "ok",
      planId: newPlan.id,
      interval,
      setupFeeDeltaCents,
      prorationCents: 0,
      recurringCents: recurringUsd(billedAtStart, interval) * 100 * locations,
      droppedChannels,
      isInProgress,
    };
  }

  if (!options.stripe && !stripeConfigured()) {
    return { status: "not_available", message: NOT_AVAILABLE };
  }
  try {
    const stripe = options.stripe ?? getStripe();
    const subscription = (await stripe.subscriptions.retrieve(
      check.row.stripeSubscriptionId as string,
      { expand: ["items.data.price"] },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as SubscriptionLike;
    const current = packageItemOf(subscription);
    if (!current) {
      return {
        status: "not_available",
        message: "Your plan is still being set up in Stripe. Try again in a few minutes.",
      };
    }
    const target = planForChannels(newPlan, [...channelList(current.plan), ...group.inService]);
    if (!target) {
      return {
        status: "refused",
        message:
          "A plan change can't drop every channel that's already answering. Choose a plan that keeps at least one of them.",
      };
    }
    const targetPrice = await priceForLookupKey(stripeLookupKey(target, interval), { stripe });
    let prorationCents = 0;
    if (targetPrice.id !== current.priceId || interval !== current.interval) {
      const expected = expectedMeteredKeys(newPlan.id, interval) ?? [];
      const metered = await meteredItemParams(meteredItemChanges(subscription, expected), {
        stripe,
      });
      const preview = await stripe.invoices.createPreview(
        {
          customer: check.row.stripeCustomerId as string,
          subscription: subscription.id,
          subscription_details: {
            items: [
              { id: current.item.id, price: targetPrice.id, quantity: locations },
              ...(metered as Stripe.InvoiceCreatePreviewParams.SubscriptionDetails.Item[]),
            ],
            proration_behavior: "always_invoice",
          },
        },
        WORKER_STRIPE_OPTIONS,
      );
      prorationCents = prorationCentsOf(preview as never);
    }
    return {
      status: "ok",
      planId: newPlan.id,
      interval,
      setupFeeDeltaCents,
      prorationCents,
      recurringCents: recurringUsd(target, interval) * 100 * locations,
      droppedChannels,
      isInProgress,
    };
  } catch (error) {
    log.warn("plan change preview unavailable", {
      clinicId: group.billingClinicId,
      code: stripeErrorCode(error),
    });
    return {
      status: "not_available",
      message: "Stripe couldn't price this change right now. Try again in a minute.",
    };
  }
}

export type PreviewAddLocationResult =
  | {
      status: "ok";
      /** The location count afterwards. */
      locations: number;
      /** The package's recurring price for the new location. */
      recurringCents: number;
      /** The setup fee, charged once. */
      setupFeeCents: number;
      /** What Stripe would invoice now for the rest of the period; 0 before the plan starts. */
      prorationCents: number;
    }
  | { status: "refused" | "not_available"; message: string };

/**
 * What `addLocation` would charge: the bought package's setup fee once, and
 * the billed package's recurring price for one more location, prorated to
 * the renewal date when the plan has started. Before the start nothing
 * recurring is charged yet: the location joins the plan's quantity at the
 * start, at the price of the channels then in service.
 */
export async function previewAddLocation(
  clinicId: string,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<PreviewAddLocationResult> {
  const now = options.now ?? new Date();
  const group = await readBillingGroup(clinicId, { now });
  const check = checkAddLocation(group.row, now);
  if (!check.ok) return { status: check.status, message: check.message };
  const { row, boughtPlan, locations } = check;
  const setupFeeCents = boughtPlan.setupFeeUsd * 100;

  if (!check.isStarted) {
    const billedAtStart = planForChannels(boughtPlan, group.inService) ?? boughtPlan;
    return {
      status: "ok",
      locations,
      recurringCents: recurringUsd(billedAtStart, row.billingInterval) * 100,
      setupFeeCents,
      prorationCents: 0,
    };
  }

  if (!options.stripe && !stripeConfigured()) {
    return { status: "not_available", message: NOT_AVAILABLE };
  }
  try {
    const stripe = options.stripe ?? getStripe();
    const subscription = (await stripe.subscriptions.retrieve(
      row.stripeSubscriptionId as string,
      { expand: ["items.data.price"] },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as SubscriptionLike;
    const current = packageItemOf(subscription);
    if (!current) {
      return {
        status: "not_available",
        message: "Your plan is still being set up in Stripe. Try again in a few minutes.",
      };
    }
    const preview = await stripe.invoices.createPreview(
      {
        customer: row.stripeCustomerId as string,
        subscription: subscription.id,
        subscription_details: {
          items: [{ id: current.item.id, quantity: locations }],
          proration_behavior: "always_invoice",
        },
      },
      WORKER_STRIPE_OPTIONS,
    );
    return {
      status: "ok",
      locations,
      recurringCents: recurringUsd(current.plan, current.interval) * 100,
      setupFeeCents,
      prorationCents: prorationCentsOf(preview as never),
    };
  } catch (error) {
    log.warn("location preview unavailable", {
      clinicId: group.billingClinicId,
      code: stripeErrorCode(error),
    });
    return {
      status: "not_available",
      message: "Stripe couldn't price this right now. Try again in a minute.",
    };
  }
}
