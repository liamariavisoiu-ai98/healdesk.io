import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { CareView, ClinicBillingView, OpsResult } from "@/lib/admin/ops-client";

import { DeliveriesLedger, DeliveryFilters, deliveryKind, shows } from "./DeliveriesLedger";

/**
 * The Deliveries tab's merged ledger (E1 step 7): the reports, the billing
 * emails, the setup reminders and the status history, each a kind under one
 * filter, each receipts without words, each saying its own failure. The
 * transcript receipts keep their own panel and test (transcripts-copy).
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const care = {
  ok: true,
  data: {
    deliveries: [
      { kind: "weekly_recap", periodKey: "2026-W42", recipient: "info@radiance.test", status: "sent", reason: null, attemptedAt: "2026-10-19 07:00 UTC" },
      { kind: "booking_alert", periodKey: "2026-10-20", recipient: "info@radiance.test", status: "failed", reason: "bounced", attemptedAt: "2026-10-20 15:00 UTC" },
    ],
  },
} as unknown as OpsResult<CareView>;

const billing = {
  ok: true,
  data: {
    notices: [
      { kind: "setup_reminder", createdAt: "2026-10-16 09:00 UTC", sendAfter: "2026-10-16 09:00 UTC", sentAt: "2026-10-16 09:01 UTC", attempts: 1, recipientsCount: 1, lastError: null },
      { kind: "invoice_paid", createdAt: "2026-10-11 09:00 UTC", sendAfter: "2026-10-11 09:00 UTC", sentAt: null, attempts: 3, recipientsCount: null, lastError: "SES: throttled" },
    ],
    transitions: [{ fromStatus: "trial", toStatus: "active", actor: "system", reason: "first answer recorded", at: "2026-10-12 10:00 UTC" }],
  },
} as unknown as OpsResult<ClinicBillingView>;

describe("the merged delivery ledger", () => {
  test("shows every kind under 'all': reports, billing emails (setup reminders kept out, they are the Reminders ledger), and status history as a kind", () => {
    const html = renderToStaticMarkup(h(DeliveriesLedger, { filter: "all", care, billing }));
    const page = text(html);
    expect(page).toContain("Reports and alerts — last 2");
    expect(page).toContain("weekly_recap");
    expect(page).toContain("bounced");
    expect(page).toContain("Billing emails — last 1");
    expect(page).toContain("invoice_paid");
    expect(page).toContain("SES: throttled");
    expect(page).not.toContain("setup_reminder");
    expect(page).toContain("Status history — last 1");
    expect(page).toContain("trial → active");
    // Receipts without words: nothing that could be an email body or a patient.
    expect(page).not.toMatch(/Dear|Hello|\+1\d{6,}/);
  });

  test("a kind filter shows that ledger alone", () => {
    const only = text(renderToStaticMarkup(h(DeliveriesLedger, { filter: "status", care, billing })));
    expect(only).toContain("Status history");
    expect(only).not.toContain("Billing emails");
    expect(only).not.toContain("Reports and alerts");
    expect(shows("all", "reports")).toBe(true);
    expect(shows("reminders", "billing")).toBe(false);
    expect(deliveryKind("reminders")).toBe("reminders");
    expect(deliveryKind("nonsense")).toBe("all");
    expect(deliveryKind(["status", "all"])).toBe("status");
  });

  test("a ledger that could not be read says so, and the others still show", () => {
    const failed = { ok: false as const, code: "failed" as const, message: "Could not reach the ops API." };
    const page = text(renderToStaticMarkup(h(DeliveriesLedger, { filter: "all", care: failed, billing })));
    expect(page).toContain("Could not read the reports sent: Could not reach the ops API.");
    expect(page).toContain("Billing emails — last 1");
  });

  test("empty ledgers say which empty", () => {
    const empty = { ok: true, data: { deliveries: [] } } as unknown as OpsResult<CareView>;
    const none = { ok: true, data: { notices: [], transitions: [] } } as unknown as OpsResult<ClinicBillingView>;
    const page = text(renderToStaticMarkup(h(DeliveriesLedger, { filter: "all", care: empty, billing: none })));
    expect(page).toContain("No reports or alerts sent yet.");
    expect(page).toContain("No billing email queued yet.");
    expect(page).toContain("No status change recorded.");
  });

  test("the filter chips keep the transcript window and mark the current kind", () => {
    const html = renderToStaticMarkup(h(DeliveryFilters, { clinicId: CLINIC, current: "billing", days: 90 }));
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries?kind=billing&amp;days=90"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries?days=90"`);
    expect(html).toMatch(/aria-current="page"[^>]*>Billing emails/);
  });
});
