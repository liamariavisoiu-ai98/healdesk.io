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
    headline: "{clinicName}'s transcript has no delivery report: it may not have arrived",
    whatHappened:
      "{clinicName}'s transcript has no delivery report: it may not have arrived. Either the send of a call or chat's transcript has failed three times, the clinic's mail server bounced, rejected or reported it, nothing confirmed a send for 72 hours, or 30 days passed undelivered. In the last two cases our copy is now deleted.",
    whyItMatters:
      "We keep no transcript: a copy deleted here cannot be sent again, and only the call or chat's time and outcome remain. A bounce usually means the clinic's one address is wrong, so every other email to it is at risk too.",
    steps: [
      "Open the clinic's Deliveries tab, choose Transcripts and read Newest receipts: the row's status says Bounced, Waiting to send, Deleted unanswered or Deleted after 30 days.",
      "Phone the clinic on its published number for a row that is Bounced, and check its address on the Account tab. If it is wrong, enter the new one with Enter the change: it needs a fresh code from your authenticator and the tick that you called the practice back, and it takes effect 72 hours later.",
      "Press Send again beside a Bounced row only once the new address is in effect, or the clinic has fixed its mailbox: until then the copy is kept and retried every hour, to the address on file. For a row that is Waiting to send, open the Map page under System and press Missing or broken first: Amazon's email setting must be in place for any to go.",
      "Phone the clinic if a row under Newest receipts says Deleted. For Deleted unanswered, ask whether that day's transcript arrived: Amazon accepted it but sent us no report, so the clinic may have it. For Deleted after 30 days it never arrived: say one transcript was lost and cannot be sent again. Never ask the clinic to read the transcript to you or to send it back.",
      "Tell whoever maintains the engine if several rows under Newest receipts say Deleted unanswered: delivery reports are not reaching us.",
      "Check Newest receipts again. You are done when the row shows Delivered, or the clinic has been told what happened to its copy.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
