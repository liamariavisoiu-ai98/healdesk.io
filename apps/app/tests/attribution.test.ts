import { describe, expect, test } from "vitest";

import {
  computeAttribution,
  trend,
  type ActivityCounts,
} from "@/lib/attribution/estimate";
import {
  monthContaining,
  month_,
  periodDays,
  previousMonth,
} from "@/lib/attribution/period";
import { assertNoPhiInReport } from "@/lib/reporting/deliver";

const activity = (over: Partial<ActivityCounts> = {}): ActivityCounts => ({
  conversationsHandled: 120,
  conversationsRecovered: 40,
  recoveredBookings: 14,
  totalBookings: 52,
  ...over,
});

describe("reporting periods", () => {
  test("a month starts at local midnight, not UTC midnight", () => {
    // New York is UTC-4 in August, so 1 August local is 04:00 UTC. Using the
    // UTC boundary would push late-evening calls on the 31st into the wrong
    // month, and the clinic's totals would stop matching their own records.
    const august = month_(2026, 8, "America/New_York");
    expect(august.start.toISOString()).toBe("2026-08-01T04:00:00.000Z");
    expect(august.end.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  test("handles a zone with no DST", () => {
    // Phoenix stays at UTC-7 year round; the offset must not drift.
    expect(month_(2026, 1, "America/Phoenix").start.toISOString()).toBe(
      "2026-01-01T07:00:00.000Z",
    );
    expect(month_(2026, 7, "America/Phoenix").start.toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
  });

  test("a month spanning a DST change has the right length", () => {
    // US DST starts 8 March 2026. March is 31 days but only 30 days and 23
    // hours of elapsed time, and the month boundaries shift by an hour.
    const march = month_(2026, 3, "America/New_York");
    const april = month_(2026, 4, "America/New_York");

    expect(march.start.toISOString()).toBe("2026-03-01T05:00:00.000Z"); // EST
    expect(march.end.toISOString()).toBe("2026-04-01T04:00:00.000Z"); // EDT
    expect(april.start.toISOString()).toBe(march.end.toISOString());

    // 30d 23h, so the naive day count rounds to 31.
    expect(periodDays(march)).toBe(31);
  });

  test("periods are half-open, so consecutive months never double-count", () => {
    const august = month_(2026, 8, "America/New_York");
    const september = month_(2026, 9, "America/New_York");
    expect(august.end.getTime()).toBe(september.start.getTime());
  });

  test("December rolls over into the next year", () => {
    const december = month_(2026, 12, "America/New_York");
    expect(december.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  test("monthContaining resolves an instant to its local month", () => {
    // 03:30 UTC on 1 September is still 31 August in New York.
    const period = monthContaining(
      new Date("2026-09-01T03:30:00Z"),
      "America/New_York",
    );
    expect(period.key).toBe("2026-08");
  });

  test("previousMonth steps back one calendar month", () => {
    expect(
      previousMonth(new Date("2026-01-15T12:00:00Z"), "America/New_York").key,
    ).toBe("2025-12");
  });
});

describe("estimated attribution", () => {
  test("multiplies recovered bookings by the clinic's own average", () => {
    const result = computeAttribution({
      mode: "estimated",
      activity: activity(),
      averageTreatmentValueUsd: 550,
    });

    expect(result.revenueUsd).toBe(7_700);
    expect(result.basis).toContain("14 recovered bookings");
    expect(result.basis).toContain("$550");
  });

  test("always states that the figure is an estimate", () => {
    // The whole point of this module: an estimate must never be presented as a
    // measurement. If this assertion is ever relaxed, the product is lying.
    const result = computeAttribution({
      mode: "estimated",
      activity: activity(),
      averageTreatmentValueUsd: 550,
    });

    expect(result.mode).toBe("estimated");
    expect(result.caveats.join(" ")).toMatch(/estimated/i);
    expect(result.caveats.join(" ")).toMatch(/not read from a point-of-sale/i);
  });

  test("returns null, not zero, when there is no average value", () => {
    // Reporting $0 would read as "we earned you nothing" — a different and
    // false claim from "we can't work this out yet".
    const result = computeAttribution({
      mode: "estimated",
      activity: activity(),
      averageTreatmentValueUsd: null,
    });

    expect(result.revenueUsd).toBeNull();
    expect(result.basis).toMatch(/can't estimate revenue/i);
  });

  test("rejects a nonsensical average value the same way", () => {
    for (const value of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = computeAttribution({
        mode: "estimated",
        activity: activity(),
        averageTreatmentValueUsd: value,
      });
      expect(result.revenueUsd).toBeNull();
    }
  });

  test("says so plainly when nothing was recovered", () => {
    const result = computeAttribution({
      mode: "estimated",
      activity: activity({ recoveredBookings: 0 }),
      averageTreatmentValueUsd: 550,
    });

    expect(result.revenueUsd).toBe(0);
    expect(result.caveats.join(" ")).toMatch(/nothing to attribute/i);
  });

  test("reports small counts rather than suppressing them", () => {
    // Deliberate product decision: always show the real number, whatever the
    // count, with the basis disclosed. The protection is that no dimension
    // narrowing it to one person is ever included in the same output.
    const result = computeAttribution({
      mode: "estimated",
      activity: activity({ recoveredBookings: 1 }),
      averageTreatmentValueUsd: 18_000,
    });

    expect(result.revenueUsd).toBe(18_000);
    expect(result.basis).toContain("1 recovered booking");
  });

  test("carries no patient-identifying fields", () => {
    const result = computeAttribution({
      mode: "estimated",
      activity: activity(),
      averageTreatmentValueUsd: 550,
    });

    // This shape ends up in an email, which is the one channel we cannot
    // secure. It must stay aggregate-only forever.
    const serialized = JSON.stringify(result).toLowerCase();
    for (const forbidden of [
      "phone",
      "email",
      "fullname",
      "patient",
      "treatment",
      "dob",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("verified attribution", () => {
  test("surfaces unmatched sales rather than absorbing them", () => {
    // Money we saw but could not attribute belongs in front of the clinic, not
    // quietly excluded from a total that then looks smaller than reality.
    const result = computeAttribution({
      mode: "verified",
      activity: activity(),
      matchedRevenueUsd: 9_400,
      unmatchedTransactionCount: 3,
      unmatchedRevenueUsd: 1_250,
      sources: ["Stripe"],
    });

    expect(result.revenueUsd).toBe(9_400);
    expect(result.caveats.join(" ")).toContain("3 sales");
    expect(result.caveats.join(" ")).toContain("$1,250");
  });

  test("states a coverage window when the source has no history", () => {
    // Vagaro is webhook-forward-only: revenue exists from the connection date
    // onward and no earlier. Saying so beats reporting a smaller number.
    const result = computeAttribution({
      mode: "verified",
      activity: activity(),
      matchedRevenueUsd: 4_000,
      unmatchedTransactionCount: 0,
      unmatchedRevenueUsd: 0,
      sources: ["Vagaro"],
      coverageStartedAt: new Date("2026-07-15T00:00:00Z"),
    });

    const caveats = result.caveats.join(" ");
    expect(caveats).toContain("15 July 2026");

    // NOT ISO, and that is the point. `2026-07-15` matches the date pattern the
    // email PHI guard treats as a possible date of birth, so an ISO date here
    // made the guard refuse to send the very report this caveat belongs on.
    // The caveat is honest and the guard is right; the format was the bug.
    expect(caveats).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(() =>
      assertNoPhiInReport({
        subject: "Your month",
        text: caveats,
        html: `<p>${caveats}</p>`,
      } as never),
    ).not.toThrow();
  });
});

describe("trend", () => {
  test("computes delta and percentage", () => {
    expect(trend(7_700, 5_500)).toEqual({ deltaUsd: 2_200, percent: 40 });
  });

  test("returns no percentage when the previous period was zero", () => {
    // "Up 100%" from nothing is arithmetically true and communicates nothing.
    expect(trend(7_700, 0)).toEqual({ deltaUsd: 7_700, percent: null });
  });

  test("returns nothing at all when either side is unknown", () => {
    expect(trend(7_700, null)).toBeNull();
    expect(trend(null, 5_500)).toBeNull();
  });
});
