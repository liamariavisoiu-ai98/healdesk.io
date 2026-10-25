import type { EmailKind } from "@/lib/email/kind-rules";
import type { OpsEvent } from "@/lib/ops/notify";

/**
 * The closed word lists an ops alert may print (lane N3, from the accuracy
 * reviews of the alert wording): each field whose values come from a closed
 * set in the code, every value mapped to plain English. A value not in its
 * list is not printable: allowedAlertFields (./allow-list.ts) leaves it out,
 * so the wording drops the clause that names it and the facts never show the
 * raw word. Ids, codes outside these lists, free text and anything about a
 * patient stay out, as before.
 *
 * Most lists are by field name (CLOSED_WORDS): `meter`, `section`, `kind`,
 * `channel`, `provider`, `decision` and `recommendation` mean one closed set
 * wherever they appear, and the two sets that share `kind` (an email kind
 * or a billing request kind) share no value; the facts label `kind` by
 * event (facts.ts). Two fields do not: `code` is a reason code on most
 * events and a vendor only on the two vendor alerts, and `status` means
 * something different at each raise site. Those are by event (EVENT_WORDS):
 * a value prints only on an event whose own list has it, so a reason code
 * that happens to equal a vendor id can never print as a vendor.
 */

/** An email's kind (lib/email/kinds.ts and direct-kinds.ts), as "a … email". Typed so a new kind needs a phrase. */
export const EMAIL_KIND_WORDS: Readonly<Record<EmailKind, string>> = {
  payment_failed: "a payment-failed notice",
  payment_action_required: "a payment-needs-action notice",
  grace_ending: "a grace-period-ending notice",
  suspended: "a suspension notice",
  restored: "a service-restored notice",
  cancel_scheduled: "a cancellation-scheduled notice",
  cancel_reversed: "a cancellation-reversed notice",
  canceled: "a cancellation notice",
  renewal_upcoming: "a renewal reminder",
  usage_80: "an allowance-nearly-used notice",
  usage_100: "an allowance-used notice",
  overage_invoiced: "an extra-usage invoice notice",
  plan_changed: "a plan-changed notice",
  location_added: "a location-added notice",
  connect_disconnected: "a payment-account-disconnected notice",
  plan_started: "a plan-started notice",
  price_stepped_up: "a price-change notice",
  step_up_reminder: "a price-change reminder",
  allowance_fallback: "an allowance-fallback notice",
  receipt: "a receipt",
  refund_issued: "a refund notice",
  card_expiring: "a card-expiring notice",
  connect_connected: "a payment-account-connected notice",
  setup_reminder: "a setup reminder",
  setup_closed: "a setup-closed notice",
  calendar_stopped: "a calendar-stopped notice",
  calendar_reconnected: "a calendar-reconnected notice",
  setting_changed: "a setting-changed notice",
  channel_ready: "a channel-ready notice",
  channel_live: "a channel-live notice",
  booking_request: "a booking-request alert",
  request_still_open: "an open-request reminder",
  request_missed: "a missed-request alert",
  deposit_to_collect: "a deposit-to-collect alert",
  handover: "a handover alert",
  urgent: "an urgent-message alert",
  website_message: "a website-message alert",
  calendar_check: "a calendar-check alert",
  ended_early: "an ended-early alert",
  daily_summary: "a daily summary",
  weekly_recap: "a weekly recap",
  ai_paused: "an AYA-paused notice",
  outage_started: "an outage notice",
  outage_ended: "an outage-ended notice",
  guarantee_miss: "a guarantee notice",
  website_changes: "a website-changes notice",
  support_request: "a support-request confirmation",
  terms_notice: "a terms notice",
  subprocessor_notice: "a subprocessor notice",
  incident_report: "an incident report",
  guarantee_claim_received: "a guarantee-claim confirmation",
  guarantee_finding: "a guarantee finding",
  suspended_for_cause: "a suspension-for-cause notice",
  patient_request: "a patient-request notice",
  product_update: "a product update",
  pass_through_ending: "a pass-through-ending notice",
  export_ready: "an export-ready notice",
  export_reminder: "an export reminder",
  assistant_ready: "an AYA-ready notice",
  practice_questions_failed: "a practice-questions notice",
  closed_day_bookings: "a closed-day-bookings notice",
  ops_alert: "an ops alert",
  sign_in_link: "a sign-in link",
  sign_in_help_link: "a sign-in help link",
  device_changed: "a device-changed notice",
  device_recovery_link: "a device recovery link",
  order_confirmed_delayed: "a delayed order confirmation",
  welcome: "the welcome email",
  steps_sent: "a setup-steps email",
  calendar_link: "a calendar link",
  calendar_election_recorded: "a calendar-terms confirmation",
  address_change_confirm: "an address-change confirmation",
  address_changing: "an address-changing notice",
  agreement_to_sign: "an agreement to sign",
  data_destroyed: "the data-destroyed notice",
  ops_digest: "the ops digest",
  flag_alert: "a flagged-answer alert",
  support_escalation: "a support escalation",
  agreement_copy: "an agreement copy",
  access_request: "an access request",
  // Lane P6f: the emails the owner sends a clinic through the approval inbox.
  setup_extended: "a more-time-for-setup email",
  setup_waiting_on_us: "a we're-finishing-it email",
  setup_help_offer: "a five-minute-call offer",
  agreement_question: "an agreement question",
  baa_resign_chase: "an agreement re-sign chase",
};

/** A billing request's kind (db/schema.ts BILLING_REQUEST_KINDS). */
export const REQUEST_KIND_WORDS: Readonly<Record<string, string>> = {
  plan_start: "starting the plan",
  step_up: "a price step-up",
  close_setup: "closing an unfinished setup",
  cancel_now: "an immediate cancellation",
};

/** The vendors in the BAA chain (lib/compliance/subjects.ts PLATFORM_VENDORS), on the two vendor alerts' `code`. */
export const VENDOR_WORDS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic (the AI model provider)",
  database_host: "the database host",
  aws: "AWS (our host)",
  retell: "Retell (the voice provider)",
};

/** A channel (catalog CHANNELS; the email allowlist admits these three only). */
export const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  voice: "phone",
  web: "website chat",
  meta: "Meta (Instagram, Messenger, WhatsApp)",
};

/** A Meta connection's provider (lib/meta/providers.ts META_PROVIDERS). */
export const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  "meta-messenger": "Facebook Messenger",
  "meta-instagram": "Instagram",
  "meta-whatsapp": "WhatsApp",
};

/** The Knowledge sections practice questions check (lib/engine/practice/types.ts PRACTICE_SECTIONS). */
export const PRACTICE_SECTION_WORDS: Readonly<Record<string, string>> = {
  practice: "practice details",
  prices: "prices",
  policies: "policies",
  promotions: "promotions",
  quick_answers: "quick answers",
  never_say: "never-say list",
  how_aya_talks: "how AYA talks",
  safety_net: "safety net",
};

/** What a clinic changed (clinic_availability_changed's `section`). */
export const CHANGE_SECTION_WORDS: Readonly<Record<string, string>> = {
  hours: "weekly opening hours",
  closures: "closed days",
  location_hours: "opening hours at its locations",
  providers: "list of named providers",
  provider_services: "services each provider offers",
};

/**
 * Every closed list, by field. A value is printable only when its field has
 * a list here (or a rule of its own in allowedAlertFields) and the value is
 * in it.
 */
export const CLOSED_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  meter: { voice_minutes: "voice minutes", chat_conversations: "chat conversations" },
  section: { ...PRACTICE_SECTION_WORDS, ...CHANGE_SECTION_WORDS },
  recommendation: {
    extend: "extend the setup window",
    offer_call: "offer a five-minute call",
    let_close: "let it close",
    wait: "wait a few more days",
    phone_the_clinic: "phone the clinic",
  },
  decision: {
    none: "none yet",
    extension_offered: "a call was offered",
    let_close: "let it close",
    extended: "the window was extended",
  },
  kind: { ...EMAIL_KIND_WORDS, ...REQUEST_KIND_WORDS },
  channel: CHANNEL_WORDS,
  provider: PROVIDER_WORDS,
};

/**
 * Each event's `status`, read from its raise site: what that status means
 * for that event, and nothing printed for a status another site passes.
 */
export const STATUS_WORDS: Readonly<Partial<Record<OpsEvent, Readonly<Record<string, string>>>>> = {
  // lib/email/outbox.ts: the health check's late notice, the sender's dead letter.
  critical_notice_undelivered: { late: "late, still being retried", dead: "given up" },
  // lib/billing/reconcile.ts: a dead request put back to try again.
  billing_request_dead_lettered: { rearmed: "set to try again" },
  // lib/scheduler/connection-health.ts: revoked connections only.
  connection_broken: { revoked: "access removed" },
  // lib/voice/provision.ts: a drift written again, or left for a person.
  voice_agent_drift: { repaired: "repaired", flagged: "left for a person" },
  // lib/ops/calendar-write-alerts.ts: the write's state. `failed` is an
  // answer that settled it (lib/booking/calendar.ts failureOutcome and
  // readBackOutcome: Google or our own set-up refused the write, the clinic
  // deleted the event, our id is taken or not ours, the calendar is broken
  // or none is connected), never retried by the sweep. A timeout, a lost
  // reply, a rate limit or a server error before the insert ends `unknown`
  // instead, retried on the ladder; since 24 October 2026 none of them ends
  // `failed`. So `failed` says only that the booking is not written.
  calendar_write_stuck: { failed: "not written", unknown: "never confirmed by Google", writing: "never finished" },
  // lib/conversations/transcript-outbox.ts: the send's state, or SES's failure event.
  transcript_undelivered: {
    retrying: "being retried",
    expired: "deleted unsent after 30 days",
    unconfirmed: "never confirmed by the mail service",
    bounce: "bounced",
    reject: "refused by the mail service",
    rendering_failure: "could not be built by the mail service",
    complaint: "marked as spam",
  },
};

/** The fields whose words depend on the event (see the header). */
export const EVENT_WORDS: Readonly<Record<string, Readonly<Partial<Record<OpsEvent, Readonly<Record<string, string>>>>>>> = {
  // lib/compliance/vendor-coverage.ts and platform.ts: the only raise sites
  // whose `code` is a vendor (PLATFORM_VENDORS).
  code: { vendor_agreement_expiring: VENDOR_WORDS, vendor_agreement_lapsed: VENDOR_WORDS },
  status: STATUS_WORDS,
};

/** Whether some event's list has this value: the allow-list admits it, and the event decides whether it prints. */
export function anyEventWord(key: string, value: unknown): boolean {
  const lists = EVENT_WORDS[key];
  return (
    typeof value === "string" && lists !== undefined && Object.values(lists).some((list) => Object.hasOwn(list!, value))
  );
}

/** The words for an event-scoped value on this event, or null when this event's list does not have it. */
export function eventWord(key: string, value: unknown, event: OpsEvent | undefined): string | null {
  if (typeof value !== "string" || !event) return null;
  const list = EVENT_WORDS[key]?.[event];
  return list && Object.hasOwn(list, value) ? list[value]! : null;
}

/** The plain words for a closed value, or null when it is not in its field's list. */
export function closedWord(key: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const list = CLOSED_WORDS[key];
  return list && Object.hasOwn(list, value) ? list[value]! : null;
}

/**
 * The values as this event may print them: each event-scoped field replaced
 * by its words for this event, or dropped when this event's list does not
 * have it (so its clause drops and no fact row shows). Both renderings call
 * it, through fillWording and the facts, with the event their wording was
 * looked up for.
 */
export function scopeToEvent(
  values: Readonly<Record<string, string | number>>,
  event: OpsEvent | undefined,
): Record<string, string | number> {
  const out = { ...values };
  for (const key of Object.keys(EVENT_WORDS)) {
    if (!Object.hasOwn(out, key)) continue;
    const word = eventWord(key, out[key], event);
    if (word === null) delete out[key];
    else out[key] = word;
  }
  return out;
}
