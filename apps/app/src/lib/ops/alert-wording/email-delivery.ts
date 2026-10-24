import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "email-delivery" section of docs/on-call.md's alert runbook. The
 * clinic's Deliveries tab lists every email to it with its SEND status
 * (apps/web app/admin/clinics/[clinicId]/deliveries): a bounced email still
 * reads sent there, so "done" for an address problem is the clinic
 * confirming an email arrived. An operator's address change on the Account
 * tab is recorded as confirmed at once, tells both addresses and takes
 * effect 72 hours after entry (lib/sign-in/address-change.ts); no link is
 * sent. The Resend account and the Cloudflare DNS are the owner's alone, so
 * a step there asks the owner. An alert's email kind is not a fact the
 * rewritten alerts print (allow-list.ts), so a step that needs it sends the
 * operator to the row on the Deliveries tab, or to the owner's error log.
 * `clinicId` can be null on the address alerts and email_refused, so those
 * name the clinic in an optional clause and say what to do when none is
 * named. A phone call about a patient or an unsent urgent email goes to the
 * clinic's direct line, never its published number, which may ring AYA.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/email/outbox.ts, once per notice, from the health check: a critical
  // notice (lib/email/kinds.ts priority "critical": payment_failed,
  // payment_action_required, suspended, suspended_for_cause, plan_started,
  // allowance_fallback, urgent, outage_started, outage_ended,
  // subprocessor_notice, incident_report) still unsent ten minutes after it
  // was due. Retries run only while the billing-notices job is on.
  critical_notice_undelivered: {
    // The title is pinned by tests/ops-slack.test.ts, and `attempts` is left
    // to the facts line, which that test reads too.
    title: "A critical email has not gone out",
    headline: "{clinicName} has not received {kind}: over 10 minutes late",
    whatHappened:
      "An email {clinicName} must get at once[, {kind},] was due ten minutes ago and is still unsent. Until it goes, the health check reads red.",
    whyItMatters:
      "The clinic is acting without something it should know right now: a card to fix, a suspension sending its calls to its direct line, an urgent message from a patient.",
    steps: [
      "Open the clinic's Deliveries tab and find the email under Billing emails: its row shows its kind, when it is next due, its attempts and the last error. If its kind is urgent, phone the clinic now, as in step 3.",
      "Check the Jobs page under System: the email is retried only while the billing-notices row reads on. If it reads off, ask the owner before pressing Turn on, which sends every waiting email to every clinic.",
      "Phone the clinic on its direct line, shown under Pause AI and the direct line on its Billing tab (its published number under Phone line on the Setup tab if none is on file), if the email still has not gone an hour later, or at once for an urgent kind. Tell them what it would have said; its kind on the row tells you which.",
      "Check the Deliveries tab again. You are done when the row shows a sent time, or the clinic has been told by phone.",
    ],
  },
  // lib/email/events.ts, once per clinic and kind, from Resend's report: a
  // hard bounce off the clinic's one address. With no clinic (a sign-in link
  // to an address no clinic row holds) the alert has no console link.
  clinic_address_bounced: {
    title: "A clinic's email address bounced",
    whatHappened:
      "Resend reported that mail to a clinic's address[, {clinicName}'s,] bounced for good: the address does not accept mail. A clinic's one address is its sign-in, its billing and every alert.",
    whyItMatters:
      "Until it is corrected the clinic cannot sign in and hears nothing from us: no payment problems, no urgent messages, no reminders.",
    steps: [
      "Open the clinic's Deliveries tab if this alert names a clinic: Reports and alerts and Billing emails list what we sent and when, so you know what the clinic has missed, though a bounced email still reads sent there. If it names none, the mail was a sign-in link to an address no account holds, and there is no clinic to phone: tell the owner if it repeats.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab. Ask for the right address, and tell them what they missed.",
      "Open the clinic's Account tab and press Enter the change under The clinic's address, with the new address and your authenticator code, only after ticking that you called the practice back. No confirmation link is sent: the change is recorded as confirmed at once, both addresses are told, and it takes effect 72 hours after entry; until then mail still goes to the old address, so phone about anything urgent. Press Stop this change on the same card if either address objects.",
      "Email the clinic from hello@ once The clinic's address on the Account tab shows the change has taken effect, and ask them to confirm it arrived. You are done when the clinic confirms an email from us has reached the new address.",
    ],
  },
  // The same raise site, for a spam report. Whether Resend suppresses an
  // address after a complaint is Resend's behaviour, not this code's: the
  // step asks the owner to check in Resend's dashboard.
  clinic_address_complained: {
    title: "A clinic marked our email as spam",
    whatHappened:
      "Someone at a clinic's address[, {clinicName}'s,] reported one of our emails as spam, and Resend told us. Mail to that address may now be refused or land in spam, and a clinic's one address is its sign-in, its billing and every alert.",
    whyItMatters:
      "A spam report hurts delivery to every clinic, not only this one, and this clinic may not see what we send next.",
    steps: [
      "Open the clinic's Deliveries tab if this alert names a clinic: the latest rows under Reports and alerts and Billing emails show what we sent last, which is likely what was reported. If it names none, the mail was a sign-in link to an address no account holds: tell the owner if it repeats.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, before anything else is sent to it. Ask whether the address is still the right one and whether they want these emails.",
      "Open the clinic's Account tab and press Enter the change under The clinic's address if they give a different address, after the call back; it is recorded as confirmed at once and takes effect 72 hours later. Otherwise ask them to mark hello@ as safe in their mail.",
      "Ask the owner to check the address in Resend's dashboard and release it if Resend suppressed it after the report, if the clinic wants these emails; only the owner has the Resend sign-in, and the Deliveries tab cannot show a suppression. You are done when the clinic has confirmed its address and that an email from us has arrived.",
    ],
  },
  // The same raise site, for Resend's suppression list.
  clinic_address_suppressed: {
    title: "Resend has stopped mail to a clinic's address",
    whatHappened:
      "Resend has put a clinic's address[, {clinicName}'s,] on its suppression list, usually after a hard bounce or a spam report, and sends nothing more to it. A clinic's one address is its sign-in, its billing and every alert.",
    whyItMatters:
      "Until the suppression is lifted or the address changed, the clinic cannot sign in and hears nothing from us.",
    steps: [
      "Open the clinic's Deliveries tab if this alert names a clinic: Reports and alerts and Billing emails list what we sent and when, though a suppressed email still reads sent there. If it names none, the mail was a sign-in link to an address no account holds: tell the owner if it repeats.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab. Confirm the address with them and tell them what they missed.",
      "Ask the owner to release the address from the suppression list in Resend's dashboard once the clinic confirms it; only the owner has the Resend sign-in. If they give a new address instead, open the clinic's Account tab and press Enter the change under The clinic's address, after the call back.",
      "Email the clinic from hello@ afterwards and ask them to confirm it arrived; the Deliveries tab shows the send, not the arrival. You are done when the clinic confirms an email from us has reached it.",
    ],
  },
  // lib/email/quota.ts, once a UTC day: Resend's own count of the day's
  // sends, across both apps, has reached 70 of the free plan's 100.
  // `windowStart` is the day. No clinic, no console link, and no console
  // control changes the plan: that is the owner's, in Resend. The Slack
  // copies of ops alerts go by webhook, not Resend.
  daily_email_count_70: {
    title: "70 of today's 100 emails are already sent",
    whatHappened:
      "Resend has sent {count:email} today[ ({windowStart}, counted until midnight UTC)]. The account is on the free plan, which stops at 100 a day across both apps.",
    whyItMatters:
      "Past 100, every email fails until midnight UTC: sign-in links, urgent alerts to clinics and the emailed copy of these alerts included; the Slack copies still arrive. Billing emails wait and go after midnight on their own; a sign-in link does not.",
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
  // have sent earlier, from a record apps/app cannot read. The dmarc-review
  // row's note names that day only on the run that raised the alert. No
  // clinic, no console link; the record itself lives in Cloudflare, which
  // the Map page lists and only the owner can change.
  dmarc_review_due: {
    title: "Time to review the DMARC reports",
    whatHappened:
      "Resend has been sending as healdesk.io for 14 days or more[, since {windowStart} or earlier], and healdesk.io's DMARC record still says only to report, never to act. The two weeks of reports to read begin on that day.",
    whyItMatters:
      "Until the record says quarantine, anyone can send mail as hello@ and inboxes will accept it. Tightening it blind could block our own mail, so the reports are read first.",
    steps: [
      "Read healdesk.io's DMARC aggregate reports[ from {windowStart} on], in the mailbox named after rua= in the DMARC record in Cloudflare. The dmarc-review row on the Jobs page under System names the same first-sending day in its note, on the run that raised this alert.",
      "Check the reports show only our own senders as healdesk.io: Resend, Amazon's email service (our transcripts) and the owner's own mail. The Map page under System lists the first two. Find out what anything else is before going on; do not touch the record while an unknown sender shows.",
      "Ask the owner to change healdesk.io's DMARC record from p=none to p=quarantine in Cloudflare, which holds healdesk.io's addresses; the Map page under System lists it, and only the owner has the Cloudflare sign-in. You are done when the record reads p=quarantine. This alert is raised once only.",
    ],
  },
  // lib/setup/welcome-email.ts runWelcomeBackstop, once per clinic: the
  // welcome (B1) is still unsent an hour after provisioning, or setup moved
  // on before it could go, in which case its row is marked skipped and it is
  // not sent late.
  welcome_email_unsent: {
    title: "A welcome email has not reached a clinic",
    whatHappened:
      "{clinicName}'s welcome email, its order confirmation with the receipt and the Continue setup link, is still unsent an hour after its account was made, or setup moved on before it could go. The hourly check keeps retrying a failed welcome while the setup window is open; one that setup has moved past is marked skipped and is not sent late.",
    whyItMatters:
      "The buyer paid and has no confirmation, no receipt and no link to start setting up.",
    steps: [
      "Open the clinic's Deliveries tab and look under Reports and alerts for the welcome row: it reads failed with a reason, skipped if setup moved past it, or sent if the hourly retry has since gone through.",
      "Wait for the next hourly retry if the row reads failed with a reason like a passing fault and the clinic has not started setup. Check the Deliveries tab again after it.",
      "Email the clinic from hello@, at the address under The clinic's address on its Account tab, with the order details and the day its setup window ends, shown on the Setup window card of its Setup tab, if the row reads skipped or still reads failed an hour on. Do not paste a sign-in link: the clinic asks for one from the sign-in page.",
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
      "Phone the clinic now on its direct line, shown under Pause AI and the direct line on its Billing tab (its published number under Phone line on the Setup tab if none is on file; the published number may ring AYA). Tell them an urgent message came in by phone, website chat or a Meta channel at about the time this alert was raised, and to check their lines and inbox.",
      "Tell them that if the conversation was recorded, its transcript reaches their address when it ends, and its receipt shows on the clinic's Deliveries tab.",
      "Tell the owner today with this alert's code: the failure is usually the database, and the owner reads the error log. The clinic's Deliveries tab will not show this email, because it was never recorded.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has been told by phone.",
    ],
  },
  // lib/email/send.ts, once a UTC day per kind and clinic: a direct email
  // was refused before sending because something in it is outside what its
  // kind may carry, or a link in it is not one an email may carry. Most
  // leave no row on the Deliveries tab. `windowStart` is the day; `kind` is
  // not a fact the alert prints; `clinicId` can be null.
  email_refused: {
    title: "An email was refused before it was sent",
    whatHappened:
      "An email to a clinic[, {clinicName},] was refused on our side before sending.[ It was {kind}.] Something it was to carry is not allowed in an email of its kind, or a link in it is not one an email may carry. The clinic has not received it, and nothing retries it.",
    whyItMatters:
      "The clinic is missing something it was owed, and the same refusal repeats for every email of that kind until the cause is fixed. You hear once a day per kind[, and this is {windowStart}'s].",
    steps: [
      "Open the clinic's Deliveries tab if this alert names a clinic: most refused emails leave no row there, because they were refused before anything was recorded, and nothing in the console names the kind. If it names none, the email had no clinic behind it, and the owner's error log says which it was.",
      "Tell the owner today, with this alert's code and the day it was raised: the error log names the kind of email and what in it was refused. The fix is in the code or the data, never on the Deliveries tab or anywhere else in the console.",
      "Phone the clinic, if this alert names one, on its published number, shown under Phone line on its Setup tab, once the owner says what the email was, and tell them what it would have said.",
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
  headline: "{clinicName} never got {kind}: it will not be sent",
  whatHappened:
    "An email {clinicName} was owed[, {kind},] will not be sent. It used every retry, or was refused outright on its first try.",
  whyItMatters:
    "If it was an urgent email, a payment problem, a suspension, an urgent message, an outage or an incident report, the clinic is acting without it. Nothing tries again on its own.",
  steps: [
    "Open the clinic's Deliveries tab and find the email under Billing emails: its kind, its attempts and the last error are on its row.",
    "Phone the clinic on its direct line, shown under Pause AI and the direct line on its Billing tab (its published number under Phone line on the Setup tab if none is on file), and tell them what the email would have said: its kind on the row tells you which.",
    "Tell the owner today with the last error if it says the email was refused rather than failed to send: a refused email means something on our side needs fixing before the next one goes.",
    "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic knows what the email said.",
  ],
};
