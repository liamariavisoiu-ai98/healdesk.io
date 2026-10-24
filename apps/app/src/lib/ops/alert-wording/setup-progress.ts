import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "setup-progress" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The lifecycle watch (lib/lifecycle/waves.ts), once per wave. The setup
  // reminders themselves go to the clinic unchanged; these are ours.
  lifecycle_no_progress: legacy(
    "A clinic's setup has not moved in days",
    "The clinic below is in its setup window and has made no progress for the days shown, with the steps shown still left. Its own reminders are going out as usual. Open its onboarding page to see what is left, and consider a call if nothing moves before day 22.",
  ),
  lifecycle_closing_soon: legacy(
    "A clinic's setup window closes soon",
    "The clinic below has the days shown left in its setup window and is close to done. No decision is owed yet: watch it, and extend its deadline from the Billing page only if it asks or stops moving.",
  ),
  // Today's true steps use the Touch log. Lane A3 is adding the Setup
  // window card's own controls; lane N2 swaps them in once they exist.
  lifecycle_decision_due: {
    title: "A stalled setup closes soon: decide what to offer",
    whatHappened:
      "{clinicName} has {remainingDays:day} left to finish setting up AYA, with {stepsLeftCount:step} still to do.[ It has made no progress for {noProgressDays:day}.]",
    whyItMatters:
      "If nothing is live when the window ends, the account closes and the setup fee is not refunded.[?recommendation=extend: Our rules suggest giving it more time.][?recommendation=offer_call: Our rules suggest offering a short call.][?recommendation=phone_the_clinic: Our rules suggest phoning the clinic first.][?recommendation=wait: Our rules suggest waiting a few more days.][?recommendation=let_close: Our rules suggest letting it close.]",
    steps: [
      "Open the clinic's Setup tab to see which steps are left.",
      "Phone the clinic on its published number, shown under Phone line on the same tab, and ask how it wants to go on.[?recommendation=extend|offer_call|phone_the_clinic|wait: Offer a five-minute call to finish the steps together.][?recommendation=let_close: Confirm it is happy for the setup to close.]",
      "[?recommendation=extend: Press Extend the setup window on the clinic's Billing tab if the clinic needs more time. Use the days suggested below unless you agreed otherwise.]",
      "[?recommendation=offer_call|phone_the_clinic|wait: Press Extend the setup window on the clinic's Billing tab only if the clinic asks for more time.]",
      "[?recommendation=let_close: Leave the setup window as it is on the clinic's Billing tab, so the setup closes when it ends.]",
      "Press Record in the Touch log on the clinic's Care tab to note what you decided. You are done when the window is extended, a call is booked, or the clinic agrees to let it close.",
    ],
  },
  lifecycle_closing_waiting_on_us: legacy(
    "A clinic waiting on us nears the end of its setup",
    "The clinic below has done its part and is waiting on us to finish a channel, and its setup window is about to end: the days left are shown below, and 0 means today is the last day. With nothing live at the end it closes anyway, so extending is likely right: use Extend the setup window on its Billing page, by at least the days it has waited, and finish our side.",
  ),
  lifecycle_waiting_on_us: legacy(
    "A clinic is waiting on us to finish its setup",
    "The clinic below has done every setup step it can, and a channel is still being prepared on our side for the hours shown. Open its onboarding page and finish our part.",
  ),
  lifecycle_waiting_on_us_long: legacy(
    "A clinic has waited on us for two business days",
    "The clinic below has done its part and has waited two business days or more for us to finish a channel. Finish our side today. The days it waited do not extend its deadline by themselves: consider extending it by the days shown from its Billing page.",
  ),
  lifecycle_channel_waiting: legacy(
    "A live clinic still has a channel waiting on it",
    "The clinic below has a channel answering and another still waiting for one step from the clinic, for the days shown. Its one reminder for that channel has gone. A short call usually finishes it.",
  ),
  lifecycle_reminder_undelivered: legacy(
    "A setup reminder did not reach the clinic",
    "A setup reminder to the clinic below bounced or could not be sent, so its address may be wrong or blocked and it is not hearing from us. Phone the clinic, check the address on its care page, and correct it if needed.",
  ),
  lifecycle_reminders_unanswered: legacy(
    "Two setup reminders arrived and nothing moved",
    "Two setup reminders in a row were delivered to the clinic below and it has made no progress since the first. Email is not moving it: phone the clinic and offer a five-minute call to finish setup together.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "lifecycle_no_progress",
  "lifecycle_closing_soon",
  "lifecycle_closing_waiting_on_us",
  "lifecycle_waiting_on_us",
  "lifecycle_waiting_on_us_long",
  "lifecycle_channel_waiting",
  "lifecycle_reminder_undelivered",
  "lifecycle_reminders_unanswered",
]);
