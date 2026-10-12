import type { OpsEvent } from "@/lib/ops/notify";

import { compose, type Block } from "./compose";
import type { EmailTemplate } from "./types";

/**
 * I1 in Annex X5: one notifyOps alert, to HEALDESK_OPS_EMAIL.
 *
 * Ids, counts and categories only, which the operator looks up in the ops
 * console. Nothing here names a clinic, quotes an address or carries free
 * text, so the alert is safe to read on a phone in a queue and safe in a
 * vendor's logs. The wording says what happened and what to do next, one
 * event at a time, because "something went wrong" at 3 am is not an alert.
 *
 * It links nowhere. The console lives on the marketing site's origin, and an
 * email from apps/app links only to apps/app's public origin (X1.6).
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
  provisioning_dead_lettered: {
    title: "Provisioning stopped retrying",
    action:
      "Provisioning for a paid order used every retry. Finish it from the console and email the buyer the date it will be ready.",
  },
  paid_intent_without_clinic: {
    title: "A paid order has no clinic",
    action:
      "Payment arrived more than ten minutes ago and no clinic exists for it. Check provisioning for this order.",
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
  provisioning_follow_up_past_due: {
    title: "An order follow-up is past due",
    action:
      "We promised a buyer an update on their order by a date that has passed. Email them today.",
  },
  support_reply_past_due: {
    title: "A support reply is past due",
    action: "A support escalation is past the reply date we gave. Reply today.",
  },
  practice_question_review_past_due: {
    title: "A practice-question review is past due",
    action: "A practice-question review is past the date we gave the clinic. Finish it today.",
  },
  agreement_unsigned_7_days: {
    title: "An updated agreement is unsigned",
    action: "A clinic has not signed its updated agreement after seven days. Call the clinic.",
  },
  no_interactions_48_hours: {
    title: "A live clinic has been quiet for 48 hours",
    action:
      "No interactions on any channel for 48 hours after go-live. Check the clinic's forwarding and channels.",
  },
  no_inbound_calls_14_days: {
    title: "No inbound calls for 14 days",
    action:
      "A live phone channel has had no inbound calls for 14 days. Check the clinic's call forwarding.",
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
      "Our own target is to tell the practice within 24 hours of discovering a breach, a security incident or an improper use or disclosure, well inside the agreement's outer limit, and no notice is recorded for the incident below. Send the notice to the practice's notice address now, following docs/incident-response.md, then record it on the incident in the console.",
  },
  agreement_refund_due: {
    title: "A terminated practice is owed a refund",
    action:
      "The practice ended its agreement for a reason the agreement refunds: the fees it paid for any time after the termination day. On the clinic's Billing page, preview the termination refund, check it, and confirm it. The subscription is already being cancelled.",
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
  clinicId: "Clinic id",
  noticeId: "Notice id",
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
  serviceEndedAt: "Service ended (UTC)",
  lateDays: "Days late",
};

function wordingFor(payload: OpsAlertPayload): Wording {
  if (payload.event === "critical_notice_undelivered" && payload.status === "dead") {
    return DEAD_LETTER;
  }
  return WORDING[payload.event] ?? { title: payload.event, action: "Look it up in the console." };
}

export const renderOpsAlert: EmailTemplate<OpsAlertPayload> = (payload, ctx) => {
  const wording = wordingFor(payload);
  const facts = Object.entries(payload)
    .filter(([key, value]) => key !== "event" && value !== null && value !== undefined)
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
    {
      type: "paragraph",
      text: "Look the ids up in the ops console. An alert carries ids and counts only; identical alerts within an hour are sent once.",
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
