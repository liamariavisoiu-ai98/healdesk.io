import {
  type BillingInterval,
  channelList,
  FIRST_PERIOD_REFUND_DAYS,
  getPlan,
  type Plan,
} from "@healdesk/catalog";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Transaction } from "@/db";
import {
  billingTransitions,
  entitlements,
  type BillingStatus,
  type ChannelsEnabled,
  type Entitlements,
  type UsageMeter,
} from "@/db/schema";

/**
 * Reading and writing what a clinic is entitled to.
 *
 * Everything here takes a `Transaction` and a clinic id rather than a
 * `TenantTx`, because the first writer is provisioning, which runs inside its
 * own `unsafeDb.transaction()` with the tenant GUC set by hand (the clinic row
 * does not exist yet when the transaction opens, so withTenant() cannot be
 * used). Every other caller is the lifecycle webhook, which passes `tx.db` out
 * of a withTenant() block. Either way RLS filters the statement to the tenant
 * that was declared, and the explicit `where clinic_id = …` is the first lock
 * in front of it.
 *
 * Status is deliberately NOT writable from here. `entitlements.status` moves
 * only through state-machine.ts, which checks the edge and records it; a
 * helper that set it directly would be the way that ledger silently stops
 * being complete.
 *
 * ## Allowances are copied, not referenced
 *
 * `includedVoiceMinutes` and `includedChatConversations` are copied out of the
 * catalog at seed time and again on every plan change. The catalog says what
 * is sold today; this row says what THIS clinic was sold. A price-book edit
 * must not change an existing customer's allowance mid-period, and a support
 * agent looking at the row must see the number the clinic was promised without
 * reconstructing which version of the catalog was live when they bought.
 *
 * ## Plan changes get the FULL new allowance
 *
 * Owner decision: an upgrade on the 20th gets the whole new monthly allowance,
 * not 10/30ths of it. Stripe prorates the money; we do not prorate the
 * minutes. It is generous by a few dollars and it removes an entire class of
 * "why do I only have 333 minutes" tickets.
 *
 * ## The allowance window is a month, even on an annual subscription
 *
 * `currentPeriodStart`/`currentPeriodEnd` is the window the counters are
 * measured over, and it is NOT always the invoiced period. A monthly clinic's
 * window is the invoiced month. An annual clinic is invoiced once a year for
 * an allowance sold "per month", and Stripe will not tell us when a month of
 * it has passed: the package price is yearly, the subscription carries no
 * monthly item, so there is exactly one `subscription_cycle` invoice per year.
 * An earlier version of this file assumed $0 monthly invoices would arrive to
 * reset the counters; nothing produces them. So for an annual clinic the
 * window is the first month of the invoiced year, and `rollAllowancePeriod()`
 * — driven by the billing sweep job, and by the usage path once one exists —
 * advances it a month at a time and zeroes the counters as it goes. The
 * annual renewal invoice re-anchors the window from the invoice.
 *
 * ## Bought and billed are two packages (the owner's decisions of 6 October)
 *
 * A clinic buys a package at checkout and is billed for the channels in
 * service: Complete bought, website chat first to answer, Web Chatbot billed
 * until the next channel answers. So `bought_plan_id` is what was sold, and
 * decides which channels may answer (`channels_enabled`), the step-up target
 * and the metered rates; `plan_code`, the interval and the `included_*`
 * allowances follow the package Stripe bills (`applyBilledPlan`). A row with
 * no `bought_plan_id` is LEGACY, written before the deferred start: there
 * `channels_enabled` still follows `plan_code`, and `recordFirstInvoice`
 * still opens the window from the first invoice, so the synthetic data and
 * the tests written against it keep today's behaviour (BD31).
 *
 * Before the plan starts there is no allowance window at all: the $0 first
 * invoice opens none, usage is recorded but never over the allowance (BD6),
 * and the window opens from the first PLAN invoice (`openAllowanceWindow`).
 * The plan has started once the worker's Stripe update went through or that
 * invoice was paid, whichever is first (`hasPlanStarted`, R8).
 */

/**
 * Thrown when a write finds no row for the clinic. Under RLS this is also
 * what a write aimed at the WRONG clinic looks like — zero rows updated — so
 * the message names the id without claiming to know which of the two it was.
 */
export class EntitlementsNotFoundError extends Error {
  constructor(readonly clinicId: string) {
    super(`No entitlements row visible for clinic ${clinicId}.`);
    this.name = "EntitlementsNotFoundError";
  }
}

/**
 * The channels a package turns on: exactly the ones the catalog lists for it.
 *
 * There is no choice to honour any more. Website chat or the Meta bot, where a
 * buyer picks one, is two packages since 5 October 2026 (catalog header), so
 * the package id alone decides, and a plan change through Stripe's Customer
 * Portal between the two moves the channel with it.
 */
export function channelsFor(plan: Plan): ChannelsEnabled {
  const enabled: ChannelsEnabled = { web: false, meta: false, voice: false };
  for (const channel of channelList(plan)) enabled[channel] = true;
  return enabled;
}

export type SeedEntitlementsInput = {
  plan: Plan;
  interval: BillingInterval;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  /**
   * healdesk's own fictional demo clinic (scripts/demo-clinic.ts, owner
   * decision Q6): status `demo`, the one marker on which a draft calendar
   * election counts (app_clinic_is_demo, drizzle/0057). Only provisioning's
   * internal option sets it, never a purchase, and never with a Stripe id.
   */
  demo?: boolean;
};

/**
 * Write the row for a freshly provisioned clinic.
 *
 * `provisioning` when there is a Stripe subscription to wait on — the first
 * invoice's `invoice.paid` is what moves it to `active` — and `active`
 * straight away when there is not, which is the no-Stripe development path
 * where nothing will ever arrive to activate it. `demo` for the operator's
 * demo clinic, which nothing else writes: the state machine has no edge into
 * `demo`, only one out of it (a demo converting to a purchase). Returns the
 * status written so the caller can report it without reading back through
 * RLS.
 */
export async function seedEntitlements(
  db: Transaction,
  clinicId: string,
  input: SeedEntitlementsInput,
): Promise<BillingStatus> {
  if (input.demo && (input.stripeCustomerId || input.stripeSubscriptionId)) {
    // A Stripe id makes it a customer, and app_clinic_is_demo() would say
    // "not a demo" of the row anyway; refused rather than half-written.
    throw new Error("A demo clinic has no Stripe customer or subscription.");
  }
  const status: BillingStatus = input.demo
    ? "demo"
    : input.stripeSubscriptionId
      ? "provisioning"
      : "active";

  await db.insert(entitlements).values({
    clinicId,
    stripeCustomerId: input.stripeCustomerId ?? null,
    stripeSubscriptionId: input.stripeSubscriptionId ?? null,
    planCode: input.plan.id,
    billingInterval: input.interval,
    status,
    channelsEnabled: channelsFor(input.plan),
    includedVoiceMinutes: input.plan.includedVoiceMinutes,
    includedChatConversations: input.plan.includedChatConversations,
  });

  // The one transition row with no `from`: the history starts here, and a
  // clinic whose first row is "active, reason provisioned" reads correctly as
  // one that never went through Stripe.
  await db.insert(billingTransitions).values({
    clinicId,
    fromStatus: null,
    toStatus: status,
    actor: "system",
    reason: input.demo ? "provisioned_demo" : "provisioned",
  });

  return status;
}

export async function getEntitlements(
  db: Transaction,
  clinicId: string,
): Promise<Entitlements | null> {
  const rows = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.clinicId, clinicId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The row, locked for the rest of the transaction (`SELECT … FOR UPDATE`).
 *
 * Every path that reads the counters to decide what to write takes this
 * lock first: the usage recorder, the annual roll, the status machine. Under
 * READ COMMITTED a reader that has to wait gets the row as the holder
 * committed it, so one writer's increment can never be read stale and then
 * overwritten by another's reset. Lock this one row and nothing else, in
 * this order, and no two of them can deadlock.
 */
export async function getEntitlementsForUpdate(
  db: Transaction,
  clinicId: string,
): Promise<Entitlements | null> {
  const rows = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.clinicId, clinicId))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

async function updateOrThrow(
  db: Transaction,
  clinicId: string,
  values: PgUpdateSetSource<typeof entitlements>,
): Promise<void> {
  const updated = await db
    .update(entitlements)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(entitlements.clinicId, clinicId))
    .returning({ clinicId: entitlements.clinicId });
  if (updated.length === 0) throw new EntitlementsNotFoundError(clinicId);
}

/**
 * Calendar arithmetic for the allowance window, in UTC.
 *
 * Clamped to the last day of the target month the way Stripe anchors billing
 * cycles: the 31st of January plus a month is the 28th of February, not the
 * 3rd of March. Rolling from a clamped date keeps the clamped day (the 28th)
 * for the rest of the year; the annual renewal invoice re-anchors it.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0),
  ).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

/**
 * The window the counters run over, from the period an invoice bought. The
 * invoiced period for a monthly clinic; its first month for an annual one
 * (see the header), never past the invoiced end.
 */
export function allowanceWindow(
  interval: BillingInterval,
  invoiced: { start: Date; end: Date },
): { start: Date; end: Date } {
  if (interval === "month") return { start: invoiced.start, end: invoiced.end };
  const monthEnd = addMonthsUtc(invoiced.start, 1);
  return {
    start: invoiced.start,
    end: monthEnd.getTime() < invoiced.end.getTime() ? monthEnd : invoiced.end,
  };
}

/**
 * A renewal was paid: the counters go back to zero and the window moves.
 *
 * Driven by the invoice, not by the calendar: the allowance is "per month" in
 * the catalog but the month that matters is the one Stripe invoiced. The one
 * exception is the annual clinic, whose invoiced period is a year and whose
 * window is therefore its first month — `rollAllowancePeriod()` walks the
 * rest of the year.
 */
export async function resetUsage(
  db: Transaction,
  clinicId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  const current = await getEntitlements(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);
  const window = allowanceWindow(current.billingInterval, {
    start: periodStart,
    end: periodEnd,
  });
  await updateOrThrow(db, clinicId, {
    usedVoiceMinutes: "0",
    usedChatConversations: 0,
    currentPeriodStart: window.start,
    currentPeriodEnd: window.end,
  });
}

export type AllowanceRoll =
  | { rolled: 0 }
  | { rolled: number; periodStart: Date; periodEnd: Date };

/**
 * Advance an annual clinic's allowance window to the month containing `now`,
 * zeroing the counters if it moved at all. A no-op for monthly clinics (their
 * invoices do this) and for a clinic with no window yet (nothing paid).
 *
 * Idempotent: a second call in the same month rolls nothing. Skipping several
 * months in one call — the sweep was off for a while — lands on the current
 * month with counters at zero, which is the same result as if every month had
 * been rolled on time; the intervening months' usage was never billable
 * anyway (there is no metered item on an annual subscription to bill it to).
 *
 * The caller records the roll in the billing history; this function, like
 * every other writer here, does not touch the status or the history. It
 * locks the row (`getEntitlementsForUpdate`) for the rest of the caller's
 * transaction.
 */
export async function rollAllowancePeriod(
  db: Transaction,
  clinicId: string,
  now: Date = new Date(),
): Promise<AllowanceRoll> {
  // Locked: the hourly sweep calls this while usage is being recorded, and an
  // unlocked read would let the sweep zero counters a recorder had just
  // incremented after the read, losing that usage from the window.
  const current = await getEntitlementsForUpdate(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);
  if (current.billingInterval !== "year") return { rolled: 0 };
  if (!current.currentPeriodStart || !current.currentPeriodEnd) return { rolled: 0 };

  let start = current.currentPeriodStart;
  let end = current.currentPeriodEnd;
  let rolled = 0;
  while (end.getTime() <= now.getTime()) {
    start = end;
    end = addMonthsUtc(start, 1);
    rolled += 1;
  }
  if (rolled === 0) return { rolled: 0 };

  await updateOrThrow(db, clinicId, {
    usedVoiceMinutes: "0",
    usedChatConversations: 0,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  return { rolled, periodStart: start, periodEnd: end };
}

/**
 * What the first invoice tells us: when the paid period runs, and how much of
 * the setup fee has actually cleared. The second matters on an upgrade —
 * `setupFeeDeltaUsd` in the catalog is computed from what was PAID, and a
 * clinic that paid $497 owes $500 more for a $997 package, not $997.
 *
 * LEGACY rows only (no `bought_plan_id`): the window is derived the same way
 * `resetUsage()` derives it, so an annual clinic starts on a one-month window
 * from its very first invoice. For a row bought under the deferred start the
 * first invoice is the setup fee and a $0 placeholder, which buys no period:
 * it records the setup fee and when it was paid (`recordSetupFeePaid`) and
 * opens NO window, because a window opened on the placeholder's month would
 * bill usage against an allowance nobody has paid for (BD7). The window opens
 * from the first plan invoice instead (`openAllowanceWindow`).
 */
export async function recordFirstInvoice(
  db: Transaction,
  clinicId: string,
  input: { periodStart: Date; periodEnd: Date; setupFeePaidUsd: number; paidAt?: Date },
): Promise<void> {
  const current = await getEntitlements(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);
  if (current.boughtPlanId !== null) {
    await recordSetupFeePaid(db, clinicId, {
      usd: input.setupFeePaidUsd,
      at: input.paidAt ?? new Date(),
    });
    return;
  }
  const window = allowanceWindow(current.billingInterval, {
    start: input.periodStart,
    end: input.periodEnd,
  });
  await updateOrThrow(db, clinicId, {
    currentPeriodStart: window.start,
    currentPeriodEnd: window.end,
    setupFeePaidUsd: input.setupFeePaidUsd.toFixed(2),
    graceEndsAt: null,
  });
}

/**
 * Move the clinic onto the package and interval Stripe now BILLS (see the
 * header). Allowances become the FULL new allowance. `channels_enabled` moves
 * with it only on a legacy row: on a row with a bought package it follows
 * what was bought, because a clinic billed as Web Chatbot while its phone is
 * still being set up must not have voice switched off by being billed for
 * less, or the phone could never answer, never be in service, and never be
 * priced in.
 *
 * Returns whether anything actually changed, because
 * `customer.subscription.updated` fires for many reasons that are not a plan
 * change and the caller should not record a plan change that did not happen.
 * Nothing is written when nothing changed, so a price-book edit never
 * rewrites an existing clinic's allowance.
 */
export async function applyBilledPlan(
  db: Transaction,
  clinicId: string,
  plan: Plan,
  interval: BillingInterval,
): Promise<{ changed: boolean }> {
  const current = await getEntitlements(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);

  const changed =
    current.planCode !== plan.id || current.billingInterval !== interval;
  if (!changed) return { changed: false };

  await updateOrThrow(db, clinicId, {
    planCode: plan.id,
    billingInterval: interval,
    ...(current.boughtPlanId === null ? { channelsEnabled: channelsFor(plan) } : {}),
    includedVoiceMinutes: plan.includedVoiceMinutes,
    includedChatConversations: plan.includedChatConversations,
  });
  return { changed: true };
}

/**
 * The name the lifecycle webhook has always called. A thin wrapper kept so
 * events.ts compiles and behaves unchanged on legacy rows while Package C
 * rewrites it against `applyBilledPlan`; new code calls that directly.
 */
export async function applyPlanChange(
  db: Transaction,
  clinicId: string,
  plan: Plan,
  interval: BillingInterval,
): Promise<{ changed: boolean }> {
  return applyBilledPlan(db, clinicId, plan, interval);
}

/**
 * Record the package BOUGHT (at checkout, or by a plan change): it decides
 * which channels may answer, so `channels_enabled` follows it. Billing is
 * untouched; `applyBilledPlan` moves that.
 */
export async function applyBoughtPlan(
  db: Transaction,
  clinicId: string,
  plan: Plan,
): Promise<void> {
  await updateOrThrow(db, clinicId, {
    boughtPlanId: plan.id,
    channelsEnabled: channelsFor(plan),
  });
}

/** Null clears it. */
export async function setGrace(
  db: Transaction,
  clinicId: string,
  until: Date | null,
): Promise<void> {
  await updateOrThrow(db, clinicId, { graceEndsAt: until });
}

/**
 * Attach Stripe ids to a row that has none yet. Ids already present are kept:
 * the webhook that carries them may arrive more than once, and a second
 * delivery must not be able to re-point a clinic at a different customer.
 */
export async function storeStripeIds(
  db: Transaction,
  clinicId: string,
  ids: { customerId?: string | null; subscriptionId?: string | null },
): Promise<void> {
  const current = await getEntitlements(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);

  const values: Partial<typeof entitlements.$inferInsert> = {};
  if (!current.stripeCustomerId && ids.customerId) {
    values.stripeCustomerId = ids.customerId;
  }
  if (!current.stripeSubscriptionId && ids.subscriptionId) {
    values.stripeSubscriptionId = ids.subscriptionId;
  }
  if (Object.keys(values).length === 0) return;
  await updateOrThrow(db, clinicId, values);
}

// -----------------------------------------------------------------------------
// The deferred start and the plan's lifecycle (build spec §3; R5, R8, R9, R14)
// -----------------------------------------------------------------------------

/**
 * Whether the plan has started (R8): the worker's Stripe update went through
 * (`plan_start_applied_at`) or the first plan invoice was paid
 * (`plan_started_at`), whichever came first. A step-up, the gate's
 * "cancelled before the start", the before-start wording of the cancellation
 * emails and the reconcile all ask this, never `plan_started_at` alone.
 */
export function hasPlanStarted(
  row: Pick<Entitlements, "planStartedAt" | "planStartAppliedAt">,
): boolean {
  return row.planStartedAt !== null || row.planStartAppliedAt !== null;
}

/**
 * Write a column that is set once: a conditional UPDATE that matches only
 * while `stillNull` is null, returning whether this call set it. Zero rows
 * is "already set" or "no row"; the second throws, like every writer here.
 */
async function setOnce(
  db: Transaction,
  clinicId: string,
  values: PgUpdateSetSource<typeof entitlements>,
  stillNull: Parameters<typeof isNull>[0],
): Promise<boolean> {
  const set = await db
    .update(entitlements)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(entitlements.clinicId, clinicId), isNull(stillNull)))
    .returning({ clinicId: entitlements.clinicId });
  if (set.length > 0) return true;
  if (!(await getEntitlements(db, clinicId))) throw new EntitlementsNotFoundError(clinicId);
  return false;
}

/**
 * The first plan invoice was paid (BD7): the plan's paid start, which Home
 * and the plan-started email show. Only while still unset, so a replayed
 * invoice.paid, or the next one, never moves it; returns whether this call
 * set it.
 */
export async function markPlanStarted(
  db: Transaction,
  clinicId: string,
  at: Date,
): Promise<boolean> {
  return setOnce(db, clinicId, { planStartedAt: at }, entitlements.planStartedAt);
}

/** The plan-start worker's Stripe update went through (R8). Only while still unset. */
export async function markPlanStartApplied(
  db: Transaction,
  clinicId: string,
  at: Date,
): Promise<boolean> {
  return setOnce(db, clinicId, { planStartAppliedAt: at }, entitlements.planStartAppliedAt);
}

/** The first plan invoice's id (R9), for the refunds. Only while still unset. */
export async function markFirstPlanInvoice(
  db: Transaction,
  clinicId: string,
  invoiceId: string,
): Promise<boolean> {
  return setOnce(db, clinicId, { firstPlanInvoiceId: invoiceId }, entitlements.firstPlanInvoiceId);
}

/**
 * A first-period refund or the guarantee was paid (BD14, R15). Only while
 * still unset, which is what stops the two stacking; returns whether this
 * call set it.
 */
export async function markFirstPeriodRefunded(
  db: Transaction,
  clinicId: string,
  at: Date,
): Promise<boolean> {
  return setOnce(db, clinicId, { firstPeriodRefundedAt: at }, entitlements.firstPeriodRefundedAt);
}

/**
 * Open the plan's first allowance window from the period the first plan
 * invoice bought, and start the counters from zero (BD6, BD7): usage before
 * it was recorded with no window and is never counted against it.
 *
 * `invoiced` is the invoiced period; the window is derived from it through
 * `allowanceWindow()` and the row's interval, exactly as `resetUsage()`
 * derives it, so an annual plan gets its first month. Passing a window that
 * is already derived gives the same window. Locks the row first, like every
 * writer that resets the counters. Returns the window it opened.
 */
export async function openAllowanceWindow(
  db: Transaction,
  clinicId: string,
  invoiced: { start: Date; end: Date },
): Promise<{ start: Date; end: Date }> {
  const current = await getEntitlementsForUpdate(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);
  const window = allowanceWindow(current.billingInterval, invoiced);
  await updateOrThrow(db, clinicId, {
    usedVoiceMinutes: "0",
    usedChatConversations: 0,
    currentPeriodStart: window.start,
    currentPeriodEnd: window.end,
  });
  return window;
}

/**
 * The setup fee cleared (BD7): what was paid towards it, and when the first
 * invoice was paid, kept from the first time it is recorded.
 */
export async function recordSetupFeePaid(
  db: Transaction,
  clinicId: string,
  input: { usd: number; at: Date },
): Promise<void> {
  await updateOrThrow(db, clinicId, {
    setupFeePaidUsd: input.usd.toFixed(2),
    firstPaidAt: sql`coalesce(${entitlements.firstPaidAt}, ${input.at}::timestamptz)`,
  });
}

/**
 * An invoice was paid: the last one paid (a late payment_failed for it is
 * stale and ignored), and the paid-through date, which only ever moves
 * forward (`greatest`), so an action invoice paid after a renewal cannot pull
 * the renewal date back.
 *
 * The open invoice is cleared only when it is THIS invoice. A different paid
 * invoice (a proration or a setup-fee difference raised while a renewal sits
 * unpaid) leaves the unpaid one on record: the clinic still owes it, Billing
 * still links it, and the suspended-to-active rule (R10) still sees it.
 */
export async function recordInvoicePaid(
  db: Transaction,
  clinicId: string,
  input: { invoiceId: string; paidThrough?: Date | null },
): Promise<void> {
  const isOpen = sql`${entitlements.openInvoiceId} = ${input.invoiceId}`;
  await updateOrThrow(db, clinicId, {
    lastPaidInvoiceId: input.invoiceId,
    openInvoiceId: sql`case when ${isOpen} then null else ${entitlements.openInvoiceId} end`,
    openInvoiceUrl: sql`case when ${isOpen} then null else ${entitlements.openInvoiceUrl} end`,
    openInvoiceAmountCents: sql`case when ${isOpen} then null else ${entitlements.openInvoiceAmountCents} end`,
    ...(input.paidThrough
      ? {
          paidThrough: sql`greatest(${entitlements.paidThrough}, ${input.paidThrough}::timestamptz)`,
        }
      : {}),
  });
}

/** An invoice the clinic owes, as the open-invoice slot records it. */
export type OpenInvoice = { invoiceId: string; url: string | null; amountDueCents?: number | null };

function openInvoiceValues(invoice: OpenInvoice | null) {
  return {
    openInvoiceId: invoice?.invoiceId ?? null,
    openInvoiceUrl: invoice?.url ?? null,
    openInvoiceAmountCents: invoice?.amountDueCents ?? null,
  };
}

/**
 * An invoice is due and unpaid (payment failed, or the card needs the clinic
 * to confirm): its id, Stripe's hosted pay page and what it asks for.
 *
 * Recorded only while no OTHER invoice is (review fix). A clinic can owe two
 * at once, a renewal and an annual overage or step-up invoice on the same
 * declined card, and the slot keeps the first: overwriting it lost that debt,
 * so paying the second cleared grace and set the clinic active while the
 * first was still unpaid. A different invoice recorded here stays until its
 * own invoice.paid moves the slot on (`moveOpenInvoice`); this one's email
 * still links its own page. The same invoice again (Stripe's retry) refreshes
 * its link and amount. Returns whether this invoice is the one recorded.
 */
export async function recordOpenInvoice(
  db: Transaction,
  clinicId: string,
  input: OpenInvoice,
): Promise<boolean> {
  const recorded = await db
    .update(entitlements)
    .set({ ...openInvoiceValues(input), updatedAt: new Date() })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        or(isNull(entitlements.openInvoiceId), eq(entitlements.openInvoiceId, input.invoiceId)),
      ),
    )
    .returning({ clinicId: entitlements.clinicId });
  if (recorded.length > 0) return true;
  if (!(await getEntitlements(db, clinicId))) throw new EntitlementsNotFoundError(clinicId);
  return false;
}

/**
 * Move the open-invoice slot on after a payment: from `from` to the next
 * invoice the clinic still owes, or to nothing (review fix). `from` is null
 * when `recordInvoicePaid` has just cleared the invoice paid, or the id of a
 * recorded invoice Stripe no longer holds open (settled without our hearing,
 * or voided). Only while the slot still holds `from`, so an invoice another
 * delivery recorded meanwhile is never overwritten. Returns whether it moved.
 */
export async function moveOpenInvoice(
  db: Transaction,
  clinicId: string,
  from: string | null,
  to: OpenInvoice | null,
): Promise<boolean> {
  const moved = await db
    .update(entitlements)
    .set({ ...openInvoiceValues(to), updatedAt: new Date() })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        from === null ? isNull(entitlements.openInvoiceId) : eq(entitlements.openInvoiceId, from),
      ),
    )
    .returning({ clinicId: entitlements.clinicId });
  return moved.length > 0;
}

/**
 * The lookup keys of the metered prices the subscription carries, as Stripe
 * returned them: sorted and deduplicated, so comparing with
 * `expectedMeteredKeys()` is an equality.
 */
export async function setMeteredPriceKeys(
  db: Transaction,
  clinicId: string,
  keys: readonly string[],
): Promise<void> {
  await updateOrThrow(db, clinicId, { meteredPriceKeys: [...new Set(keys)].sort() });
}

/** Locations on the subscription: the package item's quantity. A whole number, at least 1. */
export async function setLocations(
  db: Transaction,
  clinicId: string,
  locations: number,
): Promise<void> {
  if (!Number.isInteger(locations) || locations < 1) {
    throw new RangeError(`Locations must be a whole number of at least 1, not ${locations}.`);
  }
  await updateOrThrow(db, clinicId, { locations });
}

/** When a scheduled cancellation takes effect, or null when none is (BD10). */
export async function setCancelAt(
  db: Transaction,
  clinicId: string,
  at: Date | null,
): Promise<void> {
  await updateOrThrow(db, clinicId, { cancelAt: at });
}

/**
 * The end of the 30-day setup window: set at provisioning, moved only by
 * ops. A clinic with nothing live by then is closed.
 */
export async function setSetupDeadline(
  db: Transaction,
  clinicId: string,
  at: Date,
): Promise<void> {
  await updateOrThrow(db, clinicId, { setupDeadlineAt: at });
}

/** The owner's switch for the 80% and 100% allowance emails. */
export async function setUsageAlertsEnabled(
  db: Transaction,
  clinicId: string,
  enabled: boolean,
): Promise<void> {
  await updateOrThrow(db, clinicId, { usageAlertsEnabled: enabled });
}

/** Keep going and bill the extra (`allow`), or stop and fall back at the allowance (`hard_cap`). */
export async function setOverageMode(
  db: Transaction,
  clinicId: string,
  mode: "allow" | "hard_cap",
): Promise<void> {
  if (mode !== "allow" && mode !== "hard_cap") {
    throw new RangeError(`Unknown overage mode: ${String(mode)}.`);
  }
  await updateOrThrow(db, clinicId, { overageMode: mode });
}

/**
 * The allowance a meter counts against, pooled across the locations (BD5):
 * the billed package's included amount when it is above 0, otherwise the
 * BOUGHT package's, from the catalog, times `locations`.
 *
 * The fallback is the point. A clinic that bought Web + Voice and is billed
 * as Web Chatbot while its phone is still being set up has 0 included voice
 * minutes on the billed package; counted against 0, its first call would be
 * billed as overage, and under the hard cap it would be refused, so the
 * phone could never answer and never be priced in. Usage recording, the gate
 * and the usage alerts all use this one function. A legacy row (no bought
 * package) has no fallback: 0 there means the channel was not sold.
 */
export function effectiveIncluded(
  row: Pick<
    Entitlements,
    "includedVoiceMinutes" | "includedChatConversations" | "boughtPlanId" | "locations"
  >,
  meter: UsageMeter,
): number {
  const billed =
    meter === "voice_minutes" ? row.includedVoiceMinutes : row.includedChatConversations;
  if (billed > 0) return billed * row.locations;
  const bought = row.boughtPlanId ? getPlan(row.boughtPlanId) : undefined;
  if (!bought) return 0;
  const perLocation =
    meter === "voice_minutes" ? bought.includedVoiceMinutes : bought.includedChatConversations;
  return perLocation * row.locations;
}

/** How long a Stripe mutation lease lasts unless its holder renews or releases it (R5). */
export const STRIPE_MUTATION_LEASE_MS = 5 * 60 * 1000;

/**
 * Claim the billing clinic's Stripe mutation lease (R5), in the billing
 * clinic's transaction, before reading the subscription to change it: the
 * plan-start, step-up, close-setup and cancel-now workers, and changePlan,
 * addLocation, setAutoRenew and commitRefund. A conditional UPDATE that wins
 * when the lease is free, has run out, or is already this holder's (which
 * renews it). Returns false while another holder's lease is running: a worker
 * then defers a minute without counting an attempt, and an action answers
 * `busy`.
 *
 * `owner` names the holder for the console and for the release, e.g.
 * `billing_request:<id>:<attempt>`; 1 to 120 characters, never a person.
 * Lease writes leave `updated_at` alone: they are a lock, not a change to
 * what the clinic is entitled to.
 */
export async function claimStripeMutationLease(
  db: Transaction,
  clinicId: string,
  owner: string,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<boolean> {
  if (owner.length < 1 || owner.length > 120) {
    throw new RangeError("A Stripe mutation lease owner is 1 to 120 characters.");
  }
  const now = options.now ?? new Date();
  const until = new Date(now.getTime() + (options.leaseMs ?? STRIPE_MUTATION_LEASE_MS));
  const claimed = await db
    .update(entitlements)
    .set({ stripeMutationLeaseUntil: until, stripeMutationLeaseOwner: owner })
    .where(
      and(
        eq(entitlements.clinicId, clinicId),
        or(
          isNull(entitlements.stripeMutationLeaseUntil),
          lt(entitlements.stripeMutationLeaseUntil, now),
          eq(entitlements.stripeMutationLeaseOwner, owner),
        ),
      ),
    )
    .returning({ clinicId: entitlements.clinicId });
  if (claimed.length > 0) return true;
  if (!(await getEntitlements(db, clinicId))) throw new EntitlementsNotFoundError(clinicId);
  return false;
}

/**
 * Release the lease once the outcome is written. Only the holder's own: a
 * holder whose lease ran out and was taken over releases nothing, and
 * returns false, rather than free the new holder's lease under it.
 */
export async function releaseStripeMutationLease(
  db: Transaction,
  clinicId: string,
  owner: string,
): Promise<boolean> {
  const released = await db
    .update(entitlements)
    .set({ stripeMutationLeaseUntil: null, stripeMutationLeaseOwner: null })
    .where(
      and(eq(entitlements.clinicId, clinicId), eq(entitlements.stripeMutationLeaseOwner, owner)),
    )
    .returning({ clinicId: entitlements.clinicId });
  return released.length > 0;
}

/**
 * `parseLookupKey` moved to the catalog (packages/catalog/src/plans.ts) on 5
 * October 2026, beside its partner `stripeLookupKey()`, because apps/app is no
 * longer the only reader: the metered-item reconciler and the plan-change
 * actions need it too. Re-exported here so existing imports keep working.
 */
export { parseLookupKey, type ParsedLookupKey } from "@healdesk/catalog";

/**
 * The last day of the first-period refund window (ISO date), while it is
 * open and no refund under § 5 has been issued; null otherwise. The same
 * rule `refundWindowOpen` applies, for the `cancel_scheduled` payload.
 */
export function refundEligibleUntil(
  row: Pick<Entitlements, "planStartedAt" | "planStartAppliedAt" | "firstPeriodRefundedAt">,
  now: Date,
): string | null {
  if (!refundWindowOpen(row, now)) return null;
  const start = (row.planStartedAt ?? row.planStartAppliedAt) as Date;
  return new Date(start.getTime() + FIRST_PERIOD_REFUND_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Inside the first-period refund window (R15): the plan has started, it is
 * no more than FIRST_PERIOD_REFUND_DAYS since it did, and no refund under
 * Terms § 5 has been issued. The window runs from the paid start, or from the
 * moment the start was applied while its invoice is still being paid.
 */
export function refundWindowOpen(
  row: Pick<Entitlements, "planStartedAt" | "planStartAppliedAt" | "firstPeriodRefundedAt">,
  now: Date,
): boolean {
  const start = row.planStartedAt ?? row.planStartAppliedAt;
  if (!start || row.firstPeriodRefundedAt) return false;
  return now.getTime() <= start.getTime() + FIRST_PERIOD_REFUND_DAYS * 24 * 60 * 60 * 1000;
}
