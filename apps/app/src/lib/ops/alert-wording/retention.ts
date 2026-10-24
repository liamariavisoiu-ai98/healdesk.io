import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "retention" section of docs/on-call.md's alert runbook. The purge runs
 * from the tick at 03 and 09 UTC (lib/scheduler/tick.ts); its row under
 * System › Jobs carries the last result and a note counting the clinics that
 * ran and failed (lib/scheduler/retention-purge.ts).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised by the nightly retention purge for each clinic whose purge threw
  // (`phase` clinic, its id), and once when a run could not purge at all
  // (`phase` run, no clinic). The error is in the worker's log.
  retention_purge_failed: {
    title: "The nightly retention purge did not finish",
    whatHappened:
      "The nightly purge that deletes conversations, transcripts and raw records past the periods a clinic's agreement states could not finish[ for {clinicName}]. Either one clinic's purge failed and the rest ran, or the run could not start at all.",
    whyItMatters:
      "Until a run gets through, the clinics it did not reach keep patient records past the periods their agreements promise. The next run deletes everything that came due meanwhile, so nothing is lost by putting the cause right first.",
    steps: [
      "Open System and then Jobs, and read the retention purge's row: its last result and note say how many clinics ran and how many failed.",
      "Tell the owner, naming the clinic if the alert names one: the error is in the app's log, not under Jobs. Do not run a purge by hand: one run without the job's own checks can delete what a hold still covers.",
      "Wait for the next run once the cause is put right: it runs twice a day and catches up by itself. Check its row under Jobs afterwards.",
      "Check the retention purge's row under Jobs after that run. You are done when its result says ok and its note counts no clinic failed.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
