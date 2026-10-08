import type { EmailKind } from "../kind-rules";
import type { NoticeKind, NoticeOwner } from "../kinds";

import { ALLOWANCE_FALLBACK_ENTRY } from "./allowance_fallback";
import { CALENDAR_RECONNECTED_ENTRY, CALENDAR_STOPPED_ENTRY } from "./calendar_state";
import { CANCEL_REVERSED_ENTRY } from "./cancel_reversed";
import { CANCEL_SCHEDULED_ENTRY } from "./cancel_scheduled";
import { CANCELED_ENTRY } from "./canceled";
import { CARD_EXPIRING_ENTRY } from "./card_expiring";
import { CONNECT_CONNECTED_ENTRY } from "./connect_connected";
import { CONNECT_DISCONNECTED_ENTRY } from "./connect_disconnected";
import { DEVICE_CHANGED_ENTRY } from "./device_changed";
import { GRACE_ENDING_ENTRY } from "./grace_ending";
import { LOCATION_ADDED_ENTRY } from "./location_added";
import { OPS_ALERT_FIXTURE, renderOpsAlert } from "./ops_alert";
import { ORDER_CONFIRMED_DELAYED_ENTRY } from "./order_confirmed_delayed";
import { OVERAGE_INVOICED_ENTRY } from "./overage_invoiced";
import { PAYMENT_ACTION_REQUIRED_ENTRY } from "./payment_action_required";
import { PAYMENT_FAILED_ENTRY } from "./payment_failed";
import { PLAN_CHANGED_ENTRY } from "./plan_changed";
import { PLAN_STARTED_ENTRY } from "./plan_started";
import { PRICE_STEPPED_UP_ENTRY } from "./price_stepped_up";
import { RECEIPT_ENTRY } from "./receipt";
import { REFUND_ISSUED_ENTRY } from "./refund_issued";
import { RENEWAL_UPCOMING_ENTRY } from "./renewal_upcoming";
import { RESTORED_ENTRY } from "./restored";
import { SETUP_CLOSED_ENTRY } from "./setup_closed";
import { SETTING_CHANGED_ENTRY } from "./setting_changed";
import { SETUP_REMINDER_ENTRY } from "./setup_reminder";
import { SIGN_IN_LINK_ENTRY } from "./sign_in_link";
import { STEP_UP_REMINDER_ENTRY } from "./step_up_reminder";
import { SUSPENDED_ENTRY } from "./suspended";
import type { EmailTemplate } from "./types";
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
  // the outbox registry's order. The usage alerts are not here: they stay
  // pending below until their stop-link page ships.
  payment_failed: PAYMENT_FAILED_ENTRY,
  payment_action_required: PAYMENT_ACTION_REQUIRED_ENTRY,
  grace_ending: GRACE_ENDING_ENTRY,
  suspended: SUSPENDED_ENTRY,
  restored: RESTORED_ENTRY,
  cancel_scheduled: CANCEL_SCHEDULED_ENTRY,
  cancel_reversed: CANCEL_REVERSED_ENTRY,
  canceled: CANCELED_ENTRY,
  renewal_upcoming: RENEWAL_UPCOMING_ENTRY,
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
  // The portal (M3, part two): O4.
  setting_changed: SETTING_CHANGED_ENTRY,
};

export type PendingTemplate = {
  owner: NoticeOwner;
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
    | BillingTemplatedKind
  >,
  PendingTemplate
> = {
  // Optional kinds: they need the stop-link page, which lands with the switches.
  usage_80: { owner: "package_c", ships: "M3, with the usage-alerts stop page (L27)" },
  usage_100: { owner: "package_c", ships: "M3, with the usage-alerts stop page (L27)" },
  sign_in_help_link: { owner: "plan", ships: "M2, sign-in (O6)" },
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
