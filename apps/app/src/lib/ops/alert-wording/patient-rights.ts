import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "patient-rights" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // L32's clock (lib/patient-rights/patient-requests.ts), once per request
  // each: the clinic's and the request's ids.
  patient_request_due_soon: legacy(
    "A patient's request is due tomorrow",
    "A request a patient made to healdesk about the clinic below has not been marked received by anyone at the practice, and the agreement has us pass it on within five business days, of which one is left. The practice has had the email and two reminders. Telephone the practice on its published number today: tell them a patient's request is waiting on Home in their portal, and if the request names no contact, tell them who asked and how to reach them. Never email the person's details.",
  ),
  patient_request_past_due: legacy(
    "A patient's request is past its five business days",
    "A request a patient made to healdesk about the clinic below is past the five business days the agreement gives us to pass it on, and nobody at the practice has marked it received. Telephone the practice today and pass it on by telephone, who asked included where the request names no contact; then ask them to mark it received on its page in the portal, so the record shows it reached them.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "patient_request_due_soon",
  "patient_request_past_due",
]);
