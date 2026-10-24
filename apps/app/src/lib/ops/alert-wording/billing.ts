import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "billing" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  duplicate_subscription: legacy(
    "A clinic has two subscriptions",
    "Stripe holds a second subscription for one clinic. Cancel the duplicate, and refund it if it was charged.",
  ),
  billing_event_dead_lettered: legacy(
    "A billing event stopped retrying",
    "A Stripe event could not be applied after its retries. Replay it from the console.",
  ),
  billing_request_dead_lettered: legacy(
    "A billing request stopped retrying",
    "A plan start, step-up, cancellation or setup closure failed on Stripe after every retry. Check the clinic's subscription in Stripe, then retry the request from the console.",
  ),
  billing_request_stuck: legacy(
    "A billing request has waited over 24 hours",
    "A plan start, step-up, cancellation or setup closure is still pending a day after it was recorded. Check that the billing-requests job is on and the worker is running, then look at the request in the console.",
  ),
  setup_closure_skipped_live_channel: legacy(
    "A setup closure was skipped: a channel is live",
    "An account reached the end of its 30-day setup window with a channel already live, so it was left open. Nothing needs undoing; check that its plan starts when AYA first answers.",
  ),
  location_charged_not_created: legacy(
    "An extra location was charged but not created",
    "A clinic paid for an extra location and creating it failed. The charge stands: retry the location's setup from the console today.",
  ),
  connect_event_dead_lettered: legacy(
    "A Connect event stopped retrying",
    "A Stripe Connect event about a clinic's deposits could not be applied after its retries. Check the deposit in the clinic's own Stripe account, then replay the event from the console.",
  ),
  overage_invoice_failed: legacy(
    "An annual overage invoice failed",
    "Invoicing an annual clinic's overage for a closed month failed. Check for a draft or open invoice in Stripe, then retry it from the console.",
  ),
  first_period_refund_due: legacy(
    "A first-period refund is due",
    "A clinic turned auto-renew off inside its first-period refund window. Contact the clinic, then issue the refund from the console.",
  ),
  plan_start_after_cancel: legacy(
    "A plan started on a subscription set to cancel",
    "A clinic's first period was charged while its subscription was set to cancel. Check with the clinic whether auto-renew should be on; if not, the first-period refund applies.",
  ),
  // Raised once per location by the answer gate.
  billing_pointer_outside_practice: legacy(
    "A location is billed to another practice",
    "The clinic below records its billing clinic as one in another practice. The assistant treats it as having no billing and passes its calls and messages to the clinic rather than answer them. Find which practice the location belongs to and correct its billing clinic.",
  ),
  // Raised by a first-period refund (commitRefund) whose cancel_now waits on
  // the switched-off billing-requests job.
  refund_cancel_job_off: legacy(
    "A refunded plan is still billing",
    "A first-period refund under the Terms was issued and the plan's cancellation recorded, but the billing-requests job that carries it out is switched off, so the subscription keeps billing. Switch billing-requests on in the console, or cancel the subscription in Stripe at once, without proration.",
  ),
  // The hourly location-quantity check (lib/billing/location-quantity.ts).
  location_quantity_drift: legacy(
    "Stripe bills a different number of locations",
    "The quantity Stripe bills this account for locations is not the number of locations it has active (counting one being added whose charge is recorded). Nothing was changed: the check only reads. Open the account's Billing page and its subscription in Stripe, decide which side is wrong, and put it right by hand: too many billed may be a refund owed, too few an add to finish. You will hear once more when the two agree again.",
  ),
  location_quantity_agrees: legacy(
    "Stripe's location count matches again",
    "The quantity Stripe bills this account for locations matches its active locations again, so the mismatch reported earlier for the time below has ended. Nothing more to do unless a refund or a credit for the period it lasted is still owed.",
  ),
  agreement_refund_due: legacy(
    "A terminated practice is owed a refund",
    "The practice ended its agreement for a reason the agreement refunds: the fees it paid for any time after the termination day. On the clinic's Billing page, preview the termination refund, check it, and confirm it. Confirm it before the practice's data is destroyed (at the earliest 29 days after the termination): destruction removes the billing records the console refunds from, and after it the refund has to be made by hand in the Stripe Dashboard. The subscription is already being cancelled.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "duplicate_subscription",
  "billing_event_dead_lettered",
  "billing_request_dead_lettered",
  "billing_request_stuck",
  "setup_closure_skipped_live_channel",
  "location_charged_not_created",
  "connect_event_dead_lettered",
  "overage_invoice_failed",
  "first_period_refund_due",
  "plan_start_after_cancel",
  "billing_pointer_outside_practice",
  "refund_cancel_job_off",
  "location_quantity_drift",
  "location_quantity_agrees",
  "agreement_refund_due",
]);
