import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { notifyOps } from "@/lib/ops/notify";
import { purgeClinic, purgeIsPromised, type PurgeResult } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";

import { JOB_RETENTION_PURGE, runWideningJob } from "./jobs";

/**
 * The nightly retention purge — every clinic, on its own two clocks.
 *
 * Same shape as the billing sweep: tenants are listed through the
 * SECURITY DEFINER overview function, each clinic gets its own tenant
 * transaction, and one clinic's failure never stops the rest.
 *
 * Which clinics: the job ships switched OFF (drizzle/0032), but its switch
 * widens the run rather than starting it. A clinic whose agreement in effect
 * states the purge's periods, read from that version's own text (BAA 1.3.0
 * and the DPA today), is purged every night whatever the switch says
 * (purgeIsPromised; BAA 1.3.0 release gate 9). With the switch on, every
 * other clinic is purged too; the owner turns it on at the release of 1.3.0
 * (docs/handover.md).
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

/** Every clinic, with the version of the agreement it is on (app_agreement_in_effect), read outside any tenant. */
async function clinicsForPurge(): Promise<{ id: string; baa_version: string | null }[]> {
  const result = await unsafeDb.execute<{ id: string; baa_version: string | null }>(
    sql`select id, baa_version from app_clinics_overview()`,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return rows as { id: string; baa_version: string | null }[];
}

/**
 * Purge every clinic (the switch on), or only those whose agreement promises
 * the purge (`onlyPromised`, the switch off).
 */
export async function sweepRetention(
  now: Date = new Date(),
  options: { onlyPromised?: boolean } = {},
): Promise<RetentionSweepResult> {
  const clinicList = (await clinicsForPurge()).filter(
    (c) => !options.onlyPromised || purgeIsPromised(c.baa_version),
  );
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
      // A failed purge keeps records past their periods, so a person hears
      // of it: the clinic's id and the step, never the error's text, which
      // can quote a row (lib/ops/notify.ts).
      await notifyOps("retention_purge_failed", { clinicId: clinic.id, phase: "clinic" });
    }
  }
  return out;
}

export async function runRetentionPurgeJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runWideningJob(
    JOB_RETENTION_PURGE,
    async (switchedOn) => {
      let sweep: RetentionSweepResult;
      try {
        sweep = await sweepRetention(now, { onlyPromised: !switchedOn });
      } catch (error) {
        await notifyOps("retention_purge_failed", { phase: "run" });
        throw error;
      }
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
            r.chatThreadsDeleted +
            r.slotHoldsDeleted +
            r.depositsDeleted,
          skipped: acc.skipped + (r.skipped ? 1 : 0),
        }),
        { media: 0, rows: 0, skipped: 0 },
      );
      return (
        (switchedOn
          ? ""
          : "Switched off: only the clinics whose agreement states the purge's periods (BAA 1.3.0, the DPA). ") +
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
