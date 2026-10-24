import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "offboarding" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised once per clinic by the destruction job (lib/offboarding) from day
  // 21 after a clinic on the thirty days (BAA 1.2.2 or earlier, or no
  // agreement) left with no export recorded as delivered. Its one fact is
  // when the data goes (destroyAt). The export is owed whether or not the
  // practice asks: those agreements give it "on request", but Terms §7
  // promises it to every leaving practice and the canceled email tells the
  // practice it is coming, so it has no reason to ask.
  export_undelivered_before_destruction: legacy(
    "A leaving practice has no export delivered",
    "Deliver this practice's export, and record the handover on its care page, before the time below: Terms §7 promises every leaving practice its export within 30 days of the end, whether or not it asks. Its data is destroyed at that time whether or not the export was delivered, because its agreement gives thirty days, or it has none on file.",
  ),
  // The same, from day 21, for a clinic whose agreement (BAA 1.3.0, the DPA)
  // promises the export within thirty days and destroys the data once it is
  // delivered, or at the ninety days without it.
  export_due_undelivered: legacy(
    "A leaving practice's export is due and not delivered",
    "Deliver this practice's export, and record the handover on its care page, before the export deadline below: its agreement promises the export within thirty days of the end, without being asked. Its data is destroyed once the export is delivered, and at the destruction time below whether or not it was.",
  ),
  // Raised once by the Stripe webhook (lib/billing/events.ts) when a
  // subscription's end was processed more than a week after it happened, so
  // the database started the clock a week back and no further. Its facts are
  // the end and the days the clamp cost.
  offboarding_started_late: legacy(
    "A subscription's end was processed over a week late",
    "The destruction clock started a week back and no further, so this practice's data is destroyed the days below later than its agreement counts from the end. Find out why the event was late, and tell the owner: only the database owner can bring the destruction forward.",
  ),
  // `code` is what the closure waits on (app_account_closure_waiting_on).
  account_closure_waiting: legacy(
    "A leaving practice's account cannot close yet",
    "The clinic below has had its data destroyed and its pass-through has ended, but its account stays open, its sign-in and setup with it, until one thing is done. For code voice_agent, release its agent and number in Retell's console, delete every call Retell holds for it, and record it on its care page. For code incident_open, finish and resolve its open incident. For code critical_notice, a critical notice to the practice is still waiting to go: see why on its care page. For code stripe_connect, its Stripe Connect link is still in place: turn on billing-reconcile, or disconnect it from the Billing page. The hourly job closes the account once nothing is left.",
  ),
  account_closure_failed: legacy(
    "A leaving practice's account closure failed",
    "The hourly job tried to close the account of the clinic below and the database refused, so its sign-in and setup are still there. Read the error lines for account closure in apps/app's log; the job tries again every hour.",
  ),
  destruction_notice_undelivered: legacy(
    "A practice was not told its data was destroyed",
    "The clinic below has had its data destroyed, and the email saying so (E6) could not be sent to the address on its account when it was destroyed: the mail provider refused it, this side refused to send it, or it kept failing for a week. healdesk no longer holds that address for the email, so write to the practice by hand from its account in the console: when its data was destroyed, that backups expire within 35 days, what Anthropic keeps under its agreement, and that the signed agreement and billing records are kept.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "export_undelivered_before_destruction",
  "export_due_undelivered",
  "offboarding_started_late",
  "account_closure_waiting",
  "account_closure_failed",
  "destruction_notice_undelivered",
]);
