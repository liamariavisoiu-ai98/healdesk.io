import type { OpsEvent } from "@/lib/ops/notify";

/**
 * How soon a person must act on each alert, shown first as a coloured
 * one-word tag (lane N4; owner, 24 October 2026: "understand from the first
 * 3 seconds what the issue is"):
 *
 *   - `urgent` (red): money taken or owed, a legal clock, a patient-facing
 *     channel down or a patient's message at risk, data about to be lost.
 *     The subject also gains "URGENT:", and Slack opens it with a siren;
 *   - `today` (amber): a person must act today, but nothing is lost by the
 *     hour;
 *   - `fyi` (grey): a recovery, a digest, a count, a change to note.
 *
 * Started from the lifecycle watch's five escalations (the siren before
 * this lane) and each wording's own "why it matters". A first pass for the
 * owner to review: one line each to change.
 */
export type Urgency = "urgent" | "today" | "fyi";

export const URGENCY: Readonly<Record<OpsEvent, Urgency>> = {
  // Provisioning: a buyer has paid and has no account.
  provisioning_rejected: "urgent",
  provisioning_dead_lettered: "urgent",
  paid_intent_without_clinic: "urgent",
  // Billing: money charged wrongly or not at all.
  duplicate_subscription: "urgent",
  billing_event_dead_lettered: "today",
  billing_request_dead_lettered: "today",
  billing_request_stuck: "today",
  setup_closure_skipped_live_channel: "fyi",
  location_charged_not_created: "urgent",
  connect_event_dead_lettered: "today",
  overage_invoice_failed: "today",
  first_period_refund_due: "urgent",
  plan_start_after_cancel: "today",
  billing_pointer_outside_practice: "urgent",
  refund_cancel_job_off: "urgent",
  location_quantity_drift: "today",
  location_quantity_agrees: "fyi",
  agreement_refund_due: "urgent",
  // Usage.
  meter_report_failing: "today",
  usage_near_cap: "today",
  usage_cap_reached: "today",
  // Email delivery.
  critical_notice_undelivered: "urgent",
  clinic_address_bounced: "today",
  clinic_address_complained: "today",
  clinic_address_suppressed: "today",
  daily_email_count_70: "today",
  dmarc_review_due: "fyi",
  welcome_email_unsent: "today",
  urgent_alert_not_queued: "urgent",
  email_refused: "today",
  // Setup and support: a promise past its day.
  setup_request_reply_past_due: "today",
  provisioning_follow_up_past_due: "urgent",
  support_reply_past_due: "today",
  assistant_knows_no_services: "urgent",
  // Agreements.
  agreement_unsigned_7_days: "today",
  agreement_resign_unrenderable: "today",
  agreement_below_floor_unsigned: "today",
  agreement_termination_incomplete: "urgent",
  agreement_termination_finished_late: "today",
  agreement_copy_withheld: "today",
  // Voice: calls that may not reach a person.
  voice_fallback_no_direct_line: "urgent",
  voice_call_start_failed: "urgent",
  retell_fallback_unsynced: "urgent",
  voice_provision_failed: "today",
  voice_provision_cap_reached: "today",
  voice_agent_drift: "today",
  voice_deprovision_failed: "today",
  voice_direct_line_loops: "urgent",
  voice_test_mode_refused: "urgent",
  // Calendar.
  calendar_broken: "today",
  calendar_degraded: "today",
  calendar_recovered: "fyi",
  calendar_watch_incomplete: "fyi",
  calendar_watch_failed: "today",
  connection_broken: "urgent",
  google_oauth_client_rejected: "urgent",
  calendar_write_stuck: "urgent",
  calendar_writes_stuck_many: "urgent",
  // Transcripts: the clinic lost a conversation's only copy.
  transcript_undelivered: "today",
  // Go live.
  practice_question_failed: "today",
  practice_question_review_past_due: "today",
  no_interactions_48_hours: "urgent",
  no_inbound_calls_14_days: "today",
  first_answer_not_recorded: "today",
  go_live_held: "today",
  web_widget_to_confirm: "today",
  // Account.
  address_change_stalled: "today",
  address_change_failed: "today",
  sign_in_help_unmatched: "today",
  access_requests_capped: "today",
  step_up_phone_held: "today",
  // Offboarding: data about to be destroyed.
  export_undelivered_before_destruction: "urgent",
  export_due_undelivered: "urgent",
  offboarding_started_late: "today",
  account_closure_waiting: "today",
  account_closure_failed: "today",
  destruction_notice_undelivered: "today",
  // Patient rights: a legal clock.
  patient_request_due_soon: "urgent",
  patient_request_past_due: "urgent",
  // Incidents: a legal clock.
  incident_notice_overdue: "urgent",
  // Vendors.
  vendor_agreement_expiring: "today",
  vendor_agreement_lapsed: "urgent",
  // Meta: messages can still reach us after the service ended.
  meta_revoke_failed: "today",
  meta_revoke_by_hand: "today",
  // Retention.
  retention_purge_failed: "today",
  // Availability.
  clinic_availability_changed: "fyi",
  // Setup progress: the watch's five escalations keep their siren (design
  // E2), so all five are urgent; the routine waves are FYI, or today when a
  // clinic waits on us.
  lifecycle_no_progress: "fyi",
  lifecycle_closing_soon: "fyi",
  lifecycle_decision_due: "urgent",
  lifecycle_closing_waiting_on_us: "urgent",
  lifecycle_waiting_on_us: "today",
  lifecycle_waiting_on_us_long: "urgent",
  lifecycle_channel_waiting: "fyi",
  lifecycle_reminder_undelivered: "urgent",
  lifecycle_reminders_unanswered: "urgent",
  // The morning digest's counts.
  ops_digest_summary: "fyi",
};

/** The tag's word and colour, the subject's prefix and Slack's emoji, by level. */
export const URGENCY_LOOK: Readonly<
  Record<Urgency, { tag: string; tone: "red" | "amber" | "grey"; subject: string; emoji: string }>
> = {
  urgent: { tag: "URGENT", tone: "red", subject: "URGENT: ", emoji: ":rotating_light:" },
  today: { tag: "TODAY", tone: "amber", subject: "", emoji: ":large_yellow_circle:" },
  fyi: { tag: "FYI", tone: "grey", subject: "", emoji: ":information_source:" },
};
