import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "email-delivery" section of docs/on-call.md's alert runbook. The
 * clinic's Deliveries tab is where every email to it shows, with its status
 * (apps/web app/admin/clinics/[clinicId]/deliveries); its address is changed
 * from the Account tab, after a call back on its published number. An
 * alert's email kind is not a fact the rewritten alerts print (allow-list.ts),
 * so a step that needs it sends the operator to the row on the Deliveries
 * tab, or to the owner, who reads the error log.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/email/outbox.ts, once per notice, from the health check: a critical
  // notice (a payment problem, a suspension, the plan starting, AYA stopping
  // at the allowance, an urgent message, an outage, an incident report) still
  // unsent ten minutes after it was due, while the sender keeps retrying.
  critical_notice_undelivered: {
    // The title is pinned by tests/ops-slack.test.ts, and `attempts` is left
    // to the facts line, which that test reads too.
    title: "A critical email has not gone out",
    whatHappened:
      "An email {clinicName} must get at once was due ten minutes ago and is still unsent: a payment problem, a suspension, its plan starting, AYA stopping at its allowance, an urgent message or an outage. The sender keeps retrying it; until it goes, the health check reads red.",
    whyItMatters:
      "The clinic is acting without something it should know right now: a card to fix, a suspension sending its calls to its direct line, an urgent message from a patient.",
    steps: [
      "Open the clinic's Deliveries tab and find the email under Billing emails: its row shows its kind, when it is next due, its attempts and the last error.",
      "Check the Jobs page under System: the billing notices row must read on. Press Turn on if it reads off, and every waiting email goes within a minute.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if the email still has not gone an hour later. Tell them what it would have said, which its kind on the row tells you.",
      "Check the Deliveries tab again. You are done when the row shows a sent time, or the clinic has been told by phone.",
    ],
  },
  // lib/email/events.ts, once per clinic and kind, from Resend's report: a
  // hard bounce off the clinic's one address. With no clinic (a sign-in link
  // to an address no clinic row holds) the alert has no console link.
  clinic_address_bounced: {
    title: "A clinic's email address bounced",
    whatHappened:
      "Resend reported that mail to {clinicName}'s address bounced for good: the address does not accept mail. It is the clinic's only address, for sign-in links, billing and every alert.",
    whyItMatters:
      "Until it is corrected the clinic cannot sign in and hears nothing from us: no payment problems, no urgent messages, no reminders.",
    steps: [
      "Open the clinic's Deliveries tab and look under Reports and alerts and Billing emails for what bounced, so you know what the clinic has missed.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab. Ask for the right address, and tell them what they missed.",
      "Open the clinic's Account tab and press Enter the change under The clinic's address, with the new address and your authenticator code, only after ticking that you called the practice back. The new address gets a confirmation link, both addresses are told, and the change takes effect 72 hours after it confirms.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when The clinic's address on the Account tab shows the change confirmed and taking effect.",
    ],
  },
  clinic_address_complained: {
    title: "A clinic marked our email as spam",
    whatHappened:
      "Someone at {clinicName}'s address reported one of our emails as spam, and Resend told us. Mail to that address may now be refused or land in spam, and it is the clinic's only address: its sign-in, its billing and every alert.",
    whyItMatters:
      "A spam report hurts delivery to every clinic, not only this one, and this clinic may not see what we send next.",
    steps: [
      "Open the clinic's Deliveries tab and look at the latest rows under Reports and alerts and Billing emails to see which email was reported.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, before anything else is sent to it. Ask whether the address is still the right one and whether they want these emails.",
      "Open the clinic's Account tab and press Enter the change under The clinic's address if they give a different address, after the call back. Otherwise ask them to mark hello@ as safe in their mail.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has confirmed its address and what it wants to receive.",
    ],
  },
  clinic_address_suppressed: {
    title: "Resend has stopped mail to a clinic's address",
    whatHappened:
      "Resend has put {clinicName}'s address on its suppression list, usually after a hard bounce or a spam report, and sends nothing more to it. It is the clinic's only address: its sign-in, its billing and every alert.",
    whyItMatters:
      "Until the suppression is lifted or the address changed, the clinic cannot sign in and hears nothing from us.",
    steps: [
      "Open the clinic's Deliveries tab and look under Reports and alerts and Billing emails for what did not arrive.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab. Confirm the address with them and tell them what they missed.",
      "Release the address from the suppression list in Resend's dashboard once the clinic confirms it. If they give a new address instead, open the clinic's Account tab and press Enter the change under The clinic's address, after the call back.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when mail to the clinic shows sent again on its Deliveries tab.",
    ],
  },
  // lib/email/quota.ts, once a UTC day: Resend's own count of the day's
  // sends, across both apps, has reached 70 of the free plan's 100.
  // `windowStart` is the day. No clinic, no console link, and no console
  // control changes the plan: that is the owner's, in Resend.
  daily_email_count_70: {
    title: "70 of today's 100 emails are already sent",
    whatHappened:
      "Resend has sent {count:email} today[ ({windowStart}, counted until midnight UTC)]. The account is on the free plan, which stops at 100 a day across both apps.",
    whyItMatters:
      "Past 100, every email fails until midnight UTC: sign-in links, urgent alerts to clinics and these alerts included. Billing emails wait and go after midnight on their own; a sign-in link does not.",
    steps: [
      "Tell the owner today that the Resend account needs its paid plan. Only the owner can change it; nothing on the Jobs page or anywhere else in the console does.",
      "Keep today's optional sends for tomorrow: do not press Send setup link on the Queues page, or Resend copy on the Agreements register, for anything that can wait.",
      "Check a clinic's Deliveries tab if it says an email did not arrive after the count passed 100: a billing email shows a new due time after midnight UTC and goes then; a sign-in link is asked for again by the clinic.",
      "Open the Queues page tomorrow and send what you held back. You are done when the owner confirms the plan changed, or midnight UTC has passed.",
    ],
  },
  // Raised once, ever, by lib/scheduler/dmarc-review.ts. Its one fact is the
  // first day apps/app's records show Resend sending (windowStart), which is
  // where the reports to read begin. "Since", not "began on": apps/web may
  // have sent earlier, from a record apps/app cannot read. No clinic, no
  // console link; the record itself lives in Cloudflare, which the Map page
  // lists as the tool holding healdesk.io's addresses.
  dmarc_review_due: {
    title: "Time to review the DMARC reports",
    whatHappened:
      "Resend has been sending as healdesk.io for 14 days or more[, since {windowStart} or earlier], and healdesk.io's DMARC record still says only to report, never to act. The two weeks of reports to read begin on that day.",
    whyItMatters:
      "Until the record says quarantine, anyone can send mail as hello@ and inboxes will accept it. Tightening it blind could block our own mail, so the reports are read first.",
    steps: [
      "Read healdesk.io's DMARC aggregate reports[ from {windowStart} on], in the mailbox the record sends them to. The Jobs page under System shows the same first-sending day on the DMARC review row.",
      "Check the reports show only our own senders as healdesk.io: Resend, Amazon's email service (our transcripts) and the owner's own mail. The Map page under System lists the first two. Find out what anything else is before going on; do not touch the record while an unknown sender shows.",
      "Update healdesk.io's DMARC record from p=none to p=quarantine in Cloudflare, which holds healdesk.io's addresses; the Map page under System lists it. You are done when the record reads p=quarantine. This alert is raised once only.",
    ],
  },
  // lib/setup/welcome-email.ts runWelcomeBackstop, once per clinic: the
  // welcome (B1) is still unsent an hour after provisioning, or setup moved
  // on before it could go (a welcome setup has moved past is not sent late).
  welcome_email_unsent: {
    title: "A welcome email has not reached a clinic",
    whatHappened:
      "{clinicName}'s welcome email, its order confirmation with the receipt and the Continue setup link, is still unsent an hour after its account was made, or setup moved on before it could go. The hourly check keeps retrying it while the setup window is open; a welcome that setup has moved past is not sent late.",
    whyItMatters:
      "The buyer paid and has no confirmation, no receipt and no link to start setting up.",
    steps: [
      "Open the clinic's Deliveries tab and look under Reports and alerts for the welcome row: it reads failed with a reason, or sent if the hourly retry has since gone through.",
      "Wait for the next hourly retry if the reason reads like a passing fault and the clinic has not started setup. Check the Deliveries tab again after it.",
      "Email the clinic from hello@, at the address under The clinic's address on its Account tab, with the order details and the day its setup window ends, if the row still reads failed or the clinic has already moved on. Do not paste a sign-in link: the clinic asks for one from the sign-in page.",
      "Press Record in the Touch log on the clinic's Care tab to note what you sent. You are done when the row reads sent, or the clinic has the order details from you.",
    ],
  },
  // Raised by lib/notices/booking-alerts.ts (urgentAlertNotQueued) when an
  // urgent message's L12 could not be recorded: the clinic has no email about
  // it and the health check stays green, so a person has to phone the clinic.
  // `channel`, `conversationId` and `callId` are ids and a closed word, not
  // facts the alert prints.
  urgent_alert_not_queued: {
    title: "An urgent message's alert to the clinic failed",
    whatHappened:
      "Someone contacted {clinicName} with a complication or an urgent symptom, and the clinic's urgent email could not be recorded, so the clinic has not been told. The person was given the fixed urgent reply, 911 if it is an emergency and then the clinic's own number, or, where nothing could be recorded, asked to contact the practice directly.",
    whyItMatters:
      "A patient may be waiting on the clinic right now and the clinic does not know. The health check cannot see this, so nothing else will raise it.",
    steps: [
      "Phone the clinic now on its published number, shown under Phone line on its Setup tab. Tell them an urgent message came in by phone, website chat or a Meta channel at about the time this alert was raised, and to check their lines and inbox.",
      "Tell them that if the conversation was recorded, its transcript reaches their address when it ends, and its receipt shows on the clinic's Deliveries tab.",
      "Tell the owner today with this alert's code: the failure is usually the database, and the owner reads the error log. The clinic's Deliveries tab will not show this email, because it was never recorded.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has been told by phone.",
    ],
  },
  // lib/email/send.ts, once a UTC day per kind and clinic: a direct email
  // was refused before sending because something in it is outside what its
  // kind may carry, or a link in it is not one an email may carry.
  // `windowStart` is the day; `kind` is not a fact the alert prints.
  email_refused: {
    title: "An email was refused before it was sent",
    whatHappened:
      "An email to {clinicName} was refused on our side before sending: something it was to carry is not allowed in an email of its kind, or a link in it is not one an email may carry. The clinic has not received it, and nothing retries it.",
    whyItMatters:
      "The clinic is missing something it was owed, and the same refusal repeats for every email of that kind until the cause is fixed. You hear once a day per kind[, and this is {windowStart}'s].",
    steps: [
      "Open the clinic's Deliveries tab: the email is not there, because it was refused before it was recorded as sent. Nothing in the console names the kind.",
      "Tell the owner today, with this alert's code and the day it was raised: the error log names the kind of email and what in it was refused. The fix is in the code or the data, never on the Deliveries tab or anywhere else in the console.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, once the owner says what the email was, and tell them what it would have said.",
      "Check the clinic's Deliveries tab after the fix. You are done when the next email of that kind shows sent.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

/**
 * A dead letter is raised under critical_notice_undelivered too (OPS_EVENTS is
 * shared and kept as it is), with `status: "dead"`, and it reads differently:
 * nothing is still trying. Not an OPS_EVENTS entry, so the wording lint does
 * not reach it; it follows the same rules by hand.
 */
export const DEAD_LETTER: AlertWording = {
  title: "An email to a clinic stopped retrying",
  whatHappened:
    "An email {clinicName} was owed used every retry, or was refused outright, and will not be sent[ ({attempts:attempt} in all)]. The clinic has not received it.",
  whyItMatters:
    "If it was an urgent email, a payment problem, a suspension, an urgent message or an outage, the clinic is acting without it. Nothing tries again on its own.",
  steps: [
    "Open the clinic's Deliveries tab and find the email under Billing emails: its kind, its attempts and the last error are on its row.",
    "Phone the clinic on its published number, shown under Phone line on its Setup tab, and tell them what the email would have said: its kind on the row tells you which.",
    "Tell the owner today with the last error if it says the email was refused rather than failed to send: a refused email means something on our side needs fixing before the next one goes.",
    "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic knows what the email said.",
  ],
};
