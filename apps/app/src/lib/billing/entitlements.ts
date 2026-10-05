import {
  type BillingInterval,
  channelList,
  type Plan,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import {
  billingTransitions,
  entitlements,
  type BillingStatus,
  type ChannelsEnabled,
  type Entitlements,
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
};

/**
 * Write the row for a freshly provisioned clinic.
 *
 * `provisioning` when there is a Stripe subscription to wait on — the first
 * invoice's `invoice.paid` is what moves it to `active` — and `active`
 * straight away when there is not, which is the no-Stripe development path
 * where nothing will ever arrive to activate it. Returns the status written so
 * the caller can report it without reading back through RLS.
 */
export async function seedEntitlements(
  db: Transaction,
  clinicId: string,
  input: SeedEntitlementsInput,
): Promise<BillingStatus> {
  const status: BillingStatus = input.stripeSubscriptionId
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
    reason: "provisioned",
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

async function updateOrThrow(
  db: Transaction,
  clinicId: string,
  values: Partial<typeof entitlements.$inferInsert>,
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
 * every other writer here, does not touch the status or the history.
 */
export async function rollAllowancePeriod(
  db: Transaction,
  clinicId: string,
  now: Date = new Date(),
): Promise<AllowanceRoll> {
  const current = await getEntitlements(db, clinicId);
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
 * The window is derived the same way `resetUsage()` derives it, so an annual
 * clinic starts on a one-month window from its very first invoice.
 */
export async function recordFirstInvoice(
  db: Transaction,
  clinicId: string,
  input: { periodStart: Date; periodEnd: Date; setupFeePaidUsd: number },
): Promise<void> {
  const current = await getEntitlements(db, clinicId);
  if (!current) throw new EntitlementsNotFoundError(clinicId);
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
 * Move the clinic onto a package and interval. Allowances become the FULL
 * new allowance (see the header), channels follow the new package, and a
 * chat-channel choice already on the row is kept when the new package still
 * offers one.
 *
 * Returns whether anything actually changed, because
 * `customer.subscription.updated` fires for many reasons that are not a plan
 * change and the caller should not record a plan change that did not happen.
 */
export async function applyPlanChange(
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
    channelsEnabled: channelsFor(plan),
    includedVoiceMinutes: plan.includedVoiceMinutes,
    includedChatConversations: plan.includedChatConversations,
  });
  return { changed: true };
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

/**
 * `parseLookupKey` moved to the catalog (packages/catalog/src/plans.ts) on 5
 * October 2026, beside its partner `stripeLookupKey()`, because apps/app is no
 * longer the only reader: the metered-item reconciler and the plan-change
 * actions need it too. Re-exported here so existing imports keep working.
 */
export { parseLookupKey, type ParsedLookupKey } from "@healdesk/catalog";
