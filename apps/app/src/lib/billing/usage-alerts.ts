import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { BillingStatus, UsageMeter } from "@/db/schema";
import { JOB_USAGE_ALERTS, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { effectiveIncluded, getEntitlements } from "./entitlements";
import { enqueueNotice } from "./notices";
import {
  allowanceDedupeKey,
  openWindowAt,
  overageBlockCentsFor,
  usedOf,
  windowEndsOn,
} from "./usage";

/**
 * The 90% and 100% allowance emails (BD21, the product spec's "Usage alerts"
 * switch, Annex X L27): hourly, per meter per allowance window, on the
 * BILLING clinic, while the clinic's own switch (`usage_alerts_enabled`) is
 * on. The `usage-alerts` job row is the operator's switch for the whole job,
 * seeded off like every job.
 *
 * Only a window that is open now counts. The $0 placeholder period before the
 * plan starts opens no window, so it sends nothing (contracts §2), and a
 * monthly window that has ended but not yet been renewed is not the clinic's
 * allowance any more (R20). Each meter's allowance is effectiveIncluded, the
 * function recordUsage and the gate use (BD5), so a channel bought but not
 * yet billed is measured against its package's allowance and never reads as
 * 100% of zero.
 *
 * One email per threshold per meter per window: the dedupe key is
 * `<meter>:<windowStartIso>` (R22), so an hourly re-run, or a usage_80 and a
 * usage_100 for the same window, never repeats one. When the job first finds
 * a meter already past 100% only `usage_100` goes: the clinic needs the one
 * that is true now, not a stale 90% beside it.
 *
 * The first alert goes at USAGE_ALERT_PERCENT of the allowance: 90% since the
 * pricing sheet of 13 October 2026 ("When you use 90% of your included
 * amount, we send you a short email"), 80% before it. Its notice kind is
 * still `usage_80`: the name is a key in two CHECK constraints
 * (billing_notices and report_deliveries), in the email registry and in rows
 * already queued, and renaming it would buy a migration and nothing a clinic
 * sees. Its template (email/templates/usage_alert.ts) prints
 * USAGE_ALERT_PERCENT, never a number read off the kind's name.
 *
 * `allowance_fallback` is not this job's: recordUsage and the gate queue it
 * the moment "Stop and fall back" engages, whatever either switch says.
 */

const ACTOR = { type: "service", serviceName: "usage-alerts" } as const;
const METERS: readonly UsageMeter[] = ["voice_minutes", "chat_conversations"];

/** Statuses whose clinics are being served, so their usage can still grow. */
const SERVED: ReadonlySet<BillingStatus> = new Set(["active", "past_due", "canceling"]);

export type UsageAlertsResult = {
  clinicsConsidered: number;
  queued: number;
  failures: { clinicId: string; reason: string }[];
};

/**
 * Billing clinics only, through the scheduler's definer (app_clinics_overview,
 * the one listing the runtime role may make without a tenant): a location's
 * usage is counted on its billing clinic, which is where the alert goes.
 */
async function billingClinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where billing_clinic_id is null`,
  );
  return result.rows.map((row) => row.id);
}

/**
 * One pass, exported without the job wrapper so a test can drive it at a
 * chosen `now`. Each clinic is its own transaction, and one clinic's failure
 * is noted without stopping the rest.
 */
export async function queueUsageAlerts(now: Date = new Date()): Promise<UsageAlertsResult> {
  const ids = await billingClinicIds();
  const result: UsageAlertsResult = { clinicsConsidered: ids.length, queued: 0, failures: [] };

  for (const clinicId of ids) {
    try {
      result.queued += await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
        const row = await getEntitlements(tx.db, clinicId);
        if (!row || !row.usageAlertsEnabled || !SERVED.has(row.status)) return 0;
        const window = openWindowAt(row, now);
        if (!window) return 0;

        let queued = 0;
        for (const meter of METERS) {
          const included = effectiveIncluded(row, meter);
          if (included <= 0) continue;
          const used = usedOf(row, meter);
          const kind =
            used * 100 >= 100 * included
              ? "usage_100"
              : used * 100 >= USAGE_ALERT_PERCENT * included
                ? "usage_80"
                : null;
          if (!kind) continue;
          // The price of a started block of 100, never a per-unit rate:
          // overage is billed in blocks (6 October 2026), so that is the
          // number a clinic can check its next invoice against.
          const inserted = await enqueueNotice(tx, kind, allowanceDedupeKey(meter, window.start), {
            meter,
            used,
            included,
            windowEndsOn: windowEndsOn(window.end),
            overageMode: row.overageMode,
            blockRateCents: overageBlockCentsFor(row, meter),
          });
          if (inserted) queued += 1;
        }
        return queued;
      });
    } catch (error) {
      // The name and message only: a driver error can carry query parameters,
      // and this note ends up on the ops console.
      result.failures.push({
        clinicId,
        reason:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 200)
            : "Unknown error",
      });
    }
  }
  return result;
}

/** The `usage-alerts` job: hourly from the tick, behind its switch. */
export async function runUsageAlertsJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_USAGE_ALERTS,
    async () => {
      const result = await queueUsageAlerts(now);
      const failed = result.failures.length;
      return (
        `Checked ${result.clinicsConsidered} billing clinics: ${result.queued} allowance alerts queued` +
        (failed ? `, ${failed} failed` : "") +
        "."
      );
    },
    now,
  );
}
