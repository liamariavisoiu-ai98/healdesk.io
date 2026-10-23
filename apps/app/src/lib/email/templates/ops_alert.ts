import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";

import type { OpsEvent } from "@/lib/ops/notify";

import { compose, type Block } from "./compose";
import type { EmailTemplate } from "./types";

/**
 * I1 in Annex X5: one notifyOps alert, to HEALDESK_OPS_EMAIL.
 *
 * Ids, counts and categories, which the operator looks up in the ops
 * console, and the clinic's name beside its id (business data; the owner's
 * decision D2 of 23 October 2026). Nothing here quotes an address, names a
 * patient or carries free text, so the alert is safe to read on a phone in a
 * queue and safe in a vendor's logs. The wording says what happened and what to do next, one
 * event at a time, because "something went wrong" at 3 am is not an alert.
 *
 * It links to one place only: since the owner's decision D3 of 23 October
 * 2026, the clinic's page on the ops console (`consoleUrl`, built by
 * opsConsoleLink in lib/ops/notify.ts), which lib/email/lint.ts accepts in
 * this kind alone and only under /admin/ on HEALDESK_CONSOLE_ORIGIN. With
 * that origin unset, or an alert that names no clinic, it links nowhere.
 */

/** The alert's fields: ids, counts and categories, keyed as lib/log.ts keys them. */
export type OpsAlertPayload = {
  event: OpsEvent;
  [field: string]: string | number | boolean | null;
};

type Wording = { title: string; action: string };

const WORDING: Record<OpsEvent, Wording> = {
  provisioning_rejected: {
    title: "Provisioning was rejected",
    action:
      "A paid order could not be provisioned. Check the order in the console and finish it by hand.",
  },
  // Raised by /api/provision when a paid order's third attempt fails in a
  // way a retry could fix (lib/checkout/dead-letter.ts). `requestId` is the
  // purchase's ref; `attempts` how many failed.
  provisioning_dead_lettered: {
    title: "Provisioning a paid order keeps failing",
    action:
      "Setting up the account for the paid order below failed on each of the attempts counted, and the buyer has been emailed that it needs one step on our side, with the next business day as the day we will write by. Stripe keeps sending the payment for up to three days and each delivery tries again, so fix the cause (the request id is the purchase's ref; apps/app's error lines for provisioning say what failed), and the next delivery makes the account and sends the welcome email. If it cannot be made in time, email the buyer yourself by that day.",
  },
  // Raised by the ops watch (lib/ops/watch.ts), once per purchase.
  paid_intent_without_clinic: {
    title: "A paid order has no clinic",
    action:
      "A paid order's first invoice reached apps/app more than ten minutes ago and no account exists for it, and nothing has refused it. The request id is the purchase's ref, and attempts is how many tries failed so far. Check provisioning's error lines for it, and the Stripe event's deliveries.",
  },
  duplicate_subscription: {
    title: "A clinic has two subscriptions",
    action:
      "Stripe holds a second subscription for one clinic. Cancel the duplicate, and refund it if it was charged.",
  },
  practice_question_failed: {
    title: "Practice questions failed",
    action:
      "The practice questions failed on a clinic's own data. Review the result before AYA answers that clinic's callers.",
  },
  billing_event_dead_lettered: {
    title: "A billing event stopped retrying",
    action: "A Stripe event could not be applied after its retries. Replay it from the console.",
  },
  critical_notice_undelivered: {
    title: "A critical email has not gone out",
    action:
      "A critical notice to a clinic is still unsent ten minutes after it was due, and /api/health is red until it goes. Check Resend, then call the clinic if it stays stuck.",
  },
  clinic_address_bounced: {
    title: "A clinic's address bounced",
    action:
      "Mail to a clinic's address bounced permanently, and it has no other address. Call the clinic to correct it.",
  },
  clinic_address_complained: {
    title: "A clinic marked our email as spam",
    action:
      "Mail to a clinic's address was reported as spam. Call the clinic before anything else is sent to it.",
  },
  clinic_address_suppressed: {
    title: "A clinic's address is suppressed",
    action:
      "Resend suppressed mail to a clinic's address. Call the clinic, then lift the suppression in Resend's dashboard once the address is confirmed.",
  },
  daily_email_count_70: {
    title: "70 emails sent today",
    action:
      "The free plan stops at 100 a day, sign-in links and urgent alerts included, until midnight UTC. Move the Resend account to Pro.",
  },
  setup_request_reply_past_due: {
    title: "A setup request reply is past due",
    action: "We promised a reply to a setup request by a date that has passed. Reply today.",
  },
  // Raised by the ops watch once per purchase: B3's day has passed in New
  // York and the order still has no account.
  provisioning_follow_up_past_due: {
    title: "An order follow-up is past due",
    action:
      "We told a buyer we would email their sign-in link by a day that has now passed, and their account still does not exist. Email them today, then finish the order. The request id is the purchase's ref.",
  },
  // Raised by the ops watch once per request: L25's day has passed in New
  // York with no reply marked in the console.
  support_reply_past_due: {
    title: "A support reply is past due",
    action:
      "A support escalation from the portal is past the reply day we gave the practice, and no reply is marked. Reply to it from hello@ today, then mark it replied on the console's Support page. If you already replied, mark it there so this stops.",
  },
  practice_question_review_past_due: {
    title: "A practice-question review is past due",
    action: "A practice-question review is past the date we gave the clinic. Finish it today.",
  },
  agreement_unsigned_7_days: {
    title: "An updated agreement is unsigned",
    action: "A clinic has not signed its updated agreement after seven days. Call the clinic.",
  },
  agreement_resign_unrenderable: {
    title: "An updated agreement can't be sent to sign",
    action:
      "A clinic is on an older business associate agreement than the current one, and its agreement in force is missing what the current one is rendered from (its legal name, booking system or Google account), so no re-sign link could be sent. AYA keeps answering under the version it signed. Look at its agreement on the console's Agreements page and fix the record, so the hourly job can send it, and phone the practice.",
  },
  agreement_below_floor_unsigned: {
    title: "A clinic is answering under a superseded agreement",
    action:
      "A clinic's business associate agreement is a version go-live no longer accepts, and its updated agreement is still unsigned seven days after we sent it. AYA keeps answering under the version it signed until it's signed. Phone the practice and ask them to sign it from the email or from Billing.",
  },
  // The internal health flags (lib/ops/health-flags.ts): never shown to
  // the clinic. Once per clinic.
  no_interactions_48_hours: {
    title: "A live clinic has been quiet for 48 hours",
    action:
      "No interactions on any channel for 48 hours after go-live. Something is wrong with the deployment, not with the clinic: check the clinic's forwarding and channels.",
  },
  // Once per quiet stretch: conversationId, when present, is the last call
  // before it, so a later stretch raises again.
  no_inbound_calls_14_days: {
    title: "No inbound calls for 14 days",
    action:
      "A live phone channel has had no inbound calls for 14 days. That is almost always forwarding that was set up, then removed or broken: check the clinic's call forwarding.",
  },
  billing_request_dead_lettered: {
    title: "A billing request stopped retrying",
    action:
      "A plan start, step-up, cancellation or setup closure failed on Stripe after every retry. Check the clinic's subscription in Stripe, then retry the request from the console.",
  },
  billing_request_stuck: {
    title: "A billing request has waited over 24 hours",
    action:
      "A plan start, step-up, cancellation or setup closure is still pending a day after it was recorded. Check that the billing-requests job is on and the worker is running, then look at the request in the console.",
  },
  setup_closure_skipped_live_channel: {
    title: "A setup closure was skipped: a channel is live",
    action:
      "An account reached the end of its 30-day setup window with a channel already live, so it was left open. Nothing needs undoing; check that its plan starts when AYA first answers.",
  },
  location_charged_not_created: {
    title: "An extra location was charged but not created",
    action:
      "A clinic paid for an extra location and creating it failed. The charge stands: retry the location's setup from the console today.",
  },
  connect_event_dead_lettered: {
    title: "A Connect event stopped retrying",
    action:
      "A Stripe Connect event about a clinic's deposits could not be applied after its retries. Check the deposit in the clinic's own Stripe account, then replay the event from the console.",
  },
  overage_invoice_failed: {
    title: "An annual overage invoice failed",
    action:
      "Invoicing an annual clinic's overage for a closed month failed. Check for a draft or open invoice in Stripe, then retry it from the console.",
  },
  meter_report_failing: {
    title: "Usage is not reaching Stripe's meters",
    action:
      "Overage on monthly plans keeps failing to report. Usage reported after an invoice is finalised is never billed, so check the Stripe key and the meters today.",
  },
  first_period_refund_due: {
    title: "A first-period refund is due",
    action:
      "A clinic turned auto-renew off inside its first-period refund window. Contact the clinic, then issue the refund from the console.",
  },
  voice_fallback_no_direct_line: {
    title: "A call had no direct line to pass through to",
    action:
      "AYA could not pass a call through because the clinic has no direct line set, so she answered it with the fixed safe script. Ask the clinic for a direct line that does not forward back to us.",
  },
  voice_call_start_failed: {
    title: "A call started while the database could not be read",
    action:
      "The voice endpoint could not read the clinic's settings when a call came in. The code says where the call went: transferred_gate, transferred_database, transferred_memory or transferred_retell sent it to the clinic's direct line (named by the answer gate before the failure, read on its own from a database that failed one query rather than hung, remembered from the clinic's last call, or read back from Retell), closed means no direct line was known and the caller heard the closing line, and hung_up that the call ended (the caller hung up, or the voice process shut down) before either. Check the database first; if it stays down, put Retell in outage mode (docs/on-call.md).",
  },
  retell_fallback_unsynced: {
    title: "A Retell fallback is not the direct line",
    action:
      "The hourly sync could not set the fallback number of the clinic's AYA number in Retell to its direct line. The code says why: duplicate (two clinics name the same AYA number, whose fallback is cleared; fix the wrong one in Ops), missing (Retell has no such number), not_kept (Retell answered but did not keep it, or failed while setting it), rejected, unreachable or database; key_refused (Retell refused HEALDESK_RETELL_API_KEY) and retell_unreachable (three numbers in a row timed out) stop the run for every clinic. Until it is fixed, outage mode and a voice task started during a database outage cannot send that clinic's calls to its direct line. Check the number in Retell's dashboard and HEALDESK_RETELL_API_KEY.",
  },
  voice_provision_failed: {
    title: "A clinic's Retell set-up stopped",
    action:
      "Setting up the clinic's Retell agent and AYA number stopped, and the code says why: not_implemented (the clinic is set to Retell's own engine, which is not built), no_voice (HEALDESK_RETELL_VOICE_ID is not set), config (the public origin or the line password is not usable), number_missing (the clinic's AYA number is not in this Retell workspace), unsupported_country (Retell sells US and Canadian numbers only), not_kept (Retell answered but did not keep a setting) or rejected (Retell refused the request). Phase sync means a settings change was not written to Retell. Fix the cause, then run retryVoiceAgent from Ops.",
  },
  voice_provision_cap_reached: {
    title: "The day's cap on AYA numbers is reached",
    action:
      "Provisioning has ordered as many AYA numbers from Retell today as HEALDESK_VOICE_PROVISION_DAILY_CAP allows, so the next clinics wait until midnight UTC, when they are set up on their own. If that many clinics really paid for voice today, raise the cap; if not, find out what ordered the numbers before anything else spends.",
  },
  voice_agent_drift: {
    title: "A clinic's Retell agent drifted",
    action:
      "The nightly read-back found the clinic's Retell agent or number different from what our code wrote, and the code names the first difference (storage, engine, webhook, voice, language, number_agent, number_outbound, fallback, agent_missing or number_missing). Status repaired means it was written again; flagged means it drifted again after three repairs, or the agent or number is gone, and is left for you: check who changes it in Retell's dashboard.",
  },
  voice_deprovision_failed: {
    title: "A departed clinic's Retell number was not released",
    action:
      "The clinic's service and its forwarding pass-through have ended, but releasing its AYA number or deleting its agent at Retell failed. Retell bills the number until it goes. The sweep tries again every hour; if it keeps failing, release the number and delete the agent in Retell's dashboard.",
  },
  voice_direct_line_loops: {
    title: "A clinic's direct line forwards back to AYA",
    action:
      "The clinic's direct line is the same as its published number or its AYA number, so a call put through to it would come straight back to AYA and never reach a person. Until it changes, AYA treats the clinic as having no direct line: a call she would pass through is answered with the fixed safe script, or closed where the Services have ended, and no call is transferred. The code is the answer gate's decision on the call that found it. Ask the clinic for a direct line that reaches a person and does not forward back to us, and check its published number.",
  },
  voice_test_mode_refused: {
    title: "A call was refused in voice test mode",
    action:
      "Real calls are off (HEALDESK_VOICE_REAL_CALLS), so the voice endpoint answers only the demo clinic, and it refused a call for the clinic below. Phase not_made_up means the clinic is not the demo clinic: its Retell agent or its call forwarding already points at the endpoint, which must not happen before every agreement in the chain is signed, so find out why and point it back. Phase check_failed means the endpoint could not tell within its start deadline whether the clinic is made up, usually because the database could not be read. The code says where the call went: transferred to the clinic's direct line, or closed with the closing line. Nothing of the call was kept.",
  },
  plan_start_after_cancel: {
    title: "A plan started on a subscription set to cancel",
    action:
      "A clinic's first period was charged while its subscription was set to cancel. Check with the clinic whether auto-renew should be on; if not, the first-period refund applies.",
  },
  // Raised once, ever, by lib/scheduler/dmarc-review.ts. Its one fact is the
  // first day apps/app's records show Resend sending (windowStart, printed as
  // "Day"), which is where the reports to read begin. "Since", not "began on":
  // apps/web may have sent earlier, from a record apps/app cannot read.
  dmarc_review_due: {
    title: "Time to review the DMARC reports",
    action:
      "Resend has been sending as healdesk.io since the day below, 14 or more days ago. Read healdesk.io's DMARC aggregate reports from that day on: if the only senders they show are Resend and the owner's own mail, change healdesk.io's DMARC record from p=none to p=quarantine. If anything else sends as healdesk.io, find out what it is first.",
  },
  // Raised once per clinic by the destruction job (lib/offboarding) from day
  // 21 after a clinic on the thirty days (BAA 1.2.2 or earlier, or no
  // agreement) left with no export recorded as delivered. Its one fact is
  // when the data goes (destroyAt). The export is owed whether or not the
  // practice asks: those agreements give it "on request", but Terms §7
  // promises it to every leaving practice and the canceled email tells the
  // practice it is coming, so it has no reason to ask.
  export_undelivered_before_destruction: {
    title: "A leaving practice has no export delivered",
    action:
      "Deliver this practice's export, and record the handover on its care page, before the time below: Terms §7 promises every leaving practice its export within 30 days of the end, whether or not it asks. Its data is destroyed at that time whether or not the export was delivered, because its agreement gives thirty days, or it has none on file.",
  },
  // The same, from day 21, for a clinic whose agreement (BAA 1.3.0, the DPA)
  // promises the export within thirty days and destroys the data once it is
  // delivered, or at the ninety days without it.
  export_due_undelivered: {
    title: "A leaving practice's export is due and not delivered",
    action:
      "Deliver this practice's export, and record the handover on its care page, before the export deadline below: its agreement promises the export within thirty days of the end, without being asked. Its data is destroyed once the export is delivered, and at the destruction time below whether or not it was.",
  },
  // Raised once by the Stripe webhook (lib/billing/events.ts) when a
  // subscription's end was processed more than a week after it happened, so
  // the database started the clock a week back and no further. Its facts are
  // the end and the days the clamp cost.
  offboarding_started_late: {
    title: "A subscription's end was processed over a week late",
    action:
      "The destruction clock started a week back and no further, so this practice's data is destroyed the days below later than its agreement counts from the end. Find out why the event was late, and tell the owner: only the database owner can bring the destruction forward.",
  },
  // Raised once per breakage by markCalendarBroken, and once per run by the
  // calendar watch, counting the breakages it found or told; with exactly
  // one, its ids and code come too, and the watch's carry its run id
  // (`jobId`), which its log lines name each connection under. `code` is
  // Google's answer as the adapter names it: invalid_grant,
  // admin_policy_enforced and scope_lost mean the access itself was removed
  // and the stored token has been erased; access_denied,
  // insufficient_permissions and calendar_not_found mean the calendar
  // refused it.
  calendar_broken: {
    title: "A clinic's Google Calendar stopped working",
    action:
      "Google refused healdesk's access to a clinic's calendar, or to each of the calendars counted below, so each location affected now takes booking requests for its staff to confirm. Ask the clinic whether it removed the access on purpose; if not, it reconnects its calendar. Look the clinic up in the console.",
  },
  // Raised once per run by the calendar watch, counting the connections
  // that moved to degraded in it; with exactly one, its ids and the last
  // transient code (timeout, network, rate_limited, a 5xx word) come too.
  // Each run's alert carries its run id (`jobId`), so a second wave, or a
  // connection that degrades again after recovering, is a new alert.
  calendar_degraded: {
    title: "Google Calendar checks are failing",
    action:
      "The calendar watch could not get an answer from Google for the connections counted below three times in a row, so those locations take booking requests for their staff to confirm until a check passes. A short Google outage needs nothing from you. If it lasts over an hour, check Google Workspace's status page and this deployment's outbound network, then look the connections up in the console.",
  },
  // Raised once per run by the calendar watch, counting the degraded
  // connections whose check passed again (ids when there is one).
  calendar_recovered: {
    title: "Google Calendar checks are passing again",
    action:
      "Connections the calendar watch had moved to booking requests answered a check again, so those locations book into their calendars as their settings allow. Nothing to do: this closes the alert about failing checks.",
  },
  // Raised by a calendar watch run that stopped starting checks after four
  // minutes; `count` is how many connections it left unchecked, which go
  // first in the next run.
  calendar_watch_incomplete: {
    title: "The calendar watch ran out of time",
    action:
      "A run of the five-minute calendar watch stopped starting checks after four minutes and left the connections counted below unchecked; they go first in the next run. If this happens on most runs, Google is answering slowly or there are more connections than one run can check, and the watch needs more checks at once: raise it with whoever maintains apps/app.",
  },
  // Raised by a calendar watch run in which a step threw: a connection's
  // check or its alert, the terms check for a location, or the run itself.
  // `count` is how many; each is a log line with its ids.
  calendar_watch_failed: {
    title: "The calendar watch hit errors",
    action:
      "A run of the five-minute calendar watch could not finish the steps counted below. A location whose terms could not be checked is not checked with Google either, and stays as it was until a run gets through. Read the worker's error lines for the calendar watch, and the job's note in the console's job list; if every run fails, the database or this deployment's configuration is the likely cause.",
  },
  welcome_email_unsent: {
    title: "A welcome email has not reached a clinic",
    action:
      "A clinic's welcome email, its order confirmation with the receipt and the Continue setup link, is still unsent an hour after its account was made, or setup moved on before it could go. Check Resend, then email the order details to the clinic's address by hand.",
  },
  // Raised by the connect flow when Google's token endpoint refuses
  // healdesk's own client, and by the calendar watch, once per run, when its
  // checks meet the same refusal (code oauth_client, also when apps/app has
  // no client set) or Google says the Calendar API is disabled for the
  // project (code api_disabled): every clinic is affected until it is fixed.
  // Raised by the nightly retention purge for each clinic whose purge threw
  // (`phase` clinic, its id), and once when a run could not purge at all
  // (`phase` run). Ids and the step only; the error is in the worker's log.
  first_answer_not_recorded: {
    title: "A channel's first answer was not recorded",
    action:
      "AYA answered a patient on the live channel below, but its first answer, and the plan start or price step-up that goes with it, could not be recorded, so billing for that channel has not begun. The conversation itself is recorded. The next answered conversation on the channel tries again; if this repeats, read the error lines for the first answer in apps/app's log and check the channel on the clinic's billing page in the console.",
  },
  go_live_held: {
    title: "A clinic is held back from going live",
    action:
      "The clinic below cannot go live, so AYA answers no one there yet, and nothing has been taken offline. The code is the first thing go-live waits on: platform means an attestation is missing on /admin/compliance; no_agreement, agreement_version, agreement_kind_mismatch or agreement_insufficient mean the practice's agreement has to be signed again or moved to a business associate agreement, so call the practice; gate_b means a channel still waits on its own attestations; gate_b_not_built means Gate B asks of the code what is not built yet (the routed/answered counter, its miss notice or a live email), which holds every clinic until it ships; database means the database refused what the console allowed, so read the error lines for go-live in apps/app's log. The clinic's onboarding page in the console lists everything go-live waits on; it goes live by itself once nothing is left.",
  },
  web_widget_to_confirm: {
    title: "Confirm a clinic's website chat is on its site",
    action:
      "The clinic below has website chat waiting on its line, and the chat was opened from what claims to be its website. A claim is not proof, so website chat stays off until you look: open the clinic's website and check the chat bubble is there (until you confirm, it tells visitors to call the practice), then press \"The line is on their website\" on the clinic's onboarding page in the console.",
  },
  connection_broken: {
    title: "A clinic's connection stopped working",
    action:
      "A clinic's stored connection below is revoked or in error. For a Meta platform (provider meta-messenger, meta-instagram or meta-whatsapp) that channel cannot reply to anyone until the clinic connects it again from Facebook login: call the clinic. Every connection finding is in the 07:00 digest as well.",
  },
  // The vendors' agreements (lib/compliance/vendor-coverage.ts): `code` is the
  // vendor, `phase` 30_days or 7_days, `expiresOn` the recorded expiry.
  vendor_agreement_expiring: {
    title: "A vendor's business associate agreement expires soon",
    action:
      "The attestation for the vendor in Code expires on the day shown. When it lapses, AYA stops answering where that vendor serves (every channel for anthropic, aws and database_host; phone for retell) and calls go to each clinic's direct line. Get the renewed agreement and record it on /admin/compliance, with its new expiry, before that day.",
  },
  // `phase` withdrawn (recorded on /admin/compliance) or expired (`expiresOn`
  // passed with no renewal).
  vendor_agreement_lapsed: {
    title: "A vendor's agreement lapsed: AYA has stopped",
    action:
      "The attestation for the vendor in Code was withdrawn or passed its expiry, so AYA has stopped answering where that vendor serves: every channel for anthropic, aws and database_host, phone for retell. Calls go to each clinic's direct line, website chat is the contact form (which keeps nothing while aws or database_host is the one lapsed), and Meta messages wait unanswered. Open an incident on /admin/incidents now: patient data may have gone to the vendor between the agreement's real end and this stop. AYA answers again the moment a renewed attestation is recorded on /admin/compliance.",
  },
  // `code` is what the closure waits on (app_account_closure_waiting_on).
  account_closure_waiting: {
    title: "A leaving practice's account cannot close yet",
    action:
      "The clinic below has had its data destroyed and its pass-through has ended, but its account stays open, its sign-in and setup with it, until one thing is done. For code voice_agent, release its agent and number in Retell's console, delete every call Retell holds for it, and record it on its care page. For code incident_open, finish and resolve its open incident. For code critical_notice, a critical notice to the practice is still waiting to go: see why on its care page. For code stripe_connect, its Stripe Connect link is still in place: turn on billing-reconcile, or disconnect it from the Billing page. The hourly job closes the account once nothing is left.",
  },
  account_closure_failed: {
    title: "A leaving practice's account closure failed",
    action:
      "The hourly job tried to close the account of the clinic below and the database refused, so its sign-in and setup are still there. Read the error lines for account closure in apps/app's log; the job tries again every hour.",
  },
  // `phase` retries or destruction; the connection and provider name the row.
  meta_revoke_failed: {
    title: "Meta would not take healdesk off a leaving practice",
    action:
      "Meta keeps refusing to take healdesk's app off the Facebook Page or WhatsApp Business account of the clinic below, which has left. For phase retries the token is kept and the hourly run tries again. For phase destruction the last try failed and the clinic's data, its token included, is destroyed now, as its agreement requires. Either way, ask the practice to remove healdesk from the Page's or the WhatsApp account's connected apps in Meta Business Suite, or remove the subscription from the app's dashboard, so no message reaches healdesk again.",
  },
  // `code` says why; the connection and provider name the row.
  meta_revoke_by_hand: {
    title: "End a leaving practice's Meta subscription by hand",
    action:
      "The clinic below has left, and healdesk erased its Meta token, but could not take its app off the Page or WhatsApp Business account itself. For code no_asset_on_record, healdesk holds no Page or account id for the connection (an operator pasted its token); for code no_token, the token could not be read. For either, ask the practice to remove healdesk from the Page's or the WhatsApp account's connected apps in Meta Business Suite, or end the subscription where it was set up in the app's dashboard. For code asset_unverified, another clinic in service has a connection of the same kind that healdesk holds no Page or account id for, so the Page or account was left subscribed in case it is that clinic's too: check in Meta Business Suite which numbers or Instagram accounts are on it, leave it if the other clinic's is, and otherwise have the leaving practice remove healdesk from it.",
  },
  // L32's clock (lib/patient-rights/patient-requests.ts), once per request
  // each: the clinic's and the request's ids.
  patient_request_due_soon: {
    title: "A patient's request is due tomorrow",
    action:
      "A request a patient made to healdesk about the clinic below has not been marked received by anyone at the practice, and the agreement has us pass it on within five business days, of which one is left. The practice has had the email and two reminders. Telephone the practice on its published number today: tell them a patient's request is waiting on Home in their portal, and if the request names no contact, tell them who asked and how to reach them. Never email the person's details.",
  },
  patient_request_past_due: {
    title: "A patient's request is past its five business days",
    action:
      "A request a patient made to healdesk about the clinic below is past the five business days the agreement gives us to pass it on, and nobody at the practice has marked it received. Telephone the practice today and pass it on by telephone, who asked included where the request names no contact; then ask them to mark it received on its page in the portal, so the record shows it reached them.",
  },
  destruction_notice_undelivered: {
    title: "A practice was not told its data was destroyed",
    action:
      "The clinic below has had its data destroyed, and the email saying so (E6) could not be sent to the address on its account when it was destroyed: the mail provider refused it, this side refused to send it, or it kept failing for a week. healdesk no longer holds that address for the email, so write to the practice by hand from its account in the console: when its data was destroyed, that backups expire within 35 days, what Anthropic keeps under its agreement, and that the signed agreement and billing records are kept.",
  },
  transcript_undelivered: {
    title: "A transcript could not be emailed",
    action:
      "The transcript of the conversation below did not reach the clinic, and healdesk keeps no copy, so it is gone. The reason says why: SES refused the address, the clinic's mail server would not accept it over TLS, or SES is not set up on apps/app (HEALDESK_SES_CONFIGURATION_SET). Fix the cause so the next one arrives, and tell the clinic that one conversation's transcript was lost; its time and outcome are still on the conversation. Never ask the clinic to read the transcript to you.",
  },
  address_change_stalled: {
    title: "An address change is waiting on Stripe",
    action:
      "A clinic's change of address is due, and Stripe would not take the new email, so nothing has moved yet. It is retried every hour. Check the Stripe key and the customer, then check the clinic's sign-in page in the console.",
  },
  address_change_failed: {
    title: "An address change was closed without effect",
    action:
      "A clinic's change of address could not take effect: the new address already signs in to healdesk, or the sign-in's address moved some other way. Call the clinic on its published number and agree the address.",
  },
  sign_in_help_unmatched: {
    title: "A request for sign-in help sent no link",
    action:
      "Someone used I can't get in with a clinic's address, and no link went: the code says why. This is the day's first for this clinic and code; later ones are in the security log. Call the clinic on its published number before changing anything; never send a link anywhere but the address on the account. Requests for addresses with no account alert no one and are counted in the morning digest.",
  },
  retention_purge_failed: {
    title: "The retention purge failed",
    action:
      "The nightly retention purge could not finish for the clinic below, or for every clinic. Until it runs, that clinic keeps conversations, transcripts and raw payloads past the periods its agreement states. Read the worker's error lines for the retention purge and the job's note in the console's job list, fix the cause, then let the next run, at 03 or 09 UTC, catch up: it deletes everything that came due meanwhile.",
  },
  google_oauth_client_rejected: {
    title: "Google refused healdesk's OAuth client",
    action:
      "Google refused healdesk's own OAuth client, or apps/app has none set (code oauth_client), or Google says the Calendar API is disabled in healdesk's Google Cloud project (code api_disabled). Until it is fixed no clinic can connect a calendar or keep one working, and the calendar watch moves each connection it checks to booking requests. Check the Calendar OAuth client and that the Google Calendar API is enabled in the Google Cloud project, and GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the apps/app secret store; a clinic whose connect failed can then try again.",
  },
  // Raised by a recorded termination (lib/agreements/termination.ts) for each
  // location it could not start offboarding (phase offboarding), each
  // billing clinic it could not record a cancellation for (phase billing),
  // each billing clinic whose cancellation is recorded while the
  // billing-requests job is off (phase billing_job_off), and each location
  // whose billing pointer leads outside its practice (phase billing_pointer).
  // The termination itself is recorded, and the assistant has stopped.
  agreement_termination_incomplete: {
    title: "A terminated practice's service did not fully end",
    action:
      "The agreement's termination is recorded and the assistant has stopped, but one step did not finish for the clinic below. For phase offboarding, start offboarding from its care page. For phase billing, cancel the subscription in Stripe at once, without proration: every ending stops the fees on the day. For phase billing_job_off, the cancellation is recorded but the billing-requests job that carries it out is switched off, so the subscription keeps billing: switch billing-requests on in the console, or cancel the subscription in Stripe at once, without proration. For phase billing_pointer, the location's billing clinic is recorded as one in another practice, so nothing was cancelled for it: find which subscription bills this location and cancel it in Stripe at once, without proration, then correct the location's billing clinic.",
  },
  // Raised by the hourly reconcile per practice and step it finished.
  agreement_termination_finished_late: {
    title: "A termination's last steps were finished late",
    action:
      "A recorded termination had a step that never ran, and the hourly reconcile has now finished it for the practice below: for phase offboarding it started its locations' offboarding, for phase billing it recorded the subscription's cancellation. Check the practice in the console. If its subscription billed in between, refund that period, and if the termination refunds fees, confirm that refund on its Billing page.",
  },
  // Raised once per location by the answer gate.
  billing_pointer_outside_practice: {
    title: "A location is billed to another practice",
    action:
      "The clinic below records its billing clinic as one in another practice. The assistant treats it as having no billing and passes its calls and messages to the clinic rather than answer them. Find which practice the location belongs to and correct its billing clinic.",
  },
  // Raised by a first-period refund (commitRefund) whose cancel_now waits on
  // the switched-off billing-requests job.
  refund_cancel_job_off: {
    title: "A refunded plan is still billing",
    action:
      "A first-period refund under the Terms was issued and the plan's cancellation recorded, but the billing-requests job that carries it out is switched off, so the subscription keeps billing. Switch billing-requests on in the console, or cancel the subscription in Stripe at once, without proration.",
  },
  // Raised by a recorded termination for each billing clinic when the
  // practice ended the agreement because healdesk violated a material term,
  // or under the Subcontractors clause: the two endings BAA 1.3.0 clause 17
  // refunds.
  // Raised once per incident by the hourly incident-deadlines job, with the
  // clinic's and the incident's ids.
  incident_notice_overdue: {
    title: "An incident's notice target has passed",
    action:
      "Our own target is to tell the practice within 24 hours of discovering a breach, a security incident or an improper use or disclosure, well inside the agreement's outer limit, and no notice is recorded for the incident below. Decide it now on the console's Incidents page: send the report, which emails the practice's address from fixed fields, or record why it isn't reportable (docs/incident-response.md).",
  },
  // Raised by lib/notices/booking-alerts.ts (urgentAlertNotQueued) when an
  // urgent message's L12 could not be queued: the clinic has no email about
  // it and /api/health stays green, so a person has to phone the clinic.
  urgent_alert_not_queued: {
    title: "An urgent message's alert to the clinic failed",
    action:
      "Someone reported a complication or an urgent symptom, and the clinic's urgent alert could not be queued, so the clinic has not been emailed about it. They were given the fixed urgent reply (emergency services, then the clinic's own number), or, where the message could not be recorded at all, asked to contact the practice directly. Phone the clinic now: tell them an urgent message came in on the channel below at about the time this alert was raised; if its conversation was recorded, its transcript reaches their address when it ends. Then read apps/app's error lines for the failure, usually the database.",
  },
  access_requests_capped: {
    title: "Sign-in help reached today's cap for emails to hello@",
    action:
      "The I can't get in page has sent hello@ as many access requests today as it may, so the rest go unmailed until midnight UTC: the cap keeps the form from spending the day's emails that sign-in links and urgent alerts need. Read today's sign_in_help_unmatched alerts and the security log's sign-in help rows for the clinics that asked, and look for a flood from one place.",
  },
  email_refused: {
    title: "An email was refused before it was sent",
    action:
      "apps/app refused an email of the kind below for the clinic below before sending it: something it was to carry is outside the payload allowlist, or a link in it is not one an email may carry. The clinic has not received it. Read apps/app's error lines for the kind, fix what it was given, and send the clinic what it needed by hand meanwhile.",
  },
  agreement_copy_withheld: {
    title: "A signer's copy of the agreement is still owed",
    action:
      "Someone signed at the checkout, and the copy of the agreement was not emailed to the address they gave. The code says why: a copy already went to that address today, the names on it carry something not safe to mail to an address nobody confirmed, the day's copies to such addresses are spent, or the send failed or had no transport. The signature is on record under the agreement id below. If the signer is genuine, send them the copy by hand from hello@.",
  },
  // The hourly location-quantity check (lib/billing/location-quantity.ts).
  location_quantity_drift: {
    title: "Stripe bills a different number of locations",
    action:
      "The quantity Stripe bills this account for locations is not the number of locations it has active (counting one being added whose charge is recorded). Nothing was changed: the check only reads. Open the account's Billing page and its subscription in Stripe, decide which side is wrong, and put it right by hand: too many billed may be a refund owed, too few an add to finish. You will hear once more when the two agree again.",
  },
  location_quantity_agrees: {
    title: "Stripe's location count matches again",
    action:
      "The quantity Stripe bills this account for locations matches its active locations again, so the mismatch reported earlier for the time below has ended. Nothing more to do unless a refund or a credit for the period it lasted is still owed.",
  },
  // The usage alerts job (lib/billing/usage-alerts.ts), once per clinic,
  // meter and window, whatever the clinic's own switch says.
  usage_near_cap: {
    title: "A clinic is near its monthly allowance",
    action:
      `The clinic below has used ${USAGE_ALERT_PERCENT}% or more of the allowance on the meter shown, in its current window (used against included). The clinic gets its own email only while its Usage alerts switch is on. At this pace, moving up a step costs it less than extra blocks of 100: consider a call before the window ends.`,
  },
  usage_cap_reached: {
    title: "A clinic has used its whole allowance",
    action:
      "The clinic below has used all of the allowance on the meter shown, in its current window. What happens next is its own setting on its Billing page: extra blocks of 100 are billed, or, with Stop and fall back, AYA stops on that meter and calls go to its direct line. Check which, and call the clinic if a step up would serve it better.",
  },
  // lib/ops/calendar-write-alerts.ts, hourly, once per write and state.
  calendar_write_stuck: {
    title: "A booking could not be written to a clinic's calendar",
    action:
      "A booking the clinic confirmed is not in its Google Calendar, and the clinic was already told to add it by hand. Status failed means Google refused it and nothing retries it on its own; unknown means Google never answered and the retries have stopped (five attempts, or a day without one). The code is Google's reason: event_id_taken means an event under our id is already there at another time (look for a duplicate, do not retry); deleted_in_calendar means the clinic deleted it (nothing to do); a target_ code or calendar_not_connected means the calendar or its access changed (send the clinic a calendar link); timeout, network or unconfirmed are passing (retry the write from the clinic's onboarding page). Open the clinic's calendar writes in the console.",
  },
  // The same sweep, when one run finds more stuck writes than it alerts one
  // by one: `count` of them, each recorded as told.
  calendar_writes_stuck_many: {
    title: "Several bookings could not be written to calendars",
    action:
      "The hourly check found the number of bookings below whose Google Calendar write failed or was given up on, more than it reports one by one, so this one alert stands for all of them and none will be sent separately. Each clinic's desk was already told to add its booking by hand. Open the clinics in the console and look at each one's calendar writes on its onboarding page; a new failure after this is reported on its own again.",
  },
  // lib/clinic/change-events.ts, from the minute sweep, once per clinic and
  // kind an hour.
  clinic_availability_changed: {
    title: "A clinic changed when or with whom AYA books",
    action:
      "The clinic below changed what its section names: its weekly hours (hours), its closed days (closures), a location's hours (location_hours), its named providers (providers) or which services they offer (provider_services). Count is how many changes were saved; for closed days, written is how many days were added and deleted how many were taken off. A change made by a change file or in the database directly is recorded too. AYA uses it at once. Open the clinic's page in the console to see each change, and its audit once the clinic-audits job is on.",
  },
  step_up_phone_held: {
    title: "Phone held off a plan with more than one location",
    action:
      "Phone is answering, or is due to join the price, for an account that has more than one location or one being added. Phone is billed per location and each location needs its own AYA number, which isn't built yet, so the step-up into phone was held and nothing was charged. Decide with the practice whether phone stays on; the step-up stays held until phone per location exists.",
  },
  agreement_refund_due: {
    title: "A terminated practice is owed a refund",
    action:
      "The practice ended its agreement for a reason the agreement refunds: the fees it paid for any time after the termination day. On the clinic's Billing page, preview the termination refund, check it, and confirm it. Confirm it before the practice's data is destroyed (at the earliest 29 days after the termination): destruction removes the billing records the console refunds from, and after it the refund has to be made by hand in the Stripe Dashboard. The subscription is already being cancelled.",
  },
};

/**
 * A dead letter is raised under critical_notice_undelivered too (OPS_EVENTS is
 * shared and kept as it is), with `status: "dead"`, and it reads differently:
 * nothing is still trying.
 */
const DEAD_LETTER: Wording = {
  title: "An email to a clinic stopped retrying",
  action:
    "A notice to a clinic used every retry, or was refused outright, and will not be sent. Read its error in the console, then call the clinic.",
};

/** The labels a field prints under. Anything else prints under its own key. */
const LABELS: Record<string, string> = {
  clinicName: "Clinic",
  clinicId: "Clinic id",
  noticeId: "Notice id",
  appointmentId: "Appointment id",
  attemptCount: "Write attempts",
  deliveryId: "Delivery id",
  organizationId: "Organisation id",
  agreementId: "Agreement id",
  eventId: "Event id",
  requestId: "Request id",
  jobId: "Job id",
  connectionId: "Connection id",
  code: "Code",
  kind: "Email kind",
  status: "Status",
  attempts: "Attempts",
  count: "Count",
  windowStart: "Day",
  destroyAt: "Destruction due (UTC)",
  expiresOn: "Expires (UTC)",
  phase: "Phase",
  serviceEndedAt: "Service ended (UTC)",
  lateDays: "Days late",
  conversationId: "Conversation id",
  channel: "Channel",
  locationCount: "Locations active",
  billedCount: "Locations billed in Stripe",
  meter: "Meter",
  used: "Used",
  included: "Included",
};

function wordingFor(payload: OpsAlertPayload): Wording {
  if (payload.event === "critical_notice_undelivered" && payload.status === "dead") {
    return DEAD_LETTER;
  }
  return WORDING[payload.event] ?? { title: payload.event, action: "Look it up in the console." };
}

/** The alert's title, as its email's subject prints it: the Slack copy's first line (lib/ops/slack.ts). */
export function opsAlertTitle(payload: OpsAlertPayload): string {
  return wordingFor(payload).title;
}

/** The label a field prints under, in the email and the Slack copy alike. */
export function opsFieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

export const renderOpsAlert: EmailTemplate<OpsAlertPayload> = (payload, ctx) => {
  const wording = wordingFor(payload);
  const consoleUrl = typeof payload.consoleUrl === "string" ? payload.consoleUrl : null;
  const facts = Object.entries(payload)
    .filter(([key, value]) => key !== "event" && key !== "consoleUrl" && value !== null && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [LABELS[key] ?? key, String(value)] as const);

  const blocks: Block[] = [
    { type: "paragraph", text: wording.action },
    {
      type: "facts",
      rows: [
        ["Event", payload.event],
        ...facts,
        ["Raised", `${ctx.raisedAt.toISOString().replace("T", " ").slice(0, 16)} UTC`],
      ],
    },
    // The clinic's page on the console (D3), behind its own sign-in.
    ...(consoleUrl ? [{ type: "action" as const, label: "Open in the console", url: consoleUrl }] : []),
    {
      type: "paragraph",
      text: "Look the ids up in the ops console. An alert carries ids, counts and the clinic's name only; identical alerts within an hour are sent once.",
    },
  ];

  return compose(
    { subject: `healdesk ops: ${wording.title}`, preheader: wording.action, blocks },
    ctx,
  );
};

/** The payload the snapshot test and `npm run email:seed` render. */
export const OPS_ALERT_FIXTURE: OpsAlertPayload = {
  event: "critical_notice_undelivered",
  clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
  noticeId: "5f0e4a1b-1111-4222-8333-444455556666",
  kind: "payment_failed",
  status: "late",
  attempts: 3,
};
