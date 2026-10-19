import { and, gt, isNotNull, isNull, lte } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents } from "@/db/schema";
import { watchVendorAgreements } from "@/lib/compliance/vendor-coverage";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { replyByDay, replyByPassed } from "@/lib/reply-by";
import { JOB_OPS_WATCH, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";

import { listSupportRequests } from "./support-replies";

/**
 * The ops watch (WP5): the notifyOps raisers for promises with a clock on
 * them (Annex X5's I1 list), behind the `ops-watch` switch.
 *
 *   - `paid_intent_without_clinic`: a purchase whose paid first invoice
 *     reached this host (checkout_intents.paid_seen_at, stamped by
 *     /api/provision before provisioning runs) and has no account ten
 *     minutes later, while nothing has refused it. Once per purchase. Why
 *     the relay and not a signed call from apps/web is in
 *     lib/checkout/dead-letter.ts.
 *   - `provisioning_follow_up_past_due`: B3 told the buyer "we'll email your
 *     sign-in link by {day}" (at a refusal or a dead letter, which both set
 *     provision_failed_at), the day has passed in New York, and there is
 *     still no account. Once per purchase. The account arriving is the
 *     follow-up (B1 carries the sign-in link); an order ops settles another
 *     way is told once and then left alone.
 *   - `support_reply_past_due`: L25's day has passed with no reply marked
 *     (lib/ops/support-replies.ts). Once per request. Hourly only: it reads
 *     every clinic's outbox.
 *   - `vendor_agreement_expiring` and `vendor_agreement_lapsed`: a vendor's
 *     business associate agreement 30 or 7 days from its recorded expiry,
 *     or past it, which stops AYA where that vendor serves
 *     (lib/compliance/vendor-coverage.ts). Once per vendor, phase and expiry.
 *     Every run, as the purchases are: the platform's table is a few rows.
 *
 * Ids only: a purchase's ref travels as `requestId`, never the buyer.
 * notifyOpsOnce never throws, and keeps each alert to one email, ever, in the
 * ops log shared by every process.
 */

/** How long a paid purchase may wait for its account before ops hears (Annex X5). */
export const PAID_WITHOUT_CLINIC_AFTER_MS = 10 * 60_000;
/** How far back the purchase checks look; each alert is once-ever anyway. */
const PURCHASE_LOOKBACK_MS = 60 * 24 * 60 * 60_000;

export type PurchaseWatch = { paidWithoutClinic: number; followUpsPastDue: number };

export async function watchPurchases(now: Date = new Date()): Promise<PurchaseWatch> {
  const since = new Date(now.getTime() - PURCHASE_LOOKBACK_MS);

  const waiting = await unsafeDb
    .select({ ref: checkoutIntents.ref, failures: checkoutIntents.provisionFailures })
    .from(checkoutIntents)
    .where(
      and(
        isNotNull(checkoutIntents.paidSeenAt),
        lte(checkoutIntents.paidSeenAt, new Date(now.getTime() - PAID_WITHOUT_CLINIC_AFTER_MS)),
        gt(checkoutIntents.paidSeenAt, since),
        isNull(checkoutIntents.consumedAt),
        // A refusal or a dead letter has told ops already, and B3 the buyer.
        isNull(checkoutIntents.provisionFailedAt),
      ),
    );
  for (const intent of waiting) {
    await notifyOpsOnce("paid_intent_without_clinic", {
      requestId: intent.ref,
      attempts: intent.failures,
    });
  }

  const promised = await unsafeDb
    .select({ ref: checkoutIntents.ref, failedAt: checkoutIntents.provisionFailedAt })
    .from(checkoutIntents)
    .where(
      and(
        isNotNull(checkoutIntents.provisionFailedAt),
        gt(checkoutIntents.provisionFailedAt, since),
        isNull(checkoutIntents.consumedAt),
      ),
    );
  let followUpsPastDue = 0;
  for (const intent of promised) {
    // B3's day, computed exactly as B3 computed it (lib/checkout/order-delayed.ts).
    if (!intent.failedAt || !replyByPassed(replyByDay(intent.failedAt), now)) continue;
    followUpsPastDue += 1;
    await notifyOpsOnce("provisioning_follow_up_past_due", { requestId: intent.ref });
  }

  return { paidWithoutClinic: waiting.length, followUpsPastDue };
}

export type SupportWatch = { pastDue: number; failures: number };

export async function watchSupportReplies(now: Date = new Date()): Promise<SupportWatch> {
  const { rows, failures } = await listSupportRequests(now);
  const due = rows.filter((row) => row.pastDue);
  for (const row of due) {
    await notifyOpsOnce("support_reply_past_due", {
      clinicId: row.clinicId,
      requestId: row.requestId,
    });
  }
  return { pastDue: due.length, failures };
}

/**
 * One run, behind the `ops-watch` switch. `supportReplies` is the tick's:
 * the minute's run checks only the purchases, which are one small table.
 */
export async function runOpsWatchJob(
  options: { now?: Date; supportReplies?: boolean } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_OPS_WATCH,
    async () => {
      const purchases = await watchPurchases(now);
      // Every run: a lapse stops AYA at once, so ops hears of it within the minute.
      const vendors = await watchVendorAgreements(unsafeDb, now);
      const notes = [
        `${purchases.paidWithoutClinic} paid without an account`,
        `${purchases.followUpsPastDue} order follow-ups past due`,
        `${vendors.expiring} vendor agreements expiring, ${vendors.lapsed} lapsed`,
      ];
      if (options.supportReplies) {
        const support = await watchSupportReplies(now);
        notes.push(`${support.pastDue} support replies past due`);
        if (support.failures > 0) {
          throw new Error(`${notes.join(", ")}; ${support.failures} clinics unreadable.`);
        }
      }
      return `${notes.join(", ")}.`;
    },
    now,
  );
}
