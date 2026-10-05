import { runAnnualOverageJob } from "@/lib/billing/annual-overage";
import { runBillingHousekeepingJob } from "@/lib/billing/housekeeping";
import { runBillingNoticesJob } from "@/lib/billing/notices";
import { runUsageAlertsJob } from "@/lib/billing/usage-alerts";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { expireLapsedRequests } from "@/lib/meta/booking-requests";
import { applyBookingRequirementDefaults } from "@/lib/onboarding/requirements";

import { runAnnualRenewalReminderJob } from "./annual-renewal-reminder";
import { runBillingSweepJob } from "./billing-sweep";
import { runConnectionHealthJob } from "./connection-health";
import { heartbeat } from "./jobs";
import { runMonthlyReportJob } from "./monthly-report";
import { runNightlySyncJob } from "./nightly-sync";
import { runOffboardingDestroyJob } from "./offboarding-destroy";
import { runRetentionPurgeJob } from "./retention-purge";
import { runWeeklyRecapJob } from "./weekly-recap";

/**
 * One tick of the clock: what runs at this hour.
 *
 * pg-boss's cron sends one job to QUEUE_TICK every hour; the worker calls
 * this. Everything here is idempotent by construction (each job records its
 * own run, the mailers keep ledgers, the sweeps are pure functions of the
 * clock), so a tick that runs twice does no harm and a tick that is missed
 * is caught up by the next one. Every job is still individually switched on
 * from the ops console; a disabled job returns {status: "disabled"} and
 * costs nothing.
 *
 * The hour gates are UTC and deliberately spread: the purge and the sync run
 * at night; the annual overage invoices at 05 and billing housekeeping at
 * 06; the mailers in the morning; the sweeps every hour because their effect
 * is time-bounded anyway.
 */
export type TickOutcome = { job: string; status: string; note?: string };

export async function runTick(now: Date = new Date()): Promise<TickOutcome[]> {
  await heartbeat(now);
  const hour = now.getUTCHours();
  const out: TickOutcome[] = [];

  const record = async (job: string, run: () => Promise<{ status: string; note?: string }>) => {
    try {
      const result = await run();
      out.push({ job, status: result.status, note: result.note });
    } catch (error) {
      out.push({ job, status: "threw", note: error instanceof Error ? error.name : "unknown" });
    }
  };

  await record("billing-sweep", () => runBillingSweepJob({ now }));
  // The Stripe launch (drizzle/0043). Hourly because each is a pure function
  // of rows that already exist and decides for itself what is due: the meter
  // report sends unreported overage, the alerts job queues each threshold
  // once per window, and the notices job is the backstop for any billing
  // email the immediate send after a Stripe event did not deliver. Alerts run
  // before notices so a threshold crossed this hour is mailed this hour.
  await record("usage-meter-report", () => runUsageMeterReportJob({ now }));
  await record("usage-alerts", () => runUsageAlertsJob({ now }));
  await record("billing-notices", () => runBillingNoticesJob({ now }));
  // Phase two: runJob() reports it "disabled" in v1 whatever its switch says.
  await record("monthly-report", () => runMonthlyReportJob({ now, send: true }));
  await record("weekly-recap", () => runWeeklyRecapJob({ now }));
  await record("connection-health", () => runConnectionHealthJob({ now }));
  // §C.4: booking requests whose link or proposed times have lapsed become
  // `expired`. Not a switched job: a pure function of the clock over rows
  // that already exist, like the sweep below. (It ran inside the call-back
  // dialer job until that was removed.)
  await record("booking-request-expiry", async () => ({ status: "ok", note: `${(await expireLapsedRequests(now)).expired} expired` }));
  // §H.5: a clinic whose setup link expired unspent gets the specialty
  // defaults stamped as its booking requirement set. Same shape as the sweep
  // above: a pure function of the clock over rows that already exist.
  await record("booking-requirements-defaults", async () => ({ status: "ok", note: `${await applyBookingRequirementDefaults(now)} defaulted` }));
  // Phase two, like the monthly report.
  if (hour === 2) await record("nightly-sync", () => runNightlySyncJob({ now }));
  if (hour === 3) await record("retention-purge", () => runRetentionPurgeJob({ now }));
  if (hour === 4) await record("offboarding-destroy", () => runOffboardingDestroyJob({ now }));
  // A closed allowance month is invoiced once; the job's own ledger
  // (overage_invoices, one row per window) makes a re-run a no-op.
  if (hour === 5) await record("annual-overage-invoice", () => runAnnualOverageJob({ now }));
  if (hour === 6) await record("billing-housekeeping", () => runBillingHousekeepingJob({ now }));
  if (hour === 9) await record("annual-renewal-reminder", () => runAnnualRenewalReminderJob({ now }));

  return out;
}
