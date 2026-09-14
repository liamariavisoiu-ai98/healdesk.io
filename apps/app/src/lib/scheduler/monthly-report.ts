import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { previousMonth } from "@/lib/attribution/period";
import { buildMonthlyReport } from "@/lib/attribution/report";
import type { MonthlyReport } from "@/lib/attribution/report";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { deliverReport, type EmailTransport } from "@/lib/reporting/deliver";
import { claimDelivery, deliveredAlready, listRecipients, recordDelivery } from "@/lib/reporting/recipients";
import { renderMonthlyReport, type RenderedReport } from "@/lib/reporting/render";
import { withTenant } from "@/lib/tenant";

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
  options: { now?: Date; send?: boolean; transport?: EmailTransport } = {},
) {
  const now = options.now ?? new Date();

  return runJob(
    JOB_MONTHLY_REPORT,
    async () => {
      if (!options.send) {
        const result = await buildAllReports(now);
        const failed = result.failures.length;
        return (
          `Built ${result.reportsBuilt}/${result.clinicsConsidered} reports` +
          (failed ? `, ${failed} failed` : "") +
          ". Delivery not requested."
        );
      }
      const sent = await sendDueReports(now, options.transport);
      return (
        `Considered ${sent.considered} clinics: ${sent.sent} sent, ${sent.skipped} skipped` +
        (sent.failed ? `, ${sent.failed} failed` : "") +
        "."
      );
    },
    now,
  );
}

export type SendRunResult = { considered: number; sent: number; skipped: number; failed: number };

/**
 * The send path: build → render → assertNoPhiInReport → deliver, per clinic
 * and per recipient, with the ledger claimed before the transport is called.
 *
 * Who is due: a production clinic that went live before the month being
 * reported on ended, with at least one recipient, in whose own timezone the
 * 1st has arrived, and with nothing already sent for that period. Every
 * other clinic is skipped in silence — a synthetic clinic never gets mail.
 */
export async function sendDueReports(now: Date, transport?: EmailTransport): Promise<SendRunResult> {
  const result: SendRunResult = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  const actor = { type: "service", serviceName: "monthly-report" } as const;

  for (const clinic of await listClinics()) {
    result.considered += 1;
    if (clinic.dataClassification !== "production" || !clinic.wentLiveAt || clinic.destroyedAt) {
      result.skipped += 1;
      continue;
    }
    const period = previousMonth(now, clinic.timezone);
    // The clinic must have been live for the whole reported month to get a
    // report about it; the first one arrives after the first full month.
    if (clinic.wentLiveAt.getTime() > period.start.getTime()) {
      result.skipped += 1;
      continue;
    }

    const recipients = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
      if (await deliveredAlready(tx, { kind: "monthly", periodKey: period.key })) return [];
      return listRecipients(tx);
    });
    if (recipients.length === 0) {
      result.skipped += 1;
      continue;
    }

    let rendered: RenderedReport;
    try {
      rendered = renderMonthlyReport(await buildMonthlyReport(clinic.id, { now, actor }));
    } catch (error) {
      result.failed += 1;
      log.error("monthly report could not be built", { clinicId: clinic.id, error: describeError(error) });
      continue;
    }

    for (const recipient of recipients) {
      const claim = await withTenant({ clinicId: clinic.id, actor }, (tx) =>
        claimDelivery(tx, { kind: "monthly", periodKey: period.key, recipient: recipient.email }),
      );
      if (!claim) continue; // another run owns this slot

      const outcome = await deliverReport(
        { to: recipient.email, clinicId: clinic.id, clinicName: clinic.name },
        rendered,
        transport,
      );
      await withTenant({ clinicId: clinic.id, actor }, (tx) =>
        recordDelivery(
          tx,
          claim,
          outcome.status === "sent"
            ? { status: "sent", messageId: outcome.messageId }
            : { status: outcome.status, reason: outcome.reason },
        ),
      );
      if (outcome.status === "sent") result.sent += 1;
      else if (outcome.status === "failed") result.failed += 1;
      else result.skipped += 1;
    }
  }
  return result;
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
