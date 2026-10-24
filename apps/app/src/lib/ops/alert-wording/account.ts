import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "account" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  address_change_stalled: legacy(
    "An address change is waiting on Stripe",
    "A clinic's change of address is due, and Stripe would not take the new email, so nothing has moved yet. It is retried every hour. Check the Stripe key and the customer, then check the clinic's sign-in page in the console.",
  ),
  address_change_failed: legacy(
    "An address change was closed without effect",
    "A clinic's change of address could not take effect: the new address already signs in to healdesk, or the sign-in's address moved some other way. Call the clinic on its published number and agree the address.",
  ),
  sign_in_help_unmatched: legacy(
    "A request for sign-in help sent no link",
    "Someone used I can't get in with a clinic's address, and no link went: the code says why. This is the day's first for this clinic and code; later ones are in the security log. Call the clinic on its published number before changing anything; never send a link anywhere but the address on the account. Requests for addresses with no account alert no one and are counted in the morning digest.",
  ),
  access_requests_capped: legacy(
    "Sign-in help reached today's cap for emails to hello@",
    "The I can't get in page has sent hello@ as many access requests today as it may, so the rest go unmailed until midnight UTC: the cap keeps the form from spending the day's emails that sign-in links and urgent alerts need. Read today's sign_in_help_unmatched alerts and the security log's sign-in help rows for the clinics that asked, and look for a flood from one place.",
  ),
  step_up_phone_held: legacy(
    "Phone held off a plan with more than one location",
    "Phone is answering, or is due to join the price, for an account that has more than one location or one being added. Phone is billed per location and each location needs its own AYA number, which isn't built yet, so the step-up into phone was held and nothing was charged. Decide with the practice whether phone stays on; the step-up stays held until phone per location exists.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "address_change_stalled",
  "address_change_failed",
  "sign_in_help_unmatched",
  "access_requests_capped",
  "step_up_phone_held",
]);
