import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "morning-digest" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The 07:00 digest's line in Slack (lib/ops/digest.ts), never emailed.
  ops_digest_summary: legacy(
    "Morning digest",
    "The morning digest went to the ops address. These are its counts of what needs a person today: decisions owed, clinics waiting on us, clinics near or at their allowance, and alerts Slack could not take.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "ops_digest_summary",
]);
