import { runAnnualOverageJob } from "@/lib/billing/annual-overage";
import { runCardExpiringJob } from "@/lib/billing/card-expiring";
import { runBillingHousekeepingJob } from "@/lib/billing/housekeeping";
import { runBillingReconcileJob } from "@/lib/billing/reconcile";
import { runBillingRequestsJob } from "@/lib/billing/requests";
import { runTranscriptEmailsJob } from "@/lib/conversations/transcript-outbox";
import { runUsageAlertsJob } from "@/lib/billing/usage-alerts";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { expireLapsedRequests } from "@/lib/meta/booking-requests";
import { applyBookingRequirementDefaults } from "@/lib/onboarding/requirements";
import { expireErasureRecords } from "@/lib/patient-rights/erasure";
import { runSetupRemindersJob } from "@/lib/setup/reminders";
import { runAddressChangesJob } from "@/lib/sign-in/address-change";
import { runWelcomeBackstop } from "@/lib/setup/welcome-email";

import { runAnnualRenewalReminderJob } from "./annual-renewal-reminder";
import { runBillingSweepJob } from "./billing-sweep";
import { runConnectionHealthJob } from "./connection-health";
import { runDmarcReviewJob } from "./dmarc-review";
import { runIncidentDeadlinesJob } from "./incident-deadlines";
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
 * at night; the annual overage invoices at 05, billing housekeeping at 06 and
 * the card-expiry check at 07; the DMARC review reminder at 08; the mailers
 * in the morning; the sweeps every hour because their effect is time-bounded
 * anyway. Destruction runs every hour too, and every run destroys every
 * clinic due on either rule: a clinic is due a day before its agreement's
 * thirty days, or ninety, are up, so whatever hour it left its data is gone
 * before them (lib/offboarding).
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
  // report sends unreported overage, and the alerts job queues each threshold
  // once per window. The notices it queues are sent from the `notices` queue,
  // every minute (lib/email/outbox.ts), which replaced the hourly
  // billing-notices backstop that used to run here.
  await record("usage-meter-report", () => runUsageMeterReportJob({ now }));
  await record("usage-alerts", () => runUsageAlertsJob({ now }));
  // The Stripe build (drizzle/0050). The reconcile records whatever billing
  // request is due but missing, then the requests worker carries out what is
  // due, in that order so a request recorded this hour goes this hour. The
  // worker also runs every minute from the `billing-minute` queue; this is
  // its backstop for a worker whose queue was never installed, and each
  // request's own lease makes the overlap harmless.
  await record("billing-reconcile", () => runBillingReconcileJob({ now }));
  await record("billing-requests", () => runBillingRequestsJob({ now }));
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
  // The record of a deletion request keeps its keyed references for the
  // BACKUP_RETENTION_DAYS a backup can bring the person back, and goes with
  // them once every subcontractor step is stamped (lib/patient-rights/
  // erasure.ts). Not a switched job: BAA 1.3.0's "for no longer than it needs
  // one" does not wait for a switch that ships off. Hourly, so a reference is
  // never kept more than an hour past the window; a restore keeps the worker,
  // and so this, stopped until the deletions are applied again.
  await record("erasure-expiry", async () => {
    const r = await expireErasureRecords();
    return {
      status: r.failures ? "failed" : "ok",
      note: `${r.emptied} emptied, ${r.deleted} deleted${r.failures ? `, ${r.failures} failed` : ""}`,
    };
  });
  // Every hour, on either rule: a clinic is due at day 29 (on BAA 1.3.0 or
  // the DPA once its export is delivered, or at the delivery when later) or
  // at day 89, and the next hourly run destroys it (lib/offboarding, "Which
  // rule, and why").
  await record("offboarding-destroy", () => runOffboardingDestroyJob({ now }));
  // Every hour: an incident past our internal 24-hour notice target with no
  // notice recorded raises one ops alert, ever (BAA 1.3.0 release gate 5;
  // the agreements' own limit is 60 calendar days).
  await record("incident-deadlines", () => runIncidentDeadlinesJob({ now }));
  // The transcript outbox (drizzle/0069, 0072): sent every minute from the
  // `billing-minute` queue; this is its backstop for a worker whose queue
  // was never installed. It carries the deletion of every sealed copy that
  // was never delivered, at 30 days or 72 hours after a send nothing
  // answered, so it ships switched on and deletes even when it is off, and
  // each row's lease makes the overlap harmless
  // (lib/conversations/transcript-outbox.ts).
  await record("transcript-emails", () => runTranscriptEmailsJob({ now }));
  // The setup reminder (O7), hourly: each clinic's due reminder is queued
  // only in its own daytime, so the hour it runs is the clinic's, not UTC's.
  await record("setup-reminders", () => runSetupRemindersJob({ now }));
  // The welcome email's backstop. Not a switched job: the welcome itself goes
  // at every provisioning, unswitched, so its retry must not wait for a
  // switch that ships off. It reaches only a clinic whose provisioning
  // recorded a welcome as owed and has not sent it (lib/setup/welcome-email.ts).
  await record("welcome-email", async () => {
    const result = await runWelcomeBackstop({ now });
    return {
      status: "ok",
      note: `${result.resent} resent, ${result.unsent} still unsent, ${result.failed} failed`,
    };
  });
  // A change of a clinic's one address takes effect 72 hours after it was
  // confirmed, and an unused confirmation link closes after 72 hours (plan
  // Part D5). Not a switched job, like the welcome email's backstop: the
  // clinic was told the moment, and a switch that ships off would break it.
  // Each change is applied under its own row lock (lib/sign-in/address-change.ts).
  await record("address-changes", async () => {
    const r = await runAddressChangesJob();
    return {
      status: "ok",
      note: `${r.applied} applied, ${r.expired} expired, ${r.failed} failed, ${r.waiting} waiting`,
    };
  });
  // Phase two, like the monthly report.
  if (hour === 2) await record("nightly-sync", () => runNightlySyncJob({ now }));
  // Its switch widens it rather than starting it: a clinic on BAA 1.3.0 or
  // later, or the DPA, is purged every night, switch or not, and the switch
  // adds every other clinic (lib/scheduler/retention-purge.ts). It runs again
  // at 09: a sync run younger than six hours holds a clinic's purge
  // (SYNC_HOLDS_PURGE_HOURS), and the nightly sync starts at 02, so a clinic
  // whose sync is slow or crashed is skipped at 03 every night; at 09 its
  // hold has run out and it is purged the same day. A second run deletes
  // only what has come due since, so it costs nothing to run for everyone.
  if (hour === 3 || hour === 9) await record("retention-purge", () => runRetentionPurgeJob({ now }));
  // A closed allowance month is invoiced once; the job's own ledger
  // (overage_invoices, one row per window) makes a re-run a no-op.
  if (hour === 5) await record("annual-overage-invoice", () => runAnnualOverageJob({ now }));
  if (hour === 6) await record("billing-housekeeping", () => runBillingHousekeepingJob({ now }));
  // Once a day, after the night's jobs and before the morning's mail: whether
  // the card on file expires before the next renewal.
  if (hour === 7) await record("card-expiring", () => runCardExpiringJob({ now }));
  // Once a day is enough for a reminder counted in days: 14 days after Resend
  // first sent, one ops alert, ever, then nothing (dmarc-review.ts). A missed
  // 08:00 tick only moves it to the next day's.
  if (hour === 8) await record("dmarc-review", () => runDmarcReviewJob({ now }));
  if (hour === 9) await record("annual-renewal-reminder", () => runAnnualRenewalReminderJob({ now }));

  return out;
}
