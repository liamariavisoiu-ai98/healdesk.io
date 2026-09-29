import { sweepMetaBookingDrafts } from "@/lib/meta/front-door";
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
 * at night; the mailers in the morning; the sweeps every hour because their
 * effect is time-bounded anyway.
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
  await record("monthly-report", () => runMonthlyReportJob({ now, send: true }));
  await record("weekly-recap", () => runWeeklyRecapJob({ now }));
  await record("connection-health", () => runConnectionHealthJob({ now }));
  // §D.2 step 5: a Meta draft whose consent question went unanswered for ten
  // minutes becomes a request with no consent row, so a person who went
  // quiet is not lost. Not a switched job: it is a pure function of the
  // clock over drafts that already exist, like the other sweeps here.
  await record("meta-draft-sweep", async () => ({ status: "ok", note: `${await sweepMetaBookingDrafts(now)} created` }));
  // §H.5: a clinic whose setup link expired unspent gets the specialty
  // defaults stamped as its booking requirement set. Same shape as the sweep
  // above: a pure function of the clock over rows that already exist.
  await record("booking-requirements-defaults", async () => ({ status: "ok", note: `${await applyBookingRequirementDefaults(now)} defaulted` }));
  if (hour === 2) await record("nightly-sync", () => runNightlySyncJob({ now }));
  if (hour === 3) await record("retention-purge", () => runRetentionPurgeJob({ now }));
  if (hour === 4) await record("offboarding-destroy", () => runOffboardingDestroyJob({ now }));
  if (hour === 9) await record("annual-renewal-reminder", () => runAnnualRenewalReminderJob({ now }));

  return out;
}
