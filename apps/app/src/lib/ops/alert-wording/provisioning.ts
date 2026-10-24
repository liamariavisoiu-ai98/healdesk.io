import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "provisioning" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  provisioning_rejected: legacy(
    "Provisioning was rejected",
    "A paid order could not be provisioned. Check the order in the console and finish it by hand.",
  ),
  // Raised by /api/provision when a paid order's third attempt fails in a
  // way a retry could fix (lib/checkout/dead-letter.ts). `requestId` is the
  // purchase's ref; `attempts` how many failed.
  provisioning_dead_lettered: legacy(
    "Provisioning a paid order keeps failing",
    "Setting up the account for the paid order below failed on each of the attempts counted, and the buyer has been emailed that it needs one step on our side, with the next business day as the day we will write by. Stripe keeps sending the payment for up to three days and each delivery tries again, so fix the cause (the request id is the purchase's ref; apps/app's error lines for provisioning say what failed), and the next delivery makes the account and sends the welcome email. If it cannot be made in time, email the buyer yourself by that day.",
  ),
  // Raised by the ops watch (lib/ops/watch.ts), once per purchase.
  paid_intent_without_clinic: legacy(
    "A paid order has no clinic",
    "A paid order's first invoice reached apps/app more than ten minutes ago and no account exists for it, and nothing has refused it. The request id is the purchase's ref, and attempts is how many tries failed so far. Check provisioning's error lines for it, and the Stripe event's deliveries.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "provisioning_rejected",
  "provisioning_dead_lettered",
  "paid_intent_without_clinic",
]);
