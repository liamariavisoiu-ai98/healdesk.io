import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "setup-progress" section of docs/on-call.md's alert runbook: the
 * lifecycle watch's waves (lib/lifecycle/waves.ts), once per wave. The setup
 * reminders themselves go to the clinic unchanged; these are ours. Every
 * step names the Setup tab's "Setup window" card (lane A3): its controls are
 * "Extend the setup window", "Offered a call", "Let it close" and "Snooze
 * alerts", and the alert's link lands on that card. The undelivered-reminder
 * alert lands on the Deliveries tab's "Reminders" instead.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Days 7 and 15 of the window, while the clinic has not moved for five
  // days or never has. Routine: Slack alone.
  lifecycle_no_progress: {
    title: "A clinic's setup has not moved for days",
    whatHappened:
      "{clinicName} has {stepsLeftCount:step} still to do[ and {remainingDays:day} left] in its 30-day setup window.[ It has made no progress for {noProgressDays:day}.] Its own setup reminders keep going every five days.",
    whyItMatters:
      "A setup that stops moving usually needs a nudge, not a rescue. If nothing is live when the window ends, the account closes and the setup fee is not refunded.",
    steps: [
      "Open the clinic's Setup tab and read the Setup window card: the days left, the last progress and what we suggest.",
      "Stop here if Last progress on the Setup window card is recent: the clinic has moved since this alert.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, and offer a five-minute call to finish setup together.",
      "Press Offered a call on the Setup window card once you have offered one, so the card and later alerts know.",
      "Press Snooze alerts on the Setup window card if you want no routine alert about this clinic for 3, 7 or 14 days. Escalations still come through.",
      "Check the Setup window card in a few days: you are done when Last progress has moved, or Decision so far shows the call you offered.",
    ],
  },
  // Days 22 to 30, for a clinic that is NOT stalled: one step or none owed,
  // and someone has answered a setup screen. Routine: Slack alone.
  lifecycle_closing_soon: {
    title: "A setup window closes soon and the clinic is nearly done",
    whatHappened:
      "{clinicName} has {remainingDays:day} left in its setup window (0 means today is the last day) and only {stepsLeftCount:step} to do.[ It has made no progress for {noProgressDays:day}.]",
    whyItMatters:
      "No decision is owed: the clinic is close and moving. If nothing is live when the window ends, the account closes and the setup fee is not refunded, so a short extension is cheap if it asks.[?recommendation=extend: Our rules suggest {extendDays:day} more.][?recommendation=offer_call: Our rules suggest offering a five-minute call.][?recommendation=wait: Our rules suggest waiting.][?recommendation=phone_the_clinic: Our rules suggest phoning the clinic.][?recommendation=let_close: You decided to let this setup close.]",
    steps: [
      "Open the clinic's Setup tab and read the Setup window card: the window's end, the last progress and what we suggest.",
      "Wait if Last progress on the Setup window card is recent: the clinic is finishing on its own.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, if it has gone quiet, and ask whether it needs help with the last step.",
      "[?recommendation=extend|wait|offer_call|phone_the_clinic: Press Extend the setup window on the Setup window card if the clinic asks for more time. The days box starts at our suggestion; change it if you agreed otherwise.]",
      "[?recommendation=let_close: Leave the Setup window card as it is: you decided to let this setup close, and the day-27 and day-30 warnings to us are off.]",
      "Check the Setup window card: you are done when the clinic is live, Window ends has moved, or the clinic has said it will finish in time.",
    ],
  },
  // Days 22, 27 and 30, for a stalled clinic (owner decision D7): two steps
  // or more owed, or no setup screen answered. An escalation: Slack with a
  // siren, and the ops address.
  lifecycle_decision_due: {
    title: "A stalled setup closes soon: decide what to offer",
    whatHappened:
      "{clinicName} has {remainingDays:day} left to finish setting up AYA, with {stepsLeftCount:step} still to do.[ It has made no progress for {noProgressDays:day}.]",
    whyItMatters:
      "If nothing is live when the window ends, the account closes and the setup fee is not refunded.[?recommendation=extend: Our rules suggest giving it more time.][?recommendation=offer_call: Our rules suggest offering a short call.][?recommendation=phone_the_clinic: Our rules suggest phoning the clinic first.][?recommendation=wait: Our rules suggest waiting a few more days.][?recommendation=let_close: Our rules suggest letting it close.]",
    steps: [
      "Open the clinic's Setup tab and read the Setup window card: the days left, the last progress, the decision so far and what we suggest.",
      "Phone the clinic on its published number, shown under Phone line on the same tab, and ask how it wants to go on.[?recommendation=extend|offer_call|phone_the_clinic|wait: Offer a five-minute call to finish the steps together.][?recommendation=let_close: Confirm it is happy for the setup to close.]",
      "[?recommendation=extend: Press Extend the setup window on the Setup window card if the clinic needs more time. The days box starts at our suggestion; change it if you agreed otherwise.]",
      "[?recommendation=offer_call|phone_the_clinic|wait: Press Offered a call on the Setup window card once you have offered one. Press Extend the setup window there only if the clinic asks for more time.]",
      "[?recommendation=let_close: Leave the setup window as it is. Press Let it close on the Setup window card to record the clinic's agreement: the window still closes on its last day, and only the two closing warnings to us stop. Do not press it if the clinic wants to go on.]",
      "Check the Setup window card: Decision so far shows what you recorded. You are done when Window ends has moved, a call is offered and recorded, or Let it close is recorded.",
    ],
  },
  // Days 27 and 30 for a clinic that has done its part and waits on us. An
  // escalation, whatever was decided before: a closure now would be our delay.
  lifecycle_closing_waiting_on_us: {
    title: "A clinic waiting on us is about to lose its setup window",
    whatHappened:
      "{clinicName} has finished every setup step it can and has waited on us for {waitedDays:day} to finish a channel. Its setup window has {remainingDays:day} left (0 means today is the last day).",
    whyItMatters:
      "The window closes the account at its end whether the delay was ours or not, and the setup fee is not refunded. Days waiting on us never extend the window by themselves.[?recommendation=extend: Our rules suggest extending by {extendDays:day}, the time it waited.]",
    steps: [
      "Open the clinic's Setup tab. The Setup window card shows the window's end; the Go live and Channels cards list what is still missing on our side.",
      "Press Extend the setup window on the Setup window card first, by at least the days the clinic waited. The days box starts at our suggestion. Do not press Let it close: the delay is ours.",
      "Fix today what the Go live and Channels cards on the Setup tab list as missing on our side. Go-live is automatic once that list is empty.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, if our side will take more than a day, and tell it we are finishing it.",
      "Check the Setup window card: you are done when Window ends shows the new date and the Channels card shows the channel ready or live.",
    ],
  },
  // Four hours, then one business day, into waiting on us. Routine: Slack alone.
  lifecycle_waiting_on_us: {
    title: "A clinic is waiting on us to finish its setup",
    whatHappened:
      "{clinicName} has done every setup step it can. A channel it bought is still being prepared on our side, and it has waited {waitedHours:hour}.",
    whyItMatters:
      "Nothing answers for this clinic until we finish, and every hour it waits is ours, not the clinic's. Its setup window keeps running meanwhile: the days it waits on us do not extend it by themselves.",
    steps: [
      "Open the clinic's Setup tab: the Channels card says which channel is not ready on our side, and the Go live card lists what is missing.",
      "Fix what the Channels card and the Go live card list on our side. Go-live is automatic: the clinic goes live by itself once nothing is left.",
      "Press Ask the practice questions again on the Channels card if a channel is waiting on its practice questions after a fix on our side.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, if our side will take more than a day, and tell it we are finishing it.",
      "Check the Channels card: you are done when the channel shows ready or live.",
    ],
  },
  // Two business days or more waiting on us. An escalation, proposing the
  // days waited as the extension.
  lifecycle_waiting_on_us_long: {
    title: "A clinic has waited on us for two business days",
    whatHappened:
      "{clinicName} finished every setup step it can {waitedDays:day} ago and is still waiting for us to finish a channel. That is two business days or more.",
    whyItMatters:
      "The clinic did its part and nothing answers for it yet. Its setup window keeps running: the days it waited do not extend it by themselves, and our rules suggest giving them back[: {extendDays:day}].",
    steps: [
      "Open the clinic's Setup tab: the Channels card says which channel is not ready on our side, and the Go live card lists what is missing.",
      "Fix today what the Channels card and the Go live card list. Press Ask the practice questions again on the Channels card if a channel waits on its practice questions after your fix.",
      "Press Extend the setup window on the Setup window card by the days the clinic waited. The days box starts at our suggestion. Do not press Let it close: the delay is ours.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, and tell it we are finishing our side.",
      "Check the Channels card: you are done when the channel shows ready or live and Window ends on the Setup window card has moved.",
    ],
  },
  // Seven and fourteen days partly live, while a channel still waits on the
  // clinic. Routine: Slack alone. The Setup window card has no decision
  // controls in this stage: the window no longer closes the account.
  lifecycle_channel_waiting: {
    title: "A live clinic still has a channel waiting on it",
    whatHappened:
      "{clinicName} has had a channel answering for {waitedDays:day}, with {channelsWaitingCount:channel} still waiting on one step from the clinic.",
    whyItMatters:
      "The clinic is paying for a channel it is not getting, and people on that channel still reach nobody from AYA. Its setup window no longer closes the account, so this is a nudge, not a deadline.",
    steps: [
      "Open the clinic's Setup tab: the Channels card shows which channel is waiting and the one step the clinic owes for it.",
      "Check the clinic's Deliveries tab under Reminders: the clinic's one reminder for that channel shows there if it was sent, and whether it arrived.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, and offer a five-minute call to do that step together. A short call usually finishes it.",
      "Check the Channels card on the Setup tab: you are done when that channel shows live.",
    ],
  },
  // A setup reminder bounced or failed, and none since has arrived. An
  // escalation. Raised only when no alert about the address went already;
  // otherwise that alert stands for it.
  lifecycle_reminder_undelivered: {
    title: "A setup reminder did not reach the clinic",
    whatHappened:
      "A setup reminder we emailed {clinicName} bounced or could not be sent, and no later reminder has arrived. The clinic still has {stepsLeftCount:step} to do and is not hearing from us.",
    whyItMatters:
      "Every reminder, every notice and the sign-in link go to this one address. Until it works, the clinic cannot be reached by email at all, and its setup window keeps running.",
    steps: [
      "Open the clinic's Deliveries tab and find the reminder under Reminders: it shows bounced or failed, with the date.",
      "Open the clinic's Account tab: The clinic's address shows the address we have. Phone the clinic on its published number, shown under Phone line on its Setup tab, and check it.",
      "Press Enter the change under The clinic's address on the Account tab if the clinic gives a corrected address, and only after it confirmed it on that call. It needs your authenticator code and takes effect 72 hours later.",
      "Check under Reminders on the Deliveries tab after the next reminder goes: you are done when it shows delivered.",
    ],
  },
  // Two numbered reminders in a row arrived and the clinic has not moved
  // since the first. An escalation, once until the clinic moves.
  lifecycle_reminders_unanswered: {
    title: "Two setup reminders arrived and nothing moved",
    whatHappened:
      "{clinicName} was sent two setup reminders in a row that arrived[, {reminderCount:reminder} in all,] and has made no progress since the first of them.[ Its last progress was {noProgressDays:day} ago.] It has {stepsLeftCount:step} still to do.",
    whyItMatters:
      "Email is not moving this clinic. If nothing is live when the window ends, the account closes and the setup fee is not refunded. A phone call is the next step, not another email.",
    steps: [
      "Open the clinic's Setup tab and read the Setup window card: the days left, the last progress and what we suggest.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, and offer a five-minute call to finish setup together. Ask whether our emails reach the right person.",
      "Press Offered a call on the Setup window card once you have offered one, to record it.",
      "Press Extend the setup window on the Setup window card only if the clinic asks for more time. Do not extend because the reminders went unanswered: that is not a request.",
      "Check the Setup window card: you are done when Last progress has moved or Decision so far shows the call you offered.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
