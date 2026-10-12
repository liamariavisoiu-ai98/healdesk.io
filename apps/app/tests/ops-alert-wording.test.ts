import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { copyProblems, linkProblems, subjectProblems, visibleText } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { OPS_EVENTS } from "@/lib/ops/notify";

/**
 * Every ops alert reads as an alert (I1 in Annex X5): its own title and the
 * next thing to do, a subject that fits, the copy rules every email follows,
 * and no link. tsc already demands a wording for every event; this holds each
 * wording to the rules, including the ten the Stripe build added.
 */

const CTX = {
  clinicName: null,
  audience: "patients",
  reason: OPS_REASON,
  raisedAt: new Date("2026-10-06T12:00:00Z"),
  timeZone: "UTC",
} as const;

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
  vi.stubEnv("HEALDESK_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the ops alert's wording", () => {
  test("every event renders its own title, within the subject rules, with honest copy and no link", () => {
    const subjects = new Set<string>();
    for (const event of OPS_EVENTS) {
      const rendered = renderOpsAlert(
        { event, clinicId: "0c1d2e3f-0000-4000-8000-000000000000", requestId: "req_1" },
        CTX,
      );
      // Not the fallback ("Look it up in the console"): a wording of its own.
      expect(rendered.subject, event).not.toBe(`healdesk ops: ${event}`);
      expect(subjectProblems(rendered.subject), event).toEqual([]);
      expect(
        copyProblems(`${rendered.subject}\n${rendered.text}\n${visibleText(rendered.html)}`),
        event,
      ).toEqual([]);
      expect(linkProblems(rendered, "ops_alert"), event).toEqual([]);
      subjects.add(rendered.subject);
    }
    // One subject per event, so a glance at an inbox says which alert it is.
    expect(subjects.size).toBe(OPS_EVENTS.length);
  });

  test("the termination refund alert says to confirm it before destruction, or settle it in Stripe after", () => {
    const rendered = renderOpsAlert(
      { event: "agreement_refund_due", clinicId: "0c1d2e3f-0000-4000-8000-000000000000" },
      CTX,
    );
    expect(rendered.text).toMatch(/Confirm it before the practice's data is destroyed/);
    expect(rendered.text).toMatch(/by hand in the Stripe Dashboard/);
  });

  test("the Stripe build's events are on the list", () => {
    for (const event of [
      "billing_request_dead_lettered",
      "billing_request_stuck",
      "setup_closure_skipped_live_channel",
      "location_charged_not_created",
      "connect_event_dead_lettered",
      "overage_invoice_failed",
      "meter_report_failing",
      "first_period_refund_due",
      "voice_fallback_no_direct_line",
      "plan_start_after_cancel",
    ]) {
      expect(OPS_EVENTS as readonly string[], event).toContain(event);
    }
  });
});
