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
 * The console page an alert opens when it names no clinic: the page where
 * that work is done (lane N3: every event has one, so no alert goes without
 * a link). Events always raised with a clinic open the Clinics list here,
 * only if a raise ever arrives without one. Every path is a page apps/web
 * has today, and every anchor a section on it (tests/alert-wording.test.ts
 * checks both). The comment beside an entry says when it is raised with no
 * clinic.
 *
 * Since Phase 5 (lane P5c) an alert about machine work that the System page
 * lists under "Requires your attention" (lib/ops/inbox/queues.ts: the email
 * outbox and its dead letters, bounces, Stripe and Connect events, billing
 * requests not done, paid orders without an account) opens that section,
 * and a stuck calendar write or an undelivered transcript copy its own list
 * there. Two stay on the Clinics list on purpose: a refused order
 * (provisioning_rejected) is counted as a paid order without an account only
 * when its payment was recorded before the refusal (app/api/provision/route.ts
 * stamps paid_seen_at once the intent is found), and a dead-lettered billing
 * request has its done_at set (lib/billing/requests.ts settle), so neither
 * reliably shows on the System page.
 */
export const NO_CLINIC_PAGE: Readonly<Record<OpsEvent, string>> = {
  // no clinic yet: a paid order, refused; see the header.
  provisioning_rejected: "/admin/clinics",
  // no clinic yet: a paid order, counted under "Paid orders without an account".
  provisioning_dead_lettered: "/admin/system#attention",
  // no clinic yet: a paid order, counted under "Paid orders without an account".
  paid_intent_without_clinic: "/admin/system#attention",
  duplicate_subscription: "/admin/clinics",
  practice_question_failed: "/admin/clinics",
  // no clinic when the event names none: "Stripe events parked" counts it.
  billing_event_dead_lettered: "/admin/system#attention",
  // the outbox: "Emails waiting to send".
  critical_notice_undelivered: "/admin/system#attention",
  // no clinic when only the delivery is known; the bounces of the last day are counted by clinic.
  clinic_address_bounced: "/admin/system#attention",
  // no clinic when only the delivery is known; the bounces of the last day are counted by clinic.
  clinic_address_complained: "/admin/system#attention",
  // no clinic when only the delivery is known; the bounces of the last day are counted by clinic.
  clinic_address_suppressed: "/admin/system#attention",
  // no clinic: the optional sends to hold back are here.
  daily_email_count_70: "/admin/queues#setup-requests",
  // no clinic: the request is in the marketing Sheet.
  setup_request_reply_past_due: "/admin/queues#setup-requests",
  // no clinic yet: a paid order; Home counts paid orders without an account.
  provisioning_follow_up_past_due: "/admin/",
  support_reply_past_due: "/admin/queues#support",
  practice_question_review_past_due: "/admin/queues#reviews",
  agreement_unsigned_7_days: "/admin/clinics",
  agreement_resign_unrenderable: "/admin/clinics",
  agreement_below_floor_unsigned: "/admin/clinics",
  no_interactions_48_hours: "/admin/clinics",
  no_inbound_calls_14_days: "/admin/clinics",
  // a dead letter has its done_at set, so "Billing requests not done" does not count it; see the header.
  billing_request_dead_lettered: "/admin/clinics",
  // a pending request over a day old: "Billing requests not done" counts it.
  billing_request_stuck: "/admin/system#attention",
  setup_closure_skipped_live_channel: "/admin/clinics",
  location_charged_not_created: "/admin/clinics",
  // no clinic when the event names none: "Stripe Connect events parked" counts it.
  connect_event_dead_lettered: "/admin/system#attention",
  overage_invoice_failed: "/admin/clinics",
  meter_report_failing: "/admin/system/jobs",
  first_period_refund_due: "/admin/clinics",
  voice_fallback_no_direct_line: "/admin/clinics",
  voice_call_start_failed: "/admin/clinics",
  // no clinic when Retell refused the key or did not answer.
  retell_fallback_unsynced: "/admin/map",
  voice_provision_failed: "/admin/clinics",
  // no clinic: a day's cap.
  voice_provision_cap_reached: "/admin/clinics",
  voice_agent_drift: "/admin/clinics",
  voice_deprovision_failed: "/admin/clinics",
  voice_direct_line_loops: "/admin/clinics",
  voice_test_mode_refused: "/admin/clinics",
  plan_start_after_cancel: "/admin/clinics",
  // no clinic: the dmarc-review job's row.
  dmarc_review_due: "/admin/system/jobs",
  export_undelivered_before_destruction: "/admin/clinics",
  offboarding_started_late: "/admin/clinics",
  export_due_undelivered: "/admin/clinics",
  calendar_broken: "/admin/clinics",
  calendar_degraded: "/admin/clinics",
  calendar_recovered: "/admin/clinics",
  // no clinic.
  calendar_watch_incomplete: "/admin/system/jobs",
  // no clinic.
  calendar_watch_failed: "/admin/system/jobs",
  welcome_email_unsent: "/admin/clinics",
  // no clinic when the watch met the refusal.
  google_oauth_client_rejected: "/admin/map",
  agreement_termination_incomplete: "/admin/clinics",
  agreement_refund_due: "/admin/clinics",
  // no clinic: an organisation.
  agreement_termination_finished_late: "/admin/compliance/agreements",
  billing_pointer_outside_practice: "/admin/clinics",
  refund_cancel_job_off: "/admin/clinics",
  incident_notice_overdue: "/admin/compliance/incidents",
  // no clinic when the whole run failed.
  retention_purge_failed: "/admin/system/jobs",
  // the list of clinics with a copy not delivered.
  transcript_undelivered: "/admin/system#transcripts",
  first_answer_not_recorded: "/admin/clinics",
  go_live_held: "/admin/clinics",
  web_widget_to_confirm: "/admin/clinics",
  address_change_stalled: "/admin/clinics",
  address_change_failed: "/admin/clinics",
  // no clinic when the address is none's.
  sign_in_help_unmatched: "/admin/clinics",
  connection_broken: "/admin/clinics",
  destruction_notice_undelivered: "/admin/clinics",
  // no clinic: platform-wide.
  vendor_agreement_expiring: "/admin/compliance",
  // no clinic: platform-wide.
  vendor_agreement_lapsed: "/admin/compliance",
  account_closure_waiting: "/admin/clinics",
  account_closure_failed: "/admin/clinics",
  meta_revoke_failed: "/admin/clinics",
  meta_revoke_by_hand: "/admin/clinics",
  patient_request_due_soon: "/admin/clinics",
  patient_request_past_due: "/admin/clinics",
  urgent_alert_not_queued: "/admin/clinics",
  // no clinic: a day's cap; its steps start on Home.
  access_requests_capped: "/admin/",
  // no clinic when the email had none.
  email_refused: "/admin/clinics",
  // no clinic: a signer at checkout.
  agreement_copy_withheld: "/admin/compliance/agreements",
  location_quantity_drift: "/admin/clinics",
  location_quantity_agrees: "/admin/clinics",
  step_up_phone_held: "/admin/clinics",
  usage_near_cap: "/admin/clinics",
  usage_cap_reached: "/admin/clinics",
  // the stuck writes across clinics, one row per clinic.
  calendar_write_stuck: "/admin/system#calendar-writes",
  // no clinic: a count across clinics, listed there one clinic per row.
  calendar_writes_stuck_many: "/admin/system#calendar-writes",
  clinic_availability_changed: "/admin/clinics",
  lifecycle_no_progress: "/admin/clinics",
  lifecycle_closing_soon: "/admin/clinics",
  lifecycle_decision_due: "/admin/clinics",
  lifecycle_waiting_on_us: "/admin/clinics",
  lifecycle_waiting_on_us_long: "/admin/clinics",
  lifecycle_channel_waiting: "/admin/clinics",
  lifecycle_reminder_undelivered: "/admin/clinics",
  lifecycle_reminders_unanswered: "/admin/clinics",
  lifecycle_closing_waiting_on_us: "/admin/clinics",
  // no clinic: the digest's counts; its steps start on Home.
  ops_digest_summary: "/admin/",
  assistant_knows_no_services: "/admin/clinics",
};

/** The console pages an alert with no clinic opens, by path, as a button names them. */
const PAGE_NAMES: Readonly<Record<string, string>> = {
  "/admin/": "Home",
  "/admin/clinics": "Clinics",
  "/admin/queues": "Queues",
  "/admin/system": "System",
  "/admin/system/jobs": "Jobs",
  "/admin/map": "Map",
  "/admin/compliance": "Compliance",
  "/admin/compliance/incidents": "Incidents",
  "/admin/compliance/agreements": "the Agreements register",
};

/**
 * The button's words for a console link (lane N4): "Open in the console"
 * for a clinic's tab, "Open <page>" for a page an alert about no clinic
 * opens, so the reader knows where the button goes.
 */
export function consoleLinkLabel(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "Open in the console";
  }
  const name = PAGE_NAMES[path];
  return name ? `Open ${name}` : "Open in the console";
}
