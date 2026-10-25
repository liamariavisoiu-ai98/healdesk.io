import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "approvals" section of docs/on-call.md's alert runbook (ops automation
 * Phase 6, lane P6a): the approval inbox, where each money, legal and
 * clinic-contact step waits for the owner's yes.
 *
 * The inbox's screen is Queues › Approvals (lane P6b, apps/web
 * app/admin/queues/ApprovalsSection.tsx, `/admin/queues#approvals`): each
 * item with Approve and Reject behind the field "Code from your
 * authenticator", and a History tab. Those names are in ./places.ts with
 * their proofs, and the steps name them; History prints each event as the
 * words step 4 quotes (apps/web components/admin/approval-words.ts
 * EVENT_WORDS).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Only what no automatic process retries is ever proposed (owner decision
  // D17; lib/approvals/proposers.ts): a plan start, a step-up or an overage
  // invoice only while the job that retries it is switched off. So "nothing
  // is carried out until you approve it" holds for every kind in the list,
  // and a rejected item is still retried by that job once it is switched on.
  // lib/approvals/proposers.ts remind, once per kind: a money or routine
  // item waiting past its due time (a day after it was proposed), once; a
  // legal-clock item every 4 hours while it waits (owner decision D18; no
  // kind has a legal clock yet). Raised with the kind and how many items
  // are due a reminder, and no clinic: the items are listed across clinics
  // on one page, so the link opens it. `kind` is not printable (it is not a
  // closed word in ./words.ts), so the wording does not name it. A Stripe
  // event that resolved to no clinic is listed (proposers.ts) and is on no
  // clinic's Billing tab, which lists parked events by resolved clinic.
  approval_waiting: {
    title: "Steps are waiting for your yes in the console",
    headline: "{count:approval} waiting for your yes, now past due",
    whatHappened:
      "{count:approval} waiting for your yes, now past due. Each is a step only you can allow: a billing change the billing worker gave up on, a Stripe event parked after its retries, or an extra-usage invoice that failed. A plan start, a price step-up or an extra-usage invoice is listed only while the job that retries it is switched off. While the approvals job is on, nothing in the list is retried by itself. Nothing is carried out until you approve it, and nothing is approved by waiting.",
    whyItMatters:
      "Until you decide, what Stripe bills and what the clinic has may not match. After a week an item leaves the list without running, and the clinic's Billing tab is then where to retry it by hand. A Stripe event with no clinic is on no clinic's Billing tab; Approve on the Queues page is the only button that replays it.",
    steps: [
      "Open the Queues page and find each item under Approvals: it says what approving does, in money where money moves, and what the clinic's billing shows now.",
      "Press Approve on the Queues page if what it says is right, and enter the code from your authenticator. The same action as the button on the clinic's Billing tab runs once, and the item records whether it worked. A billing change is made due again, and the billing worker carries it out at its next run. A Stripe event with no clinic is on no clinic's Billing tab; Approve on the Queues page is the only button that replays it.",
      "Press Reject on the Queues page if it should not run, pick the reason and enter the code. Nothing is run now, and this failure is not proposed again. If the job that retries it is switched on later, that job still retries it. The clinic's Billing tab is where to retry it by hand.",
      "Check History on the Queues page. You are done when each item reads went through, failed, rejected or left the list without running.",
    ],
  },
  // Lane P6f: the same reminder for an email to a clinic (the BAA version
  // re-sign chase, the agreement question, more time for setup, the
  // waiting-on-us note, the five-minute call, a setup reminder sooner), once
  // past its due time (two days, one for the reminder), per kind with the
  // count and no clinic. Their windows are KIND_SPECS': 14 days, 3 for the
  // reminder. An extension runs before its email, and the email goes only
  // if it went through (lib/approvals/contact-executors.ts).
  clinic_email_waiting: {
    title: "Emails to clinics are waiting for your yes",
    headline: "{count:email} to a clinic waiting for your yes, now past due",
    whatHappened:
      "{count:email} to a clinic waiting for your yes, now past due. Each is an email only you can send: a chase to sign an updated agreement, a question about which agreement a practice needs, more time to finish setup, a note that we are finishing a step, an offer of a five-minute call, or a setup reminder sent sooner. Nothing goes to a clinic until you approve it, and nothing is sent by waiting.",
    whyItMatters:
      "Until you decide, the clinic hears nothing more from us about it. After two weeks an email leaves the list unsent, and a reminder sent sooner after three days; the clinic's own setup reminders still go on their days.",
    steps: [
      "Open the Queues page and find each email under Approvals: it shows the email as the clinic would read it, what approving does, and the choices you may change.",
      "Change only what is offered if you need to, then press Approve on the Queues page and enter the code from your authenticator. The email goes once. For more time, the deadline moves first and the email goes only if it moved.",
      "Press Reject on the Queues page if it should not go, pick the reason and enter the code. Nothing is sent.",
      "Check History on the Queues page. You are done when each item reads went through, failed, rejected or left the list without running.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
