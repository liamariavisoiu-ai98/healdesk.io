import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "offboarding" section of docs/on-call.md's alert runbook. The Care
 * tab's Offboarding card (apps/web CarePanel.tsx) shows the rule, the export's
 * due day and the destruction day, and holds every record an operator makes;
 * the dates themselves (destroyAt, exportDueAt, serviceEndedAt) are not
 * printable in an alert, so each step sends the reader there. The export's
 * safest route is the practice's own download under Conversations in its
 * portal, which records delivery by itself (lib/portal/conversations.ts
 * confirmClinicExport); the host's bundle is the one-off patient-export task
 * (infra/aws, run-task), which needs AWS access, so the owner runs it. The
 * Touch log takes a note for every clinic until its account is closed
 * (lane N3, lib/ops/health.ts touchRefusal); a destroyed clinic's account
 * may be closed already, so the step says what to do then.
 */

/** The one Touch log step, for a clinic whose log may be gone. */
const NOTE_IT =
  "Press Record in the Touch log on the clinic's Care tab to note it. If the clinic's account is already closed, it takes no note: tell the owner what you did instead, with no patient detail.";

const DOWNLOAD_ROUTE =
  "Ask the practice, on its published number shown under Phone line on its Setup tab, to press Download every record under Conversations in its portal. A download that arrives in full records the export as delivered by itself: that is the safest route.";

const HOST_ROUTE =
  "Deliver the export yourself only if the practice cannot: the bundle is made on the AWS host by the one-off patient-export task, run from the task script with the clinic's id, which needs AWS access, so ask the owner to run it. Not the npm command the Offboarding card shows. Hand it over by the secure channel our incident procedure names; producing it records nothing.";

const RECORD_HANDOVER =
  "Press Record export delivered under Offboarding on the Care tab, saying how it was handed over, only for a bundle you handed over yourself: the portal download records itself. Do not press it before the practice has the bundle.";

export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised once per clinic by the destruction job (lib/offboarding) from day
  // 21 after a clinic on the thirty days (BAA 1.2.2 or earlier, or no
  // agreement) left with no export recorded as delivered. The export is owed
  // whether or not the practice asks: those agreements give it "on request",
  // but Terms §7 promises it to every leaving practice and the canceled email
  // tells the practice it is coming, so it has no reason to ask.
  export_undelivered_before_destruction: {
    title: "A leaving practice has not had its export yet",
    whatHappened:
      "{clinicName} has left, and 21 days on, no export of its data is recorded as delivered. Its agreement gives thirty days, or it has none on file, so its data is destroyed[ on {destroyAt}], as Offboarding on its Care tab shows, whether or not the export was delivered. Deliver this practice's export before then: Terms §7 promises every leaving practice one within 30 days of the end, whether or not it asks.",
    whyItMatters:
      "The email about its cancellation told the practice an export is coming. Once the data is destroyed there is nothing left to export.",
    steps: [
      "Open the clinic's Care tab and read Offboarding: the rule, the day the data is destroyed, and whether the export is recorded as delivered.",
      DOWNLOAD_ROUTE,
      HOST_ROUTE,
      RECORD_HANDOVER,
      "Check Offboarding on the clinic's Care tab. You are done when it shows Export delivered, before the destruction day.",
    ],
  },
  // The same, from day 21, for a clinic whose agreement (BAA 1.3.0, the DPA)
  // promises the export within thirty days: the data goes on the export's due
  // day if the export is recorded by then, at the next hourly run if it is
  // recorded later, and on the ninety days' last day whether or not it was.
  export_due_undelivered: {
    title: "A leaving practice's export is not delivered",
    whatHappened:
      "{clinicName} has left, and 21 days on, no export of its data is recorded as delivered. Its agreement promises the export within thirty days of the end, without being asked.[ It is due by {exportDueAt}.][ The data waits for it until {destroyAt} at the latest.] Offboarding on its Care tab shows both days.",
    whyItMatters:
      "The export is a promise in the agreement, with a date. The data is destroyed on the export's due day if the export is recorded by then, at the next hourly run if it is recorded later, and on the last day shown whether or not it was; after that there is nothing left to export.",
    steps: [
      "Open the clinic's Care tab and read Offboarding: the export's due day, the last day the data waits, and whether the export is recorded as delivered.",
      DOWNLOAD_ROUTE,
      HOST_ROUTE,
      RECORD_HANDOVER,
      "Check Offboarding on the clinic's Care tab. You are done when it shows Export delivered, by the due day. Destruction then follows on that day, or at the next hourly run if the record came later.",
    ],
  },
  // Raised once by the Stripe webhook (lib/billing/events.ts) when a
  // subscription's end was processed more than a week after it happened, so
  // the database started the clock a week back and no further. `lateDays`
  // is the days the clamp cost; `serviceEndedAt` is not printable.
  offboarding_started_late: {
    title: "A subscription's end was processed over a week late",
    whatHappened:
      "{clinicName}'s subscription ended[ on {serviceEndedAt}], and we processed the end more than a week after it happened. The destruction clock starts at most a week back, so its data is destroyed {lateDays:day} later than its agreement counts from the end.",
    whyItMatters:
      "The agreement counts destruction from the day service ended, not from when we noticed. Only the database owner can bring the destruction forward; nothing in the console can.",
    steps: [
      "Open the clinic's Care tab and read Offboarding: the day the clock started and the destruction day that follows from it.",
      "Open the clinic's Billing tab and look under Parked Stripe events for the subscription's end: an event parked and replayed late is one cause, the host being off is another.",
      "Tell the owner, naming the clinic's Care tab and the days late, so the destruction can be brought forward in the database if the owner decides so. Do not change any date yourself.",
      `${NOTE_IT} You are done when the owner has decided whether to bring it forward.`,
    ],
  },
  // lib/offboarding/account-closure.ts, once per clinic and wait. `code` is
  // what the closure waits on (voice_agent, incident_open, critical_notice,
  // stripe_connect); not printable, so the steps cover each.
  account_closure_waiting: {
    title: "A leaving practice's account cannot close yet",
    whatHappened:
      "{clinicName}'s data has been destroyed and its forwarded calls have stopped passing through, but its account stays open, its sign-in and setup with it, until one thing is done. That is the agent and number released at the voice vendor, an open incident finished, a notice to the practice still waiting to go, or its Stripe connection ended.",
    whyItMatters:
      "The practice was told its sign-in would end and its setup would go once the pass-through ended. While the account stays open, both are still there.",
    steps: [
      "Open the clinic's Care tab and read Offboarding: an outstanding voice-vendor step shows in red with its button. Read Incidents on the same tab for one still open.",
      "Press Record Retell agent release under Offboarding once you have released the clinic's agent and its number in Retell's console and deleted every call Retell holds for it since. Record only what you have done.",
      "Press Resolve under Incidents on the Care tab once the open incident is finished: decided by the owner on the Incidents page under Compliance with Send report or Not reportable, and its work done.",
      "Open the clinic's Deliveries tab and look under Billing emails for a notice still shown as due, with its last error. Put right what the error names, or tell the owner.",
      "Press Disconnect Stripe under Deposits and Stripe Connect on the clinic's Billing tab if it is still connected. Deposits are already over for a destroyed clinic.",
      "Check the clinic's Account tab within the hour: the account closes by itself once nothing is left. You are done when The clinic's address reads No sign-in on file.",
    ],
  },
  // The same file: the closure threw. Hourly while it fails.
  account_closure_failed: {
    title: "A leaving practice's account closure failed",
    whatHappened:
      "{clinicName}'s account was due to close, nothing was left to finish, and the database refused the closure, so its sign-in and setup are still there. It is tried again every hour, and this alert repeats each hour while it fails.",
    whyItMatters:
      "The practice was told its sign-in would end and its setup would go. The closure is also what keeps its notice address for the six years the agreement needs, so a closure that never lands leaves that record unmade.",
    steps: [
      "Open the clinic's Care tab and read Offboarding and Incidents: everything there should already be recorded or resolved, and the Account tab should still show a sign-in.",
      "Tell the owner, naming the clinic: the reason is in the app's error log under account closure, which the console does not show. Do not end the sign-in or remove devices by hand from the Account tab.",
      "Check the clinic's Account tab after the next hour. You are done when The clinic's address reads No sign-in on file.",
    ],
  },
  // lib/offboarding/after-cancellation.ts sendDestructionNotice: `phase` is
  // expired (a week passed, with no delivery row written for that), refused
  // (this side) or rejected (the provider); not printable, and the same
  // by-hand email, with what the notice says (templates/data_destroyed.ts),
  // follows each.
  destruction_notice_undelivered: {
    title: "A practice was not told its data was destroyed",
    whatHappened:
      "{clinicName}'s data has been destroyed, and the email saying so could not be sent to the address on its account. The mail provider refused it, this side refused to send it, or it kept failing for a week. Nothing will try again.",
    whyItMatters:
      "The practice is owed that notice, and healdesk no longer holds the address copied for the email. The account's own address is on the Account tab until the account closes.",
    steps: [
      "Open the clinic's Deliveries tab and look under Reports and alerts for the data-destroyed email: its row says failed and why, or shows no success.",
      "Open the clinic's Account tab and read The clinic's address while it still shows one: that is where the notice goes. If it reads No sign-in on file, the account has closed; ask the owner for the kept notice address.",
      "Write to the practice from hello@ by hand with what the notice would have said. The day its data was destroyed, shown under Offboarding on its Care tab; that its account closes once forwarded calls stop passing through, when its sign-in ends and its address comes off it; and that backup copies expire within 35 days. Say too what our language-model provider keeps under its agreement with us, that the signed agreement and billing records are kept, and that its address is kept six years only as the agreement's notice address.",
      `${NOTE_IT} You are done when the practice has been written to.`,
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
