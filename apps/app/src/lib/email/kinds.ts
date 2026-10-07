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
  // unfinished setup has closed the account, and the calendar emails. Their
  // payloads and their enqueue are lib/notices/plan-notices.ts's.
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
