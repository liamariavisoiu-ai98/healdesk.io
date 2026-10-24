import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "vendors" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The vendors' agreements (lib/compliance/vendor-coverage.ts): `code` is the
  // vendor, `phase` 30_days or 7_days, `expiresOn` the recorded expiry.
  vendor_agreement_expiring: legacy(
    "A vendor's business associate agreement expires soon",
    "The attestation for the vendor in Code expires on the day shown. When it lapses, AYA stops answering where that vendor serves (every channel for anthropic, aws and database_host; phone for retell) and calls go to each clinic's direct line. Get the renewed agreement and record it on /admin/compliance, with its new expiry, before that day.",
  ),
  // `phase` withdrawn (recorded on /admin/compliance) or expired (`expiresOn`
  // passed with no renewal).
  vendor_agreement_lapsed: legacy(
    "A vendor's agreement lapsed: AYA has stopped",
    "The attestation for the vendor in Code was withdrawn or passed its expiry, so AYA has stopped answering where that vendor serves: every channel for anthropic, aws and database_host, phone for retell. Calls go to each clinic's direct line, website chat is the contact form (which keeps nothing while aws or database_host is the one lapsed), and Meta messages wait unanswered. Open an incident on /admin/incidents now: patient data may have gone to the vendor between the agreement's real end and this stop. AYA answers again the moment a renewed attestation is recorded on /admin/compliance.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "vendor_agreement_expiring",
  "vendor_agreement_lapsed",
]);
