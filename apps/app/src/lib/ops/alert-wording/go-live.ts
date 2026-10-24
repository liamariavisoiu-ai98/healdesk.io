import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "go-live" section of docs/on-call.md's alert runbook. Every step names
 * a card or button the Setup tab, the Account tab or the Queues page has today
 * (tests/alert-wording.test.ts PLACES); the console shows no website address
 * for a clinic, so the website-chat checks ask the clinic for it.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/engine/practice/store.ts (a run that errored, failed or went to
  // review) and job.ts (three errors in a row). `count` means a different
  // thing in each, so it is left to the facts; `outcome` and `section` are
  // not printable and the steps cover every branch.
  practice_question_failed: {
    title: "AYA's practice questions did not pass for a clinic",
    whatHappened:
      "{clinicName}'s practice questions, the test conversations AYA must pass before a channel goes live, did not pass. Either a judge flagged answers for a person to review, the clinic has something to fix in its portal, or the run itself could not finish.",
    whyItMatters:
      "Until a run passes, that channel cannot go live and AYA answers no one on it. A review has a due day the clinic can see in its portal.",
    steps: [
      "Open the Queues page and look under Reviews for {clinicName}. A review there shows what was asked, what AYA answered and the judge's reason.",
      "Press Pass if the answers are right: the run passes. Press Fail if not, choosing from the list beside it: Fail: the clinic fixes the section named, and the clinic is emailed what to fix, or Fail: ours to fix.",
      "Open the clinic's Setup tab if nothing waits in Reviews, and read Channels: a channel waiting on its practice questions says so.",
      "Wait for the clinic if it was emailed what to fix: a run starts again by itself once it changes its answers, and Channels on its Setup tab shows the channel still waiting.",
      "Press Ask the practice questions again under Channels on the Setup tab once a fault on our side is fixed, or when the run could not finish. It asks for a run; it passes nothing.",
      "Check Channels on the clinic's Setup tab later. You are done when the channel shows audit passed, or the clinic has been emailed what to fix and nothing waits in Reviews.",
    ],
  },
  // lib/engine/practice/job.ts claimPastDueReviews, once per review.
  practice_question_review_past_due: {
    title: "A practice-question review is past the day we promised",
    whatHappened:
      "A run of {clinicName}'s practice questions is waiting for a person to review it, and the day we gave the clinic for that review has passed. The clinic's portal told it we would be done by then.",
    whyItMatters:
      "The channel waiting on this review cannot go live until someone decides it. The clinic is waiting on a date we set.",
    steps: [
      "Open the Queues page and find {clinicName} under Reviews: it is marked past due. Read what was asked, what AYA answered and the judge's reason for each case.",
      "Press Pass if the answers are right: the run passes and the channel moves on.",
      "Press Fail if not, choosing from the list beside it. Fail: the clinic fixes the section named emails the clinic what to fix; Fail: ours to fix keeps it ours, so fix it and press Run the questions again.",
      "Check Reviews on the Queues page again. You are done when the review is no longer open.",
    ],
  },
  // The internal health flags (lib/ops/health-flags.ts), from the hourly
  // health-flags job: never shown to the clinic. Once per clinic.
  no_interactions_48_hours: {
    title: "A live clinic has heard from nobody in 48 hours",
    whatHappened:
      "{clinicName}'s first channel went live at least two days ago, and since then no call, website chat or message has reached AYA on any channel. Our hourly check raised this once; the clinic has not been told.",
    whyItMatters:
      "Silence this early usually means a channel is not really reaching us, not that nobody wanted the clinic. Until it is fixed, the clinic sees nothing from AYA.",
    steps: [
      "Open the clinic's Setup tab and read Channels: each channel says whether it is live and whether a patient has been answered yet.",
      "Press Start a test window under Phone line on the Setup tab if phone is live, then ring the clinic's published number from another phone and let it ring out. The call must arrive with your number showing.",
      "Check the clinic's own website if Channels shows website chat live: the chat bubble must be there and answer you. The Setup tab does not show the site's address; ask the clinic for it.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if a channel does not reach us. Ask it to dial the codes under What the clinic dials again, or to paste the chat line again.",
      "Press Record in the Touch log on the clinic's Care tab to note what you found. You are done when your test call or chat has reached AYA, or the clinic has put its forwarding or chat line right.",
    ],
  },
  // Once per quiet stretch: conversationId, when present, is the last call
  // before it, so a later stretch raises again. Every clinic takes a Touch
  // log note until its account is closed (lib/ops/health.ts touchRefusal).
  no_inbound_calls_14_days: {
    title: "A clinic's phone line has had no calls for 14 days",
    whatHappened:
      "{clinicName} has phone live and switched on, yet no call has reached AYA for 14 days. The count starts at its go-live, its last call, or when phone was last switched back on, whichever is latest.",
    whyItMatters:
      "This is almost always call forwarding that was set up and then removed or broken at the carrier. Callers are reaching the clinic's own line, or nobody, while the clinic may think AYA is answering.",
    steps: [
      "Open the clinic's Setup tab and read Phone line: the forwarding codes under What the clinic dials, and the last forwarding test.",
      "Press Start a test window under Phone line, then ring the clinic's published number from another phone and let it ring out. If the call arrives with your number showing, forwarding works.",
      "Phone the clinic on its published number, shown under Phone line, if your test call did not arrive. Ask whether forwarding was switched off or the carrier changed, and have it dial the codes under What the clinic dials again.",
      "Press Record in the Touch log on the clinic's Care tab to note it. You are done when a test call arrives, or the clinic confirms forwarding is back on.",
    ],
  },
  // lib/channels/events.ts recordFirstAnswer: the write threw. `channel` is
  // not printable; the Billing tab's Channels shows which one has no first
  // answer.
  first_answer_not_recorded: {
    title: "A channel's first answer could not be recorded",
    whatHappened:
      "AYA answered a patient on one of {clinicName}'s live channels, but the first answer on that channel could not be recorded. The conversation itself is recorded. The next answered conversation on the channel tries again by itself.",
    whyItMatters:
      "The first answer is what starts the clinic's billing for that channel: the plan start, or the step up in price. Until it is recorded, the clinic is answered for nothing and its billing shows no start.",
    steps: [
      "Open the clinic's Billing tab and read Channels: a channel in service with no first answer date is the one. Plan shows whether the plan has started.",
      "Wait for the next answered conversation on that channel: it records the first answer again by itself. Check Channels on the Billing tab afterwards.",
      "Tell the owner, with the clinic's Billing tab open, if this alert comes again for the same clinic: the cause is in the app's error log, which the console does not show.",
      "Check Channels on the clinic's Billing tab. You are done when the channel shows a first answer date and Plan shows what is billed.",
    ],
  },
  // lib/channels/events.ts goLiveIfReady, once per clinic and reason:
  // `code` is not printable; the Go live card lists each reason in words
  // (lib/onboarding/go-live.ts), except `database`, raised after the card's
  // own list passed.
  go_live_held: {
    title: "A clinic is held back from going live",
    whatHappened:
      "{clinicName} cannot go live yet, so AYA answers no one there. Either its agreement or its covered-entity answer is not in order, or its part of setup is done and something on our side is missing.[ The Go live card on its Setup tab lists {count:thing} to put right.] Nothing live was taken offline.",
    whyItMatters:
      "Go-live is automatic once nothing is left, so the clinic waits on whatever is listed. Its setup window keeps running meanwhile, and a window that ends with nothing live closes the account.",
    steps: [
      "Open the clinic's Setup tab and read Go live: it lists everything go-live waits on, in plain words.",
      "Open the clinic's Account tab if Go live says covered-entity status is undetermined. Ask the practice whether it bills any health insurance electronically, then record its answer under Covered entity with Record the answer.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, if Go live names its agreement: missing, superseded, the wrong kind, or not covering the practice. The practice must sign the current agreement, or a business associate agreement, before anything else moves.",
      "Open the Compliance page if Go live says something is not attested: the owner records each attestation under Business associate agreements in the chain, or under Gate B, with a fresh code from the authenticator.",
      "Tell the owner, naming the clinic, if Go live says Gate B asks what is not built yet: nothing in the console moves it.",
      "Press Check go-live now on the clinic's Setup tab once Go live lists nothing. If the clinic is still not live after that, tell the owner: the reason is in the app's error log. You are done when Go live says Live.",
    ],
  },
  // lib/channels/events.ts noteWidgetLoaded, once per clinic while website
  // chat waits on its line.
  web_widget_to_confirm: {
    title: "Confirm a clinic's website chat is on its site",
    whatHappened:
      "{clinicName} has website chat waiting on its own step, and the chat was just opened from what claims to be the clinic's website. A claim is not proof: any page can say it is the clinic's site, so nothing was recorded.",
    whyItMatters:
      "Until a person confirms the chat is on the site, website chat stays off and tells visitors to call the practice. Confirming on a claim alone could take website chat live on a site that is not the clinic's.",
    steps: [
      "Open the clinic's Setup tab and read Channels: Website chat says nobody has confirmed the chat is on the clinic's website.",
      "Check the clinic's own website in a browser for the chat bubble, which must open as AYA. The Setup tab does not show the site's address; ask the clinic if you do not have it.",
      "Press The line is on their website under Channels on the Setup tab only once you have seen the chat there. Do not press it on the strength of this alert alone.",
      "Check Channels on the clinic's Setup tab. You are done when Website chat no longer waits on the clinic's own step: it moves on as far as its other inputs allow.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
