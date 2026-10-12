import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { purgeClinic, type PurgeResult } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";

import { JOB_RETENTION_PURGE, runJob } from "./jobs";

/**
 * The nightly retention purge — every clinic, on its own two clocks.
 *
 * Same shape as the billing sweep: tenants are listed through the
 * SECURITY DEFINER overview function, each clinic gets its own tenant
 * transaction, one clinic's failure never stops the rest, and the whole
 * thing ships switched OFF (drizzle/0032) until an operator turns it on.
 *
 * Nightly, because a retention window measured in days does not need to be
 * enforced to the minute, and a run that catches up after an outage deletes
 * exactly what a run on time would have.
 */

const PURGE_ACTOR = { type: "service", serviceName: "retention-purge" } as const;

export type RetentionSweepResult = {
  clinicsConsidered: number;
  results: PurgeResult[];
  failures: { clinicId: string; reason: string }[];
};

async function clinicsForPurge(): Promise<{ id: string }[]> {
  const result = await unsafeDb.execute<{ id: string }>(sql`select id from app_clinics_overview()`);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return rows as { id: string }[];
}

export async function sweepRetention(now: Date = new Date()): Promise<RetentionSweepResult> {
  const clinicList = await clinicsForPurge();
  const out: RetentionSweepResult = { clinicsConsidered: clinicList.length, results: [], failures: [] };

  for (const clinic of clinicList) {
    try {
      const result = await withTenant({ clinicId: clinic.id, actor: PURGE_ACTOR }, (tx) =>
        purgeClinic(tx, now),
      );
      out.results.push(result);
    } catch (error) {
      out.failures.push({
        clinicId: clinic.id,
        reason:
          error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "Unknown error",
      });
    }
  }
  return out;
}

export async function runRetentionPurgeJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_RETENTION_PURGE,
    async () => {
      const sweep = await sweepRetention(now);
      const totals = sweep.results.reduce(
        (acc, r) => ({
          media: acc.media + r.mediaCleared,
          rows:
            acc.rows +
            r.bookingRequestsDeleted +
            r.transactionsDeleted +
            r.appointmentsDeleted +
            r.conversationsDeleted +
            r.contactsDeleted +
            r.draftsDeleted +
            r.webhookEventsDeleted +
            r.slotHoldsDeleted,
          skipped: acc.skipped + (r.skipped ? 1 : 0),
        }),
        { media: 0, rows: 0, skipped: 0 },
      );
      return (
        `Purged ${sweep.clinicsConsidered} clinics: ${totals.media} media references cleared, ` +
        `${totals.rows} rows deleted` +
        (totals.skipped ? `, ${totals.skipped} skipped (sync running)` : "") +
        (sweep.failures.length ? `, ${sweep.failures.length} failed` : "") +
        "."
      );
    },
    now,
  );
}
