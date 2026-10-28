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
      "{clinicName} has not received the support reply you approved: {count:try} failed. You approved a reply to the clinic's support request, and it was not delivered: every try failed, or the tries ran past the day in which a repeat is safe, so the sending has stopped. The reply's text is kept as you approved it, but it will not be tried again.",
    whyItMatters:
      "The clinic asked for help and is still waiting for an answer we promised by a day. It does not know a reply was written.",
    steps: [
      "Open the clinic's Deliveries tab and find the support reply under Reports and alerts: its status and reason say why the last try failed.",
      "Check the clinic's address on the Account tab if the reason is a bounce or a suppressed address, and correct it with the clinic first.",
      "Open Support and find the case: it names the topic the clinic asked about.",
      "Write to the clinic from hello@ today with the same answer, and leave patient details out. Nothing in Support sends the approved reply again.",
      "Use Close the case (the button reads Close) once you have written, and pick Replied by hand from the mailbox. You are done when the clinic has its answer and the case is closed.",
    ],
  },
  // lib/approvals/support-reply.ts (lane D), once per case: approving a
  // support reply made the Settings change its draft proposed, and then the
  // reply did not go. The clinic, the case's id and ref; never the words.
  support_action_reply_unsent: {
    title: "A support change was made but its reply did not go",
    headline: "{clinicName}'s setting changed on support case[ {supportRef}]; the reply did not go",
    whatHappened:
      "{clinicName}'s setting was changed from a support case[ {supportRef}], and the reply saying so was not sent. Approving the reply made the Settings change its draft proposed, through the clinic's own Settings, and then the reply could not go: the case was closed or a newer draft replaced it in the same moment, or the sending stopped because the clinic's sign-in address is gone or the case closed.",
    whyItMatters:
      "The clinic's setting is different from yesterday and nobody has told it. The change stays made; nothing undoes it or sends the reply again by itself.",
    steps: [
      "Open Support and find the case[ {supportRef}]: the proposed change shows its setting, its value and that it was made.",
      "Open the clinic's Setup tab and find Clinic switches: check the setting there, so you tell the clinic what it is now.",
      "Write to the clinic from hello@ today saying which setting changed and that it can switch it back in its own Settings, and leave patient details out. Nothing in Support sends the reply again.",
      "Use Close the case (the button reads Close) once you have written, and pick Replied by hand from the mailbox. You are done when the clinic knows and the case is closed.",
    ],
  },
  // lib/support/slack-passcode.ts (lane P7i), on the try that locks: five
  // wrong approval passcodes in the support reply's Slack dialog within
  // fifteen minutes. The count only; the Slack member id is in the log.
  slack_approvals_locked: {
    title: "Approvals from Slack are locked",
    headline: "{count:wrong passcode} typed in Slack within fifteen minutes",
    whatHappened:
      "{count:wrong passcode} were typed in the Slack dialog that approves support replies within fifteen minutes, so approvals from Slack are locked on that server for fifteen minutes. Nothing was approved or sent. The console's own approvals are not affected.",
    whyItMatters:
      "If that was not you, someone with access to the support channel is guessing your approval passcode.",
    steps: [
      "Open Support in the console if a reply cannot wait: the console's approvals still work. If it was you, wait fifteen minutes and try Slack again.",
      "Open the Map page and find the people allowed to press the support reply buttons in Slack, if it was not you: the ops log names the Slack member who typed them. Take that member off the list in AWS CloudShell with the put-external-secrets script, and restart.",
      "Open the Map page and find the approval passcode: make a new one with the hash-approval-passcode script and paste its hash in Vercel and AWS. You are done when the member is off the list and the new passcode works in the console.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
