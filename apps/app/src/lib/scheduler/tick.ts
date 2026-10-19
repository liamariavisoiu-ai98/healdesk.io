import { runAgreementResignsJob } from "@/lib/agreements/resign";
import { runAnnualOverageJob } from "@/lib/billing/annual-overage";
import { sweepChannelStates } from "@/lib/channels/events";
import { sweepEndedPauses } from "@/lib/channels/pause";
import { runCardExpiringJob } from "@/lib/billing/card-expiring";
import { runBillingHousekeepingJob } from "@/lib/billing/housekeeping";
import { runBillingReconcileJob } from "@/lib/billing/reconcile";
import { runBillingRequestsJob } from "@/lib/billing/requests";
import { runPracticeQuestionsSweep } from "@/lib/engine/practice/job";
import { runTranscriptEmailsJob } from "@/lib/conversations/transcript-outbox";
import { runUsageAlertsJob } from "@/lib/billing/usage-alerts";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { expireLapsedRequests } from "@/lib/meta/booking-requests";
import {
  queueAfterCancellationNotices,
  runDestructionNotices,
} from "@/lib/offboarding/after-cancellation";
import { runMetaTokenWatch } from "@/lib/meta/token-watch";
import { applyBookingRequirementDefaults } from "@/lib/onboarding/requirements";
import { expireErasureRecords } from "@/lib/patient-rights/erasure";
import { sweepPatientRequests } from "@/lib/patient-rights/patient-requests";
import { runOpsDigestJob } from "@/lib/ops/digest";
import { runHealthFlagsJob } from "@/lib/ops/health-flags";
import { runOpsWatchJob } from "@/lib/ops/watch";
import { runSetupRemindersJob } from "@/lib/setup/reminders";
import { runAddressChangesJob } from "@/lib/sign-in/address-change";
import { runWelcomeBackstop } from "@/lib/setup/welcome-email";
import { runSiteReadsSweep, runWebsiteDriftJob } from "@/lib/website/job";
import { syncRetellFallbacks } from "@/lib/voice/retell-fallback-sync";

import { runAnnualRenewalReminderJob } from "./annual-renewal-reminder";
import { runBillingSweepJob } from "./billing-sweep";
import { runConnectionHealthJob } from "./connection-health";
import { runDailySummaryJob } from "./daily-summary";
import { runDmarcReviewJob } from "./dmarc-review";
import { runIncidentDeadlinesJob } from "./incident-deadlines";
import { heartbeat } from "./jobs";
import { runMonthlyReportJob } from "./monthly-report";
import { runNightlySyncJob } from "./nightly-sync";
import { runOffboardingDestroyJob } from "./offboarding-destroy";
import { runRequestsStillOpenJob } from "./requests-still-open";
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
  // The daily summary (L13) and, while none can carry it, the weekly recap
  // alone (L14): hourly, each behind its switch, each deciding per clinic
  // from the clinic's own clock whether its opening time or its Monday has
  // come. The summary first, so a Monday it goes on carries the recap.
  await record("daily-summary", () => runDailySummaryJob({ now }));
  await record("weekly-recap", () => runWeeklyRecapJob({ now }));
  await record("connection-health", () => runConnectionHealthJob({ now }));
  // Every six hours: ask Meta whether each clinic's Facebook, Instagram and
  // WhatsApp logins still work, and mark the dropped ones so the portal offers
  // Reconnect (lib/meta/token-watch.ts). Not a switched job: it only marks.
  if (hour % 6 === 2) {
    await record("meta-token-watch", async () => {
      const r = await runMetaTokenWatch();
      return {
        status: r.failures ? "failed" : "ok",
        note: `${r.checked} checked, ${r.marked} marked${r.failures ? `, ${r.failures} failed` : ""}`,
      };
    });
  }
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
  // rule, and why"). It also releases AYA's number of a clinic destroyed
  // before its pass-through ended, once that has.
  await record("offboarding-destroy", () => runOffboardingDestroyJob({ now }));
  // E6 (lib/offboarding/after-cancellation.ts), right after the destruction
  // it reports, to the address captured in the destruction's transaction,
  // and every hour after until it goes or DESTRUCTION_NOTICE_DAYS pass. Not
  // a switched job: the captured address must not outlive its bound because
  // a switch was off.
  await record("destruction-notices", async () => {
    const r = await runDestructionNotices({ now });
    return {
      status: r.retrying || r.givenUp ? "failed" : "ok",
      note: `${r.owed} owed, ${r.sent} sent, ${r.retrying} retrying, ${r.givenUp} given up`,
    };
  });
  // E3, E4 and E5 for every clinic whose service has ended, each once: the
  // export is ready, the pass-through is ending, the export is about to go
  // undownloaded. Not a switched job, for the reason the channel sweep is not:
  // a pure function of rows that already exist, and the outbox that sends
  // them has its own switch. E3 reaches a clinic destroyed before its
  // pass-through ended too: its line still forwards to us until then.
  await record("after-cancellation", async () => {
    const r = await queueAfterCancellationNotices(now);
    return {
      status: r.failures ? "failed" : "ok",
      note: `${r.clinics} clinics, ${r.queued} queued${r.failures ? `, ${r.failures} failed` : ""}`,
    };
  });
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
  // Channel events (lib/channels/events.ts): every production clinic's
  // channels moved on as far as their inputs allow, ready, waiting on the
  // clinic, live, for any input whose own event did not ask. Not a switched
  // job: a pure function of rows the clinic and the operator set, like the
  // sweeps above. Before the setup reminder, which reads what it wrote.
  await record("channel-states", async () => {
    const r = await sweepChannelStates(now);
    return {
      status: r.failures ? "failed" : "ok",
      note: `${r.clinics} clinics, ${r.readied} ready, ${r.live} live${r.failures ? `, ${r.failures} failed` : ""}`,
    };
  });
  // The practice questions' sweep (lib/engine/practice/job.ts), behind the
  // practice-questions switch: a run for a clinic whose inputs changed with
  // none asked for, the review-past-due alert, and O8 for a complete tracker.
  // The runs themselves go every minute from their own queue.
  await record("practice-questions-sweep", () => runPracticeQuestionsSweep({ now }));
  // The header's pause (lib/channels/pause.ts): a timed pause that ended by
  // itself gets its `resumed` row, at the moment it ended, once. Not a
  // switched job, for the reason the channel-states sweep is not: the answer
  // gate already reads the end, so this only completes the record.
  await record("ai-pause", async () => {
    const r = await sweepEndedPauses(now);
    return {
      status: r.failures ? "failed" : "ok",
      note: `${r.clinics} clinics, ${r.resumed} resumed${r.failures ? `, ${r.failures} failed` : ""}`,
    };
  });
  // The internal health flags (WP5), hourly behind their switch, which ships
  // off: a clinic quiet for 48 hours after going live, a phone line with no
  // call for 14 days, each raised to ops once (lib/ops/health-flags.ts).
  // After the pause sweep above, whose `resumed` rows restart a phone line's
  // quiet stretch.
  await record("health-flags", () => runHealthFlagsJob({ now }));
  // The ops watch's hourly run (WP5): the minute's purchase checks, and the
  // support replies past their day, which read every clinic's outbox
  // (lib/ops/watch.ts). Every minute from the billing-minute queue as well.
  await record("ops-watch", () => runOpsWatchJob({ now, supportReplies: true }));
  // I2, the ops digest (WP5): at 07 UTC, or the first tick after it, once a
  // UTC day; a tick that finds today's sent does nothing (lib/ops/digest.ts).
  if (hour >= 7) await record("ops-digest", () => runOpsDigestJob({ now }));
  // The website re-reads (lib/website): behind site-reads, a read for each
  // clinic with a website and no profile its own save did not ask for, and
  // the due reads, as the minute queue's backstop; behind website-drift, off
  // until the owner switches it on, the monthly check of each live clinic.
  await record("site-reads", () => runSiteReadsSweep({ now: () => now }));
  await record("website-drift", () => runWebsiteDriftJob({ now }));
  // The voice fall-through (T14): each clinic's AYA number in Retell keeps
  // the clinic's direct line as its fallback, for outage mode and for a voice
  // task that cannot read the database (lib/voice/retell-fallback-sync.ts).
  // Not a switched job: it does nothing until HEALDESK_RETELL_API_KEY is set.
  await record("retell-fallback", () => syncRetellFallbacks());
  // The setup reminder (O7), hourly: each clinic's due reminder is queued
  // only in its own daytime, so the hour it runs is the clinic's, not UTC's.
  await record("setup-reminders", () => runSetupRemindersJob({ now }));
  // L8, hourly behind its switch: each clinic's "request still open" goes at
  // its own opening hour, so the hour it runs is the clinic's, not UTC's.
  await record("requests-still-open", () => runRequestsStillOpenJob({ now }));
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
  // L22's reminders at 3 and 7 days, and the ops alert at 7, for each
  // practice that owes its updated agreement (plan Part L; WP9). Not a
  // switched job, like the address changes: the practice was told AYA is
  // paused until it signs, and a switch that ships off would leave it waiting
  // with no word. Each email is once per re-sign and day on the ledger.
  await record("agreement-resigns", async () => {
    const r = await runAgreementResignsJob({ now });
    return { status: "ok", note: `${r.open} open, ${r.sent} sent, ${r.alerted} past 7 days` };
  });
  // L32's reminders, on the second and fourth business days, and its ops
  // alerts, on the fourth and once the fifth has passed, for each patient's
  // request passed to a practice that nobody there has marked received
  // (lib/patient-rights/patient-requests.ts). Not a switched job, like the
  // re-sign reminders: the BAA's five business days wait for no switch.
  await record("patient-requests", async () => {
    const r = await sweepPatientRequests(now);
    return {
      status: r.failures ? "failed" : "ok",
      note: `${r.open} open, ${r.reminded} reminded, ${r.dueSoon} due tomorrow, ${r.pastDue} past due${r.failures ? `, ${r.failures} failed` : ""}`,
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
