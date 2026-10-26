import { describe, expect, test } from "vitest";

import { addDays, dayBounds, newYorkDay, nineNewYork, readSnoozeChoice, SNOOZE_CHOICE_WORDS, SNOOZE_MAX_DAYS_AHEAD, snoozeUntil } from "./snooze";

/**
 * The snooze choices as instants (lane P7d): 09:00 New York, with the
 * offset read at that time, pinned on fixed dates either side of the
 * November 2026 change from daylight saving time (Sunday 1 November). The
 * day an operator picks must leave 09:00 inside apps/app's 30-day window
 * (lib/ops/support-case-ops.ts SNOOZE_MAX_DAYS) whatever the hour now.
 */

describe("New York mornings", () => {
  test("09:00 New York is 13:00 UTC in daylight saving time and 14:00 UTC after the change", () => {
    expect(nineNewYork("2026-10-30").toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(nineNewYork("2026-11-02").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // The change day itself: the clocks go back at 02:00, so 09:00 is already standard time.
    expect(nineNewYork("2026-11-01").toISOString()).toBe("2026-11-01T14:00:00.000Z");
    // The spring change (Sunday 8 March 2026): 09:00 is already daylight time.
    expect(nineNewYork("2026-03-08").toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  test("today in New York is read from the zone, not from UTC", () => {
    expect(newYorkDay(new Date("2026-10-31T03:30:00.000Z"))).toBe("2026-10-30");
    expect(newYorkDay(new Date("2026-10-31T04:30:00.000Z"))).toBe("2026-10-31");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("the choices", () => {
  const now = new Date("2026-10-30T20:15:00.000Z"); // Friday 30 Oct, 16:15 in New York

  test("tomorrow and three days are 09:00 New York on those days", () => {
    expect(snoozeUntil({ kind: "tomorrow" }, now)).toEqual({ ok: true, until: "2026-10-31T13:00:00.000Z", day: "2026-10-31" });
    // Monday 2 November is past the change: 09:00 is 14:00 UTC.
    expect(snoozeUntil({ kind: "three_days" }, now)).toEqual({ ok: true, until: "2026-11-02T14:00:00.000Z", day: "2026-11-02" });
  });

  test("a day picked: from tomorrow to 29 days on, so 09:00 on the last day is still inside apps/app's 30 days", () => {
    expect(SNOOZE_MAX_DAYS_AHEAD).toBe(29);
    expect(snoozeUntil({ kind: "day", day: "2026-11-10" }, now)).toEqual({ ok: true, until: "2026-11-10T14:00:00.000Z", day: "2026-11-10" });
    expect(snoozeUntil({ kind: "day", day: "2026-11-28" }, now)).toMatchObject({ ok: true, day: "2026-11-28" });
    expect(snoozeUntil({ kind: "day", day: "2026-11-29" }, now)).toEqual({ ok: false, message: "Pick a day up to 29 days ahead." });
    expect(snoozeUntil({ kind: "day", day: "2026-10-30" }, now)).toEqual({ ok: false, message: "Pick a day after today (New York)." });
    expect(snoozeUntil({ kind: "day", day: "2026-13-01" }, now)).toEqual({ ok: false, message: "Pick a day." });
    expect(snoozeUntil({ kind: "day", day: "tomorrow" }, now)).toEqual({ ok: false, message: "Pick a day." });
    // The last allowed day's 09:00 is inside 30 days of any hour of today: here 29 days and under 17 hours ahead.
    const last = snoozeUntil({ kind: "day", day: "2026-11-28" }, new Date("2026-10-30T04:01:00.000Z"));
    expect(last.ok && Date.parse(last.until) - Date.parse("2026-10-30T04:01:00.000Z")).toBeLessThan(30 * 24 * 60 * 60 * 1000);
    expect(dayBounds(now)).toEqual({ min: "2026-10-31", max: "2026-11-28" });
  });

  test("a choice read back from an action's argument", () => {
    expect(readSnoozeChoice({ kind: "tomorrow" })).toEqual({ kind: "tomorrow" });
    expect(readSnoozeChoice({ kind: "day", day: "2026-11-10" })).toEqual({ kind: "day", day: "2026-11-10" });
    expect(readSnoozeChoice({ kind: "day" })).toBeNull();
    expect(readSnoozeChoice({ kind: "never" })).toBeNull();
    expect(readSnoozeChoice("tomorrow")).toBeNull();
    expect(Object.keys(SNOOZE_CHOICE_WORDS)).toEqual(["tomorrow", "three_days", "day"]);
  });
});
