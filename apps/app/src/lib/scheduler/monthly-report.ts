import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { buildMonthlyReport } from "@/lib/attribution/report";
import type { MonthlyReport } from "@/lib/attribution/report";

import { JOB_MONTHLY_REPORT, runJob } from "./jobs";

/**
 * The monthly report job.
 *
 * Builds a report per clinic for the month that has just ended, in that
 * clinic's own timezone. Sending is NOT wired up yet — that needs SES and a
 * verified sending domain (Phase 8). Until then the job builds and counts, so
 * the enumeration, tenant scoping and audit trail are all exercised before any
 * mail can possibly go out.
 *
 * ⚠️ This job is switched OFF until ops enables it from the console. There are
 * no tenants yet, and a report job that runs against an empty or half-configured
 * estate produces either nothing or something embarrassing.
 */

export type ReportRunResult = {
  clinicsConsidered: number;
  reportsBuilt: number;
  failures: { clinicId: string; reason: string }[];
  reports: MonthlyReport[];
};

/**
 * Tenant listing via the SECURITY DEFINER function from
 * drizzle/0008_scheduler_enumeration.sql.
 *
 * The runtime role genuinely cannot do this with a plain SELECT — with no
 * tenant set, `clinics` returns nothing. The function is the whole exception,
 * and it returns three non-PHI columns: everything real still goes through
 * withTenant().
 */
async function clinicsForScheduler(): Promise<
  { id: string; name: string; timezone: string }[]
> {
  const result = await unsafeDb.execute<{
    id: string;
    name: string;
    timezone: string;
  }>(sql`select id, name, timezone from app_clinics_overview()`);

  // node-postgres returns { rows }, but drizzle's execute() shape varies by
  // driver version; normalise rather than assume.
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return rows as { id: string; name: string; timezone: string }[];
}

export async function runMonthlyReportJob(
  options: { now?: Date; send?: boolean } = {},
) {
  const now = options.now ?? new Date();

  return runJob(
    JOB_MONTHLY_REPORT,
    async () => {
      const result = await buildAllReports(now);

      if (options.send) {
        // Deliberately unreachable for now. Wiring delivery before the
        // aggregate-only shape and the suppression rules are verified end to
        // end is how PHI ends up in an inbox.
        throw new Error(
          "Report delivery is not implemented. See docs/launch-plan.md, Phase 8.",
        );
      }

      const failed = result.failures.length;
      return (
        `Built ${result.reportsBuilt}/${result.clinicsConsidered} reports` +
        (failed ? `, ${failed} failed` : "") +
        ". Delivery not enabled."
      );
    },
    now,
  );
}

export async function buildAllReports(now: Date): Promise<ReportRunResult> {
  const clinics = await clinicsForScheduler();
  const reports: MonthlyReport[] = [];
  const failures: { clinicId: string; reason: string }[] = [];

  for (const clinic of clinics) {
    try {
      // No `within`, so buildMonthlyReport reports on the month that just
      // ended in this clinic's timezone — which, on the 1st, is not the same
      // month for all of them. `now` is threaded through so a test can pin it.
      reports.push(await buildMonthlyReport(clinic.id, { now }));
    } catch (error) {
      // One clinic's bad data must not stop the other ninety-nine.
      failures.push({
        clinicId: clinic.id,
        reason: error instanceof Error ? error.message.slice(0, 200) : "Unknown",
      });
    }
  }

  return {
    clinicsConsidered: clinics.length,
    reportsBuilt: reports.length,
    failures,
    reports,
  };
}
