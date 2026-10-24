import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "provisioning" section of docs/on-call.md's alert runbook: a paid
 * order with no account behind it. None of the three names a clinic, so none
 * has a console link, and neither the practice's name nor the purchase's ref
 * is a fact an alert prints (allow-list.ts): the steps send the operator to
 * Stripe's Dashboard for the practice's name, to the Clinics page, where a
 * finished account appears, and to the owner, who alone can read the error
 * log and replay a parked invoice. Never "create the clinic by hand":
 * provisioning is gated on the paid invoice (CLAUDE.md).
 *
 * Since Phase 5 the System page counts "Paid orders without an account"
 * under "Requires your attention" (lib/ops/inbox/queues.ts: a purchase whose
 * paid relay was stamped, paid_seen_at, and that has no account yet). The
 * route stamps it once the intent is found (app/api/provision/route.ts), so a
 * dead-lettered order and one waiting ten minutes are counted; an order
 * refused before that point is not, so provisioning_rejected does not point
 * at the count.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // /api/provision, on every refusal of a paid order (a 422): the request
  // named no purchase, the purchase could not be found, its sealed records
  // did not match, or its terms moved on. `field` and `source` say which; the
  // buyer is emailed (B3) only where the purchase itself was found.
  provisioning_rejected: {
    title: "A paid order was refused: no account made",
    headline: "Someone paid for AYA, but the order was refused and no account was made",
    whatHappened:
      "Someone paid for AYA, but the order was refused and no account was made. The order was missing something, could not be found, or its records did not match what was paid. If the order itself was found, the buyer has been emailed that one step is left on our side, with the next business day as the day we will write by. Otherwise nobody has written to them.",
    whyItMatters:
      "The buyer's money is taken and nothing answers for the clinic. Stripe will not resend a refused invoice: it is kept parked on our side until someone fixes the cause and replays it.",
    steps: [
      "Find the payment in Stripe's Dashboard, the newest paid first invoice from about when this alert was raised, to see the practice's name and address. Then open the Clinics page, newest first, and look for that practice. If it is listed, the order was finished another way and you are done.",
      "Tell the owner today, with this alert's code and the day it was raised. Only the owner can read why the order was refused and replay the paid invoice; nothing on the Clinics page or a Billing tab finishes it. Do not create a clinic by hand.",
      "Email the buyer from hello@ by the next business day if the practice is still missing from the Clinics page, at the address on the Stripe payment. Say the account is being finished on our side and name the day you will write again.",
      "Check the Clinics page once the owner says the invoice was replayed. You are done when the practice is listed and its Deliveries tab shows the welcome email under Reports and alerts.",
    ],
  },
  // Raised by /api/provision when a paid order's third attempt fails in a
  // way a retry could fix (lib/checkout/dead-letter.ts). `requestId` is the
  // purchase's ref; `attempts` how many failed.
  provisioning_dead_lettered: {
    title: "Making a paid order's account keeps failing",
    headline: "Someone paid for AYA, and making the account keeps failing[: {attempts:time} in a row]",
    whatHappened:
      "Someone paid for AYA, and making the account keeps failing[: {attempts:time} in a row]. Each failure was one a retry could fix. The buyer has been emailed that one step is left on our side, with the next business day as the day we will write by.",
    whyItMatters:
      "The buyer's money is taken and nothing answers for the clinic yet. Stripe resends the paid invoice for up to three days and each delivery tries again, so a fix on our side finishes the account by itself; after three days it stops.",
    steps: [
      "Find the payment in Stripe's Dashboard, the newest paid first invoice from about when this alert was raised, to see the practice's name and address. Then open the Clinics page, newest first, and look for that practice. If it is listed, a later delivery made the account and you are done.",
      "Tell the owner today, with this alert's code and the day it was raised: the cause is in the error log, which only the owner can read, and nothing on the Clinics page or a Billing tab finishes the order. Do not create a clinic by hand.",
      "Email the buyer from hello@ by the next business day if the practice is still missing from the Clinics page, at the address on the Stripe payment. Say the account is being finished on our side and name the day you will write again.",
      "Check the Clinics page again after the fix, and Paid orders without an account under Requires your attention on the System page, which counts this order until the account exists. You are done when the practice is listed, the count no longer includes it, and its Deliveries tab shows the welcome email under Reports and alerts.",
    ],
  },
  // Raised by the ops watch (lib/ops/watch.ts), once per purchase: the paid
  // invoice reached this host ten minutes ago, no account exists, and nothing
  // has refused it. `attempts` is how many tries ended in an error so far.
  paid_intent_without_clinic: {
    title: "A paid order has had no account for ten minutes",
    headline: "Someone paid for AYA over 10 minutes ago and still has no account",
    whatHappened:
      "Someone paid for AYA over 10 minutes ago and still has no account. Nothing has refused the order.[ Attempts that ended in an error so far: {attempts}.]",
    whyItMatters:
      "The buyer's money is taken and nothing answers for the clinic. Stripe resends the paid invoice for up to three days, so a short delay fixes itself; if the errors reach three, a separate alert says the order is stuck.",
    steps: [
      "Find the payment in Stripe's Dashboard, the newest paid first invoice from about when this alert was raised, to see the practice's name and address. Then open the Clinics page, newest first, and look for that practice. If it is listed, the account arrived and you are done.",
      "Wait an hour if the error count is low: Stripe's next delivery usually makes the account. Paid orders without an account under Requires your attention on the System page counts this order, with how long it has waited, until the account exists.",
      "Tell the owner the same day if the practice is still missing from the Clinics page, with this alert's code: the cause is in the error log, which only the owner can read. Do not create a clinic by hand.",
      "Check the Clinics page once more after the fix. You are done when the practice is listed, Paid orders without an account on the System page no longer counts it, and its Deliveries tab shows the welcome email under Reports and alerts.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
