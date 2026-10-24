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
  // Lane N2c: go-live, account, offboarding, patient-rights, incidents,
  // vendors, meta, retention; each list read from its raise site.
  // lib/engine/practice/store.ts (outcome error, failed, in_review) and
  // job.ts (errors_in_a_row): `section` and `count` come with some outcomes.
  practice_question_failed: ["clinicId", "runId", "outcome", "count", "section"],
  // lib/engine/practice/job.ts sweepPracticeQuestions.
  practice_question_review_past_due: ["clinicId", "reviewId"],
  // lib/ops/health-flags.ts flagClinic.
  no_interactions_48_hours: ["clinicId"],
  no_inbound_calls_14_days: ["clinicId", "channel", "conversationId"],
  // lib/channels/events.ts recordFirstAnswer, goLiveIfReady, noteWidgetLoaded.
  first_answer_not_recorded: ["clinicId", "channel"],
  go_live_held: ["clinicId", "code", "count"],
  web_widget_to_confirm: ["clinicId", "channel"],
  // lib/sign-in/address-change.ts applyChange and failChange.
  address_change_stalled: ["clinicId", "code"],
  address_change_failed: ["clinicId", "code"],
  // lib/sign-in/help.ts runSignInHelp and sendAccessRequest.
  sign_in_help_unmatched: ["code", "clinicId", "windowStart"],
  access_requests_capped: ["count", "windowStart"],
  // lib/billing/reconcile.ts and requests.ts: `count` is the locations.
  step_up_phone_held: ["clinicId", "channel", "count"],
  // lib/offboarding/offboarding.ts alertUndeliveredExport and
  // alertIfOffboardingStartedLate.
  export_undelivered_before_destruction: ["clinicId", "destroyAt"],
  export_due_undelivered: ["clinicId", "exportDueAt", "destroyAt"],
  offboarding_started_late: ["clinicId", "serviceEndedAt", "lateDays"],
  // lib/offboarding/account-closure.ts closeAccountsDue.
  account_closure_waiting: ["clinicId", "code"],
  account_closure_failed: ["clinicId"],
  // lib/offboarding/after-cancellation.ts sendDestructionNotice.
  destruction_notice_undelivered: ["clinicId", "phase"],
  // lib/patient-rights/patient-requests.ts sweepPatientRequests.
  patient_request_due_soon: ["clinicId", "requestId"],
  patient_request_past_due: ["clinicId", "requestId"],
  // lib/scheduler/incident-deadlines.ts alertOverdueIncidents.
  incident_notice_overdue: ["clinicId", "incidentId"],
  // lib/compliance/vendor-coverage.ts watchVendorAgreements and
  // lib/compliance/platform.ts (a withdrawal, without `expiresOn`).
  vendor_agreement_expiring: ["code", "phase", "expiresOn"],
  vendor_agreement_lapsed: ["code", "phase", "expiresOn"],
  // lib/meta/revoke.ts revokeMetaAccess (connectionId, provider) and
  // lib/offboarding/offboarding.ts destroyDueClinics (phase destruction, count).
  meta_revoke_failed: ["clinicId", "connectionId", "provider", "phase", "count"],
  meta_revoke_by_hand: ["clinicId", "connectionId", "provider", "code"],
  // lib/scheduler/retention-purge.ts: `phase` clinic (with its id) or run.
  retention_purge_failed: ["clinicId", "phase"],
};
