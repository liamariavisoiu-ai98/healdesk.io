/**
 * The outbox's kind registry: every kind of notice that goes through
 * `billing_notices`, F0's outbox, which keeps its name (Annex X3 of
 * docs/design/funnel-onboarding-portal-2026-10-06.md).
 *
 * One list, read three ways. The CHECK on `billing_notices.kind` is generated
 * from it (`NOTICE_KINDS`, in db/schema.ts), so a kind added here changes the
 * CHECK and drizzle-kit writes the migration, instead of the INSERT failing
 * inside a Stripe event's transaction. The payload map of the kind's owner
 * must name it, or the typecheck fails: lib/billing/notices.ts for Package
 * C's and D's kinds (`PACKAGE_NOTICE_KINDS`, which db/schema.ts exports as
 * F0's `BILLING_NOTICE_KINDS`), and lib/notices/plan-notices.ts for the
 * plan's own (`PLAN_NOTICE_KINDS`). And the sender (M2) reads each kind's
 * attributes from here: its CAN-SPAM class, whether it goes in-process right
 * after commit, which optional switch can stop it, and whether it waits for
 * daytime. No column is added for any of them.
 *
 * Package C may change the attributes of its own kinds, here and nowhere
 * else: a kind's class, priority, switch or quiet-hours rule is decided in
 * this table, never at a call site or in a template.
 *
 * Pure data with no imports: drizzle-kit loads db/schema.ts, and this file
 * through it, outside the app.
 */

/** CAN-SPAM's class. A commercial kind carries List-Unsubscribe and the postal address (X1.10). */
export type NoticeClass = "transactional" | "commercial";

/** Critical kinds are sent in-process right after commit; normal ones from the `notices` queue. */
export type NoticePriority = "critical" | "normal";

/** The switches that can stop an optional email. Every other kind is part of the service. */
export type NoticeSwitch = "usage_alerts" | "daily_summary" | "product_updates";

/** `daytime` waits for 07:00–20:00 in the clinic's time zone; `any_hour` goes at once. */
export type NoticeQuietHours = "any_hour" | "daytime";

/** Who writes the kind's payload and template: this plan, or the Stripe launch's Package C or D. */
export type NoticeOwner = "plan" | "package_c" | "package_d";

export type NoticeKindAttributes = {
  /** The catalogue id in Annex X5, e.g. "L2". Several kinds share L27. */
  annex: string;
  class: NoticeClass;
  priority: NoticePriority;
  optionalSwitch: NoticeSwitch | null;
  quietHours: NoticeQuietHours;
  owner: NoticeOwner;
};

/**
 * One row of the registry, in its column order. Generic in the owner so the
 * registry's type keeps each kind's owner as a literal, which is how
 * `PlanNoticeKind` and `PackageNoticeKind` below are told apart.
 */
function kind<O extends NoticeOwner>(
  annex: string,
  cls: NoticeClass,
  priority: NoticePriority,
  optionalSwitch: NoticeSwitch | null,
  quietHours: NoticeQuietHours,
  owner: O,
): NoticeKindAttributes & { owner: O } {
  return { annex, class: cls, priority, optionalSwitch, quietHours, owner };
}

/** Every outbox kind. Columns: annex, class, priority, optional switch, quiet hours, owner. */
export const NOTICE_KIND_REGISTRY = {
  // F0's kinds (0043), in F0's order. `welcome_resend` has left: a welcome
  // sent again is a link email with a fresh token (X1.5), not an outbox row.
  payment_failed: kind("L27", "transactional", "critical", null, "any_hour", "package_c"),
  payment_action_required: kind("L27", "transactional", "critical", null, "any_hour", "package_c"),
  grace_ending: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  suspended: kind("L27", "transactional", "critical", null, "any_hour", "package_c"),
  restored: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  cancel_scheduled: kind("E1", "transactional", "normal", null, "any_hour", "package_c"),
  cancel_reversed: kind("E1", "transactional", "normal", null, "any_hour", "package_c"),
  canceled: kind("E2", "transactional", "normal", null, "any_hour", "package_c"),
  renewal_upcoming: kind("L27", "transactional", "normal", null, "daytime", "package_c"),
  // The first usage alert, at USAGE_ALERT_PERCENT: 90% since 13 October 2026.
  // The kind kept its old name, a key in two CHECK constraints.
  usage_80: kind("L27", "transactional", "normal", "usage_alerts", "any_hour", "package_c"),
  usage_100: kind("L27", "transactional", "normal", "usage_alerts", "any_hour", "package_c"),
  overage_invoiced: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  plan_changed: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  location_added: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  connect_disconnected: kind("O14", "transactional", "normal", null, "any_hour", "package_d"),

  // The deferred start and the rest of L27 (contracts §3).
  plan_started: kind("L2", "transactional", "critical", null, "any_hour", "package_c"),
  price_stepped_up: kind("L3", "transactional", "normal", null, "any_hour", "package_c"),
  step_up_reminder: kind("L4", "transactional", "normal", null, "daytime", "package_c"),
  // Sent whatever the usage-alerts switch says: that switch governs usage_80
  // and usage_100, not the fallback (X5, L19).
  allowance_fallback: kind("L19", "transactional", "critical", null, "any_hour", "package_c"),
  receipt: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  refund_issued: kind("L27", "transactional", "normal", null, "any_hour", "package_c"),
  card_expiring: kind("L27", "transactional", "normal", null, "daytime", "package_c"),
  connect_connected: kind("O14", "transactional", "normal", null, "any_hour", "package_d"),

  // The plan's own kinds (M3): the setup reminder, the email that says an
  // unfinished setup has closed the account, the calendar emails, the
  // setting-changed email and the channel-ready email. Their payloads and
  // their enqueue are lib/notices/plan-notices.ts's.
  //
  // O7, one email naming each channel's single action. It waits for daytime,
  // and the job that queues it queues it only in the clinic's daytime too, so
  // it is never queued at night to arrive after a channel has gone live.
  setup_reminder: kind("O7", "transactional", "normal", null, "daytime", "plan"),
  // The day-30 closure (owner, 6 October 2026), after Annex X5 was written,
  // so it takes the next onboarding id. The one email a setup closure sends:
  // Package C sends no `canceled` for it.
  setup_closed: kind("O15", "transactional", "normal", null, "any_hour", "plan"),
  // O13: the calendar backend tells the clinic its connection stopped
  // working, or came back after setup (lib/notices/calendar-state.ts).
  calendar_stopped: kind("O13", "transactional", "normal", null, "any_hour", "plan"),
  calendar_reconnected: kind("O13", "transactional", "normal", null, "any_hour", "plan"),
  // O4: a setting that decides where calls go (the direct line, the transfer
  // number) was changed after it was first set, from a device whose passkey
  // stepped up for it (lib/notices/setting-changed.ts). At any hour: it is
  // how a change nobody at the clinic made gets noticed.
  setting_changed: kind("O4", "transactional", "normal", null, "any_hour", "plan"),
  // O10: a channel ready on our side and still waiting on the clinic an
  // hour later, phone's forwarding or website chat's line
  // (lib/notices/channel-ready.ts, which lib/channels/events.ts calls). It
  // waits for daytime: it is a step to take, not an alert.
  channel_ready: kind("O10", "transactional", "normal", null, "daytime", "plan"),

  // The rest of Annex X5, registered together (14 October 2026) so the CHECK
  // widens once and the packages that finish the plan never collide on it.
  // The package that owes each one's payload and template is named in
  // PENDING_TEMPLATES (templates/registry.ts). Until its payload type lands
  // in lib/notices/plan-notices.ts nothing can queue one, and until its
  // template lands the sender holds any that are queued.
  //
  // L1: AYA is answering on a channel (`live`). It waits for daytime, with the
  // attributes WP1 (pkg/channel-events) gives it beside its template, so the
  // two registrations are one when both land.
  channel_live: kind("L1", "transactional", "normal", null, "daytime", "plan"),
  // The live alerts: pointers only, sent at once, at any hour, and one per
  // event, the most specific (X5). The names are BookingAlertKind's
  // (lib/notices/booking-alerts.ts), which the booking engine, deposits and
  // the runtimes already call with.
  booking_request: kind("L7", "transactional", "normal", null, "any_hour", "plan"),
  // Queued at the clinic's next opening hour, only while the daily summary is
  // off: the job picks the hour, so it goes when queued.
  request_still_open: kind("L8", "transactional", "normal", null, "any_hour", "plan"),
  request_missed: kind("L9", "transactional", "normal", null, "any_hour", "plan"),
  deposit_to_collect: kind("L10", "transactional", "normal", null, "any_hour", "plan"),
  handover: kind("L11", "transactional", "normal", null, "any_hour", "plan"),
  // The one critical alert: in-process right after commit.
  urgent: kind("L12", "transactional", "critical", null, "any_hour", "plan"),
  website_message: kind("L20", "transactional", "normal", null, "any_hour", "plan"),
  calendar_check: kind("L34", "transactional", "normal", null, "any_hour", "plan"),
  // L13, at the clinic's opening time each working day: the job picks the
  // hour, so it goes when queued. The spec's switch, which its one-click
  // stop link also turns off.
  daily_summary: kind("L13", "transactional", "normal", "daily_summary", "any_hour", "plan"),
  // L14, on Mondays only while the daily summary is off (otherwise it rides
  // in the week's first summary). Part of the service, so no switch: the
  // daily summary's switch would stop it exactly when it is meant to go.
  weekly_recap: kind("L14", "transactional", "normal", null, "daytime", "plan"),
  // L15: a pause until tomorrow or indefinitely, or a channel switched Off.
  // At any hour, like O4: it is how a pause nobody at the clinic made gets
  // noticed.
  ai_paused: kind("L15", "transactional", "normal", null, "any_hour", "plan"),
  // L17 and L18: one pair per incident, both critical (X5).
  outage_started: kind("L17", "transactional", "critical", null, "any_hour", "plan"),
  outage_ended: kind("L18", "transactional", "critical", null, "any_hour", "plan"),
  // L21: a guarantee miss, within the Terms' notice days.
  guarantee_miss: kind("L21", "transactional", "normal", null, "daytime", "plan"),
  // L23: the drift check found changes on the clinic's website.
  website_changes: kind("L23", "transactional", "normal", null, "daytime", "plan"),
  // L25: the acknowledgement of a support-chat escalation, naming the reply date.
  support_request: kind("L25", "transactional", "normal", null, "any_hour", "plan"),
  // The operator's notices (L28–L33). Terms notices are mandatory, with no
  // unsubscribe, and go 30 days ahead, so they wait for daytime.
  terms_notice: kind("L28", "transactional", "normal", null, "daytime", "plan"),
  // L29 is two emails with two payloads, and both are critical once ops
  // sends them (X5; WP7): a new subprocessor's notice period runs from the
  // notice, and an incident report is the agreement's written report. Each
  // goes at once, turns /api/health red if it is late, and a dead letter
  // raises notifyOps for a person to phone the practice.
  subprocessor_notice: kind("L29", "transactional", "critical", null, "any_hour", "plan"),
  incident_report: kind("L29", "transactional", "critical", null, "any_hour", "plan"),
  // L30's two: the claim received, then our finding.
  guarantee_claim_received: kind("L30", "transactional", "normal", null, "any_hour", "plan"),
  guarantee_finding: kind("L30", "transactional", "normal", null, "any_hour", "plan"),
  // L31: suspended for a legal or security reason. Critical, like billing's
  // `suspended`: calls go to the direct line from then on.
  suspended_for_cause: kind("L31", "transactional", "critical", null, "any_hour", "plan"),
  // L32: a pointer to a patient's request, which ops records by hand. It
  // waits for daytime: its clock is five business days, its reminders fall
  // due at the first hourly run of a clinic-local day, and a pointer at 3 am
  // helps nobody (lib/patient-rights/patient-requests.ts).
  patient_request: kind("L32", "transactional", "normal", null, "daytime", "plan"),
  // L33: changes to features the clinic already has. Transactional, never
  // promotional, with its own one-click switch.
  product_update: kind("L33", "transactional", "normal", "product_updates", "daytime", "plan"),
  // After cancellation: E3 at 7 days and 1 day before pass-through ends, E4
  // once the export is built, E5 a week before destruction if the export
  // has not been downloaded. E6 is a direct kind (direct-kinds.ts): it goes
  // to an address captured before destruction, not the clinic's address.
  pass_through_ending: kind("E3", "transactional", "normal", null, "daytime", "plan"),
  export_ready: kind("E4", "transactional", "normal", null, "daytime", "plan"),
  export_reminder: kind("E5", "transactional", "normal", null, "daytime", "plan"),
  // O8 and O9, from the practice questions: steps to take, not alerts.
  assistant_ready: kind("O8", "transactional", "normal", null, "daytime", "plan"),
  practice_questions_failed: kind("O9", "transactional", "normal", null, "daytime", "plan"),
} as const;

export type NoticeKind = keyof typeof NOTICE_KIND_REGISTRY;

/** The kinds in registry order, which is the order of the CHECK's list. */
export const NOTICE_KINDS = Object.keys(NOTICE_KIND_REGISTRY) as readonly NoticeKind[];

/** The plan's own kinds, enqueued through lib/notices/plan-notices.ts. */
export type PlanNoticeKind = {
  [K in NoticeKind]: (typeof NOTICE_KIND_REGISTRY)[K]["owner"] extends "plan" ? K : never;
}[NoticeKind];

/** Package C's and D's kinds, enqueued through lib/billing/notices.ts. */
export type PackageNoticeKind = Exclude<NoticeKind, PlanNoticeKind>;

export const PLAN_NOTICE_KINDS: readonly PlanNoticeKind[] = NOTICE_KINDS.filter(
  (k): k is PlanNoticeKind => NOTICE_KIND_REGISTRY[k].owner === "plan",
);

export const PACKAGE_NOTICE_KINDS: readonly PackageNoticeKind[] = NOTICE_KINDS.filter(
  (k): k is PackageNoticeKind => NOTICE_KIND_REGISTRY[k].owner !== "plan",
);
