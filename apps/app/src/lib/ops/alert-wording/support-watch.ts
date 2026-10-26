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
      "Open Support and find the case[ {supportRef}] under Needs you. It shows the topic and the state, never the clinic's words.",
      "Open the case, read the draft reply, edit it if it needs it, and use Send the reply (the button reads Send) with the code from your authenticator. It goes to the clinic's one sign-in address, once. If the case says its reply was already approved, it is being tried again and needs nothing from you; if it says the sending stopped, write to the clinic yourself.",
      "Write to the clinic from hello@ today if no draft is there or it cannot be fixed, and leave patient details out. Then use Close the case (the button reads Close) and pick Replied by hand from the mailbox.",
      "Check Support again. You are done when the case shows under Waiting on the clinic or Closed.",
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
      "Open Support and find the case[ {supportRef}] under Needs you. It shows the topic and what the clinic chose in the chat, never its words.",
      "Phone the clinic today on the number on its Account tab if calls are not reaching AYA or are ringing out, and check its Phone line card on the Setup tab while you talk.",
      "Open the case and read the draft reply, then use Send the reply (the button reads Send) with the code from your authenticator, or write to the clinic from hello@ yourself and use Close the case (the button reads Close) with the reason Replied by hand from the mailbox. Leave patient details out.",
      "Check Support again. You are done when the clinic has an answer and the case shows under Waiting on the clinic or Closed.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
