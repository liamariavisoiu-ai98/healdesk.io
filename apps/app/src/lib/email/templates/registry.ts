import type { EmailKind } from "../kind-rules";
import type { NoticeKind, NoticeOwner } from "../kinds";

import { ADDRESS_CHANGE_CONFIRM_ENTRY } from "./address_change_confirm";
import { AGREEMENT_TO_SIGN_ENTRY } from "./agreement_to_sign";
import { ADDRESS_CHANGING_ENTRY } from "./address_changing";
import { AI_PAUSED_ENTRY } from "./ai_paused";
import { ALLOWANCE_FALLBACK_ENTRY } from "./allowance_fallback";
import { ASSISTANT_READY_ENTRY } from "./assistant_ready";
import {
  BOOKING_REQUEST_ENTRY,
  CALENDAR_CHECK_ENTRY,
  DEPOSIT_TO_COLLECT_ENTRY,
  HANDOVER_ENTRY,
  REQUEST_MISSED_ENTRY,
  REQUEST_STILL_OPEN_ENTRY,
  URGENT_ENTRY,
  WEBSITE_MESSAGE_ENTRY,
} from "./booking_alert";
import { CALENDAR_RECONNECTED_ENTRY, CALENDAR_STOPPED_ENTRY } from "./calendar_state";
import { CALENDAR_ELECTION_RECORDED_ENTRY } from "./calendar_election_recorded";
import { CALENDAR_LINK_ENTRY } from "./calendar_link";
import { CANCEL_REVERSED_ENTRY } from "./cancel_reversed";
import { CANCEL_SCHEDULED_ENTRY } from "./cancel_scheduled";
import { CANCELED_ENTRY } from "./canceled";
import { CARD_EXPIRING_ENTRY } from "./card_expiring";
import { CHANNEL_LIVE_ENTRY } from "./channel_live";
import { CHANNEL_READY_ENTRY } from "./channel_ready";
import { CONNECT_CONNECTED_ENTRY } from "./connect_connected";
import { CONNECT_DISCONNECTED_ENTRY } from "./connect_disconnected";
import { DEVICE_CHANGED_ENTRY } from "./device_changed";
import { GRACE_ENDING_ENTRY } from "./grace_ending";
import { GUARANTEE_CLAIM_RECEIVED_ENTRY, GUARANTEE_FINDING_ENTRY } from "./guarantee_claim";
import { INCIDENT_REPORT_ENTRY } from "./incident_report";
import { LOCATION_ADDED_ENTRY } from "./location_added";
import { OPS_ALERT_FIXTURE, renderOpsAlert } from "./ops_alert";
import { ORDER_CONFIRMED_DELAYED_ENTRY } from "./order_confirmed_delayed";
import { OVERAGE_INVOICED_ENTRY } from "./overage_invoiced";
import { PAYMENT_ACTION_REQUIRED_ENTRY } from "./payment_action_required";
import { PAYMENT_FAILED_ENTRY } from "./payment_failed";
import { PLAN_CHANGED_ENTRY } from "./plan_changed";
import { PLAN_STARTED_ENTRY } from "./plan_started";
import { PRACTICE_QUESTIONS_FAILED_ENTRY } from "./practice_questions_failed";
import { PRICE_STEPPED_UP_ENTRY } from "./price_stepped_up";
import { PRODUCT_UPDATE_ENTRY } from "./product_update";
import { RECEIPT_ENTRY } from "./receipt";
import { REFUND_ISSUED_ENTRY } from "./refund_issued";
import { RENEWAL_UPCOMING_ENTRY } from "./renewal_upcoming";
import { RESTORED_ENTRY } from "./restored";
import { SETTING_CHANGED_ENTRY } from "./setting_changed";
import { SETUP_CLOSED_ENTRY } from "./setup_closed";
import { SETUP_REMINDER_ENTRY } from "./setup_reminder";
import { SIGN_IN_HELP_LINK_ENTRY } from "./sign_in_help_link";
import { SIGN_IN_LINK_ENTRY } from "./sign_in_link";
import { STEP_UP_REMINDER_ENTRY } from "./step_up_reminder";
import { STEPS_SENT_ENTRY } from "./steps_sent";
import { SUBPROCESSOR_NOTICE_ENTRY } from "./subprocessor_notice";
import { SUPPORT_ESCALATION_ENTRY } from "./support_escalation";
import { SUPPORT_REQUEST_ENTRY } from "./support_request";
import { SUSPENDED_ENTRY } from "./suspended";
import { SUSPENDED_FOR_CAUSE_ENTRY } from "./suspended_for_cause";
import { TERMS_NOTICE_ENTRY } from "./terms_notice";
import type { EmailTemplate } from "./types";
import { USAGE_100_ENTRY, USAGE_80_ENTRY } from "./usage_alert";
import { WELCOME_ENTRY } from "./welcome";

/**
 * Which kinds have a template, and who owes the rest.
 *
 * The sender looks a kind up here. A kind with no entry is HELD: its notices
 * stay pending, untouched, until a template ships, and the minute job counts
 * them, rather than burning retries on an email it cannot render. Package C
 * and later milestones add entries as they build their templates; each entry
 * carries the fixture its snapshot test and `npm run email:seed` render.
 *
 * The test in tests/email-templates.test.ts holds the two lists to the
 * registries: every kind has a template or a line in PENDING_TEMPLATES naming
 * its owner, never both, never neither.
 */

export type TemplateEntry<P = Readonly<Record<string, unknown>>> = {
  render: EmailTemplate<P>;
  /** A realistic payload: ids, counts and dates only, as the allowlist requires. */
  fixture: P;
};

// `any` is the registry's own business: each entry pairs a render with a fixture
// of the same payload type, and the lookup below hands both back together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = TemplateEntry<any>;

export const TEMPLATES: Partial<Record<EmailKind, AnyEntry>> = {
  ops_alert: { render: renderOpsAlert, fixture: OPS_ALERT_FIXTURE },
  sign_in_link: SIGN_IN_LINK_ENTRY,
  order_confirmed_delayed: ORDER_CONFIRMED_DELAYED_ENTRY,
  device_changed: DEVICE_CHANGED_ENTRY,
  // The Stripe launch's billing emails (Package C, and Package D's two), in
  // the outbox registry's order.
  payment_failed: PAYMENT_FAILED_ENTRY,
  payment_action_required: PAYMENT_ACTION_REQUIRED_ENTRY,
  grace_ending: GRACE_ENDING_ENTRY,
  suspended: SUSPENDED_ENTRY,
  restored: RESTORED_ENTRY,
  cancel_scheduled: CANCEL_SCHEDULED_ENTRY,
  cancel_reversed: CANCEL_REVERSED_ENTRY,
  canceled: CANCELED_ENTRY,
  renewal_upcoming: RENEWAL_UPCOMING_ENTRY,
  // The usage alerts, at 90% (still `usage_80`) and 100% of the allowance,
  // with the pricing sheet's choice of 13 October 2026: move up a step, or
  // let extra blocks of 100 bill. Optional kinds, so they carry the one-click
  // stop link, whose page (/email/stop) shipped on 8 October.
  usage_80: USAGE_80_ENTRY,
  usage_100: USAGE_100_ENTRY,
  overage_invoiced: OVERAGE_INVOICED_ENTRY,
  plan_changed: PLAN_CHANGED_ENTRY,
  location_added: LOCATION_ADDED_ENTRY,
  connect_disconnected: CONNECT_DISCONNECTED_ENTRY,
  plan_started: PLAN_STARTED_ENTRY,
  price_stepped_up: PRICE_STEPPED_UP_ENTRY,
  step_up_reminder: STEP_UP_REMINDER_ENTRY,
  allowance_fallback: ALLOWANCE_FALLBACK_ENTRY,
  receipt: RECEIPT_ENTRY,
  refund_issued: REFUND_ISSUED_ENTRY,
  card_expiring: CARD_EXPIRING_ENTRY,
  connect_connected: CONNECT_CONNECTED_ENTRY,
  // The setup milestone (M3): the welcome email, the setup reminder, the
  // setup closure and the calendar emails.
  welcome: WELCOME_ENTRY,
  setup_reminder: SETUP_REMINDER_ENTRY,
  setup_closed: SETUP_CLOSED_ENTRY,
  calendar_stopped: CALENDAR_STOPPED_ENTRY,
  calendar_reconnected: CALENDAR_RECONNECTED_ENTRY,
  // The portal (M3, part two): O4, O10 and O11.
  setting_changed: SETTING_CHANGED_ENTRY,
  channel_ready: CHANNEL_READY_ENTRY,
  steps_sent: STEPS_SENT_ENTRY,
  // Go-live (M6): L1, queued when a channel is recorded live.
  channel_live: CHANNEL_LIVE_ENTRY,
  // The header's pause and a channel switched Off (M6): L15.
  ai_paused: AI_PAUSED_ENTRY,
  // The calendar backend's two (plan §2.6, §4.1).
  calendar_link: CALENDAR_LINK_ENTRY,
  calendar_election_recorded: CALENDAR_ELECTION_RECORDED_ENTRY,
  // The live alerts (M5, package F): pointers into Bookings, sent at once at
  // any hour, L12 in-process after commit.
  booking_request: BOOKING_REQUEST_ENTRY,
  request_still_open: REQUEST_STILL_OPEN_ENTRY,
  request_missed: REQUEST_MISSED_ENTRY,
  deposit_to_collect: DEPOSIT_TO_COLLECT_ENTRY,
  handover: HANDOVER_ENTRY,
  urgent: URGENT_ENTRY,
  website_message: WEBSITE_MESSAGE_ENTRY,
  calendar_check: CALENDAR_CHECK_ENTRY,
  // The operator's notices from /admin (WP7): L28, L29's two, L30's two,
  // L31 and L33, each from fixed fields only.
  terms_notice: TERMS_NOTICE_ENTRY,
  subprocessor_notice: SUBPROCESSOR_NOTICE_ENTRY,
  incident_report: INCIDENT_REPORT_ENTRY,
  guarantee_claim_received: GUARANTEE_CLAIM_RECEIVED_ENTRY,
  guarantee_finding: GUARANTEE_FINDING_ENTRY,
  suspended_for_cause: SUSPENDED_FOR_CAUSE_ENTRY,
  product_update: PRODUCT_UPDATE_ENTRY,
  // WP8 (plan Part D5): O6 from /sign-in/help, and O5's confirmation link and
  // notice for a change of the clinic's one address.
  sign_in_help_link: SIGN_IN_HELP_LINK_ENTRY,
  address_change_confirm: ADDRESS_CHANGE_CONFIRM_ENTRY,
  address_changing: ADDRESS_CHANGING_ENTRY,
  // WP10, the support chat (M7): L25 to the clinic, I3 to hello@.
  support_request: SUPPORT_REQUEST_ENTRY,
  support_escalation: SUPPORT_ESCALATION_ENTRY,
  // The practice questions (M4, package B): O8 and O9.
  assistant_ready: ASSISTANT_READY_ENTRY,
  practice_questions_failed: PRACTICE_QUESTIONS_FAILED_ENTRY,
  // WP9, the DPA's completion (plan Part L): L22 and its reminders.
  agreement_to_sign: AGREEMENT_TO_SIGN_ENTRY,
};

/**
 * The package that owes a pending template: one of the packages that finish
 * the funnel and portal plan (14 October 2026). `runtime` is the voice and
 * chat runtime's own work: L17, L18 and L21 wait for its routed/answered
 * counter, which no package here builds.
 */
export type OwingPackage =
  | "B"
  | "WP1"
  | "WP3"
  | "WP4"
  | "WP5"
  | "WP6"
  | "WP7"
  | "WP9"
  | "WP10"
  | "WP11"
  | "runtime";

export type PendingTemplate = {
  owner: NoticeOwner;
  /** The package that builds its payload, its template and whatever queues it. */
  package: OwingPackage;
  /** Where Annex X5 ships it. */
  ships: string;
};

/** The billing kinds templated above, kept out of the pending list's type. */
type BillingTemplatedKind =
  | "payment_failed"
  | "payment_action_required"
  | "grace_ending"
  | "suspended"
  | "restored"
  | "cancel_scheduled"
  | "cancel_reversed"
  | "canceled"
  | "renewal_upcoming"
  | "usage_80"
  | "usage_100"
  | "overage_invoiced"
  | "plan_changed"
  | "location_added"
  | "connect_disconnected"
  | "plan_started"
  | "price_stepped_up"
  | "step_up_reminder"
  | "allowance_fallback"
  | "receipt"
  | "refund_issued"
  | "card_expiring"
  | "connect_connected";

/** The live alerts templated above (package F). */
type LiveAlertKind =
  | "booking_request"
  | "request_still_open"
  | "request_missed"
  | "deposit_to_collect"
  | "handover"
  | "urgent"
  | "website_message"
  | "calendar_check";
/** The operator's notices templated above (WP7), kept out of the pending list's type. */
type OperatorTemplatedKind =
  | "terms_notice"
  | "subprocessor_notice"
  | "incident_report"
  | "guarantee_claim_received"
  | "guarantee_finding"
  | "suspended_for_cause"
  | "product_update";

/** Every kind still waiting for its template, with the session that owes it. */
export const PENDING_TEMPLATES: Record<
  Exclude<
    EmailKind,
    | "ops_alert"
    | "sign_in_link"
    | "order_confirmed_delayed"
    | "device_changed"
    | "welcome"
    | "setup_reminder"
    | "setup_closed"
    | "calendar_stopped"
    | "calendar_reconnected"
    | "setting_changed"
    | "channel_ready"
    | "channel_live"
    | "ai_paused"
    | "steps_sent"
    | "calendar_link"
    | "calendar_election_recorded"
    | LiveAlertKind
    | OperatorTemplatedKind
    | "sign_in_help_link"
    | "address_change_confirm"
    | "address_changing"
    | "support_request"
    | "support_escalation"
    | "assistant_ready"
    | "practice_questions_failed"
    | "agreement_to_sign"
    | BillingTemplatedKind
  >,
  PendingTemplate
> = {
  // WP4: the claims function's emails.
  daily_summary: { owner: "plan", package: "WP4", ships: "M6 (L13)" },
  weekly_recap: { owner: "plan", package: "WP4", ships: "M6 (L14, retargeted)" },
  // The runtime's routed/answered counter: blocked, owned by no package yet.
  outage_started: { owner: "plan", package: "runtime", ships: "M6 (L17)" },
  outage_ended: { owner: "plan", package: "runtime", ships: "M6 (L18)" },
  guarantee_miss: { owner: "plan", package: "runtime", ships: "M6 (L21)" },
  // WP11: the drift list.
  website_changes: { owner: "plan", package: "WP11", ships: "M7 (L23)" },
  // L32, a patient's request recorded from a trusted shell: its own table
  // (patient_requests, behind the BAA gate) and the Home pointer. Not part of
  // WP7's operator notices, which are templated above.
  patient_request: { owner: "plan", package: "WP7", ships: "M5 (L32)" },
  // WP6: after cancellation.
  pass_through_ending: { owner: "plan", package: "WP6", ships: "M6 (E3)" },
  export_ready: { owner: "plan", package: "WP6", ships: "M6 (E4)" },
  export_reminder: { owner: "plan", package: "WP6", ships: "M6 (E5)" },
  data_destroyed: { owner: "plan", package: "WP6", ships: "M6 (E6)" },
  // WP5: the ops digest and the internal alerts.
  ops_digest: { owner: "plan", package: "WP5", ships: "Gate A (I2)" },
  flag_alert: { owner: "plan", package: "WP5", ships: "Gate A (I4)" },
};

/** The template for a kind, or undefined while it is pending. */
export function templateFor(kind: string): AnyEntry | undefined {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? TEMPLATES[kind as EmailKind]
    : undefined;
}

/** The outbox kinds the sender can render now: the ones it asks the database for. */
export function templatedNoticeKinds(
  kinds: readonly NoticeKind[],
  lookup: (kind: string) => AnyEntry | undefined = templateFor,
): NoticeKind[] {
  return kinds.filter((kind) => lookup(kind) !== undefined);
}
