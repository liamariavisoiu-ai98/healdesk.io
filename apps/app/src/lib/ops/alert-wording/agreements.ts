import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "agreements" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  agreement_unsigned_7_days: legacy(
    "An updated agreement is unsigned",
    "A clinic has not signed its updated agreement after seven days. Call the clinic.",
  ),
  agreement_resign_unrenderable: legacy(
    "An updated agreement can't be sent to sign",
    "A clinic is on an older business associate agreement than the current one, and its agreement in force is missing what the current one is rendered from (its legal name, booking system or Google account), so no re-sign link could be sent. AYA keeps answering under the version it signed. Look at its agreement on the console's Agreements page and fix the record, so the hourly job can send it, and phone the practice.",
  ),
  agreement_below_floor_unsigned: legacy(
    "A clinic is answering under a superseded agreement",
    "A clinic's business associate agreement is a version go-live no longer accepts, and its updated agreement is still unsigned seven days after we sent it. AYA keeps answering under the version it signed until it's signed. Phone the practice and ask them to sign it from the email or from Billing.",
  ),
  // Raised by a recorded termination (lib/agreements/termination.ts) for each
  // location it could not start offboarding (phase offboarding), each
  // billing clinic it could not record a cancellation for (phase billing),
  // each billing clinic whose cancellation is recorded while the
  // billing-requests job is off (phase billing_job_off), and each location
  // whose billing pointer leads outside its practice (phase billing_pointer).
  // The termination itself is recorded, and the assistant has stopped.
  agreement_termination_incomplete: legacy(
    "A terminated practice's service did not fully end",
    "The agreement's termination is recorded and the assistant has stopped, but one step did not finish for the clinic below. For phase offboarding, start offboarding from its care page. For phase billing, cancel the subscription in Stripe at once, without proration: every ending stops the fees on the day. For phase billing_job_off, the cancellation is recorded but the billing-requests job that carries it out is switched off, so the subscription keeps billing: switch billing-requests on in the console, or cancel the subscription in Stripe at once, without proration. For phase billing_pointer, the location's billing clinic is recorded as one in another practice, so nothing was cancelled for it: find which subscription bills this location and cancel it in Stripe at once, without proration, then correct the location's billing clinic.",
  ),
  // Raised by the hourly reconcile per practice and step it finished.
  agreement_termination_finished_late: legacy(
    "A termination's last steps were finished late",
    "A recorded termination had a step that never ran, and the hourly reconcile has now finished it for the practice below: for phase offboarding it started its locations' offboarding, for phase billing it recorded the subscription's cancellation. Check the practice in the console. If its subscription billed in between, refund that period, and if the termination refunds fees, confirm that refund on its Billing page.",
  ),
  agreement_copy_withheld: legacy(
    "A signer's copy of the agreement is still owed",
    "Someone signed at the checkout, and the copy of the agreement was not emailed to the address they gave. The code says why: a copy already went to that address today, the names on it carry something not safe to mail to an address nobody confirmed, the day's copies to such addresses are spent, or the send failed or had no transport. The signature is on record under the agreement id below. If the signer is genuine, send them the copy by hand from hello@.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "agreement_unsigned_7_days",
  "agreement_resign_unrenderable",
  "agreement_below_floor_unsigned",
  "agreement_termination_incomplete",
  "agreement_termination_finished_late",
  "agreement_copy_withheld",
]);
