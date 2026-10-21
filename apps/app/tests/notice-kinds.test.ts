import { describe, expect, test } from "vitest";

import { BILLING_NOTICE_KINDS } from "@/db/schema";
import { CRITICAL_NOTICE_KINDS } from "@/lib/email/kind-rules";
import {
  NOTICE_KIND_REGISTRY,
  NOTICE_KINDS,
  PACKAGE_NOTICE_KINDS,
  PLAN_NOTICE_KINDS,
  type NoticeKind,
} from "@/lib/email/kinds";
import type { BookingAlertKind } from "@/lib/notices/booking-alerts";

/**
 * The outbox's kind registry (lib/email/kinds.ts) against the lists built
 * from it: the CHECK covers every kind (`NOTICE_KINDS`), lib/billing's
 * payload map the packages' (`BILLING_NOTICE_KINDS`) and lib/notices/plan-
 * notices.ts's the plan's. Each payload map is held to its kinds by a
 * compile-time check, so none of them can drift apart.
 */

/** The plan's kinds that shipped with their templates in M3. */
const M3_PLAN_KINDS = [
  "calendar_reconnected",
  "calendar_stopped",
  "channel_ready",
  "setting_changed",
  "setup_closed",
  "setup_reminder",
] as const;

/**
 * The rest of Annex X5's outbox kinds, registered on 14 October 2026 before
 * the packages that build them: annex id, priority, switch, quiet hours.
 */
const REGISTERED_AHEAD: Record<
  string,
  readonly [
    string,
    "critical" | "normal",
    "daily_summary" | "product_updates" | null,
    "any_hour" | "daytime",
  ]
> = {
  channel_live: ["L1", "normal", null, "daytime"],
  booking_request: ["L7", "normal", null, "any_hour"],
  request_still_open: ["L8", "normal", null, "any_hour"],
  request_missed: ["L9", "normal", null, "any_hour"],
  deposit_to_collect: ["L10", "normal", null, "any_hour"],
  handover: ["L11", "normal", null, "any_hour"],
  urgent: ["L12", "critical", null, "any_hour"],
  website_message: ["L20", "normal", null, "any_hour"],
  calendar_check: ["L34", "normal", null, "any_hour"],
  ended_early: ["L35", "normal", null, "any_hour"],
  daily_summary: ["L13", "normal", "daily_summary", "any_hour"],
  weekly_recap: ["L14", "normal", null, "daytime"],
  ai_paused: ["L15", "normal", null, "any_hour"],
  outage_started: ["L17", "critical", null, "any_hour"],
  outage_ended: ["L18", "critical", null, "any_hour"],
  guarantee_miss: ["L21", "normal", null, "daytime"],
  website_changes: ["L23", "normal", null, "daytime"],
  support_request: ["L25", "normal", null, "any_hour"],
  terms_notice: ["L28", "normal", null, "daytime"],
  // Critical once sent, like the incident report (WP7): its notice period
  // runs from it, so a late one turns /api/health red.
  subprocessor_notice: ["L29", "critical", null, "any_hour"],
  incident_report: ["L29", "critical", null, "any_hour"],
  guarantee_claim_received: ["L30", "normal", null, "any_hour"],
  guarantee_finding: ["L30", "normal", null, "any_hour"],
  suspended_for_cause: ["L31", "critical", null, "any_hour"],
  // Daytime: a five-business-day clock, and reminders due at a clinic-local day's first run.
  patient_request: ["L32", "normal", null, "daytime"],
  product_update: ["L33", "normal", "product_updates", "daytime"],
  pass_through_ending: ["E3", "normal", null, "daytime"],
  export_ready: ["E4", "normal", null, "daytime"],
  export_reminder: ["E5", "normal", null, "daytime"],
  assistant_ready: ["O8", "normal", null, "daytime"],
  practice_questions_failed: ["O9", "normal", null, "daytime"],
};

const F0_KINDS = [
  "payment_failed",
  "payment_action_required",
  "grace_ending",
  "suspended",
  "restored",
  "cancel_scheduled",
  "cancel_reversed",
  "canceled",
  "renewal_upcoming",
  "usage_80",
  "usage_100",
  "overage_invoiced",
  "plan_changed",
  "location_added",
  "connect_disconnected",
];

describe("the notice kind registry", () => {
  test("every outbox kind has an entry, and every entry is an outbox kind", () => {
    expect([...NOTICE_KINDS].sort()).toEqual(Object.keys(NOTICE_KIND_REGISTRY).sort());
    expect(new Set(NOTICE_KINDS).size).toBe(NOTICE_KINDS.length);
  });

  test("each kind is enqueued by its owner's payload map: billing's for the packages, the plan's for its own", () => {
    expect(BILLING_NOTICE_KINDS).toEqual(PACKAGE_NOTICE_KINDS);
    expect([...PACKAGE_NOTICE_KINDS, ...PLAN_NOTICE_KINDS].sort()).toEqual([...NOTICE_KINDS].sort());
    for (const kind of BILLING_NOTICE_KINDS) {
      expect(NOTICE_KIND_REGISTRY[kind].owner, kind).not.toBe("plan");
    }
    expect([...PLAN_NOTICE_KINDS].sort()).toEqual(
      [...M3_PLAN_KINDS, ...Object.keys(REGISTERED_AHEAD)].sort(),
    );
    for (const kind of PLAN_NOTICE_KINDS) expect(NOTICE_KIND_REGISTRY[kind].owner, kind).toBe("plan");
  });

  test("the setup reminder and O10 wait for daytime; the closure, the calendar emails and O4 go at any hour", () => {
    expect(NOTICE_KIND_REGISTRY.setup_reminder).toMatchObject({ annex: "O7", quietHours: "daytime" });
    expect(NOTICE_KIND_REGISTRY.setup_closed.quietHours).toBe("any_hour");
    expect(NOTICE_KIND_REGISTRY.calendar_stopped).toMatchObject({ annex: "O13", quietHours: "any_hour" });
    expect(NOTICE_KIND_REGISTRY.setting_changed).toMatchObject({ annex: "O4", quietHours: "any_hour" });
    // O10 is a step to take, not an alert: it waits for the clinic's daytime.
    expect(NOTICE_KIND_REGISTRY.channel_ready).toMatchObject({ annex: "O10", quietHours: "daytime" });
    for (const kind of M3_PLAN_KINDS) {
      expect(NOTICE_KIND_REGISTRY[kind]).toMatchObject({
        class: "transactional",
        priority: "normal",
        optionalSwitch: null,
      });
    }
  });

  test("the rest of Annex X5 is registered ahead of its packages, each with its id, priority, switch and quiet hours", () => {
    for (const [kind, expected] of Object.entries(REGISTERED_AHEAD)) {
      const [annex, priority, optionalSwitch, quietHours] = expected;
      expect(NOTICE_KIND_REGISTRY[kind as NoticeKind], kind).toEqual({
        annex,
        class: "transactional",
        priority,
        optionalSwitch,
        quietHours,
        owner: "plan",
      });
    }
  });

  test("the live alerts are booking-alerts.ts's kinds, each a pointer sent at any hour, and only L12 critical", () => {
    // A compile-time check as well: every BookingAlertKind the booking engine,
    // deposits and the runtimes call notifyBookingAlert with is an outbox kind.
    const alerts = [
      "booking_request",
      "request_still_open",
      "request_missed",
      "deposit_to_collect",
      "handover",
      "urgent",
      "website_message",
      "calendar_check",
      "ended_early",
    ] as const satisfies readonly BookingAlertKind[];
    const registered: readonly NoticeKind[] = alerts;
    for (const kind of registered) {
      expect(NOTICE_KIND_REGISTRY[kind].quietHours, kind).toBe("any_hour");
      expect(NOTICE_KIND_REGISTRY[kind].priority, kind).toBe(
        kind === "urgent" ? "critical" : "normal",
      );
    }
    expect(
      CRITICAL_NOTICE_KINDS.filter((k) => NOTICE_KIND_REGISTRY[k].owner === "plan").sort(),
    ).toEqual([
      "incident_report",
      "outage_ended",
      "outage_started",
      "subprocessor_notice",
      "suspended_for_cause",
      "urgent",
    ]);
  });

  test("only the daily summary and product updates have a switch among the plan's kinds, and L14 has none", () => {
    expect(
      PLAN_NOTICE_KINDS.filter((k) => NOTICE_KIND_REGISTRY[k].optionalSwitch !== null).map((k) => [
        k,
        NOTICE_KIND_REGISTRY[k].optionalSwitch,
      ]),
    ).toEqual([
      ["daily_summary", "daily_summary"],
      ["product_update", "product_updates"],
    ]);
    // L14 goes only while the daily summary is off, so that switch must not stop it.
    expect(NOTICE_KIND_REGISTRY.weekly_recap.optionalSwitch).toBeNull();
    expect(NOTICE_KIND_REGISTRY.request_still_open.optionalSwitch).toBeNull();
  });

  test("F0's kinds stay, apart from the welcome resend, which is a link email", () => {
    for (const kind of F0_KINDS) expect(BILLING_NOTICE_KINDS, kind).toContain(kind);
    expect(BILLING_NOTICE_KINDS).not.toContain("welcome_resend");
  });

  test("every attribute is one the sender knows", () => {
    for (const [kind, a] of Object.entries(NOTICE_KIND_REGISTRY)) {
      expect(a.annex, kind).toMatch(/^[A-Z][0-9]+$/);
      expect(["transactional", "commercial"], kind).toContain(a.class);
      expect(["critical", "normal"], kind).toContain(a.priority);
      expect([null, "usage_alerts", "daily_summary", "product_updates"], kind).toContain(
        a.optionalSwitch,
      );
      expect(["any_hour", "daytime"], kind).toContain(a.quietHours);
      expect(["plan", "package_c", "package_d"], kind).toContain(a.owner);
    }
  });

  test("a critical notice never waits for daytime, and the fallback ignores the usage-alerts switch", () => {
    for (const [kind, a] of Object.entries(NOTICE_KIND_REGISTRY)) {
      if (a.priority === "critical") expect(a.quietHours, kind).toBe("any_hour");
    }
    // Annex X5, L19: sent whatever the usage-alerts switch says, which
    // governs only the 80% and 100% emails.
    expect(NOTICE_KIND_REGISTRY.allowance_fallback.optionalSwitch).toBeNull();
    expect(NOTICE_KIND_REGISTRY.usage_80.optionalSwitch).toBe("usage_alerts");
    expect(NOTICE_KIND_REGISTRY.usage_100.optionalSwitch).toBe("usage_alerts");
  });
});
