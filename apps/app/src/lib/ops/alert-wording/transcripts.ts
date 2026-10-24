import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "transcripts" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The transcript outbox (lib/conversations/transcript-outbox.ts), once per
  // transcript and state: the third failed send (status retrying), SES's
  // bounce, rejection, complaint or rendering failure (the event's type),
  // a copy deleted unanswered 72 hours after an accepted send
  // (unconfirmed), or deleted undelivered 30 days after queueing
  // (expired). The status and SES's reason are not printed; the clinic's
  // Deliveries tab shows each receipt's status.
  transcript_undelivered: {
    title: "A transcript could not be emailed to the clinic",
    whatHappened:
      "The transcript of a call or chat at {clinicName} has not reached the clinic. Either the send has failed three times, the clinic's mail server bounced or rejected it, nothing confirmed a send for 72 hours, or 30 days passed undelivered. In the last two cases our copy is now deleted.",
    whyItMatters:
      "We keep no transcript: a copy deleted undelivered is gone for good, and only the call or chat's time and outcome remain. A bounce usually means the clinic's one address is wrong, so every other email to it is at risk too.",
    steps: [
      "Open the clinic's Deliveries tab, choose Transcripts and read Newest receipts: the row's status says Bounced, Waiting to send, Deleted unanswered or Deleted after 30 days.",
      "Phone the clinic on its published number for a row that is Bounced, and check its address on the Account tab; a wrong address is changed there with Enter the change. Then press Send again beside the row: the copy goes to the clinic's address within a minute.",
      "Press Send again beside a row that is Waiting to send only after fixing the cause. Open the Map page under System and press Missing or broken if every transcript waits: Amazon's email setting must be in place for any to go.",
      "Phone the clinic if a row under Newest receipts says Deleted: tell it one transcript was lost and cannot be sent again. Never ask the clinic to read the transcript to you or to send it back.",
      "Check Newest receipts again. You are done when the row shows Delivered, or the clinic has been told the copy is gone.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
