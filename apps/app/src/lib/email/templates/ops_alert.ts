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
  kind: "Email kind",
  status: "Status",
  attempts: "Attempts",
  count: "Count",
  windowStart: "Day",
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
