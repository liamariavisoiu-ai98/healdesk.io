import type { OpsEvent } from "@/lib/ops/notify";

/**
 * The fields each rewritten event is raised with, read from its raise site.
 * The wording lint (tests/alert-wording.test.ts) holds a wording's
 * placeholders to these, plus `clinicName` where the event names a clinic and
 * `percent` where it carries `used` and `included`. Add the event here in the
 * commit that rewrites its wording; a field missing here is a placeholder the
 * alert can never fill.
 */
export const EVENT_FIELDS: Partial<Record<OpsEvent, readonly string[]>> = {
  // lib/ops/promise-ops.ts opSetupRepliesPastDue.
  setup_request_reply_past_due: ["requestId", "source", "business", "promisedOn"],
  // lib/billing/usage-alerts.ts.
  usage_near_cap: ["clinicId", "meter", "windowStart", "used", "included"],
  // lib/ops/calendar-write-alerts.ts.
  calendar_write_stuck: ["clinicId", "appointmentId", "status", "code", "attemptCount"],
  // lib/lifecycle/waves.ts dueWaves.
  lifecycle_decision_due: [
    "clinicId",
    "stepsLeftCount",
    "noProgressDays",
    "setupDays",
    "remainingDays",
    "decision",
    "recommendation",
    "extendDays",
  ],
  // lib/clinic/change-events.ts changeAlertFields.
  clinic_availability_changed: ["clinicId", "section", "count", "written", "deleted"],

  // Lane N2a: provisioning, billing, usage and email delivery, each read from
  // its raise site (named beside it). A key that two raise sites disagree on
  // is listed once; a null value is simply absent from the alert.
  // app/api/provision/route.ts, every refusal.
  provisioning_rejected: ["field", "source"],
  // lib/checkout/dead-letter.ts announceDeadLetter.
  provisioning_dead_lettered: ["requestId", "attempts"],
  // lib/ops/watch.ts watchPurchases.
  paid_intent_without_clinic: ["requestId", "attempts"],
  // app/api/provision/route.ts, by intent or by customer.
  duplicate_subscription: ["clinicId", "source"],
  // lib/billing/events.ts handleStripeEvent.
  billing_event_dead_lettered: ["eventId", "type", "failures", "clinicId"],
  // lib/billing/requests.ts settle, and lib/billing/reconcile.ts (status rearmed).
  billing_request_dead_lettered: ["clinicId", "requestId", "kind", "channel", "attempts", "code", "status"],
  // lib/billing/reconcile.ts fieldsOf.
  billing_request_stuck: ["clinicId", "requestId", "kind", "channel"],
  // lib/billing/requests.ts closeSetupWorker.
  setup_closure_skipped_live_channel: ["clinicId"],
  // lib/billing/stripe-actions.ts finishLocationSetup; lib/billing/reconcile.ts resumes.
  location_charged_not_created: ["clinicId", "requestId", "count"],
  // lib/billing/connect-events.ts handleConnectEvent.
  connect_event_dead_lettered: ["eventId", "eventType", "clinicId", "code"],
  // lib/billing/annual-overage.ts.
  overage_invoice_failed: ["clinicId", "windowStart"],
  // lib/billing/stripe-actions.ts setAutoRenew.
  first_period_refund_due: ["clinicId"],
  // lib/billing/requests.ts planStart.
  plan_start_after_cancel: ["clinicId", "requestId"],
  // lib/billing/answering.ts.
  billing_pointer_outside_practice: ["clinicId"],
  // lib/billing/stripe-actions.ts commitRefund.
  refund_cancel_job_off: ["clinicId"],
  // lib/billing/location-quantity.ts alertOnChange.
  location_quantity_drift: ["clinicId", "windowStart", "locationCount", "billedCount"],
  location_quantity_agrees: ["clinicId", "windowStart", "locationCount"],
  // lib/agreements/termination.ts.
  agreement_refund_due: ["clinicId", "agreementId"],
  // lib/billing/usage-report.ts.
  meter_report_failing: ["clinicId", "count"],
  // lib/billing/usage-alerts.ts, the same fields as usage_near_cap.
  usage_cap_reached: ["clinicId", "meter", "windowStart", "used", "included"],
  // lib/email/outbox.ts (late, from the health check; dead, from the sender).
  critical_notice_undelivered: ["clinicId", "noticeId", "kind", "status", "attempts"],
  // lib/email/events.ts applyEmailEvent: with a clinic, `kind`; without one, `deliveryId`.
  clinic_address_bounced: ["clinicId", "kind", "deliveryId"],
  clinic_address_complained: ["clinicId", "kind", "deliveryId"],
  clinic_address_suppressed: ["clinicId", "kind", "deliveryId"],
  // lib/email/quota.ts recordDailyQuota.
  daily_email_count_70: ["count", "windowStart"],
  // lib/scheduler/dmarc-review.ts checkDmarcReview.
  dmarc_review_due: ["windowStart"],
  // lib/setup/welcome-email.ts runWelcomeBackstop.
  welcome_email_unsent: ["clinicId"],
  // lib/notices/booking-alerts.ts urgentAlertNotQueued.
  urgent_alert_not_queued: ["clinicId", "channel", "conversationId", "callId"],
  // lib/email/send.ts refused.
  email_refused: ["kind", "clinicId", "windowStart"],
};
