import { describe, expect, test } from "vitest";

import { addDays, dueWeekStart, isWeekStart, mondayOf, newYorkClock, recentWeeks } from "./pack-week";

/**
 * The pack's week as apps/app defines it, mirrored here for the list page:
 * due at 07:00 New York on the Monday after the week, so 11:00 UTC in
 * summer and 12:00 UTC in winter. Fixed instants, never the clock.
 */

describe("the week", () => {
  test("a Monday, real, as YYYY-MM-DD", () => {
    expect(isWeekStart("2026-10-26")).toBe(true);
    expect(isWeekStart("2026-10-27")).toBe(false);
    expect(isWeekStart("2026-02-30")).toBe(false);
    expect(isWeekStart("2026-10-26T00:00")).toBe(false);
    expect(isWeekStart(20261026)).toBe(false);
  });

  test("Mondays and day arithmetic", () => {
    expect(mondayOf("2026-10-29")).toBe("2026-10-26");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(addDays("2026-10-26", -7)).toBe("2026-10-19");
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
  });

  test("New York's clock, across the clock change", () => {
    // Summer: 11:00 UTC is 07:00 New York.
    expect(newYorkClock(new Date("2026-10-26T11:00:00.000Z"))).toEqual({ date: "2026-10-26", hour: 7 });
    expect(newYorkClock(new Date("2026-10-26T10:59:00.000Z"))).toEqual({ date: "2026-10-26", hour: 6 });
    // Winter (clocks went back on 1 November 2026): 12:00 UTC is 07:00 New York.
    expect(newYorkClock(new Date("2026-11-09T12:00:00.000Z"))).toEqual({ date: "2026-11-09", hour: 7 });
    expect(newYorkClock(new Date("2026-11-09T04:30:00.000Z"))).toEqual({ date: "2026-11-08", hour: 23 });
  });

  test("the week now due: last week from 07:00 New York on Monday, the week before until then", () => {
    expect(dueWeekStart(new Date("2026-10-26T11:00:00.000Z"))).toBe("2026-10-19");
    expect(dueWeekStart(new Date("2026-10-26T10:59:00.000Z"))).toBe("2026-10-12");
    expect(dueWeekStart(new Date("2026-10-28T15:00:00.000Z"))).toBe("2026-10-19");
    expect(dueWeekStart(new Date("2026-11-09T12:00:00.000Z"))).toBe("2026-11-02");
    expect(dueWeekStart(new Date("2026-11-09T11:59:00.000Z"))).toBe("2026-10-26");
    // Sunday night New York, Monday morning UTC: still the week before.
    expect(dueWeekStart(new Date("2026-11-09T04:30:00.000Z"))).toBe("2026-10-26");
  });

  test("the recent weeks, newest first", () => {
    expect(recentWeeks(new Date("2026-10-28T15:00:00.000Z"), 3)).toEqual(["2026-10-19", "2026-10-12", "2026-10-05"]);
  });
});
