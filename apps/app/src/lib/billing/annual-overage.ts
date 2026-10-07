import {
  getPlan,
  meteredPriceLookupKey,
  METERS,
  OVERAGE_BLOCK_UNITS,
  overageBlockCents,
  overageBlocks,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
} from "@healdesk/catalog";
import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
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
import type { OneOffItem } from "./stripe-actions";
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
 * Overage is billed per STARTED block of 100 units since 6 October 2026
 * (catalog OVERAGE_BLOCK_UNITS), so each meter's month total becomes
 * `overageBlocks(units)` blocks at the block price: 1 to 100 minutes over is
 * one block of $80, 101 is two. That is the sum a monthly plan's metered
 * price makes at the end of its period (its `transform_quantity` divides the
 * total by 100 and rounds up), so an annual clinic pays exactly what a
 * monthly one would for the same month. The blocks are counted on the
 * month's total, never per call or per row: two 60-minute overruns are 120
 * minutes, two blocks, not one each.
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
 *
 * A clinic that LEAVES annual billing (a plan change to monthly, review fix
 * of 7 October 2026) is billed by the meters from then on, and this job
 * would stop looking at it with its annual months still owed: the one in
 * progress, which now ends at the switch, and any closed since the last
 * run. The plan change claims them here in the transaction that applies it
 * (`claimOverageOnLeavingAnnual`), and the job invoices a claimed window
 * whatever the clinic is billed by now.
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

/** The bought package's price for one block on a meter in whole cents, or 0 when it does not sell it. */
function blockCents(rateUsd: number): number {
  return rateUsd > 0 ? overageBlockCents(rateUsd) : 0;
}

/** "1 block of 100", "3 blocks of 100": what an invoice line's quantity counts. */
function blocksOf(blocks: number): string {
  return `${blocks} ${blocks === 1 ? "block" : "blocks"} of ${OVERAGE_BLOCK_UNITS}`;
}

type Claimed = {
  row: OverageInvoice;
  voiceBlockCents: number;
  chatBlockCents: number;
  /** Started blocks billed on each meter: 0 for a meter the bought package does not sell. */
  voiceBlocks: number;
  chatBlocks: number;
  amountCents: number;
};

/**
 * Claim a window's ledger row (step 1): insert it, or take over a `failed`
 * (or crashed `pending`) one with the amounts it was claimed with. `done`
 * when the window is already invoiced or skipped, or has nothing to bill.
 *
 * The amount is started blocks times the block price per meter, never units
 * times the per-unit rate. The ledger keeps the units it counted, and its
 * rate columns hold the price of one block, which is what each invoice item
 * charges per unit of its quantity: so `amount_cents` is always
 * `overageBlocks(voice_units) × voice_rate_cents` plus the same for chat.
 */
async function claimWindow(
  tx: TenantTx,
  plan: Plan,
  window: OverageWindow,
): Promise<Claimed | { done: OverageInvoice }> {
  const voiceBlockCents = blockCents(plan.overagePerVoiceMinuteUsd);
  const chatBlockCents = blockCents(plan.overagePerChatConversationUsd);
  const voiceBlocks = voiceBlockCents > 0 ? overageBlocks(window.voiceUnits) : 0;
  const chatBlocks = chatBlockCents > 0 ? overageBlocks(window.chatUnits) : 0;
  const amountCents = voiceBlocks * voiceBlockCents + chatBlocks * chatBlockCents;
  const claimed = { voiceBlockCents, chatBlockCents, voiceBlocks, chatBlocks, amountCents };
  const values = {
    windowEnd: window.end,
    voiceUnits: window.voiceUnits,
    chatUnits: window.chatUnits,
    voiceRateCents: voiceBlockCents,
    chatRateCents: chatBlockCents,
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
    return inserted.status === "skipped" ? { done: inserted } : { row: inserted, ...claimed };
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
  // Taken over as it was claimed, never worked out again: a closed month's
  // units cannot grow, a plan change since must not re-price a past month,
  // and a month claimed as the clinic left annual billing has had its rows
  // handed over, so a fresh count would find nothing to bill.
  const [taken] = await tx.db
    .update(overageInvoices)
    .set({ status: existing.amountCents > 0 ? "pending" : "skipped", error: null })
    .where(eq(overageInvoices.id, existing.id))
    .returning();
  return taken!.status === "skipped" ? { done: taken! } : { row: taken!, ...claimedFrom(taken!) };
}

/** What a ledger row was claimed for: its block prices, the started blocks, the amount. */
function claimedFrom(row: OverageInvoice): Omit<Claimed, "row"> {
  return {
    voiceBlockCents: row.voiceRateCents,
    chatBlockCents: row.chatRateCents,
    voiceBlocks: row.voiceRateCents > 0 ? overageBlocks(row.voiceUnits) : 0,
    chatBlocks: row.chatRateCents > 0 ? overageBlocks(row.chatUnits) : 0,
    amountCents: row.amountCents,
  };
}

/**
 * The per-unit rate a block price stands for, to find the meter's price: the
 * claimed block price decides the product an invoice line is booked to,
 * because the package bought now may not sell that meter any more.
 */
function rateOfBlock(blockCents: number): number {
  return blockCents / (OVERAGE_BLOCK_UNITS * 100);
}

/**
 * Hand a clinic's annual months over to this invoice as it leaves annual
 * billing (review fix of 7 October 2026). `tx` is the billing clinic's
 * transaction that applies the plan change, after the allowance window has
 * re-opened at the switch, so the annual month in progress is closed and
 * ends there.
 *
 *   1. Every closed window not yet invoiced or skipped is claimed in the
 *      ledger as it stands: its units, at the block prices of `plan`, the
 *      package bought while those months ran.
 *   2. Every unreported row past the allowance from before the switch is
 *      marked as handed to this invoice (`stripe_reported_at`, with
 *      `stripe_report_error` ANNUAL_INVOICE_HANDOVER): the monthly meter
 *      reporter takes over this clinic now, and would otherwise send those
 *      rows to a meter (Stripe would bill them a second time, or, dated
 *      before the metered items existed, not at all), including the rows of
 *      months this job has already invoiced, which it never marks.
 *
 * Both in the caller's transaction, so the reporter, which reads the
 * interval first, never sees the clinic as monthly with those rows still
 * unreported. The daily job invoices the claimed windows. Returns how many
 * it claimed.
 */
export async function claimOverageOnLeavingAnnual(
  tx: TenantTx,
  input: { switchAt: Date; plan: Plan; now: Date },
): Promise<number> {
  const row = await getEntitlements(tx.db, tx.clinicId);
  if (!row) return 0;
  // Stripe dates the switch, a moment after the caller's clock was read: the
  // month that ends there counts as closed by then.
  const at = new Date(Math.max(input.now.getTime(), input.switchAt.getTime()));
  const done = await tx.db
    .select({ windowStart: overageInvoices.windowStart, status: overageInvoices.status })
    .from(overageInvoices)
    .where(eq(overageInvoices.clinicId, tx.clinicId));
  const finished = new Set(
    done
      .filter((d) => d.status === "invoiced" || d.status === "skipped")
      .map((d) => d.windowStart.getTime()),
  );
  let claimed = 0;
  for (const window of await closedOverageWindows(tx, row, at)) {
    if (window.start.getTime() >= input.switchAt.getTime()) continue;
    if (finished.has(window.start.getTime())) continue;
    const result = await claimWindow(tx, input.plan, window);
    if (!("done" in result)) claimed += 1;
  }
  await tx.db
    .update(usageEvents)
    .set({ stripeReportedAt: at, stripeReportError: ANNUAL_INVOICE_HANDOVER })
    .where(
      and(
        eq(usageEvents.clinicId, tx.clinicId),
        lt(usageEvents.windowStart, input.switchAt),
        gt(usageEvents.overAllowance, 0),
        isNull(usageEvents.stripeReportedAt),
      ),
    );
  return claimed;
}

/**
 * The `stripe_report_error` code on a usage row handed to the annual overage
 * invoice when its clinic left annual billing: never sent to a meter, and
 * not an error. A closed code, like every other value of that column.
 */
export const ANNUAL_INVOICE_HANDOVER = "annual_invoice";

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
      return { claimed, row };
    },
  );
  if (!claim) return { status: "failed", reason: "no_billing_account" };
  if ("done" in claim.claimed) {
    return {
      status: "skipped",
      reason: claim.claimed.done.status === "skipped" ? "zero_units" : "already_done",
    };
  }
  const { claimed, row } = claim;
  const windowStartIso = window.start.toISOString();
  // The invoice and the email describe the month as the ledger claimed it,
  // like the amount: a count made again later (the console's retry) can
  // differ once a clinic has left annual billing and its rows were handed over.
  const ledger = claimed.row;

  try {
    // Loaded here, not imported: stripe-actions imports this module (a plan
    // change leaving annual billing claims its months here), and a static
    // import back would make the two a cycle.
    const { chargeOneOffInvoice } = await import("./stripe-actions");
    const stripe = options.stripe ?? getStripe();
    const items: OneOffItem[] = [];
    const days = `${windowStartIso.slice(0, 10)} to ${ledger.windowEnd.toISOString().slice(0, 10)}`;
    // One item per meter: the blocks as its quantity, at the price of one
    // block, on the meter's own product so the line reads like the monthly
    // plans' metered line. The description is generic: a meter, the dates
    // and a count, nothing about who called or what was asked.
    if (claimed.voiceBlocks > 0) {
      const price = await priceForLookupKey(
        meteredPriceLookupKey("voiceMinutes", rateOfBlock(claimed.voiceBlockCents)),
        { stripe },
      );
      items.push({
        product: price.productId,
        unitAmountCents: claimed.voiceBlockCents,
        quantity: claimed.voiceBlocks,
        description: `${METERS.voiceMinutes.displayName}, ${days}: ${blocksOf(claimed.voiceBlocks)}`,
      });
    }
    if (claimed.chatBlocks > 0) {
      const price = await priceForLookupKey(
        meteredPriceLookupKey("chatConversations", rateOfBlock(claimed.chatBlockCents)),
        { stripe },
      );
      items.push({
        product: price.productId,
        unitAmountCents: claimed.chatBlockCents,
        quantity: claimed.chatBlocks,
        description: `${METERS.chatConversations.displayName}, ${days}: ${blocksOf(claimed.chatBlocks)}`,
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
        windowEnd: ledger.windowEnd.toISOString(),
        voiceMinutes: ledger.voiceUnits,
        chatConversationsCount: ledger.chatUnits,
        voiceBlocksCount: claimed.voiceBlocks,
        chatBlocksCount: claimed.chatBlocks,
        voiceBlockRateCents: claimed.voiceBlockCents,
        chatBlockRateCents: claimed.chatBlockCents,
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
 * One pass over every started billing clinic: for an annual one, each closed
 * window that is not yet invoiced or skipped; for any, a window claimed in
 * the ledger and not yet invoiced (pending, or failed last time), which is
 * how the months of a clinic that has left annual billing are still billed.
 * Exported without the job wrapper so a test can drive it at a pinned `now`.
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
        if (!row || !row.stripeCustomerId || !hasPlanStarted(row) || row.status === "purged") {
          return [];
        }
        const ledger = await tx.db
          .select()
          .from(overageInvoices)
          .where(eq(overageInvoices.clinicId, clinicId));
        // Claimed and not yet invoiced: this job's, whatever the clinic is
        // billed by now (a month claimed as it left annual billing).
        const claimed: OverageWindow[] = ledger
          .filter((l) => l.status === "pending" || l.status === "failed")
          .map((l) => ({
            start: l.windowStart,
            end: l.windowEnd,
            voiceUnits: l.voiceUnits,
            chatUnits: l.chatUnits,
          }));
        if (row.billingInterval !== "year") return claimed;
        const known = new Set(ledger.map((l) => l.windowStart.getTime()));
        const closed = (await closedOverageWindows(tx, row, now)).filter(
          (window) => !known.has(window.start.getTime()),
        );
        return [...claimed, ...closed].sort((a, b) => a.start.getTime() - b.start.getTime());
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
