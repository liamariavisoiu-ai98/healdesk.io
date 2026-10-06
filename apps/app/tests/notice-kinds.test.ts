import { describe, expect, test } from "vitest";

import { BILLING_NOTICE_KINDS } from "@/db/schema";
import { NOTICE_KIND_REGISTRY, NOTICE_KINDS } from "@/lib/email/kinds";

/**
 * The outbox's kind registry (lib/email/kinds.ts) against the list the CHECK
 * is built from. The payload map in lib/billing/notices.ts is held to the
 * same kinds by its compile-time check, so the three cannot drift apart.
 */

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
    expect([...BILLING_NOTICE_KINDS].sort()).toEqual(Object.keys(NOTICE_KIND_REGISTRY).sort());
    expect(new Set(BILLING_NOTICE_KINDS).size).toBe(BILLING_NOTICE_KINDS.length);
    expect(BILLING_NOTICE_KINDS).toEqual(NOTICE_KINDS);
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
