import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "answering" section of docs/on-call.md's alert runbook: the workflows
 * behind the routed/answered counter's three emails (lib/channels/
 * answer-notices.ts; docs/design/launch-readiness-2026-10-27/
 * gate-b-notice-workflows.md). Each alert is raised once per incident or
 * case, after the transaction that opened it and queued its email.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Once per outage incident, as it opens and L17 is queued.
  aya_outage_started: {
    title: "AYA kept failing at a clinic for ten minutes",
    headline: "{clinicName}: AYA kept failing for ten minutes",
    whatHappened:
      "Calls or messages to {clinicName} kept failing for at least ten minutes[, from {windowStart}], each within ten minutes of the one before, with none answered in between. We have emailed the clinic that the cause is on our side, that we are working on it, and that we will email it the moment it is fixed.",
    whyItMatters:
      "The clinic was told we are working on it. If it is still not fixed, the alert comes again two hours after it opened, and the clinic hears nothing more until AYA answers again.",
    steps: [
      "Open the Jobs page under System: if recent runs show failed, the fault is ours and every clinic is affected, not one.",
      "Check the clinic's Care tab and the Misses and outages list on the Queues page: they show which channels failed and since when.",
      "Fix the cause, then make a test call or send a test message. The clinic is emailed that AYA is answering again by itself, once she has answered for ten minutes with nothing failing. You are done when the incident shows closed in Misses and outages.",
    ],
  },
  // Two hours after the incident opened with no recovery, then every twelve hours.
  aya_outage_unresolved: {
    title: "An outage at a clinic needs a call from you",
    headline: "{clinicName}: AYA is still not answering, hours after we told the clinic",
    whatHappened:
      "AYA has still not answered again at {clinicName}[ since {windowStart}]. The clinic was told at the start that we are working on it and will email it the moment it is fixed. This is reminder[ {count}] about the same incident.",
    whyItMatters:
      "The clinic is waiting on a promise we made in writing. It hears from us again only when AYA answers, so while it lasts this long a person should tell it what is happening.",
    steps: [
      "Open the Misses and outages list on the Queues page and read the incident: when it started, its channels and when it was escalated.",
      "Phone the clinic during its opening hours on its published number, shown under Phone line on its Setup tab, or email it from hello@, and say what is wrong and when you expect AYA back.",
      "Note the call on the Touch log of the clinic's Care tab. You are done when AYA answers again and the incident shows closed in Misses and outages.",
    ],
  },
  // Once per miss case, as it opens and L21 is queued.
  aya_miss_case_opened: {
    title: "AYA missed a clinic's call or message in its first month",
    headline: "{clinicName}: AYA missed a call or message, and the clinic was told",
    whatHappened:
      "Our records show AYA did not answer[ {count}] call or message[ on {channel}] to {clinicName} in a day of its first month. We emailed the clinic that we are looking into why and will fix it so it does not happen again.",
    whyItMatters:
      "The clinic was told we are fixing it. Look into it[ by {promisedOn}]. A miss in the first month can also mean a refund of the first month under the guarantee, if the account owner claims it.",
    steps: [
      "Open the Misses and outages list on the Queues page and find the case by its ref.",
      "Press Mark looking while you find out why. Read the Jobs page and the clinic's Care tab for the cause.",
      "Press Mark explained once it is fixed, with a closing note of one or two plain lines: the clinic reads it in its portal beside each missed call or chat. Nothing is emailed.",
      "Check the Support page for a reply from the clinic, and answer it there.",
      "Press Close miss case once nothing more is owed. You are done when the case shows closed.",
    ],
  },
  // An incident opened within an hour of the last one closing: no L17, no L18 for it.
  aya_outage_flapping: {
    title: "A clinic's outage came back within the hour",
    headline: "{clinicName}: AYA is failing again soon after recovering",
    whatHappened:
      "Calls or messages to {clinicName} have kept failing for ten minutes again, less than an hour after we emailed the clinic that AYA is answering again. We did not email the clinic this time, and will not email it when this one ends either, so it is not told \"can't answer\" and \"answering again\" over and over.",
    whyItMatters:
      "The clinic believes AYA is answering. Until this settles, only you know she is not, and a fault that comes and goes is often one that will not fix itself.",
    steps: [
      "Open the Misses and outages list on the Queues page: the incident is open there, marked as not emailed.",
      "Open the Jobs page under System and the clinic's Care tab to find why AYA keeps dropping.",
      "Phone the clinic during its opening hours, or email it from hello@, if it goes on, and note it on its Touch log. You are done when AYA answers steadily and the incident shows closed.",
    ],
  },
  // The minute sweep behind L17, L18 and L21 has failed several runs in a row.
  answer_notices_failing: {
    title: "The answering-emails sweep keeps failing",
    headline: "The answering sweep has failed[ {count}] runs in a row",
    whatHappened:
      "The minute sweep that settles unanswered calls and chats, and opens outages and miss cases, has failed[ {count}] runs in a row. While it fails, no clinic is emailed that AYA cannot answer, that she is answering again, or that a first-month call was missed.",
    whyItMatters:
      "Those emails are promises in the Terms and in our own emails. Each run that fails delays them for every clinic.",
    steps: [
      "Open the Jobs page under System and read the answer-notices runs: the note says how many clinics failed, and the database is the usual cause.",
      "Fix it. You are done when an answer-notices run on the Jobs page shows ok; the emails it held back then go by themselves.",
    ],
  },
  // A notice of the counter's whose transaction failed: the next minute tries again.
  answer_notice_not_queued: {
    title: "An answering email could not be queued",
    headline: "{clinicName}: an email about AYA missing calls could not be queued",
    whatHappened:
      "An email to {clinicName} about AYA not answering could not be queued, so the outage or miss case it opens was not opened either. Every minute it is tried again.",
    whyItMatters:
      "Until it goes, the clinic does not know AYA is missing calls, or that she is answering again, and nothing is listed for you to follow up.",
    steps: [
      "Open the Jobs page under System: if recent runs show failed, the database is the likely cause, and the email goes once it is back.",
      "Check the Misses and outages list on the Queues page a few minutes later. You are done when the incident or case shows there.",
    ],
  },
};

/** None of the section's events is carried over unchanged. */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
