import { describe, expect, test } from "vitest";

import type { MonthlyReport } from "@/lib/attribution/report";
import {
  assertNoPhiInReport,
  ConsoleTransport,
  deliverReport,
  PhiInEmailError,
} from "@/lib/reporting/deliver";
import { renderMonthlyReport } from "@/lib/reporting/render";
import { month_ } from "@/lib/attribution/period";

/**
 * The monthly email.
 *
 * The whole delivery strategy rests on the rendered output containing no PHI:
 * that is what makes it safe to send to a shared front-desk inbox with no
 * login. These tests defend that property, because the change that breaks it —
 * adding a "patients you recovered" list — would be easy, useful, and a breach.
 */

const period = month_(2026, 7, "America/New_York");

const report = (over: Partial<MonthlyReport> = {}): MonthlyReport => ({
  clinicId: "c1",
  clinicName: "Radiance Med Spa",
  period,
  partial: false,
  trend: { deltaUsd: 2_200, percent: 40 },
  attribution: {
    mode: "estimated",
    conversationsHandled: 120,
    conversationsRecovered: 40,
    recoveredBookings: 14,
    revenueUsd: 7_700,
    basis: "14 recovered bookings × $550 average = $7,700",
    caveats: [
      "Estimated from your own average appointment value of $550, not read from a point-of-sale.",
    ],
  },
  ...over,
});

describe("rendering", () => {
  test("leads with the recovered figure and the period", () => {
    const rendered = renderMonthlyReport(report());
    expect(rendered.subject).toContain("Radiance Med Spa");
    expect(rendered.subject).toContain("$7,700");
    expect(rendered.subject).toContain("July 2026");
  });

  test("marks an estimate as an estimate, in the body", () => {
    const rendered = renderMonthlyReport(report());
    expect(rendered.text).toMatch(/\(estimated\)/);
    expect(rendered.text).toContain("14 recovered bookings");
  });

  test("says 'not available' rather than $0 when revenue is unknown", () => {
    // "$0 recovered" reads as "we earned you nothing" — a different and false
    // claim from "we couldn't work it out".
    const rendered = renderMonthlyReport(
      report({
        attribution: {
          ...report().attribution,
          revenueUsd: null,
          basis: "We don't have an average appointment value for this clinic.",
          caveats: [],
        },
        trend: null,
      }),
    );

    expect(rendered.text).toContain("Revenue recovered: not available");
    expect(rendered.text).not.toMatch(/\$0\b/);
  });

  test("renders every caveat verbatim", () => {
    const rendered = renderMonthlyReport(
      report({
        attribution: {
          ...report().attribution,
          caveats: ["3 sales could not be matched.", "Coverage starts 2026-07-15."],
        },
      }),
    );

    expect(rendered.text).toContain("3 sales could not be matched.");
    expect(rendered.text).toContain("Coverage starts 2026-07-15.");
  });

  test("flags a period still in progress", () => {
    const rendered = renderMonthlyReport(report({ partial: true }));
    expect(rendered.text).toMatch(/still in progress/i);
  });

  test("omits a percentage when the previous month was zero", () => {
    const rendered = renderMonthlyReport(
      report({ trend: { deltaUsd: 7_700, percent: null } }),
    );
    expect(rendered.text).toContain("$7,700 up on the month before.");
    expect(rendered.text).not.toContain("(%)");
  });

  test("escapes clinic names into the HTML", () => {
    const rendered = renderMonthlyReport(
      report({ clinicName: `Bob's <script>alert(1)</script> Spa` }),
    );
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });
});

describe("PHI guard", () => {
  test("a normal report passes", () => {
    expect(() => assertNoPhiInReport(renderMonthlyReport(report()))).not.toThrow();
  });

  test("refuses to send a phone number", () => {
    expect(() =>
      assertNoPhiInReport({
        subject: "Your July report",
        text: "Recovered: Jane, +1 555 123 4567",
        html: "",
      }),
    ).toThrow(PhiInEmailError);
  });

  test("refuses to send a patient email address", () => {
    expect(() =>
      assertNoPhiInReport({
        subject: "Your July report",
        text: "Recovered: jane.doe@gmail.com",
        html: "",
      }),
    ).toThrow(PhiInEmailError);
  });

  test("refuses to send a date of birth", () => {
    expect(() =>
      assertNoPhiInReport({
        subject: "Your July report",
        text: "Patient DOB 1984-03-02 booked",
        html: "",
      }),
    ).toThrow(PhiInEmailError);
  });

  test("the guard runs before the transport does", async () => {
    // Belt and braces over the renderer: the cost of a false positive is one
    // undelivered report, the cost of a false negative is PHI in a shared inbox.
    let sent = false;
    const transport = {
      name: "spy",
      async send() {
        sent = true;
        return { status: "sent" as const, messageId: "x" };
      },
    };

    await expect(
      deliverReport(
        { to: "owner@clinic.test", clinicId: "c1", clinicName: "Radiance" },
        { subject: "s", text: "call +1 555 123 4567", html: "" },
        transport,
      ),
    ).rejects.toThrow(PhiInEmailError);

    expect(sent).toBe(false);
  });

  test("the console transport reports honestly that nothing was sent", async () => {
    // A silent no-op that lets a scheduler log "sent 40 reports" while sending
    // none is worse than a crash — it looks like success for a month.
    const result = await new ConsoleTransport().send(
      { to: "owner@clinic.test", clinicId: "c1", clinicName: "Radiance" },
      renderMonthlyReport(report()),
    );

    expect(result.status).toBe("skipped");
  });
});
