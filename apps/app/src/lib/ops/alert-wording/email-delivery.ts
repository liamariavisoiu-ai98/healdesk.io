import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "email-delivery" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  critical_notice_undelivered: legacy(
    "A critical email has not gone out",
    "A critical notice to a clinic is still unsent ten minutes after it was due, and /api/health is red until it goes. Check Resend, then call the clinic if it stays stuck.",
  ),
  clinic_address_bounced: legacy(
    "A clinic's address bounced",
    "Mail to a clinic's address bounced permanently, and it has no other address. Call the clinic to correct it.",
  ),
  clinic_address_complained: legacy(
    "A clinic marked our email as spam",
    "Mail to a clinic's address was reported as spam. Call the clinic before anything else is sent to it.",
  ),
  clinic_address_suppressed: legacy(
    "A clinic's address is suppressed",
    "Resend suppressed mail to a clinic's address. Call the clinic, then lift the suppression in Resend's dashboard once the address is confirmed.",
  ),
  daily_email_count_70: legacy(
    "70 emails sent today",
    "The free plan stops at 100 a day, sign-in links and urgent alerts included, until midnight UTC. Move the Resend account to Pro.",
  ),
  // Raised once, ever, by lib/scheduler/dmarc-review.ts. Its one fact is the
  // first day apps/app's records show Resend sending (windowStart, printed as
  // "Day"), which is where the reports to read begin. "Since", not "began on":
  // apps/web may have sent earlier, from a record apps/app cannot read.
  dmarc_review_due: legacy(
    "Time to review the DMARC reports",
    "Resend has been sending as healdesk.io since the day below, 14 or more days ago. Read healdesk.io's DMARC aggregate reports from that day on: if the only senders they show are Resend and the owner's own mail, change healdesk.io's DMARC record from p=none to p=quarantine. If anything else sends as healdesk.io, find out what it is first.",
  ),
  welcome_email_unsent: legacy(
    "A welcome email has not reached a clinic",
    "A clinic's welcome email, its order confirmation with the receipt and the Continue setup link, is still unsent an hour after its account was made, or setup moved on before it could go. Check Resend, then email the order details to the clinic's address by hand.",
  ),
  // Raised by lib/notices/booking-alerts.ts (urgentAlertNotQueued) when an
  // urgent message's L12 could not be queued: the clinic has no email about
  // it and /api/health stays green, so a person has to phone the clinic.
  urgent_alert_not_queued: legacy(
    "An urgent message's alert to the clinic failed",
    "Someone reported a complication or an urgent symptom, and the clinic's urgent alert could not be queued, so the clinic has not been emailed about it. They were given the fixed urgent reply (emergency services, then the clinic's own number), or, where the message could not be recorded at all, asked to contact the practice directly. Phone the clinic now: tell them an urgent message came in on the channel below at about the time this alert was raised; if its conversation was recorded, its transcript reaches their address when it ends. Then read apps/app's error lines for the failure, usually the database.",
  ),
  email_refused: legacy(
    "An email was refused before it was sent",
    "apps/app refused an email of the kind below for the clinic below before sending it: something it was to carry is outside the payload allowlist, or a link in it is not one an email may carry. The clinic has not received it. Read apps/app's error lines for the kind, fix what it was given, and send the clinic what it needed by hand meanwhile.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "critical_notice_undelivered",
  "clinic_address_bounced",
  "clinic_address_complained",
  "clinic_address_suppressed",
  "daily_email_count_70",
  "dmarc_review_due",
  "welcome_email_unsent",
  "urgent_alert_not_queued",
  "email_refused",
]);

/**
 * A dead letter is raised under critical_notice_undelivered too (OPS_EVENTS is
 * shared and kept as it is), with `status: "dead"`, and it reads differently:
 * nothing is still trying.
 */
export const DEAD_LETTER: AlertWording = legacy(
  "An email to a clinic stopped retrying",
  "A notice to a clinic used every retry, or was refused outright, and will not be sent. Read its error in the console, then call the clinic.",
);
