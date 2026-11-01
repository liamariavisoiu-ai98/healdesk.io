import { describe, expect, test } from "vitest";

import { homeTiles } from "@/lib/portal/home-summary";
import { weekDays } from "@/lib/portal/week-schedule";
import type { ClaimsPayload } from "@/lib/reporting/claim-words";

/**
 * The first slice of the portal redesign (owner, 1 November 2026): Home's
 * three big numbers and its week at a glance. Pure parts only; the week's
 * counts are read by readWeekSchedule against the database.
 */

const base: ClaimsPayload = {
  handledCount: 0,
  voiceCount: null,
  webCount: null,
  metaCount: null,
  rangOutCount: null,
  isRequestMode: false,
  requestsTakenCount: 0,
  requestsConfirmedCount: 0,
  bookedByAyaCount: 0,
  bookedValueCents: 0,
  pricedBookingsCount: 0,
  perUnitBookingsCount: 0,
  unpricedBookingsCount: 0,
  depositsCollectedCount: 0,
  depositsCollectedCents: 0,
  urgentCount: 0,
  handoverCount: 0,
};

describe("homeTiles", () => {
  test("a week with bookings: booked value at listed prices, bookings, deposits", () => {
    const tiles = homeTiles({
      ...base,
      handledCount: 27,
      bookedByAyaCount: 4,
      bookedValueCents: 144_800,
      pricedBookingsCount: 4,
      depositsCollectedCount: 3,
      depositsCollectedCents: 15_000,
    });
    expect(tiles).toEqual([
      { key: "value", label: "Booked value", value: "$1,448", hint: "4 bookings at your listed prices" },
      { key: "bookings", label: "Booked by AYA", value: "4", hint: "from 27 conversations" },
      { key: "deposits", label: "Deposits collected", value: "$150", hint: "3 deposits paid" },
    ]);
  });

  test("an empty week reads as zero, never blank", () => {
    const tiles = homeTiles(base);
    expect(tiles.map((t) => t.value)).toEqual(["$0", "0", "$0"]);
    expect(tiles[0]!.hint).toBe("Bookings at your listed prices");
    expect(tiles[2]!.hint).toBe("None collected yet");
  });

  test("per-unit and unpriced bookings are named, never added in", () => {
    const tiles = homeTiles({
      ...base,
      bookedValueCents: 29_900,
      pricedBookingsCount: 1,
      perUnitBookingsCount: 2,
      unpricedBookingsCount: 1,
    });
    expect(tiles[0]!.hint).toBe(
      "1 booking at your listed prices · 2 bookings priced per unit, not added in · 1 booking with no listed price",
    );
  });

  test("while bookings are requests, the middle tile counts requests under their own name", () => {
    const tiles = homeTiles({ ...base, isRequestMode: true, requestsTakenCount: 5, requestsConfirmedCount: 2 });
    expect(tiles[1]).toEqual({
      key: "bookings",
      label: "Booking requests",
      value: "5",
      hint: "2 confirmed by your team",
    });
  });

  test("never claims revenue, ROI or money collected beyond deposits", () => {
    const text = JSON.stringify(
      homeTiles({ ...base, bookedValueCents: 100_000, pricedBookingsCount: 2, depositsCollectedCount: 1 }),
    ).toLowerCase();
    expect(text).not.toMatch(/revenue|roi|return|profit|earned/);
  });
});

describe("weekDays", () => {
  test("Monday to Sunday of the clinic's own week, today marked", () => {
    // Wednesday 4 November 2026, 15:00 UTC: 10 am in New York.
    const days = weekDays(new Date("2026-11-04T15:00:00Z"), "America/New_York");
    expect(days.map((d) => d.date)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    expect(days.map((d) => d.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(days.filter((d) => d.isToday).map((d) => d.date)).toEqual(["2026-11-04"]);
    expect(days.every((d) => d.count === 0)).toBe(true);
  });

  test("the day is the clinic's, not UTC's: late Sunday evening in Los Angeles is still Sunday", () => {
    // 03:00 UTC on Monday 9 November is 7 pm Sunday 8 November in Los Angeles.
    const days = weekDays(new Date("2026-11-09T03:00:00Z"), "America/Los_Angeles");
    expect(days[0]!.date).toBe("2026-11-02");
    expect(days[6]).toMatchObject({ date: "2026-11-08", isToday: true, dayOfMonth: 8 });
  });

  test("a Monday starts its own week", () => {
    const days = weekDays(new Date("2026-11-09T17:00:00Z"), "America/New_York");
    expect(days[0]).toMatchObject({ date: "2026-11-09", isToday: true });
  });

  test("an unknown zone falls back rather than throwing", () => {
    expect(weekDays(new Date("2026-11-04T15:00:00Z"), "Not/AZone")).toHaveLength(7);
  });
});
