import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "approvals" section of docs/on-call.md's alert runbook (ops automation
 * Phase 6, lane P6a): the approval inbox, where each money, legal and
 * clinic-contact step waits for the owner's yes.
 *
 * The inbox's own screen is lane P6b's: the Approvals section of the Queues
 * page (`/admin/queues#approvals`), each item with Approve and Reject, a
 * History tab, and the field labelled "Code from your authenticator". Until
 * those names are in ./places.ts (the lead adds them with P6b, with proofs
 * in apps/web ApprovalsSection.tsx), every step also names the Queues page,
 * which exists today, so the wording lint holds.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/approvals/proposers.ts remind, once per kind: a money or routine
  // item waiting past its due time (a day after it was proposed), once; a
  // legal-clock item every 4 hours while it waits (owner decision D18; no
  // kind has a legal clock yet). Raised with the kind and how many items
  // are due a reminder, and no clinic: the items are listed across clinics
  // on one page, so the link opens it. `kind` is not printable (it is not a
  // closed word in ./words.ts), so the wording does not name it.
  approval_waiting: {
    title: "Steps are waiting for your yes in the console",
    headline: "{count:approval} waiting for your yes, now past due",
    whatHappened:
      "{count:approval} waiting for your yes, now past due. Each is a step only you can allow, such as retrying a billing change that failed at Stripe on every try. Nothing is carried out until you approve it, and nothing is approved by waiting.",
    whyItMatters:
      "Until you decide, what Stripe bills and what the clinic has may not match. After a week an item leaves the list without running, and the clinic's Billing tab is then where to retry it.",
    steps: [
      "Open the Queues page and find each item under Approvals: it says what approving does, in money where money moves, and what the clinic's billing shows now.",
      "Press Approve on the Queues page if what it says is right, and enter the code from your authenticator. The same action as the button on the clinic's Billing tab runs once, and the item records whether it worked.",
      "Press Reject on the Queues page if it should not run, and pick the reason. Nothing is carried out, and the item leaves the list.",
      "Check History on the Queues page. You are done when each item reads carried out, failed or rejected.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
