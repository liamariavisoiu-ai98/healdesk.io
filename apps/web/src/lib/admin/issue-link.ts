import { isOpsEvent, type OpsEvent } from "@/lib/admin/ops-events";

/**
 * The one URL shape for an issue on the admin console (E1 §3, shared by every
 * lane of the ops automation program):
 *
 *   /admin/clinics/<clinic id>/<tab>#<event>-<id>
 *
 * The clinic panel reads the fragment and shows "Fix with Claude" for that
 * alert (app/admin/clinics/[clinicId]/IssuePanel.tsx). Ids only in the URL: a
 * uuid, an event name from the closed list, a tab from the closed list.
 * Anything else is refused rather than encoded, so a forged or mistyped link
 * cannot carry words into the console's address bar.
 *
 * Today (23 October 2026) nothing emits this shape yet: apps/app's alerts
 * link to `/admin/ops/<id>/care|onboarding` (lib/ops/notify.ts,
 * opsConsoleLink), which redirect to the panel with no issue named
 * (app/admin/ops/[clinicId]/*). The notification rewrite lane moves apps/app
 * to this shape; Home rows and Slack lines follow. Pure: client components
 * import it.
 */

export const ISSUE_TABS = ["setup", "billing", "deliveries", "care", "account"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isIssueTab(value: unknown): value is IssueTab {
  return typeof value === "string" && (ISSUE_TABS as readonly string[]).includes(value);
}

/** The clinic panel, on one tab. */
export function clinicTabPath(clinicId: string, tab: IssueTab): string {
  if (!isUuid(clinicId)) throw new Error("issue-link: not a clinic id");
  if (!isIssueTab(tab)) throw new Error("issue-link: not a tab");
  return `/admin/clinics/${clinicId.toLowerCase()}/${tab}`;
}

/** The anchor's id on the tab: `<event>-<id>`. */
export function issueAnchorId(event: OpsEvent, id: string): string {
  if (!isOpsEvent(event)) throw new Error("issue-link: not an ops event");
  if (!isUuid(id)) throw new Error("issue-link: not an id");
  return `${event}-${id.toLowerCase()}`;
}

/** The whole link, tab chosen by the event unless one is given. */
export function issueLink(clinicId: string, event: OpsEvent, id: string, tab: IssueTab = issueTabFor(event)): string {
  return `${clinicTabPath(clinicId, tab)}#${issueAnchorId(event, id)}`;
}

/** `#<event>-<id>` read back, or null when it is not an issue anchor. */
export function parseIssueHash(hash: string): { event: OpsEvent; id: string } | null {
  const match = /^#?([a-z0-9_]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  if (!match) return null;
  const [, event, id] = match;
  if (!isOpsEvent(event) || id === undefined) return null;
  return { event, id: id.toLowerCase() };
}

/**
 * The tab that owns each event: where the operator acts on it. The setup
 * list is apps/app's `ONBOARDING_PAGE_EVENTS` (lib/ops/notify.ts) plus the
 * voice and calendar events that land on the same cards; billing is the
 * Stripe build's and the lifecycle's; deliveries is every email receipt;
 * account is the address and the devices. Everything else is Care: incidents,
 * agreements, patient rights and offboarding are decided there.
 */
const SETUP: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
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

const BILLING: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
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

const DELIVERIES: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
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

const ACCOUNT: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "address_change_stalled",
  "address_change_failed",
  "sign_in_help_unmatched",
  "access_requests_capped",
  "step_up_phone_held",
]);

export function issueTabFor(event: OpsEvent): IssueTab {
  if (SETUP.has(event)) return "setup";
  if (BILLING.has(event)) return "billing";
  if (DELIVERIES.has(event)) return "deliveries";
  if (ACCOUNT.has(event)) return "account";
  return "care";
}
