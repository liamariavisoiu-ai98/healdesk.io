import { randomUUID } from "node:crypto";

import {
  channelList,
  FIRST_PERIOD_REFUND_DAYS,
  getPlan,
  isCarrier,
  parseLookupKey,
  planForChannels,
  recurringUsd,
  setupFeeDeltaUsd,
  stripeLookupKey,
  terminationRefundsFees,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";

import type { Transaction } from "@/db";
import {
  billingRequests,
  clinicChannels,
  clinics,
  entitlements,
  type BillingRequestReason,
  type Entitlements,
} from "@/db/schema";
import { assertNoPhi, type ActorContext } from "@/lib/audit";
import { readCoverageMode, type CoverageMode } from "@/lib/billing/answering";
import {
  activatePendingLocation,
  isLocationRequestId,
  LocationAcceptanceRefused,
  retireUnpaidLocation,
  writePendingLocation,
  type LocationAcceptance,
  type NewLocation,
} from "@/lib/location-add";
import { anyLocationsReady, locationsReady } from "@/lib/locations";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { publicOrigin } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { claimOverageOnLeavingAnnual } from "./annual-overage";
import { resolveBillingClinicId } from "./billing-clinic";
import {
  addMonthsUtc,
  allowanceWindow,
  applyBilledPlan,
  applyBoughtPlan,
  claimStripeMutationLease,
  getEntitlements,
  getEntitlementsForUpdate,
  hasPlanStarted,
  markFirstPeriodRefunded,
  openAllowanceWindow,
  releaseStripeMutationLease,
  setCancelAt,
  setLocations,
  setMeteredPriceKeys,
  STRIPE_MUTATION_LEASE_MS,
  refundEligibleUntil,
  refundWindowOpen,
} from "./entitlements";
import {
  currentPeriodEndOf,
  expectedMeteredKeys,
  isCardError,
  meteredItemChanges,
  meteredItemParams,
  meteredKeysOf,
  packageItemOf,
  stripeErrorCode,
  type PackageItem,
  type SubscriptionItemLike,
  type SubscriptionLike,
} from "./metered-items";
import { enqueueNotice, type NoticePayloads } from "./notices";
import { priceForLookupKey } from "./prices";
import { billingRequestsSwitchedOn, rearmBillingRequest, requestCancelNow } from "./requests";
import { recordBillingNote } from "./state-machine";
import { getStripe, stripeConfigured } from "./stripe-client";
import {
  effectivePaymentMethod,
  stripeRefId,
  WORKER_STRIPE_OPTIONS,
  workerRequestOptions,
} from "./stripe-helpers";
import {
  channelsDroppedBy,
  checkAddLocation,
  checkPlanChange,
  closesAt,
  isoDay,
  pendingPlanChangeOf,
  readBillingGroup,
  type PlanChangeCheck,
} from "./summary";

/**
 * What a clinic (from the portal's Billing) or an operator (from the console)
 * can do to a subscription: change the plan, add a location, turn auto-renew
 * off or on, open Stripe's portal for the card and the invoices, and refund
 * the first period (build decisions BD10, BD12 to BD15; R5, R13 to R15).
 *
 * Every action works on the BILLING clinic of the clinic it is given, never
 * calls Stripe inside a database transaction, and holds the billing clinic's
 * Stripe mutation lease (`entitlements.stripe_mutation_lease_*`) for the
 * length of a change, so it answers `busy` rather than race a worker. The
 * result unions are the contract the portal and the console are built
 * against; a refusal always carries a sentence fit to show.
 *
 * The shape of every change is the same three steps: a billing transaction
 * that re-checks the row under its lock and claims the lease; the Stripe
 * calls, outside any transaction, each with an idempotency key built from
 * the caller's `requestId`; and a second billing transaction that writes the
 * outcome and releases the lease. A retry of the same request is recognised
 * by a marker it left in Stripe (subscription metadata, or a one-off
 * invoice's `hd_ref`), never by comparing prices, so a request is charged
 * once however often it is retried.
 *
 * When Stripe does not answer and we cannot tell whether a change went
 * through, the lease is deliberately NOT released: until it runs out (five
 * minutes) only a retry of the same request can claim it, and that retry
 * finds the marker. A different request in that window gets `busy`. The
 * lease alone does not outlast a reload, so a plan change and an extra
 * location are also recorded on the billing row before anything is charged
 * (`pending_plan_change_*`, `pending_location_*`): a later request carries
 * the pending one on under its id, or is refused, and is never charged
 * twice; the hourly reconcile finishes, or drops, what nobody comes back for.
 *
 * Each action also takes an optional second argument, `{ now, stripe }`, for
 * tests and for the console; the first argument and the result union are
 * the contract (R30).
 */

/** Kept for callers built against S0's stubs; nothing throws it any more. */
export class BillingActionNotBuiltError extends Error {
  constructor(readonly action: string) {
    super(`${action} is not built yet (Package C-actions).`);
    this.name = "BillingActionNotBuiltError";
  }
}

/** The optional second argument every action takes. */
export type BillingActionOptions = { now?: Date; stripe?: Stripe };

const NOT_AVAILABLE = "This isn't available yet. Nothing was changed and nothing was charged.";
const BUSY =
  "Another billing change for this account is in progress. Nothing was changed: try again in a minute.";
const NO_ANSWER =
  "Stripe didn't answer, so we can't tell yet whether this went through. Try again in a minute: the same request is recognised and never charged twice.";
const DECLINED =
  "The card was declined, so nothing changed and nothing was charged. Update the card in Billing, then try again.";

/** A request id rides into Stripe metadata and idempotency keys, so it is an opaque token. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function actorFor(actorLabel: string): ActorContext {
  const label = actorLabel.trim().slice(0, 200);
  return { type: "service", serviceName: label.length > 0 ? label : "billing-action" };
}

function stripeFor(options: BillingActionOptions): Stripe | null {
  if (options.stripe) return options.stripe;
  return stripeConfigured() ? getStripe() : null;
}

/** Lost the lease mid-change: someone else's lease replaced ours after it ran out. */
class LeaseLostError extends Error {
  constructor() {
    super("The Stripe mutation lease was lost.");
    this.name = "LeaseLostError";
  }
}

/**
 * Renew our lease before a call that moves money, so a slow sequence of
 * Stripe calls can never outlive it and let a worker act on the same
 * subscription. Lease times are wall-clock: they measure real elapsed time,
 * not the business `now` a test may pin.
 */
async function renewLease(billingClinicId: string, owner: string, actor: ActorContext) {
  const kept = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
    claimStripeMutationLease(tx.db, billingClinicId, owner),
  );
  if (!kept) throw new LeaseLostError();
}

async function releaseLease(billingClinicId: string, owner: string, actor: ActorContext) {
  try {
    await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
      releaseStripeMutationLease(tx.db, billingClinicId, owner),
    );
  } catch (error) {
    // The lease runs out by itself; the caller's own outcome is what matters.
    log.warn("billing action lease not released", {
      clinicId: billingClinicId,
      code: stripeErrorCode(error),
    });
  }
}

/** Retrieve a subscription with its item prices, which is all the actions read from it. */
async function retrieveSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<SubscriptionLike> {
  return (await stripe.subscriptions.retrieve(
    subscriptionId,
    { expand: ["items.data.price", "latest_invoice"] },
    WORKER_STRIPE_OPTIONS,
  )) as unknown as SubscriptionLike;
}

function hasEnded(subscription: SubscriptionLike): boolean {
  return subscription.status === "canceled" || subscription.status === "incomplete_expired";
}

const TRIALING =
  "This subscription is in a state healdesk never puts one in, so nothing was changed. We've been told and will put it right.";

/**
 * healdesk never uses a Stripe trial (contracts §2: Stripe would print
 * "TRIAL OVER" on the first charge), so a `trialing` subscription is a fault
 * somewhere upstream. An action refuses to build on it rather than act on a
 * subscription whose next invoice nobody can predict (R37).
 */
function isTrialing(subscription: SubscriptionLike, billingClinicId: string): boolean {
  if (subscription.status !== "trialing") return false;
  log.error("billing action refused: the subscription is trialing", {
    clinicId: billingClinicId,
    status: "trialing",
  });
  return true;
}

/**
 * The hosted URL of the invoice a subscription update just raised, or null
 * when the update raised none (`latest_invoice` is then an older invoice,
 * whose link would be the wrong one to show).
 */
function invoiceUrlRaisedSince(
  subscription: SubscriptionLike,
  sinceSeconds: number,
): string | null {
  const invoice = subscription.latest_invoice as {
    billing_reason?: string | null;
    created?: number | null;
    hosted_invoice_url?: string | null;
  } | null;
  if (!invoice || typeof invoice !== "object") return null;
  if (invoice.billing_reason !== "subscription_update") return null;
  if (typeof invoice.created !== "number" || invoice.created < sinceSeconds - 120) return null;
  return invoice.hosted_invoice_url ?? null;
}

// -----------------------------------------------------------------------------
// R13a: the draft-first one-off invoice
// -----------------------------------------------------------------------------

export type OneOffItem =
  | { price: string; quantity: number; description?: string }
  | { product: string; unitAmountCents: number; quantity: number; description?: string };

export type OneOffInvoiceInput = {
  customerId: string;
  /** effectivePaymentMethod (R16): the customer's default, else the subscription's. */
  defaultPaymentMethod: string | null;
  hdKind: "plan_change_setup" | "location_setup" | "annual_overage";
  /** What makes a retry find this invoice again: the request id, or the overage window. */
  hdRef: string;
  /** The idempotency keys are `<keyPrefix>:invoice`, `:item:<n>`, `:finalize`, `:pay` and `:void`. */
  keyPrefix: string;
  description?: string;
  items: readonly OneOffItem[];
  /**
   * An action voids a declined invoice and refuses (nothing must stay owed
   * for a change that did not happen). Annual overage leaves it open: it is
   * owed either way, and the open invoice goes to dunning like any other.
   */
  onDecline: "void" | "leave_open";
  /** Called just before the charge, to renew a lease. */
  beforePay?: () => Promise<void>;
};

export type OneOffInvoiceResult =
  | {
      status: "paid" | "open";
      invoiceId: string;
      hostedInvoiceUrl: string | null;
      amountCents: number;
      /** A previous attempt's invoice was found by `hd_ref` and finished, not a new one created. */
      isResumed: boolean;
    }
  /** Declined. With `onDecline: "void"` the invoice was voided (or a previous attempt's was). */
  | { status: "declined"; invoiceId: string | null; isVoided: boolean }
  /** `leave_open` only: a previous invoice for this `hd_ref` was voided, by hand. */
  | { status: "voided"; invoiceId: string };

type InvoiceLike = {
  id: string;
  status?: string | null;
  hosted_invoice_url?: string | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  total?: number | null;
  metadata?: Record<string, string> | null;
  lines?: { data?: Array<{ metadata?: Record<string, string> | null }> | null } | null;
};

/**
 * The customer's invoices carrying this `hd_kind` and `hd_ref`, newest first.
 * `invoices.list` cannot filter on metadata, so the newest 500 are read and
 * filtered here; a one-off invoice is created minutes (or for overage, days)
 * before a retry looks for it, so it is always among them. Search is not
 * used: it is eventually consistent, and a retry seconds after a crash would
 * miss the draft and create a second invoice.
 */
async function findOneOffInvoices(
  stripe: Stripe,
  customerId: string,
  hdKind: string,
  hdRef: string,
): Promise<InvoiceLike[]> {
  const found: InvoiceLike[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const list = (await stripe.invoices.list(
      {
        customer: customerId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as { data?: InvoiceLike[]; has_more?: boolean };
    const data = list.data ?? [];
    for (const invoice of data) {
      if (invoice.metadata?.hd_kind === hdKind && invoice.metadata?.hd_ref === hdRef) {
        found.push(invoice);
      }
    }
    if (!list.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]!.id;
  }
  return found;
}

/**
 * Charge a one-off amount on its own invoice (R13a), for a setup-fee
 * difference, a location's setup fee before the plan starts, and annual
 * overage:
 *
 *   1. `invoices.create` as a DRAFT (`auto_advance: false`) that EXCLUDES
 *      pending invoice items, with the card to charge and `{ hd_kind, hd_ref }`;
 *   2. `invoiceItems.create` attached to that draft by id, one per item;
 *   3. `invoices.finalizeInvoice` with `auto_advance: false`;
 *   4. `invoices.pay` off-session.
 *
 * Why this order and never `pending_invoice_items_behavior: "include"`: an
 * invoice item created without an invoice is PENDING on the customer, and
 * the next invoice of any kind sweeps it in — the plan start's, a step-up's,
 * the renewal's — so a setup fee could be charged twice, or ride on an
 * invoice the clinic does not expect. Created on a draft that excludes
 * pending items, an item can belong to this invoice and nothing else.
 *
 * A retry finds the earlier invoice by `hd_ref` and resumes it: a paid one is
 * done, an open one is paid, a draft gets its missing items (by `hd_item`)
 * and is finalized. On a decline the invoice is voided (`onDecline: "void"`)
 * or left open for dunning (`"leave_open"`). Any other Stripe failure is
 * thrown: the caller cannot tell what happened and must retry the same
 * request.
 */
export async function chargeOneOffInvoice(
  stripe: Stripe,
  input: OneOffInvoiceInput,
): Promise<OneOffInvoiceResult> {
  const found = await findOneOffInvoices(stripe, input.customerId, input.hdKind, input.hdRef);
  const byStatus = (status: string) => found.find((invoice) => invoice.status === status);

  const paid = byStatus("paid");
  if (paid) return settled("paid", paid, true);

  let invoice = byStatus("open") ?? byStatus("draft") ?? null;
  const isResumed = invoice !== null;
  if (!invoice) {
    const dead = found.find((i) => i.status === "void" || i.status === "uncollectible");
    if (dead) {
      return input.onDecline === "void"
        ? { status: "declined", invoiceId: dead.id, isVoided: true }
        : { status: "voided", invoiceId: dead.id };
    }
    invoice = (await stripe.invoices.create(
      {
        customer: input.customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        ...(input.defaultPaymentMethod
          ? { default_payment_method: input.defaultPaymentMethod }
          : {}),
        ...(input.description ? { description: input.description } : {}),
        metadata: { hd_kind: input.hdKind, hd_ref: input.hdRef },
      },
      workerRequestOptions(`${input.keyPrefix}:invoice`),
    )) as unknown as InvoiceLike;
  }

  if (invoice.status === "draft") {
    const present = new Set(
      (invoice.lines?.data ?? []).map((line) => line.metadata?.hd_item).filter(Boolean),
    );
    for (let n = 1; n <= input.items.length; n += 1) {
      if (present.has(String(n))) continue;
      const item = input.items[n - 1]!;
      await stripe.invoiceItems.create(
        {
          customer: input.customerId,
          invoice: invoice.id,
          ...("price" in item
            ? { pricing: { price: item.price } }
            : {
                price_data: {
                  currency: "usd",
                  product: item.product,
                  unit_amount: item.unitAmountCents,
                },
              }),
          quantity: item.quantity,
          ...(item.description ? { description: item.description } : {}),
          metadata: { hd_kind: input.hdKind, hd_ref: input.hdRef, hd_item: String(n) },
        },
        workerRequestOptions(`${input.keyPrefix}:item:${n}`),
      );
    }
    invoice = (await stripe.invoices.finalizeInvoice(
      invoice.id,
      { auto_advance: false },
      workerRequestOptions(`${input.keyPrefix}:finalize`),
    )) as unknown as InvoiceLike;
  }

  // Below Stripe's minimum charge the invoice is settled at finalization
  // from the customer's balance; there is nothing left to pay.
  if (invoice.status === "paid") return settled("paid", invoice, isResumed);

  await input.beforePay?.();
  try {
    invoice = (await stripe.invoices.pay(
      invoice.id,
      { off_session: true },
      workerRequestOptions(`${input.keyPrefix}:pay`),
    )) as unknown as InvoiceLike;
  } catch (error) {
    if (!isCardError(error)) throw error;
    if (input.onDecline === "leave_open") return settled("open", invoice, isResumed);
    try {
      await stripe.invoices.voidInvoice(
        invoice.id,
        {},
        workerRequestOptions(`${input.keyPrefix}:void`),
      );
      return { status: "declined", invoiceId: invoice.id, isVoided: true };
    } catch (voidError) {
      // Still open and unpaid: a retry of the same request finds it and tries
      // the card again. Nothing was charged either way.
      log.warn("declined one-off invoice not voided", { code: stripeErrorCode(voidError) });
      return { status: "declined", invoiceId: invoice.id, isVoided: false };
    }
  }
  // A card payment either succeeds here or throws; anything still open is
  // processing, and Stripe settles it without us.
  return settled(invoice.status === "paid" ? "paid" : "open", invoice, isResumed);
}

function settled(
  status: "paid" | "open",
  invoice: InvoiceLike,
  isResumed: boolean,
): OneOffInvoiceResult {
  return {
    status,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    amountCents:
      status === "paid"
        ? (invoice.amount_paid ?? invoice.total ?? 0)
        : (invoice.amount_due ?? invoice.total ?? 0),
    isResumed,
  };
}

/** The card a one-off invoice charges (R16): the customer's default, else the subscription's. */
async function oneOffPaymentMethod(
  stripe: Stripe,
  customerId: string,
  subscription: SubscriptionLike | null,
): Promise<string | null> {
  return effectivePaymentMethod(stripe, { customerId, subscription }, WORKER_STRIPE_OPTIONS);
}

// -----------------------------------------------------------------------------
// Shared local writes
// -----------------------------------------------------------------------------

/**
 * A clinic_channels row, with provisioning's defaults, for every channel
 * `plan` sells, at every location of the billing group: a newly bought
 * channel then shows as "Setting up" everywhere instead of being refused as
 * not live for want of a row. Existing rows are left alone. One transaction
 * per location, in sequence.
 */
async function addBoughtChannelRows(
  locationIds: readonly string[],
  plan: Plan,
  actor: ActorContext,
) {
  const channels = channelList(plan);
  if (channels.length === 0) return;
  for (const locationId of locationIds) {
    await withTenant({ clinicId: locationId, actor }, async (tx) => {
      await tx.db
        .insert(clinicChannels)
        .values(channels.map((channel) => ({ clinicId: locationId, channel })))
        .onConflictDoNothing({ target: [clinicChannels.clinicId, clinicChannels.channel] });
    });
  }
}

/**
 * How the clinic's calls reach us, for an email that ends a channel's service
 * (R31). `routing` is the clinic's coverage mode, through `readCoverageMode`
 * in answering.ts: `clinic_settings.coverage_mode`, the single source.
 */
async function forwardingFacts(tx: TenantTx): Promise<{
  carrier: NoticePayloads["plan_changed"]["carrier"];
  phoneSystem: NonNullable<NoticePayloads["plan_changed"]["phoneSystem"]>;
  routing: CoverageMode;
} | null> {
  const [clinic] = await tx.db
    .select({
      carrier: clinics.carrier,
      phoneSystem: clinics.phoneSystemType,
      callRouting: clinics.callRouting,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;
  return {
    carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
    phoneSystem: clinic.phoneSystem,
    routing: await readCoverageMode(tx.db, tx.clinicId, clinic),
  };
}

// -----------------------------------------------------------------------------
// changePlan (BD12, R7, R13)
// -----------------------------------------------------------------------------

export type ChangePlanInput = {
  clinicId: string;
  planId: string;
  interval: BillingInterval;
  /** Fresh per user attempt, supplied by the UI: a retry is recognised by it, never by comparing prices. */
  requestId: string;
  actorLabel: string;
};

export type ChangePlanResult =
  | {
      status: "changed";
      /** The invoice for the setup-fee difference or the proration, when one was raised. */
      hostedInvoiceUrl: string | null;
      /** Channels in service that the new package does not include: the gate passes them through. */
      droppedChannels: Channel[];
    }
  | { status: "refused" | "busy" | "payment_failed" | "not_available"; message: string };

type StripeOutcome =
  | {
      ok: true;
      hostedInvoiceUrl: string | null;
      /** The package Stripe now bills; null before the plan starts. */
      billed: Plan | null;
      /** Metered keys from the subscription Stripe returned; null when nothing was read. */
      meteredKeys: string[] | null;
      /**
       * The package item's current period on the subscription Stripe
       * returned; null before the start. An interval change re-anchors it,
       * and the allowance window follows (`reanchorAllowanceWindow`).
       */
      period: { start: Date; end: Date } | null;
      /**
       * The billed price or interval changed, so the update prorated the rest
       * of the period onto its invoice (`always_invoice`). Absent means not:
       * the setup-fee difference alone, or nothing, was invoiced.
       */
      isProrated?: boolean;
    }
  /** Refused or declined before anything was charged: the change is over. */
  | { ok: false; result: ChangePlanResult };

type StripeApplied = Extract<StripeOutcome, { ok: true }>;

/**
 * A plan change as the Stripe calls see it: the shared check's answer, and
 * the request every Stripe lookup, idempotency key and marker uses. That is
 * the caller's own `requestId`, or the pending change's when this call
 * carries it on (review fix of 7 October 2026).
 */
type PlanChangeClaim = Extract<PlanChangeCheck, { ok: true }> & { requestId: string };

/** The pending plan change columns, written only by changePlan and its resume. */
async function setPendingPlanChange(
  db: Transaction,
  clinicId: string,
  change: { requestId: string; planId: string; interval: BillingInterval },
) {
  await db
    .update(entitlements)
    .set({
      pendingPlanChangeRequestId: change.requestId,
      pendingPlanChangePlanId: change.planId,
      pendingPlanChangeInterval: change.interval,
    })
    .where(
      and(eq(entitlements.clinicId, clinicId), isNull(entitlements.pendingPlanChangeRequestId)),
    );
}

/** Cleared only while it is still this request: a newer one is not ours to drop. */
async function clearPendingPlanChange(db: Transaction, clinicId: string, requestId: string) {
  await db
    .update(entitlements)
    .set({
      pendingPlanChangeRequestId: null,
      pendingPlanChangePlanId: null,
      pendingPlanChangeInterval: null,
    })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        eq(entitlements.pendingPlanChangeRequestId, requestId),
      ),
    );
}

/**
 * renewLease for a plan change, which also stops once the change is no
 * longer the pending one: an attempt that stalled past its lease, while the
 * reconcile found nothing charged and dropped the change, must not charge
 * for it when it wakes, least of all after the clinic has started another.
 */
async function renewPlanChangeLease(
  billingClinicId: string,
  owner: string,
  requestId: string,
  actor: ActorContext,
) {
  const kept = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    if (row?.pendingPlanChangeRequestId !== requestId) return false;
    return claimStripeMutationLease(tx.db, billingClinicId, owner);
  });
  if (!kept) throw new LeaseLostError();
}

/** A subscription item's current period, or null when Stripe sent none. */
function periodOf(
  item: SubscriptionItemLike | null | undefined,
): { start: Date; end: Date } | null {
  const start = item?.current_period_start;
  const end = item?.current_period_end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start: new Date(start * 1000), end: new Date(end * 1000) };
}

/** Beside `hd_plan_change`: "true" when that update prorated, "false" when it only set the marker. */
const PLAN_CHANGE_PRORATED_KEY = "hd_plan_change_prorated";

/**
 * What a subscription that already carries the change's marker says was
 * applied. Which branch the earlier attempt took is read off the subscription
 * too (`hd_plan_change_prorated`, written in the same update as the marker),
 * never off our row: by the time a retry or the resume gets here, the
 * subscription webhook has usually written the new package and interval to
 * the row, so comparing against it would call a prorated change setup-only.
 */
function appliedFrom(
  subscription: SubscriptionLike,
  current: PackageItem,
  setupInvoiceUrl: string | null,
): StripeApplied {
  const isProrated = subscription.metadata?.[PLAN_CHANGE_PRORATED_KEY] === "true";
  return {
    ok: true,
    // A prorating update raised one invoice, the proration and any setup-fee
    // difference together. Otherwise the difference was its own one-off
    // invoice, and the subscription's latest invoice is some other one.
    hostedInvoiceUrl: isProrated
      ? (invoiceUrlRaisedSince(subscription, 0) ?? setupInvoiceUrl)
      : setupInvoiceUrl,
    billed: current.plan,
    meteredKeys: meteredKeysOf(subscription),
    period: periodOf(current.item),
    isProrated,
  };
}

/**
 * Change the package bought, and with it the price and the channels (BD12,
 * R13). Works on the billing clinic, so every location follows.
 *
 * Before the plan starts nothing is billed yet: a setup-fee difference above
 * zero is charged on its own one-off invoice (R13a), and the rest is local
 * (the bought package, the interval, channel rows), because the plan start
 * reads them when it swaps the $0 placeholder.
 *
 * After the start the billed package becomes `target`, the package for the
 * channels Stripe bills now plus those in service, kept to the new bought
 * package (R7), so a change never silently drops a channel already answering
 * from the price, and never bills one the new package does not sell.
 *
 *   - When `target`'s price or the interval changes: ONE subscription update
 *     swaps the package item (quantity = locations), swaps the metered items
 *     to the new package's rates, adds the setup-fee difference as an
 *     invoice item, invoices the proration at once (`always_invoice`) and
 *     refuses rather than apply unpaid (`error_if_incomplete`).
 *   - Otherwise (blocker 0: a newly bought channel that is not in service yet
 *     leaves the billed package as it is): the difference goes on a one-off
 *     invoice first, then a second update swaps the metered items and sets
 *     the marker, with no proration.
 *
 * Either way the subscription ends up carrying `metadata.hd_plan_change =
 * requestId`, which is how a retry knows the change already went through.
 * `plan_changed` is enqueued by this flow alone, in `finishPlanChange` (BD8).
 *
 * The change is recorded on the billing row before anything is charged
 * (`pending_plan_change_*`, in the transaction that claims the lease) and
 * cleared in the one that applies it, or on a refusal or decline before any
 * charge. A request for the same plan while a change is pending carries that
 * change on under its request id, so it finds the first attempt's charge
 * instead of making a second; any other change is refused until it is done.
 * A change nobody comes back for is finished, or dropped when nothing was
 * charged, by the hourly reconcile (`resumePlanChange`).
 */
export async function changePlan(
  input: ChangePlanInput,
  options: BillingActionOptions = {},
): Promise<ChangePlanResult> {
  const now = options.now ?? new Date();
  if (!REQUEST_ID.test(input.requestId)) {
    return {
      status: "refused",
      message: "That request couldn't be read. Reload the page and try again.",
    };
  }
  const actor = actorFor(input.actorLabel);
  const group = await readBillingGroup(input.clinicId, { now, actor });
  const check = checkPlanChange(group.row, input, group.inService, now);
  if (!check.ok) return { status: check.status, message: check.message };
  const stripe = stripeFor(options);
  if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };

  const billingClinicId = group.billingClinicId;
  // The lease is held under the caller's own request even when it carries on
  // a pending one: while the first attempt's lease runs, a fresh request is
  // busy, and only that attempt's own retry can act.
  const owner = `change_plan:${input.requestId}`;
  const claim = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const fresh = checkPlanChange(
      await getEntitlementsForUpdate(tx.db, billingClinicId),
      input,
      group.inService,
      now,
    );
    if (!fresh.ok) return fresh;
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
      return { ok: false as const, status: "busy" as const, message: BUSY };
    }
    const requestId = fresh.pendingRequestId ?? input.requestId;
    if (fresh.pendingRequestId === null) {
      await setPendingPlanChange(tx.db, billingClinicId, {
        requestId,
        planId: fresh.newPlan.id,
        interval: fresh.interval,
      });
    }
    return { ...fresh, requestId };
  });
  if (!claim.ok) return { status: claim.status, message: claim.message };

  let releaseOnExit = true;
  try {
    const outcome = claim.isStarted
      ? await changeStartedPlan(stripe, claim, group.inService, billingClinicId, owner, actor, now)
      : await chargePlanChangeDelta(stripe, claim, null, billingClinicId, owner, actor);
    if (!outcome.ok) {
      // Refused or declined before anything was charged: the change is over.
      await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
        await clearPendingPlanChange(tx.db, billingClinicId, claim.requestId);
        await releaseStripeMutationLease(tx.db, billingClinicId, owner);
      });
      releaseOnExit = false;
      return outcome.result;
    }
    const droppedChannels = await finishPlanChange({
      billingClinicId,
      claim,
      outcome,
      inService: group.inService,
      locationIds: group.locationIds,
      owner,
      actor,
      billingActor: "client",
      now,
    });
    releaseOnExit = false;
    return { status: "changed", hostedInvoiceUrl: outcome.hostedInvoiceUrl, droppedChannels };
  } catch (error) {
    // We cannot tell whether Stripe applied the change (or, with the lease
    // lost, whether a charge before it went through): keep any lease we hold
    // and the pending change, so a retry, or a fresh request for the same
    // plan, carries it on and finds its own markers.
    releaseOnExit = false;
    log.warn("plan change interrupted", {
      clinicId: billingClinicId,
      requestId: claim.requestId,
      code: stripeErrorCode(error),
    });
    return { status: "refused", message: NO_ANSWER };
  } finally {
    if (releaseOnExit) await releaseLease(billingClinicId, owner, actor);
  }
}

/**
 * The local half of a plan change Stripe has applied, for changePlan and its
 * resume alike: channel rows for the new package at every location, then
 * one billing transaction with the bought and billed packages, the metered
 * keys Stripe returned, the allowance window when the interval change
 * re-anchored the cycle (and, leaving annual billing, the overage of the
 * annual months), the pending change cleared, the history, `plan_changed`
 * and the lease released. Returns the channels in service the new package
 * drops.
 */
async function finishPlanChange(input: {
  billingClinicId: string;
  claim: PlanChangeClaim;
  outcome: StripeApplied;
  inService: readonly Channel[];
  locationIds: readonly string[];
  owner: string;
  actor: ActorContext;
  /** Who the billing history names: the clinic's own request, or the reconcile finishing it. */
  billingActor: "client" | "system";
  now: Date;
}): Promise<Channel[]> {
  const { billingClinicId, claim, outcome, actor } = input;
  const droppedChannels = channelsDroppedBy(claim.newPlan, input.inService);
  await addBoughtChannelRows(input.locationIds, claim.newPlan, actor);
  const voiceDropped = claim.boughtPlan.channels.voice && !claim.newPlan.channels.voice;

  await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    await applyBoughtPlan(tx.db, billingClinicId, claim.newPlan);
    // Before the start plan_code keeps following the bought package, as
    // provisioning seeds it; the plan start moves it to the billed one.
    await applyBilledPlan(tx.db, billingClinicId, outcome.billed ?? claim.newPlan, claim.interval);
    if (outcome.meteredKeys) {
      await setMeteredPriceKeys(tx.db, billingClinicId, outcome.meteredKeys);
    }
    if (outcome.period) {
      await reanchorAllowanceWindow(tx, {
        interval: claim.interval,
        period: outcome.period,
        leftBought: claim.boughtPlan,
        now: input.now,
      });
    }
    await clearPendingPlanChange(tx.db, billingClinicId, claim.requestId);
    await recordBillingNote(tx, { actor: input.billingActor, reason: "plan_change" });
    tx.audit.record({
      action: "update",
      resourceType: "entitlements",
      resourceId: billingClinicId,
      metadata: {
        field: "plan",
        planCode: claim.newPlan.id,
        interval: claim.interval,
        isBeforeStart: !claim.isStarted,
      },
    });
    const facts = voiceDropped ? await forwardingFacts(tx) : null;
    await enqueueNotice(tx, "plan_changed", `plan:${claim.requestId}`, {
      planName: claim.newPlan.name,
      interval: claim.interval,
      locations: claim.locations,
      setupFeeDeltaCents: claim.deltaPerLocationCents * claim.locations,
      hostedInvoiceUrl: outcome.hostedInvoiceUrl,
      hasDroppedChannels: droppedChannels.length > 0,
      isBeforeStart: !claim.isStarted,
      billedPlanId: outcome.billed?.id ?? null,
      isProrated: outcome.isProrated === true,
      ...(facts ?? {}),
    });
    await releaseStripeMutationLease(tx.db, billingClinicId, input.owner);
  });
  return droppedChannels;
}

/**
 * Move the allowance window when a plan change re-anchored Stripe's billing
 * cycle (review fix [20], 7 October 2026). Changing the interval resets the
 * anchor: the package item's new period starts at the change, and the first
 * renewal is a whole month or year later. Left alone, the old window would
 * run on (an annual month past the switch counted against the old allowance)
 * and then lapse with nothing to move it until that first renewal, so usage
 * in between was measured against no allowance: no overage, no hard cap, no
 * alerts. The window re-opens from the new period here, in the transaction
 * that applies the change, with the counters from zero.
 *
 * A re-anchor is read from Stripe's period, not from the row's interval,
 * which the subscription webhook may already have moved: the window began
 * before the new period, and does not simply end where it starts (that is a
 * renewal whose invoice.paid has not arrived yet, R20, which moves the
 * window itself). A change that keeps the interval keeps the cycle and the
 * window.
 *
 * Re-anchored onto a monthly interval means the clinic left annual billing:
 * the annual months not yet invoiced, the one in progress now ending at the
 * switch, are claimed for the annual overage invoice in this transaction,
 * before the meter reporter, which now reports this clinic, can send their
 * usage to a meter (`claimOverageOnLeavingAnnual`).
 */
async function reanchorAllowanceWindow(
  tx: TenantTx,
  input: {
    interval: BillingInterval;
    period: { start: Date; end: Date };
    /** The package bought before this change: its rates priced the annual months. */
    leftBought: Plan;
    now: Date;
  },
): Promise<void> {
  const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
  const windowStart = row?.currentPeriodStart ?? null;
  if (!row || !windowStart) return;
  if (windowStart.getTime() >= input.period.start.getTime()) return;
  if (row.currentPeriodEnd?.getTime() === input.period.start.getTime()) return;
  await openAllowanceWindow(tx.db, tx.clinicId, allowanceWindow(input.interval, input.period));
  if (input.interval === "month") {
    await claimOverageOnLeavingAnnual(tx, {
      switchAt: input.period.start,
      plan: input.leftBought,
      now: input.now,
    });
  }
}

async function changeStartedPlan(
  stripe: Stripe,
  claim: PlanChangeClaim,
  inService: readonly Channel[],
  billingClinicId: string,
  owner: string,
  actor: ActorContext,
  now: Date,
): Promise<StripeOutcome> {
  const subscription = await retrieveSubscription(stripe, claim.row.stripeSubscriptionId as string);
  const current = packageItemOf(subscription);

  // The change already went through (this request's retry, or a request
  // carrying on the pending one): nothing more to charge, whatever else has
  // happened to the subscription since.
  if (subscription.metadata?.hd_plan_change === claim.requestId && current) {
    return appliedFrom(subscription, current, await recoverDeltaInvoiceUrl(stripe, claim));
  }
  if (hasEnded(subscription)) {
    return refused("This plan has ended, so it can't be changed.");
  }
  if (isTrialing(subscription, billingClinicId)) return refused(TRIALING);
  if (!current) {
    return {
      ok: false,
      result: {
        status: "not_available",
        message: "Your plan is still being set up in Stripe. Try again in a few minutes.",
      },
    };
  }
  // At the new plan's steps: a step change within the package moves the
  // package price exactly as a change of package does.
  const target = planForChannels(claim.newPlan, [...channelList(current.plan), ...inService]);
  if (!target) {
    return refused(
      "A plan change can't drop every channel that's already answering. Choose a plan that keeps at least one of them.",
    );
  }

  const expected = expectedMeteredKeys(claim.newPlan.id, claim.interval) ?? [];
  const metered = await meteredItemParams(meteredItemChanges(subscription, expected), { stripe });
  const targetPrice = await priceForLookupKey(stripeLookupKey(target, claim.interval), { stripe });
  // On the caller's clock, like the rest of this change: an invoice is ours only if
  // Stripe created it after this moment, give or take the window in invoiceUrlRaisedSince.
  const sinceSeconds = Math.floor(now.getTime() / 1000);

  if (targetPrice.id !== current.priceId || claim.interval !== current.interval) {
    const setupProduct =
      claim.deltaPerLocationCents > 0
        ? (await priceForLookupKey(stripeLookupKey(claim.newPlan, "setup"), { stripe })).productId
        : null;
    await renewPlanChangeLease(billingClinicId, owner, claim.requestId, actor);
    let updated: SubscriptionLike;
    try {
      updated = (await stripe.subscriptions.update(
        subscription.id,
        {
          items: [
            { id: current.item.id, price: targetPrice.id, quantity: claim.locations },
            ...metered,
          ],
          ...(setupProduct
            ? {
                add_invoice_items: [
                  {
                    price_data: {
                      currency: "usd",
                      product: setupProduct,
                      unit_amount: claim.deltaPerLocationCents,
                    },
                    quantity: claim.locations,
                  },
                ],
              }
            : {}),
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
          off_session: true,
          metadata: { hd_plan_change: claim.requestId, [PLAN_CHANGE_PRORATED_KEY]: "true" },
          expand: ["items.data.price", "latest_invoice"],
        },
        workerRequestOptions(`hd-plan:${billingClinicId}:${claim.requestId}`),
      )) as unknown as SubscriptionLike;
    } catch (error) {
      // error_if_incomplete: a declined charge leaves the subscription as it was.
      if (isCardError(error))
        return { ok: false, result: { status: "payment_failed", message: DECLINED } };
      throw error;
    }
    return {
      ok: true,
      hostedInvoiceUrl: invoiceUrlRaisedSince(updated, sinceSeconds),
      billed: target,
      meteredKeys: meteredKeysOf(updated),
      period: periodOf(packageItemOf(updated)?.item),
      isProrated: true,
    };
  }

  // The billed package stays: charge the difference first, then the marker.
  const delta = await chargePlanChangeDelta(
    stripe,
    claim,
    subscription,
    billingClinicId,
    owner,
    actor,
  );
  if (!delta.ok) return delta;
  await renewPlanChangeLease(billingClinicId, owner, claim.requestId, actor);
  const updated = await markPlanChange(
    stripe,
    subscription.id,
    claim.requestId,
    metered,
    `hd-plan:${billingClinicId}:${claim.requestId}:marker`,
  );
  return {
    ok: true,
    hostedInvoiceUrl: delta.hostedInvoiceUrl,
    billed: current.plan,
    meteredKeys: meteredKeysOf(updated),
    period: periodOf((packageItemOf(updated) ?? current).item),
  };
}

/**
 * The second update of a change that keeps the billed package, and the
 * resume's way to finish one whose difference was paid: the metered items
 * swapped to the new package's rates and the marker set, with no proration,
 * so it charges nothing.
 */
async function markPlanChange(
  stripe: Stripe,
  subscriptionId: string,
  requestId: string,
  metered: Stripe.SubscriptionUpdateParams.Item[],
  idempotencyKey: string,
): Promise<SubscriptionLike> {
  return (await stripe.subscriptions.update(
    subscriptionId,
    {
      ...(metered.length > 0 ? { items: metered } : {}),
      proration_behavior: "none",
      off_session: true,
      metadata: { hd_plan_change: requestId, [PLAN_CHANGE_PRORATED_KEY]: "false" },
      expand: ["items.data.price"],
    },
    workerRequestOptions(idempotencyKey),
  )) as unknown as SubscriptionLike;
}

function refused(message: string): { ok: false; result: ChangePlanResult } {
  return { ok: false, result: { status: "refused", message } };
}

/**
 * The setup-fee difference on its own invoice (R13a), `hd_kind
 * plan_change_setup`, `hd_ref` the request id; nothing when the difference
 * is zero. Before the start this is the plan change's only Stripe call.
 */
async function chargePlanChangeDelta(
  stripe: Stripe,
  claim: PlanChangeClaim,
  subscription: SubscriptionLike | null,
  billingClinicId: string,
  owner: string,
  actor: ActorContext,
): Promise<StripeOutcome> {
  if (claim.deltaPerLocationCents <= 0) {
    return { ok: true, hostedInvoiceUrl: null, billed: null, meteredKeys: null, period: null };
  }
  const customerId = claim.row.stripeCustomerId as string;
  const sub =
    subscription ?? (await retrieveSubscription(stripe, claim.row.stripeSubscriptionId as string));
  const product = (await priceForLookupKey(stripeLookupKey(claim.newPlan, "setup"), { stripe }))
    .productId;
  const charge = await chargeOneOffInvoice(stripe, {
    customerId,
    defaultPaymentMethod: await oneOffPaymentMethod(stripe, customerId, sub),
    hdKind: "plan_change_setup",
    hdRef: claim.requestId,
    keyPrefix: `hd-plan:${billingClinicId}:${claim.requestId}`,
    description: "Setup fee difference",
    items: [
      {
        product,
        unitAmountCents: claim.deltaPerLocationCents,
        quantity: claim.locations,
        description: "Setup fee difference",
      },
    ],
    onDecline: "void",
    beforePay: () => renewPlanChangeLease(billingClinicId, owner, claim.requestId, actor),
  });
  if (charge.status === "declined" || charge.status === "voided") {
    return { ok: false, result: { status: "payment_failed", message: DECLINED } };
  }
  return {
    ok: true,
    hostedInvoiceUrl: charge.hostedInvoiceUrl,
    billed: null,
    meteredKeys: null,
    period: null,
  };
}

/** On a retry that finds the marker: the setup-difference invoice's link, when there was one. */
async function recoverDeltaInvoiceUrl(
  stripe: Stripe,
  claim: PlanChangeClaim,
): Promise<string | null> {
  if (claim.deltaPerLocationCents <= 0) return null;
  const found = await findOneOffInvoices(
    stripe,
    claim.row.stripeCustomerId as string,
    "plan_change_setup",
    claim.requestId,
  );
  return found.find((invoice) => invoice.status === "paid")?.hosted_invoice_url ?? null;
}

// -----------------------------------------------------------------------------
// resumePlanChange: a plan change nobody came back for (review fix, 7 October)
// -----------------------------------------------------------------------------

/**
 * How long a pending plan change has to go untouched before the hourly
 * reconcile steps in: twice the lease, so the attempt that set it has
 * certainly stopped, and the clinic's own retry, which carries it on, has
 * had its chance first.
 */
export const STALE_PLAN_CHANGE_MS = 2 * STRIPE_MUTATION_LEASE_MS;

export type ResumePlanChangeInput = {
  clinicId: string;
  actorLabel: string;
  /**
   * Resume only a change nobody has touched for this long: its lease free,
   * and last claimed or renewed at least this long ago. The reconcile
   * passes STALE_PLAN_CHANGE_MS.
   */
  staleAfterMs?: number;
};

export type ResumePlanChangeResult =
  | { status: "changed"; hostedInvoiceUrl: string | null }
  /** Stripe holds no charge or marker for it, so it was dropped: nothing was charged, and the clinic can ask again. */
  | { status: "cleared" }
  | { status: "nothing_pending" }
  | { status: "busy" | "refused" | "not_available"; message: string };

/**
 * Finish, or drop, a plan change left pending (review fix of 7 October
 * 2026): the attempt that recorded it lost Stripe's answer, or died, and
 * nobody retried. The hourly reconcile calls this once the change has gone
 * untouched for STALE_PLAN_CHANGE_MS; without it the bought package and the
 * channels stayed on the old plan for good, a channel whose setup difference
 * had been paid was refused as not purchased, and every other plan change
 * was refused for as long as it stayed pending.
 *
 * It never charges, and it judges by what Stripe holds for the pending
 * request, never by comparing prices:
 *   - the subscription carries the change's marker: it went through, so the
 *     local writes are done exactly as changePlan does them;
 *   - the setup-difference invoice for the request was paid but the marker
 *     update did not go through: that update is made (the metered swap and
 *     the marker, with no proration, so nothing is charged), then the local
 *     writes; before the start there is no update to make;
 *   - neither: nothing was charged, so an invoice an attempt left open is
 *     voided, a draft deleted, and the pending change cleared. The clinic
 *     can make the change again; charging now would take money for a change
 *     it was told might not have happened.
 *
 * Holds the lease under its own name, so it is `busy` while anything else,
 * the original attempt included, is mid-flight.
 */
export async function resumePlanChange(
  input: ResumePlanChangeInput,
  options: BillingActionOptions = {},
): Promise<ResumePlanChangeResult> {
  const now = options.now ?? new Date();
  const actor = actorFor(input.actorLabel);
  // A cheap look first: the reconcile asks this of every billing clinic hourly.
  const billingClinicId = await withTenant({ clinicId: input.clinicId, actor }, (tx) =>
    resolveBillingClinicId(tx),
  );
  const row = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
    getEntitlements(tx.db, billingClinicId),
  );
  if (!row || !pendingPlanChangeOf(row)) return { status: "nothing_pending" };
  const stripe = stripeFor(options);
  if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };
  const group = await readBillingGroup(billingClinicId, { now, actor });
  const owner = `resume_plan:${randomUUID()}`;
  // Leases are wall-clock (renewLease); a pinned `now` ahead of the clock
  // is honoured, as the reconcile's own resumes do, never one behind it.
  const leaseNow = new Date(Math.max(now.getTime(), Date.now()));

  const claimed = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const locked = await getEntitlementsForUpdate(tx.db, billingClinicId);
    const pending = locked ? pendingPlanChangeOf(locked) : null;
    if (!locked || !pending) return { ok: false as const, status: "nothing_pending" as const };
    // A lease is claimed for STRIPE_MUTATION_LEASE_MS, so its expiry less that
    // is the last time anyone claimed or renewed it. No lease at all means
    // another holder took it over once the change's own had run out, and
    // released it since: the change is at least a lease old and nobody is on it.
    const lastTouched = locked.stripeMutationLeaseUntil
      ? locked.stripeMutationLeaseUntil.getTime() - STRIPE_MUTATION_LEASE_MS
      : null;
    if (
      input.staleAfterMs !== undefined &&
      lastTouched !== null &&
      leaseNow.getTime() - lastTouched < input.staleAfterMs
    ) {
      return { ok: false as const, status: "busy" as const };
    }
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner, { now: leaseNow }))) {
      return { ok: false as const, status: "busy" as const };
    }
    const boughtPlan = locked.boughtPlanId ? getPlan(locked.boughtPlanId) : undefined;
    const newPlan = getPlan(pending.planId);
    if (!boughtPlan || !newPlan) {
      await releaseStripeMutationLease(tx.db, billingClinicId, owner);
      return { ok: false as const, status: "refused" as const };
    }
    const claim: PlanChangeClaim = {
      ok: true,
      row: locked,
      boughtPlan,
      newPlan,
      interval: pending.interval,
      isStarted: hasPlanStarted(locked),
      deltaPerLocationCents: setupFeeDeltaUsd(boughtPlan, newPlan) * 100,
      locations: locked.locations,
      pendingRequestId: pending.requestId,
      requestId: pending.requestId,
    };
    return { ok: true as const, claim };
  });
  if (!claimed.ok) {
    if (claimed.status === "nothing_pending") return { status: "nothing_pending" };
    if (claimed.status === "busy") return { status: "busy", message: BUSY };
    return {
      status: "refused",
      message:
        "This plan change names a plan that is no longer sold. It needs a person to finish it.",
    };
  }
  const claim = claimed.claim;

  let releaseOnExit = true;
  try {
    const evidence = await planChangeEvidence(stripe, claim);
    if (evidence.isMarked && !evidence.current) {
      // Marked as applied, yet no package price to read: never dropped on that.
      throw new Error("The subscription carries the plan change's marker but no package item.");
    }
    let outcome: StripeApplied | null = null;
    if (evidence.isMarked && evidence.current && evidence.subscription) {
      outcome = appliedFrom(
        evidence.subscription,
        evidence.current,
        evidence.paid?.hosted_invoice_url ?? null,
      );
    } else if (evidence.paid) {
      const paidUrl = evidence.paid.hosted_invoice_url ?? null;
      if (claim.isStarted && evidence.subscription && evidence.current) {
        const expected = expectedMeteredKeys(claim.newPlan.id, claim.interval) ?? [];
        const metered = await meteredItemParams(
          meteredItemChanges(evidence.subscription, expected),
          { stripe },
        );
        await renewPlanChangeLease(billingClinicId, owner, claim.requestId, actor);
        // A key of this resume's own: an earlier marker update's failure,
        // cached by Stripe under the request's key for a day, must not be
        // replayed. Safe to repeat, because the marker was checked first and
        // the update charges nothing.
        const updated = await markPlanChange(
          stripe,
          evidence.subscription.id,
          claim.requestId,
          metered,
          `hd-plan:${billingClinicId}:${claim.requestId}:marker:${owner}`,
        );
        const after = packageItemOf(updated) ?? evidence.current;
        outcome = {
          ok: true,
          hostedInvoiceUrl: paidUrl,
          billed: after.plan,
          meteredKeys: meteredKeysOf(updated),
          period: periodOf(after.item),
        };
      } else {
        outcome = {
          ok: true,
          hostedInvoiceUrl: paidUrl,
          billed: null,
          meteredKeys: null,
          period: null,
        };
      }
    }

    if (!outcome) {
      for (const invoiceId of evidence.openInvoiceIds) {
        await stripe.invoices.voidInvoice(invoiceId, {}, WORKER_STRIPE_OPTIONS);
      }
      for (const invoiceId of evidence.draftInvoiceIds) {
        await stripe.invoices.del(invoiceId, {}, WORKER_STRIPE_OPTIONS);
      }
      await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
        await clearPendingPlanChange(tx.db, billingClinicId, claim.requestId);
        await recordBillingNote(tx, { actor: "system", reason: "plan_change_cleared" });
        await releaseStripeMutationLease(tx.db, billingClinicId, owner);
      });
      releaseOnExit = false;
      log.info("pending plan change cleared: nothing was charged", {
        clinicId: billingClinicId,
        requestId: claim.requestId,
      });
      return { status: "cleared" };
    }

    await finishPlanChange({
      billingClinicId,
      claim,
      outcome,
      inService: group.inService,
      locationIds: group.locationIds,
      owner,
      actor,
      billingActor: "system",
      now,
    });
    releaseOnExit = false;
    log.info("pending plan change finished", {
      clinicId: billingClinicId,
      requestId: claim.requestId,
    });
    return { status: "changed", hostedInvoiceUrl: outcome.hostedInvoiceUrl };
  } catch (error) {
    // Nothing here charges, so the lease goes now; the next run looks again.
    log.warn("pending plan change not resumed", {
      clinicId: billingClinicId,
      requestId: claim.requestId,
      code: stripeErrorCode(error),
    });
    return { status: "refused", message: NO_ANSWER };
  } finally {
    if (releaseOnExit) await releaseLease(billingClinicId, owner, actor);
  }
}

/** What Stripe holds for a pending plan change: its marker, and its setup-difference invoices. */
async function planChangeEvidence(
  stripe: Stripe,
  claim: PlanChangeClaim,
): Promise<{
  subscription: SubscriptionLike | null;
  current: PackageItem | null;
  isMarked: boolean;
  paid: InvoiceLike | null;
  openInvoiceIds: string[];
  draftInvoiceIds: string[];
}> {
  const subscription = claim.row.stripeSubscriptionId
    ? await retrieveSubscription(stripe, claim.row.stripeSubscriptionId)
    : null;
  const found = claim.row.stripeCustomerId
    ? await findOneOffInvoices(
        stripe,
        claim.row.stripeCustomerId,
        "plan_change_setup",
        claim.requestId,
      )
    : [];
  return {
    subscription,
    current: subscription ? packageItemOf(subscription) : null,
    isMarked: subscription?.metadata?.hd_plan_change === claim.requestId,
    paid: found.find((invoice) => invoice.status === "paid") ?? null,
    openInvoiceIds: found.filter((invoice) => invoice.status === "open").map((i) => i.id),
    draftInvoiceIds: found.filter((invoice) => invoice.status === "draft").map((i) => i.id),
  };
}

// -----------------------------------------------------------------------------
// addLocation (BD13, R14)
// -----------------------------------------------------------------------------

export type AddLocationInput = {
  clinicId: string;
  /**
   * Fresh per user attempt (a lower-case uuid); the pending-location columns
   * and the pending location row resume a failed attempt by it.
   */
  requestId: string;
  actorLabel: string;
  /** The location being added. Required for a new request; a resume reads the row it wrote. */
  location?: NewLocation;
  /** The central-assistant acknowledgement, ticked under a passkey step-up. Required for a new request. */
  acceptance?: LocationAcceptance;
};

export type AddLocationResult =
  | { status: "added"; locationId: string }
  | {
      status: "pending_setup" | "refused" | "busy" | "payment_failed" | "not_available";
      message: string;
    };

const LOCATION_IN_PROGRESS =
  "Another location is still being added to this account. Wait for it to finish, then try again.";
const PENDING_SETUP =
  "The location is paid for and is being set up. We've been told, and it will appear here shortly; there's no need to add it again.";

const ADD_LOCATION_DETAILS =
  "Give the location's name and address, and tick the acknowledgement, then try again. Nothing was charged.";

/** A refusal from inside the claim's transaction, thrown so the transaction rolls back. */
class LocationAddRefused extends Error {
  constructor(
    readonly status: "refused" | "not_available",
    message: string,
  ) {
    super(message);
    this.name = "LocationAddRefused";
  }
}

/** The pending-location columns, written only here and in the resume (R14). */
async function setPendingLocation(
  db: Transaction,
  clinicId: string,
  requestId: string,
  count: number,
) {
  await db
    .update(entitlements)
    .set({ pendingLocationRequestId: requestId, pendingLocationCount: count })
    .where(and(eq(entitlements.clinicId, clinicId), isNull(entitlements.pendingLocationRequestId)));
}

async function markPendingLocationCharged(
  db: Transaction,
  clinicId: string,
  requestId: string,
  at: Date,
) {
  await db
    .update(entitlements)
    .set({
      pendingLocationChargedAt: sql`coalesce(${entitlements.pendingLocationChargedAt}, ${at}::timestamptz)`,
    })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        eq(entitlements.pendingLocationRequestId, requestId),
      ),
    );
}

async function clearPendingLocation(db: Transaction, clinicId: string, requestId: string) {
  await db
    .update(entitlements)
    .set({
      pendingLocationRequestId: null,
      pendingLocationCount: null,
      pendingLocationChargedAt: null,
    })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        eq(entitlements.pendingLocationRequestId, requestId),
      ),
    );
}

/**
 * Add a location (BD13, R14): one more of the package price on the same
 * subscription and renewal date, plus the bought package's setup fee once,
 * for a further location of this same account, answered by the account's one
 * AYA (the owner's central model of 20 October 2026; lib/location-add.ts).
 *
 * Refused with `not_available` before anything else while no package may
 * add a location (`anyLocationsReady`), and by `checkAddLocation` while the
 * package bought may not (`locationsReady`): until the location can be
 * created, a charge would buy something that cannot exist.
 *
 * Every step is resumable, all under the billing clinic's mutation lease:
 *   1. in one transaction, before any charge: the central-assistant
 *      acknowledgement recorded under the person's step-up and the pending
 *      location naming it (`writePendingLocation`, which refuses a DPA
 *      practice and an unreleased acknowledgement), and the billing row's
 *      pending request and the count it makes (`pending_location_*`); a
 *      different request while one is pending is refused, the same request
 *      resumes;
 *   2. the charge: after the start, one subscription update (quantity n,
 *      the setup price as an invoice item, invoiced and paid at once or
 *      refused, `metadata.hd_location = requestId`, which a retry finds);
 *      before the start, a one-off invoice (R13a), found again by `hd_ref`;
 *      a decline clears the pending request and retires its location;
 *   3. `pending_location_charged_at` and the new location count;
 *   4. the pending location made active (`activatePendingLocation`, through
 *      app_activate_location(), which refuses it until step 3 is recorded
 *      and returns the same time when repeated), so a resume never makes two;
 *   5. the pending request cleared and `location_added` enqueued.
 * A failure after step 3 leaves the request pending: the hourly reconcile
 * or the console's `retryLocationSetup` finishes it (`resumeLocationSetup`),
 * and ops are told straight away.
 */
export async function addLocation(
  input: AddLocationInput,
  options: BillingActionOptions = {},
): Promise<AddLocationResult> {
  if (!anyLocationsReady()) {
    return {
      status: "not_available",
      message:
        "Adding a location from Billing isn't available yet. Nothing was changed and nothing was charged.",
    };
  }
  const now = options.now ?? new Date();
  if (!REQUEST_ID.test(input.requestId) || !isLocationRequestId(input.requestId)) {
    return {
      status: "refused",
      message: "That request couldn't be read. Reload the page and try again.",
    };
  }
  const actor = actorFor(input.actorLabel);
  const group = await readBillingGroup(input.clinicId, { now, actor });
  const stripe = stripeFor(options);
  if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };
  const billingClinicId = group.billingClinicId;
  const owner = `add_location:${input.requestId}`;

  let claim;
  try {
    claim = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
      const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
      const pendingId = row?.pendingLocationRequestId ?? null;
      if (row && pendingId !== null && pendingId !== input.requestId) {
        return { ok: false as const, status: "refused" as const, message: LOCATION_IN_PROGRESS };
      }
      const resumingCharged =
        row !== null && pendingId === input.requestId && row.pendingLocationChargedAt !== null;
      const check = checkAddLocation(row, now);
      // A request that has already been charged is finished whatever the
      // account's standing now: the money was taken for this location.
      if (!check.ok && !resumingCharged) return check;
      if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
        return { ok: false as const, status: "busy" as const, message: BUSY };
      }
      const current = row as Entitlements;
      const count = current.pendingLocationCount ?? current.locations + 1;
      if (pendingId === null) {
        // The acknowledgement and the pending location, before anything is
        // charged and in this transaction: a refusal rolls back the lease and
        // the pending marker with them (LocationAddRefused, caught below).
        if (!input.location || !input.acceptance) {
          throw new LocationAddRefused("refused", ADD_LOCATION_DETAILS);
        }
        const written = await writePendingLocation(tx, {
          requestId: input.requestId,
          boughtPlan: getPlan(current.boughtPlanId as string) as Plan,
          location: input.location,
          acceptance: input.acceptance,
        });
        if (!written.ok) {
          throw new LocationAddRefused(
            written.code === "dpa" || written.code === "not_released" ? "not_available" : "refused",
            written.message,
          );
        }
        await setPendingLocation(tx.db, billingClinicId, input.requestId, count);
      }
      return {
        ok: true as const,
        row: current,
        boughtPlan: getPlan(current.boughtPlanId as string) as Plan,
        isStarted: hasPlanStarted(current),
        count,
        isCharged: current.pendingLocationChargedAt !== null,
      };
    });
  } catch (error) {
    if (error instanceof LocationAddRefused) return { status: error.status, message: error.message };
    // The database refused the acceptance (an ended step-up, a person with no
    // grant): rolled back with everything else, and said in its own words.
    if (error instanceof LocationAcceptanceRefused) {
      return { status: "refused", message: error.message };
    }
    throw error;
  }
  if (!claim.ok) return { status: claim.status, message: claim.message };

  let releaseOnExit = true;
  try {
    let hostedInvoiceUrl: string | null = null;
    if (!claim.isCharged) {
      const charge = await chargeLocation(
        stripe,
        claim,
        input.requestId,
        billingClinicId,
        owner,
        actor,
        now,
      );
      if (charge.status === "declined") {
        await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
          await clearPendingLocation(tx.db, billingClinicId, input.requestId);
          await retireUnpaidLocation(tx, input.requestId);
          await releaseStripeMutationLease(tx.db, billingClinicId, owner);
        });
        releaseOnExit = false;
        return { status: "payment_failed", message: DECLINED };
      }
      if (charge.status === "not_available") {
        await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
          await clearPendingLocation(tx.db, billingClinicId, input.requestId);
          await retireUnpaidLocation(tx, input.requestId);
          await releaseStripeMutationLease(tx.db, billingClinicId, owner);
        });
        releaseOnExit = false;
        return { status: "not_available", message: charge.message };
      }
      hostedInvoiceUrl = charge.hostedInvoiceUrl;
      await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
        await markPendingLocationCharged(tx.db, billingClinicId, input.requestId, now);
        await setLocations(tx.db, billingClinicId, claim.count);
      });
    }

    const finished = await finishLocationSetup({
      billingClinicId,
      requestId: input.requestId,
      count: claim.count,
      actor,
      billingActor: "client",
      owner,
      hostedInvoiceUrl,
      inService: group.inService,
    });
    releaseOnExit = false;
    return finished;
  } catch (error) {
    // The charge's outcome is unknown (or our lease was lost before it): keep
    // any lease we hold and the pending request, so only this request resumes,
    // and step 2 finds its own marker instead of charging again.
    releaseOnExit = false;
    log.warn("location add interrupted", {
      clinicId: billingClinicId,
      requestId: input.requestId,
      code: stripeErrorCode(error),
    });
    return { status: "refused", message: NO_ANSWER };
  } finally {
    if (releaseOnExit) await releaseLease(billingClinicId, owner, actor);
  }
}

type LocationClaim = {
  row: Entitlements;
  boughtPlan: Plan;
  isStarted: boolean;
  count: number;
};

type LocationCharge =
  | { status: "charged"; hostedInvoiceUrl: string | null }
  | { status: "declined" }
  | { status: "not_available"; message: string };

/** Step 2 of addLocation: the charge, or the evidence of an earlier attempt's. */
async function chargeLocation(
  stripe: Stripe,
  claim: LocationClaim,
  requestId: string,
  billingClinicId: string,
  owner: string,
  actor: ActorContext,
  now: Date,
): Promise<LocationCharge> {
  const subscription = await retrieveSubscription(stripe, claim.row.stripeSubscriptionId as string);
  if (hasEnded(subscription)) {
    return {
      status: "not_available",
      message: "This plan has ended, so a location can't be added.",
    };
  }
  if (isTrialing(subscription, billingClinicId))
    return { status: "not_available", message: TRIALING };
  const setupPrice = await priceForLookupKey(stripeLookupKey(claim.boughtPlan, "setup"), {
    stripe,
  });
  const keyPrefix = `hd-location:${billingClinicId}:${requestId}`;

  if (!claim.isStarted) {
    const customerId = claim.row.stripeCustomerId as string;
    const charge = await chargeOneOffInvoice(stripe, {
      customerId,
      defaultPaymentMethod: await oneOffPaymentMethod(stripe, customerId, subscription),
      hdKind: "location_setup",
      hdRef: requestId,
      keyPrefix,
      description: "Setup fee for an additional location",
      items: [
        { price: setupPrice.id, quantity: 1, description: "Setup fee for an additional location" },
      ],
      onDecline: "void",
      beforePay: () => renewLease(billingClinicId, owner, actor),
    });
    if (charge.status === "declined" || charge.status === "voided") return { status: "declined" };
    return { status: "charged", hostedInvoiceUrl: charge.hostedInvoiceUrl };
  }

  if (subscription.metadata?.hd_location === requestId) {
    return { status: "charged", hostedInvoiceUrl: invoiceUrlRaisedSince(subscription, 0) };
  }
  const current = packageItemOf(subscription);
  if (!current) {
    return {
      status: "not_available",
      message: "Your plan is still being set up in Stripe. Try again in a few minutes.",
    };
  }
  // On the caller's clock, like the rest of this change: an invoice is ours only if
  // Stripe created it after this moment, give or take the window in invoiceUrlRaisedSince.
  const sinceSeconds = Math.floor(now.getTime() / 1000);
  await renewLease(billingClinicId, owner, actor);
  try {
    const updated = (await stripe.subscriptions.update(
      subscription.id,
      {
        items: [{ id: current.item.id, quantity: claim.count }],
        add_invoice_items: [{ price: setupPrice.id }],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        off_session: true,
        metadata: { hd_location: requestId },
        expand: ["items.data.price", "latest_invoice"],
      },
      workerRequestOptions(`hd-location:${billingClinicId}:${requestId}`),
    )) as unknown as SubscriptionLike;
    return { status: "charged", hostedInvoiceUrl: invoiceUrlRaisedSince(updated, sinceSeconds) };
  } catch (error) {
    if (isCardError(error)) return { status: "declined" };
    throw error;
  }
}

/**
 * Steps 4 and 5: activate the add's location, then clear the pending
 * request and enqueue `location_added`. Releases the lease either way; on an
 * activation failure the request stays pending and ops are told.
 */
async function finishLocationSetup(input: {
  billingClinicId: string;
  requestId: string;
  count: number;
  actor: ActorContext;
  /** Who the billing history names: the clinic's own request, or support finishing it. */
  billingActor: "client" | "support";
  owner: string;
  hostedInvoiceUrl: string | null;
  inService: readonly Channel[];
}): Promise<AddLocationResult> {
  const { billingClinicId, requestId, count, actor, owner } = input;
  try {
    await renewLease(billingClinicId, owner, actor);
  } catch {
    // Someone else holds the lease now (the reconcile's resume, or an
    // operator's): the request is charged and pending, and they finish it.
    return { status: "pending_setup", message: PENDING_SETUP };
  }
  let created: { locationId: string; activatedAt: Date } | null;
  try {
    // The location the add wrote before its charge, made active now that the
    // charge is recorded: app_activate_location() refuses it otherwise.
    created = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
      activatePendingLocation(tx, requestId),
    );
    if (!created) throw new Error("the add has no pending location to activate");
  } catch (error) {
    log.warn("location not activated after its charge", {
      clinicId: billingClinicId,
      requestId,
      code: stripeErrorCode(error),
    });
    await notifyOps("location_charged_not_created", { clinicId: billingClinicId, count });
    await releaseLease(billingClinicId, owner, actor);
    return { status: "pending_setup", message: PENDING_SETUP };
  }

  await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlements(tx.db, billingClinicId);
    const started = row ? hasPlanStarted(row) : false;
    const bought = row?.boughtPlanId ? (getPlan(row.boughtPlanId) ?? null) : null;
    const billed = started && row ? (getPlan(row.planCode) ?? null) : null;
    const interval = row?.billingInterval ?? "month";
    const priced =
      billed ??
      (bought ? (planForChannels(bought, input.inService) ?? bought) : null);
    await clearPendingLocation(tx.db, billingClinicId, requestId);
    await recordBillingNote(tx, { actor: input.billingActor, reason: "location_added" });
    tx.audit.record({
      action: "update",
      resourceType: "entitlements",
      resourceId: billingClinicId,
      metadata: { field: "locations", locations: count },
    });
    await enqueueNotice(tx, "location_added", `location:${requestId}`, {
      locations: count,
      recurringCents: priced ? recurringUsd(priced, interval) * 100 : 0,
      setupFeeCents: bought ? bought.setupFeeUsd * 100 : 0,
      hostedInvoiceUrl: input.hostedInvoiceUrl,
      isBeforeStart: !started,
      billedPlanId: billed?.id ?? null,
    });
    await releaseStripeMutationLease(tx.db, billingClinicId, owner);
  });
  return { status: "added", locationId: created.locationId };
}

export type ResumeLocationSetupResult =
  | { status: "added"; locationId: string }
  /** The pending request was never charged, so it was cleared: the clinic can add the location again. */
  | { status: "cleared" }
  | { status: "pending_setup" | "refused" | "busy" | "not_available"; message: string };

/**
 * Finish a pending location (R14): the shared resume behind the console's
 * `retryLocationSetup`, and the logic the hourly reconcile's resume follows.
 *
 * Charged already (`pending_location_charged_at`): activate the location and
 * enqueue `location_added`, exactly as addLocation's last two steps do.
 * Not charged on record: ask Stripe whether the charge went through (the
 * subscription's `hd_location` marker, or a paid one-off invoice for the
 * request); if it did, record it and finish; if it did not, clear the
 * pending request and retire its location, because charging now would take
 * money the clinic did not just agree to. Never charges.
 *
 * Holds the lease under its own name, so it is `busy` while the original
 * request (or anything else) is still mid-flight.
 */
export async function resumeLocationSetup(
  input: { clinicId: string; actorLabel: string },
  options: BillingActionOptions = {},
): Promise<ResumeLocationSetupResult> {
  const now = options.now ?? new Date();
  const actor = actorFor(input.actorLabel);
  const group = await readBillingGroup(input.clinicId, { now, actor });
  const billingClinicId = group.billingClinicId;
  const owner = `resume_location:${randomUUID()}`;

  const claim = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    if (!row || !row.pendingLocationRequestId || row.pendingLocationCount === null) {
      return {
        ok: false as const,
        status: "refused" as const,
        message: "No location is waiting to be set up on this account.",
      };
    }
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
      return { ok: false as const, status: "busy" as const, message: BUSY };
    }
    return {
      ok: true as const,
      row,
      requestId: row.pendingLocationRequestId,
      count: row.pendingLocationCount,
      isCharged: row.pendingLocationChargedAt !== null,
    };
  });
  if (!claim.ok) return { status: claim.status, message: claim.message };

  let releaseOnExit = true;
  try {
    if (!claim.isCharged) {
      const stripe = stripeFor(options);
      if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };
      const evidence = await locationChargeEvidence(stripe, claim.row, claim.requestId);
      if (!evidence.isCharged) {
        // An attempt that died between finalizing its invoice and paying it
        // left that invoice open: void it, so nothing stays owed for a
        // location that will not be added.
        for (const invoiceId of evidence.openInvoiceIds) {
          await stripe.invoices.voidInvoice(invoiceId, {}, WORKER_STRIPE_OPTIONS);
        }
        await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
          await clearPendingLocation(tx.db, billingClinicId, claim.requestId);
          await retireUnpaidLocation(tx, claim.requestId);
          await recordBillingNote(tx, { actor: "support", reason: "location_request_cleared" });
          await releaseStripeMutationLease(tx.db, billingClinicId, owner);
        });
        releaseOnExit = false;
        return { status: "cleared" };
      }
      await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
        await markPendingLocationCharged(tx.db, billingClinicId, claim.requestId, now);
        await setLocations(tx.db, billingClinicId, claim.count);
      });
    }
    if (!locationsReady(claim.row.boughtPlanId)) {
      return {
        status: "pending_setup",
        message:
          "The location is paid for, but locations can't be switched on for this package yet. It stays pending.",
      };
    }
    const finished = await finishLocationSetup({
      billingClinicId,
      requestId: claim.requestId,
      count: claim.count,
      actor,
      billingActor: "support",
      owner,
      hostedInvoiceUrl: null,
      inService: group.inService,
    });
    releaseOnExit = false;
    if (finished.status === "added") return finished;
    return { status: "pending_setup", message: PENDING_SETUP };
  } catch (error) {
    log.warn("location resume failed", { clinicId: billingClinicId, code: stripeErrorCode(error) });
    return { status: "refused", message: NO_ANSWER };
  } finally {
    if (releaseOnExit) await releaseLease(billingClinicId, owner, actor);
  }
}

/**
 * Whether Stripe holds the charge for a pending location request, by its
 * markers (the subscription's `hd_location`, or a paid one-off invoice for
 * the request), and any of the request's one-off invoices left open.
 */
async function locationChargeEvidence(
  stripe: Stripe,
  row: Entitlements,
  requestId: string,
): Promise<{ isCharged: boolean; openInvoiceIds: string[] }> {
  if (row.stripeSubscriptionId) {
    const subscription = await retrieveSubscription(stripe, row.stripeSubscriptionId);
    if (subscription.metadata?.hd_location === requestId) {
      return { isCharged: true, openInvoiceIds: [] };
    }
  }
  if (!row.stripeCustomerId) return { isCharged: false, openInvoiceIds: [] };
  const found = await findOneOffInvoices(stripe, row.stripeCustomerId, "location_setup", requestId);
  return {
    isCharged: found.some((invoice) => invoice.status === "paid"),
    openInvoiceIds: found.filter((invoice) => invoice.status === "open").map((i) => i.id),
  };
}

// -----------------------------------------------------------------------------
// setAutoRenew (BD10, R5, R15)
// -----------------------------------------------------------------------------

export type SetAutoRenewInput = { clinicId: string; on: boolean; actorLabel: string };

export type SetAutoRenewResult =
  | {
      status: "ok";
      /** ISO date the account closes on with auto-renew off; null with it on. */
      closesOn: string | null;
    }
  | { status: "busy" | "refused"; message: string };

/** The renewal and cancellation statuses auto-renew can be changed from. */
const AUTO_RENEW_STATUSES = new Set(["active", "past_due", "canceling"]);

/**
 * Turn auto-renew off or on (BD10): Stripe's `cancel_at_period_end`, on the
 * billing clinic's subscription.
 *
 * `entitlements.cancel_at` is stamped here, synchronously, from the
 * subscription Stripe returns, rather than left to the webhook: between this
 * call and `customer.subscription.updated` arriving, a first answer could
 * otherwise start the plan of an account that has just asked to close. The
 * webhook still moves the status and sends `cancel_scheduled` or
 * `cancel_reversed`.
 *
 * Before the plan starts, turning it off also marks a pending `plan_start`
 * request skipped (`cancel_pending`) in the same transaction that claims the
 * lease (R5), so no plan can start on an account that is closing; turning
 * it back on re-arms that request. While the plan-start worker holds the
 * lease this answers `busy`.
 *
 * Turned off after the start inside the first-period refund window, with no
 * refund yet, it tells ops a refund is due (R15): the clinic's email says
 * the team will be in touch.
 */
export async function setAutoRenew(
  input: SetAutoRenewInput,
  options: BillingActionOptions = {},
): Promise<SetAutoRenewResult> {
  const now = options.now ?? new Date();
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await withTenant({ clinicId: input.clinicId, actor }, (tx) =>
    resolveBillingClinicId(tx),
  );
  const stripe = stripeFor(options);
  if (!stripe) return { status: "refused", message: NOT_AVAILABLE };
  const owner = `auto_renew:${randomUUID()}`;

  const claim = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    if (!row)
      return {
        ok: false as const,
        status: "refused" as const,
        message: "We couldn't find a billing account for this clinic.",
      };
    if (!row.stripeSubscriptionId) {
      return {
        ok: false as const,
        status: "refused" as const,
        message: "Billing isn't set up for this account yet.",
      };
    }
    if (!AUTO_RENEW_STATUSES.has(row.status)) {
      return {
        ok: false as const,
        status: "refused" as const,
        message:
          row.status === "canceled" || row.status === "purged"
            ? "This plan has already ended."
            : "Auto-renew can't be changed while the account is on hold. Contact us and we'll sort it out.",
      };
    }
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
      return { ok: false as const, status: "busy" as const, message: BUSY };
    }
    let skipped: { id: string; reason: BillingRequestReason } | null = null;
    if (!input.on && !hasPlanStarted(row)) {
      const [pending] = await tx.db
        .update(billingRequests)
        .set({ doneAt: now, outcome: "skipped", outcomeReason: "cancel_pending", leaseUntil: null })
        .where(
          and(
            eq(billingRequests.clinicId, billingClinicId),
            eq(billingRequests.kind, "plan_start"),
            isNull(billingRequests.doneAt),
          ),
        )
        .returning({ id: billingRequests.id, reason: billingRequests.reason });
      skipped = pending ?? null;
    }
    return { ok: true as const, row, skipped };
  });
  if (!claim.ok) return { status: claim.status, message: claim.message };

  let updated: SubscriptionLike;
  try {
    const subscription = await retrieveSubscription(
      stripe,
      claim.row.stripeSubscriptionId as string,
    );
    if (hasEnded(subscription) || isTrialing(subscription, billingClinicId)) {
      await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
        if (claim.skipped)
          await rearmBillingRequest(tx, claim.skipped.id, claim.skipped.reason, now);
        await releaseStripeMutationLease(tx.db, billingClinicId, owner);
      });
      return {
        status: "refused",
        message: hasEnded(subscription) ? "This plan has already ended." : TRIALING,
      };
    }
    const scheduled =
      subscription.cancel_at_period_end === true || typeof subscription.cancel_at === "number";
    updated = subscription;
    if (input.on && scheduled) {
      // A dated cancel_at (never ours: the portal's cancellation is off) is
      // cleared by its own parameter; Stripe refuses the two together. The
      // refund marker goes with it: there is no cancellation left to refund.
      updated = (await stripe.subscriptions.update(
        subscription.id,
        {
          ...(subscription.cancel_at_period_end === true
            ? { cancel_at_period_end: false }
            : { cancel_at: "" as const }),
          metadata: { [REFUND_ELIGIBLE_METADATA_KEY]: "" },
          expand: ["items.data.price"],
        },
        WORKER_STRIPE_OPTIONS,
      )) as unknown as SubscriptionLike;
    } else if (!input.on && !scheduled) {
      const refundUntil = refundEligibleUntil(claim.row, now);
      updated = (await stripe.subscriptions.update(
        subscription.id,
        {
          cancel_at_period_end: true,
          ...(refundUntil ? { metadata: { [REFUND_ELIGIBLE_METADATA_KEY]: refundUntil } } : {}),
          expand: ["items.data.price"],
        },
        WORKER_STRIPE_OPTIONS,
      )) as unknown as SubscriptionLike;
    }
  } catch (error) {
    log.warn("auto-renew not changed", { clinicId: billingClinicId, code: stripeErrorCode(error) });
    // Setting the flag again sets it the same way, so the lease goes now and a
    // plan start skipped on the way in is re-armed. If Stripe did apply the
    // change before its answer was lost, nothing is wrong for long: the
    // plan-start worker re-reads the subscription and skips one set to
    // cancel, and the webhook stores Stripe's cancel_at.
    await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
      if (claim.skipped) await rearmBillingRequest(tx, claim.skipped.id, claim.skipped.reason, now);
      await releaseStripeMutationLease(tx.db, billingClinicId, owner);
    });
    return {
      status: "refused",
      message:
        "Stripe didn't answer, so we can't confirm the change. Try again in a minute: asking twice is harmless.",
    };
  }

  const cancelAt = input.on
    ? null
    : typeof updated.cancel_at === "number"
      ? new Date(updated.cancel_at * 1000)
      : currentPeriodEndOf(updated);
  const started = hasPlanStarted(claim.row);
  await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    await setCancelAt(tx.db, billingClinicId, cancelAt);
    if (input.on && !started) {
      const skipped = await tx.db
        .select({ id: billingRequests.id, reason: billingRequests.reason })
        .from(billingRequests)
        .where(
          and(
            eq(billingRequests.clinicId, billingClinicId),
            eq(billingRequests.kind, "plan_start"),
            eq(billingRequests.outcome, "skipped"),
            eq(billingRequests.outcomeReason, "cancel_pending"),
          ),
        );
      for (const request of skipped) await rearmBillingRequest(tx, request.id, request.reason, now);
    }
    await recordBillingNote(tx, {
      actor: "client",
      reason: input.on ? "auto_renew_on" : "auto_renew_off",
    });
    tx.audit.record({
      action: "update",
      resourceType: "entitlements",
      resourceId: billingClinicId,
      metadata: { field: "auto_renew", on: input.on, isBeforeStart: !started },
    });
    await releaseStripeMutationLease(tx.db, billingClinicId, owner);
  });

  // A refund is due only on money paid: while the first plan invoice is
  // unpaid (an applied start whose first charge failed) refundEligibility
  // refuses, and the cancel_scheduled email promises none (events.ts), so ops
  // are not sent to arrange one either.
  if (!input.on && claim.row.planStartedAt !== null && refundWindowOpen(claim.row, now)) {
    await notifyOps("first_period_refund_due", { clinicId: billingClinicId });
  }
  return {
    status: "ok",
    closesOn: input.on
      ? null
      : isoDay(
          closesAt({
            cancelAt,
            setupDeadlineAt: claim.row.setupDeadlineAt,
            planStartedAt: claim.row.planStartedAt,
            planStartAppliedAt: claim.row.planStartAppliedAt,
          }),
        ),
  };
}

/**
 * The subscription metadata key setAutoRenew(off) writes when it turns
 * auto-renew off inside the first-period refund window (R15): the window's
 * last day, YYYY-MM-DD. It is how "a refund is due" travels to the
 * `cancel_scheduled` email, which only the webhook enqueues (R22): the
 * webhook applies the live subscription and carries this value into the
 * payload's `refundWindowEndsOn`. Turning auto-renew back on clears it.
 */
export const REFUND_ELIGIBLE_METADATA_KEY = "hd_refund_eligible_until";

export { refundEligibleUntil, refundWindowOpen };

// -----------------------------------------------------------------------------
// createPortalSession (BD15)
// -----------------------------------------------------------------------------

export type CreatePortalSessionInput = {
  clinicId: string;
  /** Where Stripe's portal sends the browser back: a publicUrl() on apps/app. */
  returnUrl: string;
  /** Open straight on the card form. Payment method and invoice history are all the portal offers. */
  flow?: "payment_method_update";
};

/**
 * The URL lasts about five minutes: hand it to the browser at once, never put
 * it in an email.
 */
export type CreatePortalSessionResult = { url: string } | { status: "unavailable" };

/** The tag stripe-account-settings.ts puts on healdesk's portal configuration. */
export const PORTAL_CONFIGURATION_TAG = "customer-portal";

let portalConfigurationId: string | null = null;

/** Test-only: forget the cached portal configuration. */
export function __clearPortalConfigurationForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__clearPortalConfigurationForTests is not available in production.");
  }
  portalConfigurationId = null;
}

/**
 * Healdesk's portal configuration: the active one tagged
 * `metadata.healdesk = "customer-portal"`, cached per process. It is never
 * the account default (the Stripe account is shared with scalabid), so a
 * session without it would open someone else's portal.
 */
async function findPortalConfiguration(stripe: Stripe): Promise<string | null> {
  if (portalConfigurationId) return portalConfigurationId;
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const list = (await stripe.billingPortal.configurations.list(
      { active: true, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as {
      data?: Array<{ id: string; metadata?: Record<string, string> | null }>;
      has_more?: boolean;
    };
    const data = list.data ?? [];
    const ours = data.find((config) => config.metadata?.healdesk === PORTAL_CONFIGURATION_TAG);
    if (ours) {
      portalConfigurationId = ours.id;
      return ours.id;
    }
    if (!list.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]!.id;
  }
  return null;
}

/** A return URL on apps/app's own public origin, and nothing else (no open redirect). */
function isOwnReturnUrl(returnUrl: string): boolean {
  try {
    const target = new URL(returnUrl);
    const origin = new URL(publicOrigin());
    return target.origin === origin.origin && !target.username && !target.password;
  } catch {
    return false;
  }
}

/**
 * A Stripe Customer Portal session for the billing clinic's customer (BD15):
 * the card and the invoice history, nothing else (stripe-account-settings.ts
 * switches cancellation and plan changes off). `flow` opens straight on the
 * card form and comes back here when the card is saved.
 *
 * `unavailable` when there is no customer, no Stripe, no healdesk portal
 * configuration, a return URL off our own origin, or Stripe refuses.
 */
export async function createPortalSession(
  input: CreatePortalSessionInput,
  options: BillingActionOptions = {},
): Promise<CreatePortalSessionResult> {
  if (input.flow !== undefined && input.flow !== "payment_method_update")
    return { status: "unavailable" };
  if (!isOwnReturnUrl(input.returnUrl)) {
    log.warn("portal session refused: return URL off our origin", { field: "returnUrl" });
    return { status: "unavailable" };
  }
  const stripe = stripeFor(options);
  if (!stripe) return { status: "unavailable" };
  const actor: ActorContext = { type: "service", serviceName: "billing-portal" };
  const billingClinicId = await withTenant({ clinicId: input.clinicId, actor }, (tx) =>
    resolveBillingClinicId(tx),
  );
  const row = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
    getEntitlements(tx.db, billingClinicId),
  );
  if (!row?.stripeCustomerId) return { status: "unavailable" };

  try {
    const configuration = await findPortalConfiguration(stripe);
    if (!configuration) {
      log.warn("portal session refused: no healdesk portal configuration", {
        clinicId: billingClinicId,
      });
      return { status: "unavailable" };
    }
    const session = await stripe.billingPortal.sessions.create(
      {
        customer: row.stripeCustomerId,
        configuration,
        return_url: input.returnUrl,
        ...(input.flow === "payment_method_update"
          ? {
              flow_data: {
                type: "payment_method_update",
                after_completion: { type: "redirect", redirect: { return_url: input.returnUrl } },
              },
            }
          : {}),
      },
      WORKER_STRIPE_OPTIONS,
    );
    return session.url ? { url: session.url } : { status: "unavailable" };
  } catch (error) {
    // A configuration archived since it was cached is looked up afresh next time.
    portalConfigurationId = null;
    log.warn("portal session refused by Stripe", {
      clinicId: billingClinicId,
      code: stripeErrorCode(error),
    });
    return { status: "unavailable" };
  }
}

// -----------------------------------------------------------------------------
// previewRefund and commitRefund (BD14, R15)
// -----------------------------------------------------------------------------

/**
 * Terms § 5: the first period refunded in full and the plan cancelled at once
 * (`first_period_cancel`), or one month's fee by operator judgement with the
 * plan kept (`guarantee`). They do not stack, and the setup fee is never
 * refunded.
 *
 * `agreement_terminated`: BAA 1.3.0 clause 17 ¶3, "Where Practice terminates
 * because healdesk has violated a material term, or under the Subcontractors
 * clause, no Fees accrue for any time after that day, and healdesk refunds
 * any Fees Practice has paid for that time". Owed only once a recorded
 * termination has left the practice no agreement in effect, and only for
 * those two reasons (terminationRefundsFees in @healdesk/catalog): every
 * other ending stops the Services and the Fees on the day and refunds
 * nothing. The termination itself cancels the subscription
 * (lib/agreements/termination.ts); this refund is the operator's to preview
 * and confirm, like the other two, and is not held back by a § 5 refund.
 */
export type RefundKind = "first_period_cancel" | "guarantee" | "agreement_terminated";

export type PreviewRefundInput = { clinicId: string; kind: RefundKind };

export type PreviewRefundResult =
  | {
      status: "ok";
      kind: RefundKind;
      /** What commitRefund will refund. It refuses a confirmation of any other amount. */
      amountCents: number;
      /** first_period_cancel and agreement_terminated cancel the plan at once; guarantee keeps it. */
      cancelsPlan: boolean;
      /**
       * The Terms' dates, for the operator: when the plan started and when
       * this refund's window ends; for agreement_terminated, the day the
       * agreement ended, the last day it does not refund. ISO dates.
       */
      planStartedOn: string | null;
      windowEndsOn: string | null;
      /**
       * Invoices this refund covers that were paid without a payment intent
       * (marked paid out of band), so nothing of them can go back to a
       * card: not in `amountCents`, for the operator to settle by hand.
       * Absent when there are none.
       */
      settleByHand?: SettleByHand;
    }
  | { status: "refused" | "not_available"; message: string };

export type SettleByHand = { amountCents: number; invoiceIds: string[] };

export type CommitRefundInput = {
  clinicId: string;
  kind: RefundKind;
  /** The amount previewRefund showed; anything else is refused. */
  confirmAmountCents: number;
  /** Why, in the operator's words, for the billing history. Required. */
  reason: string;
  actorLabel: string;
};

export type CommitRefundResult =
  | {
      status: "refunded";
      amountCents: number;
      /** ISO timestamp the refund was stamped. */
      refundedAt: string;
      /** A first-period or termination refund records a cancel_now request in the same transaction. */
      isCancelRequested: boolean;
    }
  | { status: "refused" | "busy" | "failed" | "not_available"; message: string };

const REFUND_KINDS: readonly RefundKind[] = [
  "first_period_cancel",
  "guarantee",
  "agreement_terminated",
];
const DAY_MS = 24 * 60 * 60 * 1000;

type RefundEligibility =
  | { ok: true; start: Date; windowEnd: Date }
  | { ok: false; status: "refused" | "not_available"; message: string };

/**
 * How the practice's agreement ended: the latest termination recorded for
 * the billing clinic's organisation, with who ended it and why, once no
 * agreement is in effect for it; null while one is, or when none was ever
 * bound.
 */
export type AgreementEnding = { terminatedAt: Date; reason: string | null };

/**
 * The ending, read in the billing clinic's own transaction, which sees its
 * organisation's agreements and no other's (baa_acceptances is FORCE RLS,
 * drizzle/0031). "In effect" is app_agreement_in_effect (0048), the one
 * definition of it.
 */
export async function readAgreementEnding(tx: TenantTx): Promise<AgreementEnding | null> {
  const result = await tx.db.execute<{
    terminated_at: Date | string | null;
    termination_reason: string | null;
  }>(
    sql`select b.terminated_at, b.termination_reason
          from clinics c
          join baa_acceptances b on b.organization_id = c.organization_id
         where c.id = ${tx.clinicId}
           and b.terminated_at is not null
           and not exists (select 1 from app_agreement_in_effect(c.organization_id))
         order by b.terminated_at desc, b.accepted_at desc
         limit 1`,
  );
  const row = result.rows[0];
  if (!row || row.terminated_at === null) return null;
  return { terminatedAt: new Date(row.terminated_at), reason: row.termination_reason };
}

/**
 * The termination refund's own rule (clause 17 ¶3): a recorded ending with
 * no agreement left in effect, for one of the two reasons the clause
 * refunds, and a plan that had started, since before the start the clinic
 * paid only the setup fee and the $0 line. Never held back by a § 5 refund:
 * `first_period_refunded_at` stops the two § 5 refunds stacking, and the
 * amount is capped by what each payment has left instead (planRefund). No
 * time limit: the refund is owed whenever the ending is recorded.
 */
function terminationEligibility(
  row: Entitlements,
  ending: AgreementEnding | null,
): RefundEligibility {
  if (!ending) {
    return {
      ok: false,
      status: "refused",
      message:
        "No termination is recorded for this practice with no agreement left in effect, so no termination refund is owed.",
    };
  }
  if (!terminationRefundsFees(ending.reason)) {
    return {
      ok: false,
      status: "refused",
      message:
        "This agreement's ending is not refunded: the agreement refunds the fees paid for time after it ended only when the practice ended it because healdesk violated a material term, or under the Subcontractors clause.",
    };
  }
  const start = row.planStartedAt;
  if (!start) {
    return {
      ok: false,
      status: "refused",
      message:
        "The plan had not started when the agreement ended, so no fee was paid for time after it: there's nothing to refund.",
    };
  }
  return { ok: true, start, windowEnd: ending.terminatedAt };
}

/**
 * Who may be refunded, from the database alone: a started plan whose first
 * plan invoice was paid, no refund under § 5 yet (`first_period_refunded_at`
 * is what stops the two stacking), and for `first_period_cancel` no more
 * than FIRST_PERIOD_REFUND_DAYS since the plan started. The guarantee has no
 * time gate beyond that: it is the operator's judgement, so its window is
 * shown, not enforced. `agreement_terminated` has its own rule
 * (terminationEligibility) and is not held back by a § 5 refund.
 */
function refundEligibility(
  row: Entitlements | null,
  kind: RefundKind,
  now: Date,
  ending: AgreementEnding | null = null,
): RefundEligibility {
  if (!REFUND_KINDS.includes(kind))
    return { ok: false, status: "refused", message: "That isn't a refund the Terms offer." };
  if (!row)
    return {
      ok: false,
      status: "refused",
      message: "We couldn't find a billing account for this clinic.",
    };
  if (!row.stripeCustomerId || !row.stripeSubscriptionId) {
    return {
      ok: false,
      status: "not_available",
      message: "This account has nothing in Stripe to refund.",
    };
  }
  if (row.status === "purged")
    return { ok: false, status: "refused", message: "This account's records are gone." };
  if (kind === "agreement_terminated") return terminationEligibility(row, ending);
  if (row.firstPeriodRefundedAt) {
    return {
      ok: false,
      status: "refused",
      message:
        "A refund under the Terms (§ 5) has already been issued for this account. The two refunds don't stack.",
    };
  }
  const start = row.planStartedAt;
  if (!start) {
    return {
      ok: false,
      status: "refused",
      message: "The first plan invoice hasn't been paid, so there's nothing to refund yet.",
    };
  }
  if (kind === "first_period_cancel") {
    const windowEnd = new Date(start.getTime() + FIRST_PERIOD_REFUND_DAYS * DAY_MS);
    if (now.getTime() > windowEnd.getTime()) {
      return {
        ok: false,
        status: "refused",
        message: `The ${FIRST_PERIOD_REFUND_DAYS}-day refund window closed on ${isoDay(windowEnd)}.`,
      };
    }
    return { ok: true, start, windowEnd };
  }
  if (!row.firstPlanInvoiceId) {
    return {
      ok: false,
      status: "refused",
      message: "The first plan invoice isn't on record yet, so the guarantee can't be worked out.",
    };
  }
  return { ok: true, start, windowEnd: addMonthsUtc(start, 1) };
}

type RefundPart = {
  invoiceId: string;
  paymentIntentId: string;
  amountCents: number;
  /** What refunds of this same kind already on the payment intent come to (#3: a repeat). */
  sameKindCents: number;
};

/** An invoice paid without a payment intent (out of band): owed, but not refundable to a card. */
type HandPart = { invoiceId: string; amountCents: number };

/** A refund, invoice by invoice: the parts that go back to the card, and those to settle by hand. */
type RefundPlan = { parts: RefundPart[]; byHand: HandPart[] };

type InvoiceLineLike = {
  amount?: number | null;
  discount_amounts?: Array<{ amount?: number | null }> | null;
  period?: { start?: number | null; end?: number | null } | null;
  parent?: {
    type?: string | null;
    subscription_item_details?: { proration?: boolean | null } | null;
  } | null;
  pricing?: { price_details?: { price?: unknown } | null } | null;
};

/** A line's amount after its discounts: what the clinic actually paid for it. */
function netAmount(line: InvoiceLineLike): number {
  const discounts = (line.discount_amounts ?? []).reduce((sum, d) => sum + (d.amount ?? 0), 0);
  return (line.amount ?? 0) - discounts;
}

/**
 * A subscription-fee line: the package price (or its proration) on a
 * subscription item, never a setup fee or an overage line. The price is
 * expanded, so its lookup key says which: a catalog package key for a month
 * or a year, not the placeholder, a setup key or a metered key.
 */
function isSubscriptionFeeLine(line: InvoiceLineLike): boolean {
  if (line.parent?.type !== "subscription_item_details") return false;
  const price = line.pricing?.price_details?.price as {
    lookup_key?: unknown;
    recurring?: { usage_type?: unknown } | null;
  } | null;
  if (!price || typeof price !== "object") return false;
  if (price.recurring?.usage_type === "metered") return false;
  const parsed = typeof price.lookup_key === "string" ? parseLookupKey(price.lookup_key) : null;
  return parsed !== null && parsed.kind !== "setup";
}

async function subscriptionFeeLines(stripe: Stripe, invoiceId: string): Promise<InvoiceLineLike[]> {
  const lines: InvoiceLineLike[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const list = (await stripe.invoices.listLineItems(
      invoiceId,
      {
        limit: 100,
        // Four levels, Stripe's limit: line prices are bare ids otherwise.
        expand: ["data.pricing.price_details.price"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as { data?: Array<InvoiceLineLike & { id: string }>; has_more?: boolean };
    const data = list.data ?? [];
    lines.push(...data.filter(isSubscriptionFeeLine));
    if (!list.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]!.id;
  }
  return lines;
}

/** The payment intent that paid an invoice, from its invoice payments (dahlia has no invoice.payment_intent). */
async function paymentIntentOf(stripe: Stripe, invoiceId: string): Promise<string | null> {
  const list = (await stripe.invoicePayments.list(
    { invoice: invoiceId, status: "paid", limit: 10 },
    WORKER_STRIPE_OPTIONS,
  )) as unknown as {
    data?: Array<{ payment?: { type?: string | null; payment_intent?: unknown } | null }>;
  };
  for (const payment of list.data ?? []) {
    const id = stripeRefId(payment.payment?.payment_intent ?? null);
    if (id) return id;
  }
  return null;
}

type InvoiceSummary = { id: string; amount_paid?: number | null; created?: number | null };

/**
 * The first plan period, from the first plan invoice's package line when it
 * is on record, else a month or a year from the plan start.
 */
async function firstPlanPeriod(
  stripe: Stripe,
  row: Entitlements,
  start: Date,
): Promise<{ start: number; end: number }> {
  if (row.firstPlanInvoiceId) {
    const lines = await subscriptionFeeLines(stripe, row.firstPlanInvoiceId);
    const packageLine = lines.find(
      (line) =>
        line.parent?.subscription_item_details?.proration !== true &&
        typeof line.period?.start === "number" &&
        typeof line.period?.end === "number",
    );
    if (packageLine?.period?.start && packageLine.period.end) {
      return { start: packageLine.period.start, end: packageLine.period.end };
    }
  }
  const end = addMonthsUtc(start, row.billingInterval === "year" ? 12 : 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

type RefundOnRecord = {
  amount?: number | null;
  status?: string | null;
  metadata?: Record<string, string> | null;
};

/** What an invoice charged in subscription fees: its fee lines after discounts, credits included. */
function feesOn(lines: InvoiceLineLike[]): number {
  return lines.reduce((sum, line) => sum + netAmount(line), 0);
}

/**
 * One invoice's part of a refund of `kind`: `wantedCents`, capped by what
 * the payment has left, added to the plan; nothing when nothing is left. An
 * invoice paid without a payment intent (marked paid out of band) has no
 * card to refund to: its part, capped by what it was paid and by its fees,
 * goes on the plan's `byHand` list, so the preview shows the operator what
 * to settle by hand rather than quietly owing less.
 *
 * The refunds counted against it are those of another kind on its payment
 * intent that have not failed or been cancelled. A refund of the same kind
 * is not counted: commit reuses that one (refundPart), and a preview after a
 * partial commit shows the same amount as before. Two caps, the lower wins:
 *
 *   - what the charge has left: what the invoice was paid, less every such
 *     refund, a guarantee, first-period or termination refund or one made by
 *     hand in the Dashboard (no hd_kind), so Stripe is never asked for more
 *     than the charge holds;
 *   - what its fees have left: the invoice's subscription-fee lines
 *     (`invoiceFeeCents`), less the refunds healdesk made of another kind,
 *     every one of which paid back fees. Without it, a § 5 refund after a
 *     termination refund (or the other way round) would reach into the
 *     invoice's overage or setup line, which no refund kind pays back.
 *
 * The three kinds share this one cap, so a charge is never paid back twice.
 *
 * Tax: fee lines are amounts before tax, so if STRIPE_AUTOMATIC_TAX is ever
 * switched on, every kind under-refunds the tax charged on the refunded
 * time. Credit notes, which carry the tax with the line, are the fix then.
 */
async function cappedPart(
  stripe: Stripe,
  invoice: InvoiceSummary,
  kind: RefundKind,
  wantedCents: number,
  invoiceFeeCents: number,
  plan: RefundPlan,
): Promise<void> {
  if (wantedCents <= 0) return;
  const paymentIntentId = await paymentIntentOf(stripe, invoice.id);
  if (!paymentIntentId) {
    const amountCents = Math.min(wantedCents, invoice.amount_paid ?? 0, invoiceFeeCents);
    if (amountCents > 0) plan.byHand.push({ invoiceId: invoice.id, amountCents });
    return;
  }
  const refunds = (await stripe.refunds.list(
    { payment_intent: paymentIntentId, limit: 100 },
    WORKER_STRIPE_OPTIONS,
  )) as unknown as { data?: RefundOnRecord[] };
  const standing = (refunds.data ?? []).filter(
    (refund) => refund.status !== "failed" && refund.status !== "canceled",
  );
  const elsewhere = standing.filter((refund) => refund.metadata?.hd_kind !== kind);
  const sum = (list: RefundOnRecord[]) =>
    list.reduce((total, refund) => total + (refund.amount ?? 0), 0);
  const chargeLeft = (invoice.amount_paid ?? 0) - sum(elsewhere);
  const feesLeft =
    invoiceFeeCents - sum(elsewhere.filter((refund) => Boolean(refund.metadata?.hd_kind)));
  const amountCents = Math.min(wantedCents, chargeLeft, feesLeft);
  if (amountCents <= 0) return;
  plan.parts.push({
    invoiceId: invoice.id,
    paymentIntentId,
    amountCents,
    sameKindCents: sum(standing.filter((refund) => refund.metadata?.hd_kind === kind)),
  });
}

/** Every part already has its full refund of this kind: confirming again would only record it twice. */
function alreadyRefunded(plan: RefundPlan): boolean {
  return plan.parts.length > 0 && plan.parts.every((part) => part.sameKindCents >= part.amountCents);
}

/**
 * The day a refund of this kind was last recorded for the billing clinic
 * (commitRefund's billing note, `refund_<kind>`), or null.
 */
async function refundRecordedOn(tx: TenantTx, kind: RefundKind): Promise<string | null> {
  const result = await tx.db.execute<{ at: Date | string | null }>(
    sql`select max(created_at) as at from billing_transitions
         where clinic_id = ${tx.clinicId} and reason = ${`refund_${kind}`}`,
  );
  const at = result.rows[0]?.at;
  return at ? isoDay(new Date(at)) : null;
}

function alreadyRefundedMessage(on: string): string {
  return `Already refunded on ${on}: every payment this refund covers already has it, and confirming again would only record it a second time.`;
}

/** The out-of-band part of a plan, for the operator to settle by hand, or undefined when there is none. */
function settleByHandOf(plan: RefundPlan): SettleByHand | undefined {
  if (plan.byHand.length === 0) return undefined;
  return {
    amountCents: plan.byHand.reduce((sum, part) => sum + part.amountCents, 0),
    invoiceIds: plan.byHand.map((part) => part.invoiceId),
  };
}

/**
 * What a refund pays back, invoice by invoice (R15).
 *
 * `first_period_cancel`: every subscription-fee line (the package price and
 * its prorations, never setup or overage) on the subscription's paid
 * invoices whose period starts inside the first plan period. That is the
 * whole first period, a year on an annual plan, including any step-up made
 * in it.
 *
 * `guarantee`: one month's fee from the first plan invoice's package line:
 * the line itself on a monthly plan, a twelfth of it on an annual one
 * (rounded down: never more than a month).
 *
 * `agreement_terminated`: the fees paid for time after the agreement ended
 * (terminationRefund).
 *
 * Every kind, per invoice, is no more than the payment has left after the
 * refunds of other kinds on it (cappedPart).
 */
async function planRefund(
  stripe: Stripe,
  row: Entitlements,
  kind: RefundKind,
  start: Date,
  ending: AgreementEnding | null = null,
): Promise<RefundPlan> {
  const plan: RefundPlan = { parts: [], byHand: [] };
  if (kind === "agreement_terminated") {
    if (ending) await terminationRefund(stripe, row, ending.terminatedAt, plan);
    return plan;
  }
  if (kind === "guarantee") {
    const invoiceId = row.firstPlanInvoiceId as string;
    const invoice = (await stripe.invoices.retrieve(
      invoiceId,
      {},
      WORKER_STRIPE_OPTIONS,
    )) as unknown as InvoiceSummary;
    const lines = await subscriptionFeeLines(stripe, invoiceId);
    const packageCents = lines
      .filter((line) => line.parent?.subscription_item_details?.proration !== true)
      .reduce((sum, line) => sum + netAmount(line), 0);
    const monthCents =
      row.billingInterval === "year" ? Math.floor(packageCents / 12) : packageCents;
    await cappedPart(stripe, invoice, kind, monthCents, feesOn(lines), plan);
    return plan;
  }

  const period = await firstPlanPeriod(stripe, row, start);
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const list = (await stripe.invoices.list(
      {
        subscription: row.stripeSubscriptionId as string,
        status: "paid",
        limit: 100,
        // Nothing invoiced before the plan started can be for the first period.
        created: { gte: period.start - 24 * 60 * 60 },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as { data?: InvoiceSummary[]; has_more?: boolean };
    const data = list.data ?? [];
    for (const invoice of data) {
      const lines = await subscriptionFeeLines(stripe, invoice.id);
      const feeCents = lines
        .filter((line) => {
          const lineStart = line.period?.start;
          return (
            typeof lineStart === "number" && lineStart >= period.start && lineStart < period.end
          );
        })
        .reduce((sum, line) => sum + netAmount(line), 0);
      await cappedPart(stripe, invoice, kind, feeCents, feesOn(lines), plan);
    }
    if (!list.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]!.id;
  }
  return plan;
}

/** The start of the UTC day after the one `at` falls on, in Unix seconds. */
function dayAfterSeconds(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.floor(next / 1000);
}

/**
 * The part of a subscription-fee line paid for time from `fromSec` to the end
 * of its own period: its amount after discounts, times (period.end − from)
 * over (period.end − period.start), rounded toward zero. A line wholly after
 * `fromSec` comes back in full (a renewal paid after the end), one wholly
 * before it not at all, and a proration credit counts against its invoice
 * like any other line.
 */
function unusedShare(line: InvoiceLineLike, fromSec: number): number {
  const start = line.period?.start;
  const end = line.period?.end;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return 0;
  const from = Math.max(start, fromSec);
  if (from >= end) return 0;
  return Math.trunc((netAmount(line) * (end - from)) / (end - start));
}

/**
 * The termination refund (BAA 1.3.0 clause 17 ¶3), invoice by invoice: the
 * fees paid for any time after the day the agreement ended.
 *
 * Only the subscription-fee lines count (isSubscriptionFeeLine: the package
 * price and its prorations, never the setup fee and never metered overage,
 * which is billed in arrears for time already served). Each is prorated by
 * its own period, from the start of the UTC day after the termination to the
 * period's end, so the current paid period comes back in part, the rest of
 * the year on an annual plan, and a period paid after the end in full; a
 * period over before it, nothing. Before the plan started there is no such
 * line, only the $0 placeholder, and the eligibility refuses first.
 *
 * Per invoice the refund is no more than the payment has left after every
 * refund of another kind on its payment intent (cappedPart).
 */
async function terminationRefund(
  stripe: Stripe,
  row: Entitlements,
  terminatedAt: Date,
  plan: RefundPlan,
): Promise<void> {
  const fromSec = dayAfterSeconds(terminatedAt);
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const list = (await stripe.invoices.list(
      {
        subscription: row.stripeSubscriptionId as string,
        status: "paid",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as { data?: InvoiceSummary[]; has_more?: boolean };
    const data = list.data ?? [];
    for (const invoice of data) {
      const lines = await subscriptionFeeLines(stripe, invoice.id);
      const unused = lines.reduce((sum, line) => sum + unusedShare(line, fromSec), 0);
      await cappedPart(stripe, invoice, "agreement_terminated", unused, feesOn(lines), plan);
    }
    if (!list.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1]!.id;
  }
}

const REFUND_READ_ACTOR: ActorContext = { type: "service", serviceName: "refund-preview" };

function nothingPaidMessage(kind: RefundKind, byHand?: SettleByHand): string {
  if (byHand) {
    return `Nothing here can go back to a card: ${dollars(byHand.amountCents)} was paid outside Stripe's card payments (invoices ${byHand.invoiceIds.join(", ")}). Settle it by hand.`;
  }
  return kind === "agreement_terminated"
    ? "Nothing was paid for time after the agreement ended that could be refunded to the card."
    : "Nothing was paid for the first period that could be refunded to the card.";
}

/** Cents as dollars, for an operator's message: "$1,234.50". */
function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * What `commitRefund` would refund, and the Terms' dates for the operator.
 * Reads Stripe outside any transaction; writes nothing.
 */
export async function previewRefund(
  input: PreviewRefundInput,
  options: BillingActionOptions = {},
): Promise<PreviewRefundResult> {
  const now = options.now ?? new Date();
  const group = await readBillingGroup(input.clinicId, { now });
  const ending =
    input.kind === "agreement_terminated"
      ? await withTenant({ clinicId: group.billingClinicId, actor: REFUND_READ_ACTOR }, (tx) =>
          readAgreementEnding(tx),
        )
      : null;
  const eligible = refundEligibility(group.row, input.kind, now, ending);
  if (!eligible.ok) return { status: eligible.status, message: eligible.message };
  const stripe = stripeFor(options);
  if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };
  try {
    const plan = await planRefund(
      stripe,
      group.row as Entitlements,
      input.kind,
      eligible.start,
      ending,
    );
    const amountCents = plan.parts.reduce((sum, part) => sum + part.amountCents, 0);
    const settleByHand = settleByHandOf(plan);
    if (amountCents <= 0) {
      return { status: "refused", message: nothingPaidMessage(input.kind, settleByHand) };
    }
    if (alreadyRefunded(plan)) {
      const recordedOn = await withTenant(
        { clinicId: group.billingClinicId, actor: REFUND_READ_ACTOR },
        (tx) => refundRecordedOn(tx, input.kind),
      );
      if (recordedOn) return { status: "refused", message: alreadyRefundedMessage(recordedOn) };
    }
    return {
      status: "ok",
      kind: input.kind,
      amountCents,
      cancelsPlan: input.kind !== "guarantee",
      planStartedOn: isoDay(eligible.start),
      windowEndsOn: isoDay(eligible.windowEnd),
      ...(settleByHand ? { settleByHand } : {}),
    };
  } catch (error) {
    log.warn("refund preview unavailable", {
      clinicId: group.billingClinicId,
      code: stripeErrorCode(error),
    });
    return {
      status: "not_available",
      message: "Stripe couldn't work out the refund right now. Try again in a minute.",
    };
  }
}

/**
 * Refund under Terms § 5 (BD14, R15), or the termination refund (BAA 1.3.0
 * clause 17 ¶3), from the console.
 *
 * Re-checks eligibility under the billing row's lock and claims the lease,
 * works the amount out again from Stripe and refuses unless it equals the
 * one the operator confirmed, then refunds each invoice's part to its card
 * (`reason: requested_by_customer`, `metadata.hd_kind`, key
 * `hd-refund:<kind>:<billing>:<invoice>`). Before each refund it lists the
 * refunds already on that payment intent and reuses one of this kind: the
 * key protects a retry for 24 hours, the listing protects it for ever.
 *
 * Then, in one transaction: `first_period_refunded_at` for a § 5 refund (so
 * the two never stack; a termination refund neither stamps it nor is held
 * back by it), a billing note and an audit row with the operator's reason, a
 * `cancel_now` request for a first-period or termination refund (its worker
 * cancels the subscription at once, without proration), and one
 * `refund_issued` for the whole refund. The setup fee is never refunded: no
 * setup line is ever counted.
 */
export async function commitRefund(
  input: CommitRefundInput,
  options: BillingActionOptions = {},
): Promise<CommitRefundResult> {
  const now = options.now ?? new Date();
  const remark = typeof input.reason === "string" ? input.reason.trim() : "";
  if (remark.length === 0 || remark.length > 500) {
    return { status: "refused", message: "Give a reason for the refund (up to 500 characters)." };
  }
  try {
    assertNoPhi({ remark }, "reason");
  } catch {
    return {
      status: "refused",
      message:
        "The reason looks like it carries an email address or a phone number. Describe it without them.",
    };
  }
  if (!Number.isSafeInteger(input.confirmAmountCents) || input.confirmAmountCents <= 0) {
    return { status: "refused", message: "Confirm the amount the preview showed, in cents." };
  }
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await withTenant({ clinicId: input.clinicId, actor }, (tx) =>
    resolveBillingClinicId(tx),
  );
  const stripe = stripeFor(options);
  if (!stripe) return { status: "not_available", message: NOT_AVAILABLE };
  const owner = `refund:${input.kind}:${randomUUID()}`;

  const claim = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    const ending = input.kind === "agreement_terminated" ? await readAgreementEnding(tx) : null;
    const eligible = refundEligibility(row, input.kind, now, ending);
    if (!eligible.ok) return eligible;
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
      return { ok: false as const, status: "busy" as const, message: BUSY };
    }
    const recordedOn = await refundRecordedOn(tx, input.kind);
    return { ...eligible, row: row as Entitlements, ending, recordedOn };
  });
  if (!claim.ok) return { status: claim.status, message: claim.message };

  let releaseOnExit = true;
  try {
    const plan = await planRefund(stripe, claim.row, input.kind, claim.start, claim.ending);
    const parts = plan.parts;
    const amountCents = parts.reduce((sum, part) => sum + part.amountCents, 0);
    if (amountCents <= 0) {
      return { status: "refused", message: nothingPaidMessage(input.kind, settleByHandOf(plan)) };
    }
    // Every part refunded and the refund recorded: a second confirmation
    // would reuse the refunds but write a second billing note and audit row
    // with the amount, reading as two refunds. Every part refunded and
    // nothing recorded is a commit that died after Stripe: it goes on, and
    // records the refund once.
    if (claim.recordedOn && alreadyRefunded(plan)) {
      return { status: "refused", message: alreadyRefundedMessage(claim.recordedOn) };
    }
    if (amountCents !== input.confirmAmountCents) {
      return {
        status: "refused",
        message: `The refund now comes to ${amountCents} cents, not the ${input.confirmAmountCents} confirmed. Preview it again.`,
      };
    }

    const refunds: Array<{ id: string; amountCents: number }> = [];
    for (const part of parts) {
      refunds.push(await refundPart(stripe, part, input.kind, billingClinicId));
    }

    let isCancelRequested = false;
    await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
      // The termination refund does not stamp the § 5 marker: it is not a
      // § 5 refund, and stamping it would refuse a § 5 refund the Terms may
      // still owe for the time before the end. Each kind is capped by what
      // the payment has left after the others (cappedPart), so the two never
      // pay a charge twice.
      if (input.kind !== "agreement_terminated") {
        await markFirstPeriodRefunded(tx.db, billingClinicId, now);
      }
      await recordBillingNote(tx, { actor: "support", reason: `refund_${input.kind}` });
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: billingClinicId,
        metadata: {
          field:
            input.kind === "agreement_terminated" ? "termination_refund" : "first_period_refund",
          kind: input.kind,
          amountCents,
          remark,
        },
      });
      // Both end the subscription at once, without proration. A termination
      // has already recorded its cancellation (lib/agreements/termination.ts),
      // so this one is a no-op there, kept so the refund and the cancellation
      // cannot come apart whichever runs first.
      if (input.kind !== "guarantee") {
        await requestCancelNow(tx, billingClinicId);
        isCancelRequested = true;
      }
      // One email for the whole refund, however many invoices it was spread
      // across: one per part would each say the first period's fee was
      // refunded in full and the plan cancelled. Keyed on the first refund,
      // which a retry reuses (refundPart); the webhook leaves refunds of
      // these kinds to this notice (events.ts onChargeRefunded).
      const [first] = refunds;
      if (first) {
        await enqueueNotice(tx, "refund_issued", `refund:${first.id}`, {
          amountCents: refunds.reduce((sum, refund) => sum + refund.amountCents, 0),
          kind: input.kind,
          refundedAt: now.toISOString(),
        });
      }
      await releaseStripeMutationLease(tx.db, billingClinicId, owner);
    });
    releaseOnExit = false;
    // The cancel_now just recorded is carried out only by the billing-requests
    // job, which ships off. A termination has already told ops if it is
    // (lib/agreements/termination.ts); a first-period refund tells them here,
    // or the plan it refunded keeps billing.
    // A switch that can't be read counts as off: the alert is the safe side.
    if (
      input.kind === "first_period_cancel" &&
      !(await billingRequestsSwitchedOn().catch(() => false))
    ) {
      await notifyOps("refund_cancel_job_off", { clinicId: billingClinicId });
    }
    return { status: "refunded", amountCents, refundedAt: now.toISOString(), isCancelRequested };
  } catch (error) {
    log.warn("refund not completed", { clinicId: billingClinicId, code: stripeErrorCode(error) });
    return {
      status: "failed",
      message:
        "Stripe didn't complete the refund. Check the payments in Stripe before trying again: a retry reuses any part that went through.",
    };
  } finally {
    if (releaseOnExit) await releaseLease(billingClinicId, owner, actor);
  }
}

/** One invoice's refund: an existing one of this kind on the payment intent, or a new one. */
async function refundPart(
  stripe: Stripe,
  part: RefundPart,
  kind: RefundKind,
  billingClinicId: string,
): Promise<{ id: string; amountCents: number }> {
  const existing = (await stripe.refunds.list(
    { payment_intent: part.paymentIntentId, limit: 100 },
    WORKER_STRIPE_OPTIONS,
  )) as unknown as {
    data?: Array<{
      id: string;
      amount?: number | null;
      status?: string | null;
      metadata?: Record<string, string> | null;
    }>;
  };
  const reuse = (existing.data ?? []).find(
    (refund) =>
      refund.metadata?.hd_kind === kind &&
      refund.status !== "failed" &&
      refund.status !== "canceled",
  );
  if (reuse) return { id: reuse.id, amountCents: reuse.amount ?? part.amountCents };
  const refund = await stripe.refunds.create(
    {
      payment_intent: part.paymentIntentId,
      amount: part.amountCents,
      reason: "requested_by_customer",
      metadata: { hd_kind: kind, hd_invoice: part.invoiceId },
    },
    workerRequestOptions(`hd-refund:${kind}:${billingClinicId}:${part.invoiceId}`),
  );
  return { id: refund.id, amountCents: refund.amount ?? part.amountCents };
}
