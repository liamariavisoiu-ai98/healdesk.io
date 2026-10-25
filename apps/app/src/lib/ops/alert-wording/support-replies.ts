import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "support-replies" section of docs/on-call.md's alert runbook (ops automation lane P7c). */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/support/send.ts, once an hour per clinic: a reply the owner approved
  // failed every try (six, on the email outbox's schedule), so the sending
  // stopped. The clinic and the count of tries only; never the reply's words.
  support_reply_dead: {
    title: "A support reply you approved could not be sent",
    headline: "{clinicName} has not received the support reply you approved: {count:try} failed",
    whatHappened:
      "{clinicName} has not received the support reply you approved: {count:try} failed. You approved a reply to the clinic's support request, and every try to send it failed, so the sending has stopped. The reply's text is kept as you approved it, but it will not be tried again.",
    whyItMatters:
      "The clinic asked for help and is still waiting for an answer we promised by a day. It does not know a reply was written.",
    steps: [
      "Open the clinic's Deliveries tab and find the support reply under Reports and alerts: its status and reason say why the last try failed.",
      "Check the clinic's address on the Account tab if the reason is a bounce or a suppressed address, and correct it with the clinic first.",
      "Open the Queues page and find the case under Support: it names the topic the clinic asked about.",
      "Write to the clinic from hello@ today with the same answer, and leave patient details out. Nothing on the Queues page sends the approved reply again.",
      "Close the case under Support once you have written. You are done when the clinic has its answer and the case is closed.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
