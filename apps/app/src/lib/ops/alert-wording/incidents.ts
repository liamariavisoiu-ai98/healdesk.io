import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "incidents" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised by a recorded termination for each billing clinic when the
  // practice ended the agreement because healdesk violated a material term,
  // or under the Subcontractors clause: the two endings BAA 1.3.0 clause 17
  // refunds.
  // Raised once per incident by the hourly incident-deadlines job, with the
  // clinic's and the incident's ids.
  incident_notice_overdue: legacy(
    "An incident's notice target has passed",
    "Our own target is to tell the practice within 24 hours of discovering a breach, a security incident or an improper use or disclosure, well inside the agreement's outer limit, and no notice is recorded for the incident below. Decide it now on the console's Incidents page: send the report, which emails the practice's address from fixed fields, or record why it isn't reportable (docs/incident-response.md).",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "incident_notice_overdue",
]);
