import {
  getPlan,
  meteredPriceLookupKey,
  METERS,
  OVERAGE_RATES_PROVISIONAL,
  overageRateCents,
  type Plan,
} from "@healdesk/catalog";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import { overageInvoices, usageEvents, type Entitlements, type OverageInvoice } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { JOB_ANNUAL_OVERAGE_INVOICE, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { addMonthsUtc, getEntitlements, hasPlanStarted } from "./entitlements";
import { stripeErrorCode, type SubscriptionLike } from "./metered-items";
import { enqueueNotice } from "./notices";
import { priceForLookupKey } from "./prices";
import { chargeOneOffInvoice, type OneOffItem } from "./stripe-actions";
import { getStripe } from "./stripe-client";
import { effectivePaymentMethod, WORKER_STRIPE_OPTIONS } from "./stripe-helpers";

/**
 * Overage on annual plans, invoiced once per closed allowance month (BD20,
 * R13a, R17).
 *
 * An annual subscription carries no metered prices: Stripe invoices it once
 * a year, so usage past the monthly allowance cannot ride on a cycle
 * invoice. Instead, for every allowance window that has closed, this sums the
 * window's `over_allowance` by meter (only rows never reported to a meter,
 * so a clinic that moved from monthly to annual is never billed twice) and
 * charges it on one invoice of its own at the BOUGHT package's rates.
 *
 * The ledger is `overage_invoices`, one row per window (unique on the
 * window), and the order of operations is what makes a crash harmless:
 *
 *   1. CLAIM the window: insert its row `pending` (or `skipped` when there is
 *      nothing to bill), so a second run, or a retry from the console, finds
 *      it taken;
 *   2. charge it with the draft-first one-off recipe (R13a), `hd_kind
 *      annual_overage` and `hd_ref = <clinic>:<windowStart>`, so a run that
 *      died anywhere in the middle resumes the same invoice instead of
 *      creating a second one;
 *   3. record `invoiced` and enqueue `overage_invoiced`; or `failed`, with a
 *      closed code, and tell ops. A `failed` window is retried on the next
 *      run, after looking up the invoice it may already have.
 *
 * A declined card is not a failure here: the invoice is owed either way, so
 * it is left open (never voided) and goes through dunning like any other
 * unpaid invoice. An invoice someone voided by hand in Stripe is respected:
 * the window is recorded `skipped` and never invoiced again.
 */

const OVERAGE_ACTOR: ActorContext = { type: "service", serviceName: "annual-overage-invoice" };

export type OverageWindow = {
  start: Date;
  end: Date;
  voiceUnits: number;
  chatUnits: number;
};

export type OverageWindowResult =
  | { status: "invoiced"; amountCents: number; hostedInvoiceUrl: string | null }
  | { status: "skipped"; reason: "zero_units" | "invoice_voided" | "already_done" }
  | { status: "failed"; reason: string };

/**
 * The closed allowance windows that have usage, oldest first, each with its
 * unreported overage by meter. A window is closed once the next one has
 * begun (its start is before the open window's) and its end has passed. Its
 * end is a month after its start, clamped to the next window's start, as
 * `rollAllowancePeriod` and the renewal's re-anchoring make it.
 */
export async function closedOverageWindows(
  tx: TenantTx,
  row: Pick<Entitlements, "currentPeriodStart">,
  now: Date,
): Promise<OverageWindow[]> {
  const sums = await tx.db
    .select({
      windowStart: usageEvents.windowStart,
      voiceUnits: sql<number>`coalesce(sum(${usageEvents.overAllowance}) filter (where ${usageEvents.meter} = 'voice_minutes' and ${usageEvents.stripeReportedAt} is null), 0)::int`,
      chatUnits: sql<number>`coalesce(sum(${usageEvents.overAllowance}) filter (where ${usageEvents.meter} = 'chat_conversations' and ${usageEvents.stripeReportedAt} is null), 0)::int`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.clinicId, tx.clinicId), isNotNull(usageEvents.windowStart)))
    .groupBy(usageEvents.windowStart)
    .orderBy(asc(usageEvents.windowStart));

  const windows: OverageWindow[] = [];
  sums.forEach((sum, i) => {
    const start = sum.windowStart as Date;
    const open = row.currentPeriodStart;
    if (open && start.getTime() >= open.getTime()) return;
    let end = addMonthsUtc(start, 1);
    const next = sums[i + 1]?.windowStart ?? open ?? null;
    if (next && next.getTime() < end.getTime()) end = next;
    if (end.getTime() > now.getTime()) return;
    windows.push({
      start,
      end,
      voiceUnits: Number(sum.voiceUnits),
      chatUnits: Number(sum.chatUnits),
    });
  });
  return windows;
}

/** The bought package's rate for a meter in whole cents, or 0 when the package does not sell it. */
function rateCents(rateUsd: number): number {
  return rateUsd > 0 ? overageRateCents(rateUsd) : 0;
}

type Claimed = {
  row: OverageInvoice;
  voiceRateCents: number;
  chatRateCents: number;
  amountCents: number;
};

/**
 * Claim a window's ledger row (step 1): insert it, or take over a `failed`
 * (or crashed `pending`) one with the amounts worked out afresh. `done` when
 * the window is already invoiced or skipped, or has nothing to bill.
 */
async function claimWindow(
  tx: TenantTx,
  plan: Plan,
  window: OverageWindow,
): Promise<Claimed | { done: OverageInvoice }> {
  const voiceRateCents = rateCents(plan.overagePerVoiceMinuteUsd);
  const chatRateCents = rateCents(plan.overagePerChatConversationUsd);
  const amountCents = window.voiceUnits * voiceRateCents + window.chatUnits * chatRateCents;
  const values = {
    windowEnd: window.end,
    voiceUnits: window.voiceUnits,
    chatUnits: window.chatUnits,
    voiceRateCents,
    chatRateCents,
    amountCents,
  };

  const [inserted] = await tx.db
    .insert(overageInvoices)
    .values({
      clinicId: tx.clinicId,
      windowStart: window.start,
      ...values,
      status: amountCents > 0 ? "pending" : "skipped",
    })
    .onConflictDoNothing({ target: [overageInvoices.clinicId, overageInvoices.windowStart] })
    .returning();
  if (inserted) {
    return inserted.status === "skipped"
      ? { done: inserted }
      : { row: inserted, voiceRateCents, chatRateCents, amountCents };
  }

  const [existing] = await tx.db
    .select()
    .from(overageInvoices)
    .where(
      and(eq(overageInvoices.clinicId, tx.clinicId), eq(overageInvoices.windowStart, window.start)),
    )
    .limit(1)
    .for("update");
  // The insert conflicted, so the row exists: the runtime role cannot delete one.
  if (!existing) throw new Error("The overage ledger row for this window could not be read.");
  if (existing.status === "invoiced" || existing.status === "skipped") return { done: existing };
  const [taken] = await tx.db
    .update(overageInvoices)
    .set({ ...values, status: amountCents > 0 ? "pending" : "skipped", error: null })
    .where(eq(overageInvoices.id, existing.id))
    .returning();
  return taken!.status === "skipped"
    ? { done: taken! }
    : { row: taken!, voiceRateCents, chatRateCents, amountCents };
}

/**
 * Invoice one closed window for a billing clinic (steps 1 to 3). Safe to
 * call again for the same window at any time: a done window is left alone,
 * and anything half-done resumes by `hd_ref`.
 */
export async function invoiceOverageWindow(
  billingClinicId: string,
  window: OverageWindow,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<OverageWindowResult> {
  const now = options.now ?? new Date();
  const claim = await withTenant(
    { clinicId: billingClinicId, actor: OVERAGE_ACTOR },
    async (tx) => {
      const row = await getEntitlements(tx.db, billingClinicId);
      const plan = row ? getPlan(row.boughtPlanId ?? row.planCode) : undefined;
      if (!row || !plan || !row.stripeCustomerId) return null;
      const claimed = await claimWindow(tx, plan, window);
      return { claimed, plan, row };
    },
  );
  if (!claim) return { status: "failed", reason: "no_billing_account" };
  if ("done" in claim.claimed) {
    return {
      status: "skipped",
      reason: claim.claimed.done.status === "skipped" ? "zero_units" : "already_done",
    };
  }
  const { claimed, plan, row } = claim;
  const windowStartIso = window.start.toISOString();

  try {
    const stripe = options.stripe ?? getStripe();
    const items: OneOffItem[] = [];
    const days = `${windowStartIso.slice(0, 10)} to ${window.end.toISOString().slice(0, 10)}`;
    if (window.voiceUnits > 0 && claimed.voiceRateCents > 0) {
      const price = await priceForLookupKey(
        meteredPriceLookupKey("voiceMinutes", plan.overagePerVoiceMinuteUsd),
        { stripe },
      );
      items.push({
        product: price.productId,
        unitAmountCents: claimed.voiceRateCents,
        quantity: window.voiceUnits,
        description: `${METERS.voiceMinutes.displayName}, ${days}`,
      });
    }
    if (window.chatUnits > 0 && claimed.chatRateCents > 0) {
      const price = await priceForLookupKey(
        meteredPriceLookupKey("chatConversations", plan.overagePerChatConversationUsd),
        { stripe },
      );
      items.push({
        product: price.productId,
        unitAmountCents: claimed.chatRateCents,
        quantity: window.chatUnits,
        description: `${METERS.chatConversations.displayName}, ${days}`,
      });
    }
    const subscription = row.stripeSubscriptionId
      ? ((await stripe.subscriptions.retrieve(
          row.stripeSubscriptionId,
          {},
          WORKER_STRIPE_OPTIONS,
        )) as unknown as SubscriptionLike)
      : null;
    const charge = await chargeOneOffInvoice(stripe, {
      customerId: row.stripeCustomerId as string,
      defaultPaymentMethod: await effectivePaymentMethod(
        stripe,
        { customerId: row.stripeCustomerId as string, subscription },
        WORKER_STRIPE_OPTIONS,
      ),
      hdKind: "annual_overage",
      hdRef: `${billingClinicId}:${windowStartIso}`,
      keyPrefix: `hd-annual-overage:${billingClinicId}:${windowStartIso}`,
      description: `Usage over your allowance, ${days}`,
      items,
      onDecline: "leave_open",
    });

    if (charge.status === "voided") {
      await withTenant({ clinicId: billingClinicId, actor: OVERAGE_ACTOR }, (tx) =>
        tx.db
          .update(overageInvoices)
          .set({ status: "skipped", stripeInvoiceId: charge.invoiceId, error: "invoice_voided" })
          .where(eq(overageInvoices.id, claimed.row.id)),
      );
      return { status: "skipped", reason: "invoice_voided" };
    }
    if (charge.status === "declined") {
      // leave_open never declines; a void found on the way is "voided" above.
      throw new Error("unexpected decline outcome");
    }

    await withTenant({ clinicId: billingClinicId, actor: OVERAGE_ACTOR }, async (tx) => {
      await tx.db
        .update(overageInvoices)
        .set({
          status: "invoiced",
          stripeInvoiceId: charge.invoiceId,
          invoicedAt: now,
          error: null,
        })
        .where(eq(overageInvoices.id, claimed.row.id));
      await enqueueNotice(tx, "overage_invoiced", windowStartIso, {
        amountCents: claimed.amountCents,
        windowStart: windowStartIso,
        windowEnd: window.end.toISOString(),
        voiceMinutes: window.voiceUnits,
        chatConversationsCount: window.chatUnits,
        hostedInvoiceUrl: charge.hostedInvoiceUrl,
      });
    });
    return {
      status: "invoiced",
      amountCents: claimed.amountCents,
      hostedInvoiceUrl: charge.hostedInvoiceUrl,
    };
  } catch (error) {
    const reason = stripeErrorCode(error);
    log.warn("annual overage not invoiced", {
      clinicId: billingClinicId,
      windowStart: windowStartIso,
      code: reason,
    });
    await withTenant({ clinicId: billingClinicId, actor: OVERAGE_ACTOR }, (tx) =>
      tx.db
        .update(overageInvoices)
        .set({ status: "failed", error: reason })
        .where(eq(overageInvoices.id, claimed.row.id)),
    );
    await notifyOps("overage_invoice_failed", {
      clinicId: billingClinicId,
      windowStart: windowStartIso,
    });
    return { status: "failed", reason };
  }
}

/** Billing clinics, by id only, through the SECURITY DEFINER overview. */
async function billingClinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string; billing_clinic_id: string | null }>(
    sql`select id, billing_clinic_id from app_clinics_overview()`,
  );
  return result.rows.filter((row) => row.billing_clinic_id === null).map((row) => row.id);
}

export type AnnualOverageSummary = {
  clinics: number;
  invoiced: number;
  skipped: number;
  failed: number;
};

/**
 * One pass over every started annual billing clinic: each closed window that
 * is not yet invoiced or skipped. Exported without the job wrapper so a test
 * can drive it at a pinned `now`.
 */
export async function invoiceAnnualOverage(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<AnnualOverageSummary> {
  const now = options.now ?? new Date();
  const summary: AnnualOverageSummary = { clinics: 0, invoiced: 0, skipped: 0, failed: 0 };
  if (OVERAGE_RATES_PROVISIONAL) return summary;

  for (const clinicId of await billingClinicIds()) {
    try {
      const due = await withTenant({ clinicId, actor: OVERAGE_ACTOR }, async (tx) => {
        const row = await getEntitlements(tx.db, clinicId);
        if (
          !row ||
          row.billingInterval !== "year" ||
          !row.stripeCustomerId ||
          !hasPlanStarted(row) ||
          row.status === "purged"
        ) {
          return [];
        }
        const windows = await closedOverageWindows(tx, row, now);
        if (windows.length === 0) return [];
        const done = await tx.db
          .select({ windowStart: overageInvoices.windowStart, status: overageInvoices.status })
          .from(overageInvoices)
          .where(eq(overageInvoices.clinicId, clinicId));
        const finished = new Set(
          done
            .filter((d) => d.status === "invoiced" || d.status === "skipped")
            .map((d) => d.windowStart.getTime()),
        );
        return windows.filter((window) => !finished.has(window.start.getTime()));
      });
      if (due.length === 0) continue;
      summary.clinics += 1;
      for (const window of due) {
        const result = await invoiceOverageWindow(clinicId, window, options);
        if (result.status === "invoiced") summary.invoiced += 1;
        else if (result.status === "skipped") summary.skipped += 1;
        else summary.failed += 1;
      }
    } catch (error) {
      // One clinic's failure must not stop the run for the rest.
      summary.failed += 1;
      log.warn("annual overage pass failed for a clinic", {
        clinicId,
        code: stripeErrorCode(error),
      });
    }
  }
  return summary;
}

/**
 * Retry one window now (R35's `retryOverageInvoice`): a `failed` window, or
 * one left `pending` by a crash, for a billing clinic. Anything already
 * invoiced or skipped is left as it is.
 */
export async function retryOverageWindow(
  billingClinicId: string,
  windowStart: Date,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<OverageWindowResult | { status: "refused"; message: string }> {
  const now = options.now ?? new Date();
  const found = await withTenant(
    { clinicId: billingClinicId, actor: OVERAGE_ACTOR },
    async (tx) => {
      const [ledger] = await tx.db
        .select()
        .from(overageInvoices)
        .where(
          and(
            eq(overageInvoices.clinicId, billingClinicId),
            eq(overageInvoices.windowStart, windowStart),
          ),
        )
        .limit(1);
      if (!ledger) return null;
      const row = await getEntitlements(tx.db, billingClinicId);
      const windows = row ? await closedOverageWindows(tx, row, now) : [];
      const window = windows.find((w) => w.start.getTime() === windowStart.getTime()) ?? {
        start: ledger.windowStart,
        end: ledger.windowEnd,
        voiceUnits: ledger.voiceUnits,
        chatUnits: ledger.chatUnits,
      };
      return { ledger, window };
    },
  );
  if (!found)
    return { status: "refused", message: "No overage invoice is on record for that month." };
  if (found.ledger.status !== "failed" && found.ledger.status !== "pending") {
    return {
      status: "refused",
      message:
        found.ledger.status === "invoiced"
          ? "That month's overage is already invoiced."
          : "That month had nothing to invoice.",
    };
  }
  return invoiceOverageWindow(billingClinicId, found.window, { ...options, now });
}

/**
 * The `annual-overage-invoice` job, daily at 05 UTC from the tick. Behind
 * runJob's switch and lock: one run a day, and the ledger makes a re-run a
 * no-op.
 */
export async function runAnnualOverageJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_ANNUAL_OVERAGE_INVOICE,
    async () => {
      if (OVERAGE_RATES_PROVISIONAL) return "Overage rates are provisional: nothing is invoiced.";
      const result = await invoiceAnnualOverage({ now, stripe: options.stripe });
      return (
        `Annual overage for ${result.clinics} clinics: ${result.invoiced} invoiced, ` +
        `${result.skipped} skipped, ${result.failed} failed.`
      );
    },
    now,
  );
}
