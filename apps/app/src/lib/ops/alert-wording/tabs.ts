import type { OpsEvent } from "@/lib/ops/notify";

/**
 * Where an alert's console link lands: the clinic panel's tab that owns the
 * event, or, for an alert about no clinic, the console page that owns it.
 *
 * The tabs are apps/web's `issueTabFor` (lib/admin/issue-link.ts), copied
 * here because apps/app cannot import apps/web; tests/alert-wording.test.ts
 * parses that file and fails the moment the two lists disagree. Change both
 * in one commit.
 */

export const ISSUE_TABS = ["setup", "billing", "deliveries", "care", "account"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

export const SETUP: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "assistant_knows_no_services",
  "clinic_availability_changed",
  "lifecycle_no_progress",
  "lifecycle_closing_soon",
  "lifecycle_decision_due",
  "lifecycle_waiting_on_us",
  "lifecycle_waiting_on_us_long",
  "lifecycle_channel_waiting",
  "lifecycle_reminders_unanswered",
  "lifecycle_closing_waiting_on_us",
  "calendar_broken",
  "calendar_degraded",
  "calendar_recovered",
  "calendar_write_stuck",
  "go_live_held",
  "web_widget_to_confirm",
  "voice_provision_failed",
  "voice_agent_drift",
  "voice_direct_line_loops",
  "voice_deprovision_failed",
  "voice_fallback_no_direct_line",
  "voice_test_mode_refused",
  "retell_fallback_unsynced",
  "practice_question_failed",
  "practice_question_review_past_due",
  "connection_broken",
  "no_interactions_48_hours",
  "no_inbound_calls_14_days",
  "first_answer_not_recorded",
  "provisioning_follow_up_past_due",
  "meta_revoke_failed",
  "meta_revoke_by_hand",
]);

export const BILLING: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "provisioning_rejected",
  "provisioning_dead_lettered",
  "paid_intent_without_clinic",
  "duplicate_subscription",
  "billing_event_dead_lettered",
  "billing_request_dead_lettered",
  "billing_request_stuck",
  "setup_closure_skipped_live_channel",
  "location_charged_not_created",
  "connect_event_dead_lettered",
  "overage_invoice_failed",
  "meter_report_failing",
  "first_period_refund_due",
  "plan_start_after_cancel",
  "billing_pointer_outside_practice",
  "refund_cancel_job_off",
  "location_quantity_drift",
  "location_quantity_agrees",
  "usage_near_cap",
  "usage_cap_reached",
  "agreement_refund_due",
]);

export const DELIVERIES: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "lifecycle_reminder_undelivered",
  "critical_notice_undelivered",
  "clinic_address_bounced",
  "clinic_address_complained",
  "clinic_address_suppressed",
  "daily_email_count_70",
  "transcript_undelivered",
  "welcome_email_unsent",
  "destruction_notice_undelivered",
  "email_refused",
  "agreement_copy_withheld",
  "urgent_alert_not_queued",
]);

export const ACCOUNT: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "address_change_stalled",
  "address_change_failed",
  "sign_in_help_unmatched",
  "access_requests_capped",
  "step_up_phone_held",
]);

/** The clinic panel's tab for an event: apps/web's issueTabFor, rule for rule. */
export function issueTabFor(event: OpsEvent): IssueTab {
  if (SETUP.has(event)) return "setup";
  if (BILLING.has(event)) return "billing";
  if (DELIVERIES.has(event)) return "deliveries";
  if (ACCOUNT.has(event)) return "account";
  return "care";
}

/**
 * The console page an alert with no clinic opens: the page where that work
 * is done. Every path is a page apps/web has today (the alert-wording test
 * checks each against apps/web's routes). An event not listed has no link
 * when it names no clinic, as before.
 */
export const NO_CLINIC_PAGE: Partial<Record<OpsEvent, string>> = {
  setup_request_reply_past_due: "/admin/queues#setup-requests",
  support_reply_past_due: "/admin/queues#support",
  practice_question_review_past_due: "/admin/queues#reviews",
  calendar_writes_stuck_many: "/admin/clinics",
  ops_digest_summary: "/admin/clinics",
  calendar_watch_incomplete: "/admin/system/jobs",
  calendar_watch_failed: "/admin/system/jobs",
  retention_purge_failed: "/admin/system/jobs",
  meter_report_failing: "/admin/system/jobs",
  vendor_agreement_expiring: "/admin/compliance",
  vendor_agreement_lapsed: "/admin/compliance",
  incident_notice_overdue: "/admin/compliance/incidents",
};
