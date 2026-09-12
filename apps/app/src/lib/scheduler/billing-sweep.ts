import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { getEntitlements, rollAllowancePeriod } from "@/lib/billing/entitlements";
import { recordBillingNote, transition } from "@/lib/billing/state-machine";
import { withTenant } from "@/lib/tenant";

import { JOB_BILLING_SWEEP, runJob } from "./jobs";

/**
 * The billing sweep: the two clocks Stripe does not run for us.
 *
 * Everything else about a clinic's paid life is driven by a Stripe event
 * (lib/billing/events.ts). Two things are not, because Stripe has no event
 * for "time passed":
 *
 *   1. Grace expiry. A failed renewal moves the clinic to `past_due` and opens
 *      a GRACE_DAYS window (events.ts → onPaymentFailed). The Dashboard is
 *      set to "on payment failure: do not cancel" (docs/handover.md), so Stripe
 *      keeps retrying and never ends the subscription; if nothing here closed
 *      the window, a clinic whose card failed would keep full service for as
 *      long as Stripe kept trying. This job moves `past_due → suspended` once
 *      `grace_ends_at` has passed. A renewal paid later lifts it (events.ts).
 *
 *   2. Annual allowances. An annual clinic is invoiced once a year for an
 *      allowance sold per month, and there is no monthly invoice to reset the
 *      counters on. `rollAllowancePeriod()` (lib/billing/entitlements.ts)
 *      advances the window a month at a time; this job is what calls it.
 *
 * Hourly is the intended cadence — nothing here is time-critical to the
 * minute, and a sweep that runs after an outage catches up on its own: a
 * grace window that expired during the outage is still expired, and the roll
 * skips as many months as it has to.
 *
 * ⚠️ Like every job, this ships switched OFF (drizzle/0030) and is enabled
 * from the ops console. Until it is on, `past_due` clinics are never suspended
 * by the app — the handover says so in the same breath as the "do not cancel"
 * instruction, because that setting is only safe with this job running.
 */

const SWEEP_ACTOR = { type: "service", serviceName: "billing-sweep" } as const;

export type SweepResult = {
  clinicsConsidered: number;
  /** Clinic ids moved past_due → suspended this run. */
  suspended: string[];
  /** Clinic ids whose annual allowance window advanced this run. */
  rolled: string[];
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
    failures: [],
  };

  for (const clinic of clinics) {
    try {
      await withTenant(
        { clinicId: clinic.id, actor: SWEEP_ACTOR },
        async (tx) => {
          const row = await getEntitlements(tx.db, tx.clinicId);
          // A demo, or a clinic provisioned before entitlements existed:
          // nothing to sweep.
          if (!row) return;

          if (
            row.status === "past_due" &&
            row.graceEndsAt !== null &&
            row.graceEndsAt.getTime() <= now.getTime()
          ) {
            await transition(tx, "suspended", {
              actor: "system",
              reason: "grace_expired",
            });
            result.suspended.push(tx.clinicId);
          }

          const roll = await rollAllowancePeriod(tx.db, tx.clinicId, now);
          if (roll.rolled > 0) {
            // In the history, so "why did my minutes reset on the 14th" has
            // an answer next to every other billing question.
            await recordBillingNote(tx, {
              actor: "system",
              reason: "allowance_rolled",
            });
            result.rolled.push(tx.clinicId);
          }
        },
      );
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

export async function runBillingSweepJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();

  return runJob(
    JOB_BILLING_SWEEP,
    async () => {
      const result = await sweepBilling(now);
      const failed = result.failures.length;
      return (
        `Swept ${result.clinicsConsidered} clinics: ` +
        `${result.suspended.length} suspended, ${result.rolled.length} allowances rolled` +
        (failed ? `, ${failed} failed` : "") +
        "."
      );
    },
    now,
  );
}
