/**
 * The outbox's kind registry: every kind of notice that goes through
 * `billing_notices`, F0's outbox, which keeps its name (Annex X3 of
 * docs/design/funnel-onboarding-portal-2026-10-06.md).
 *
 * One list, read three ways. The CHECK on `billing_notices.kind` is generated
 * from it (`BILLING_NOTICE_KINDS` in db/schema.ts), so a kind added here
 * changes the CHECK and drizzle-kit writes the migration, instead of the
 * INSERT failing inside a Stripe event's transaction. The payload map in
 * lib/billing/notices.ts must name the same kinds, or the typecheck fails.
 * And the sender (M2) reads each kind's attributes from here: its CAN-SPAM
 * class, whether it goes in-process right after commit, which optional
 * switch can stop it, and whether it waits for daytime. No column is added
 * for any of them.
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

/** One row of the registry, in its column order. */
function kind(
  annex: string,
  cls: NoticeClass,
  priority: NoticePriority,
  optionalSwitch: NoticeSwitch | null,
  quietHours: NoticeQuietHours,
  owner: NoticeOwner,
): NoticeKindAttributes {
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
} as const;

export type NoticeKind = keyof typeof NOTICE_KIND_REGISTRY;

/** The kinds in registry order, which is the order of the CHECK's list. */
export const NOTICE_KINDS = Object.keys(NOTICE_KIND_REGISTRY) as readonly NoticeKind[];
