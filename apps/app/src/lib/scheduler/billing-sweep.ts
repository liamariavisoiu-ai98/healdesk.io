import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { Entitlements } from "@/db/schema";
import { getEntitlementsForUpdate, rollAllowancePeriod } from "@/lib/billing/entitlements";
import { emailLink, queueSuspendedNotice } from "@/lib/billing/events";
import { deliverCriticalAfterCommit, enqueueNotice } from "@/lib/billing/notices";
import { recordBillingNote, transition } from "@/lib/billing/state-machine";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { JOB_BILLING_SWEEP, runJob } from "./jobs";

/**
 * The billing sweep: the two clocks Stripe does not run for us.
 *
 * Everything else about a clinic's paid life is driven by a Stripe event
 * (lib/billing/events.ts). Two things are not, because Stripe has no event
 * for "time passed":
 *
 *   1. Grace expiry. A failed renewal moves the clinic to `past_due` and opens
 *      a GRACE_DAYS window (events.ts → onInvoiceUnpaid). The Dashboard is
 *      set to "on payment failure: do not cancel" (docs/handover.md), so Stripe
 *      keeps retrying and never ends the subscription; if nothing here closed
 *      the window, a clinic whose card failed would keep full service for as
 *      long as Stripe kept trying. This job moves the clinic to `suspended`
 *      once `grace_ends_at` has passed, and tells it (`suspended`, critical,
 *      delivered as soon as the clinic's transaction commits). A clinic
 *      serving out a cancelled period (`canceling`) is suspended the same way
 *      (R21): a scheduled end is no licence to keep answering unpaid. A day
 *      before that happens it is warned once (`grace_ending`, BD18). A payment
 *      made later lifts it (events.ts, R10).
 *
 *   2. Annual allowances. An annual clinic is invoiced once a year for an
 *      allowance sold per month, and there is no monthly invoice to reset the
 *      counters on. `rollAllowancePeriod()` (lib/billing/entitlements.ts)
 *      advances the window a month at a time; this job is what calls it.
 *
 * Every decision is made from the entitlements row LOCKED for the clinic's
 * transaction (`SELECT … FOR UPDATE`, R21), never from a read taken before
 * it: a renewal paid between such a read and the suspension would otherwise
 * clear grace and return the clinic to `active`, and the sweep, holding its
 * stale `past_due`, would then suspend a clinic that had just paid (the
 * `active → suspended` edge exists, for chargebacks).
 *
 * Hourly is the intended cadence — nothing here is time-critical to the
 * minute, and a sweep that runs after an outage catches up on its own: a
 * grace window that expired during the outage is still expired, and the roll
 * skips as many months as it has to. A grace window that expired while the
 * sweep was off goes straight to suspension, without the warning a day
 * before it that there was no longer a day for.
 *
 * ⚠️ Like every job, this ships switched OFF (drizzle/0030) and is enabled
 * from the ops console. Until it is on, `past_due` clinics are never suspended
 * by the app — the handover says so in the same breath as the "do not cancel"
 * instruction, because that setting is only safe with this job running.
 */

const SWEEP_ACTOR = { type: "service", serviceName: "billing-sweep" } as const;

/** How long before grace ends the clinic is warned (BD18). */
export const GRACE_ENDING_NOTICE_MS = 24 * 60 * 60 * 1000;

export type SweepResult = {
  clinicsConsidered: number;
  /** Clinic ids moved to suspended this run. */
  suspended: string[];
  /** Clinic ids whose annual allowance window advanced this run. */
  rolled: string[];
  /** Clinic ids warned this run that grace ends within a day (`grace_ending`). */
  graceWarned: string[];
  failures: { clinicId: string; reason: string }[];
};

/**
 * Tenant listing via the SECURITY DEFINER function from
 * drizzle/0008_scheduler_enumeration.sql — the same three non-PHI columns
 * the report job reads, for the same reason: the runtime role cannot list
 * clinics with no tenant set, and the function is the whole exception.
 */
async function clinicsForSweep(): Promise<{ id: string }[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview()`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return rows as { id: string }[];
}

/** Grace that is running, or has run out, on a clinic it still applies to. */
function graceOf(row: Entitlements): Date | null {
  if (row.status !== "past_due" && row.status !== "canceling") return null;
  return row.graceEndsAt;
}

/**
 * One pass over every clinic. Exported without the job wrapper so a test can
 * drive it at a chosen `now` and so an operator can run it by hand; the
 * scheduled entry point is `runBillingSweepJob()`.
 */
export async function sweepBilling(now: Date = new Date()): Promise<SweepResult> {
  const clinics = await clinicsForSweep();
  const result: SweepResult = {
    clinicsConsidered: clinics.length,
    suspended: [],
    rolled: [],
    graceWarned: [],
    failures: [],
  };

  for (const clinic of clinics) {
    try {
      const outcome = await withTenant(
        { clinicId: clinic.id, actor: SWEEP_ACTOR },
        async (tx) => {
          // R21: locked before anything is decided; see the header.
          const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
          // A demo, a location (its billing clinic holds the row), or a clinic
          // provisioned before entitlements existed: nothing to sweep.
          if (!row) return null;

          let suspended = false;
          let warned = false;
          const grace = graceOf(row);
          if (grace && grace.getTime() <= now.getTime()) {
            await transition(tx, "suspended", {
              actor: "system",
              reason: "grace_expired",
            });
            await queueSuspendedNotice(tx, "grace_expired", grace.toISOString());
            suspended = true;
          } else if (grace && grace.getTime() - GRACE_ENDING_NOTICE_MS <= now.getTime()) {
            warned = await queueGraceEnding(tx, row, grace);
          }

          const roll = await rollAllowancePeriod(tx.db, tx.clinicId, now);
          if (roll.rolled > 0) {
            // In the history, so "why did my minutes reset on the 14th" has
            // an answer next to every other billing question.
            await recordBillingNote(tx, {
              actor: "system",
              reason: "allowance_rolled",
            });
          }
          return { suspended, warned, rolled: roll.rolled > 0 };
        },
      );
      if (!outcome) continue;
      if (outcome.suspended) {
        result.suspended.push(clinic.id);
        // Critical, and committed: the clinic hears now, not at the next
        // minute's queue run. Never throws; whatever it misses, the queue sends.
        await deliverCriticalAfterCommit(clinic.id);
      }
      if (outcome.warned) result.graceWarned.push(clinic.id);
      if (outcome.rolled) result.rolled.push(clinic.id);
    } catch (error) {
      // One clinic's failure must not stop the sweep for the rest. The reason
      // is the error's name and message only — a driver error can carry query
      // parameters, and this note ends up on the ops console.
      result.failures.push({
        clinicId: clinic.id,
        reason:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 200)
            : "Unknown error",
      });
    }
  }

  return result;
}

/**
 * `grace_ending` (BD18): once per grace window (`grace:<graceEndsAtIso>`,
 * R22), with the invoice owed and its pay page when one is recorded.
 */
async function queueGraceEnding(tx: TenantTx, row: Entitlements, grace: Date): Promise<boolean> {
  const iso = grace.toISOString();
  return enqueueNotice(tx, "grace_ending", `grace:${iso}`, {
    graceEndsAt: iso,
    hostedInvoiceUrl: emailLink(row.openInvoiceUrl, "grace_ending"),
    amountDueCents: row.openInvoiceAmountCents,
  });
}

export async function runBillingSweepJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();

  return runJob(
    JOB_BILLING_SWEEP,
    async () => {
      const result = await sweepBilling(now);
      const failed = result.failures.length;
      const warned = result.graceWarned.length;
      return (
        `Swept ${result.clinicsConsidered} clinics: ` +
        `${result.suspended.length} suspended, ${result.rolled.length} allowances rolled` +
        (warned ? `, ${warned} warned grace ends within a day` : "") +
        (failed ? `, ${failed} failed` : "") +
        "."
      );
    },
    now,
  );
}
