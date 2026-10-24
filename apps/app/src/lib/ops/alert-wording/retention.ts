import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "retention" section of docs/on-call.md's alert runbook. The purge runs
 * from the tick at 03 and 09 UTC (lib/scheduler/tick.ts). Its row under
 * System › Jobs, named retention-purge, carries the last result: a run that
 * failed as a whole puts its error in the Result note (lib/scheduler/jobs.ts
 * runWideningJob); a single clinic's failure is only counted in the note, and
 * its reason is kept in memory and never logged (lib/scheduler/
 * retention-purge.ts sweepRetention).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised by the nightly retention purge for each clinic whose purge threw
  // (`phase` clinic, its id), and once when a run could not purge at all
  // (`phase` run, no clinic).
  retention_purge_failed: {
    title: "The nightly retention purge did not finish",
    // The clinic is optional (a run that could not start names none), so the
    // headline starts with the purge and takes the clinic in a clause.
    headline: "The retention purge failed[ for {clinicName}]: old records may still be kept",
    whatHappened:
      "The retention purge failed[ for {clinicName}], so records past their periods may still be kept. The purge deletes conversations, transcripts and raw records past the periods a clinic's agreement states. Either one clinic's purge failed and the rest ran, or the run could not start at all.",
    whyItMatters:
      "Until a run gets through, the clinics it did not reach keep patient records past the periods their agreements promise. The next run deletes everything that came due meanwhile, so nothing is lost by putting the cause right first.",
    steps: [
      "Open System and then Jobs, and read the retention-purge row: its Result says ok or failed, and its note counts the clinics that ran and how many failed.",
      "Tell the owner what the row says, naming the clinic if the alert names one. A run that failed as a whole has its error in that row's Result note under Jobs; a single clinic's failure is only counted there, and its reason is kept nowhere. Do not run a purge by hand: one run without the job's own checks can delete what a hold still covers.",
      "Wait for the next run once the cause is put right: it runs twice a day and catches up by itself. Check the retention-purge row under Jobs afterwards.",
      "Check the retention-purge row under Jobs after that run. You are done when its Result says ok and its note counts no clinic failed.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
