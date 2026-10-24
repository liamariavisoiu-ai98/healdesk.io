import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "retention" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  retention_purge_failed: legacy(
    "The retention purge failed",
    "The nightly retention purge could not finish for the clinic below, or for every clinic. Until it runs, that clinic keeps conversations, transcripts and raw payloads past the periods its agreement states. Read the worker's error lines for the retention purge and the job's note in the console's job list, fix the cause, then let the next run, at 03 or 09 UTC, catch up: it deletes everything that came due meanwhile.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "retention_purge_failed",
]);
