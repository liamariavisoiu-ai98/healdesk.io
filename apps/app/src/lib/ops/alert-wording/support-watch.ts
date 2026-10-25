import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "support-cases" section of docs/on-call.md's alert runbook (ops automation lane P7e). */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/support/watch.ts, from the hourly ops watch, once per case, ever: a
  // case that still needs us (nothing sent yet) whose reply-by day has passed
  // in New York. It replaces support_reply_past_due for every chat escalation
  // recorded on a case, so one promise raises one alert. The clinic, the
  // case's ref and its reply-by day; never the clinic's words.
  support_case_past_due: {
    title: "A support case is past the day we promised a reply",
    headline: "{clinicName} has had no reply to its support case[ {supportRef}], promised by {promisedOn}",
    whatHappened:
      "{clinicName} has had no reply to its support case[ {supportRef}], promised by {promisedOn}. The clinic asked for help through its portal's support chat, and we told it a person would reply by that day. No reply has been sent on the case yet: it is still new, being drafted, drafted and waiting for your yes, or waiting for an edit.",
    whyItMatters:
      "The clinic is waiting on a written promise that has now passed, and it does not know whether anyone has read its request. Nothing is ever sent without your approval, so the case waits on you.",
    steps: [
      "Open the Queues page and go to Support: find the case[ {supportRef}]. It shows the topic and the state, never the clinic's words.",
      "Read the draft reply beside the case if one is waiting for your yes, edit it if it needs it, and press Approve with the code from your authenticator. It goes to the clinic's one sign-in address, once.",
      "Write to the clinic from hello@ today if no draft is there or it cannot be fixed, and leave patient details out. Then close the case under Support as replied by hand.",
      "Check the case under Support again. You are done when it shows waiting on the clinic or closed.",
    ],
  },
  // lib/support/watch.ts, from the ops watch every minute, once per case,
  // ever: a case of urgency `now` (AYA not answering, calls ringing out, a
  // charge in question, a lost device, sign-in security) that still needs
  // us. The ops Slack sweep posts it, as it posts every alert. The clinic,
  // the case's ref and its reply-by day; never the clinic's words.
  support_case_now: {
    title: "A support case needs a person now",
    headline: "{clinicName} needs help now on support case[ {supportRef}]; reply by {promisedOn}",
    whatHappened:
      "{clinicName} needs help now on support case[ {supportRef}]; reply by {promisedOn}. The clinic asked through its portal's support chat about something that cannot wait: calls not reaching AYA or ringing out, a charge it questions, a lost device, or the security of its sign-in.",
    whyItMatters:
      "While this waits, callers may be reaching no one, or the clinic's money or account may be at risk. A draft reply may follow, but nothing is sent without your approval, so a person has to act.",
    steps: [
      "Open the Queues page and go to Support: find the case[ {supportRef}]. It shows the topic and what the clinic chose in the chat, never its words.",
      "Phone the clinic today on the number on its Account tab if calls are not reaching AYA or are ringing out, and check its Phone line card on the Setup tab while you talk.",
      "Read the draft reply beside the case if one is waiting for your yes, and press Approve with the code from your authenticator, or write to the clinic from hello@ yourself and close the case as replied by hand. Leave patient details out.",
      "Check the case under Support again. You are done when the clinic has an answer and the case shows waiting on the clinic or closed.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
