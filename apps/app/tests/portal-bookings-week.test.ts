import { describe, expect, test } from "vitest";

import { bookingsWeek, WEEK_OFFSET_MAX, WEEK_OFFSET_MIN, weekOffsetOf } from "@/lib/portal/bookings-week";

/**
 * Bookings' week calendar (portal redesign, third slice, owner, 1 November
 * 2026), drawn only from the appointments the screen already read behind
 * the passkey.
 */

const ZONE = "America/New_York";
/** Wednesday 4 November 2026, 10 am in New York. */
const NOW = new Date("2026-11-04T15:00:00Z");

type Appt = Parameters<typeof bookingsWeek>[0][number];
const appt = (over: Partial<Appt> & { id: string; scheduledFor: Date }): Appt => ({
  firstName: "Maya",
  treatment: "HydraFacial",
  status: "scheduled",
  depositStatus: "none",
  ...over,
});

describe("bookingsWeek", () => {
  test("lays this week's appointments out Monday to Sunday, in time order, in the clinic's zone", () => {
    const week = bookingsWeek(
      [
        appt({ id: "b", scheduledFor: new Date("2026-11-04T19:00:00Z") }), // Wed 2 pm
        appt({ id: "a", scheduledFor: new Date("2026-11-04T14:30:00Z"), firstName: "Jordan" }), // Wed 9:30 am
        appt({ id: "c", scheduledFor: new Date("2026-11-08T04:30:00Z"), firstName: null, treatment: null }), // Sat 11:30 pm local
        appt({ id: "out", scheduledFor: new Date("2026-11-10T15:00:00Z") }), // next week
      ],
      { now: NOW, timeZone: ZONE },
    );
    expect(week.title).toBe("This week");
    expect(week.count).toBe(3);
    expect(week.days.map((d) => d.date)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    expect(week.days[2]).toMatchObject({ isToday: true });
    expect(week.days[2]!.items.map((i) => [i.id, i.time, i.name])).toEqual([
      ["a", "9:30 am", "Jordan"],
      ["b", "2:00 pm", "Maya"],
    ]);
    expect(week.days[5]!.items).toEqual([
      { id: "c", time: "11:30 pm", name: "Someone", treatment: null, deposit: null, inactive: false },
    ]);
  });

  test("a deposit the desk must take is flagged; a cancelled or moved one is kept, struck, and not counted", () => {
    const week = bookingsWeek(
      [
        appt({ id: "owed", scheduledFor: new Date("2026-11-05T15:00:00Z"), depositStatus: "pending_front_desk" }),
        appt({ id: "link", scheduledFor: new Date("2026-11-05T17:00:00Z"), depositStatus: "pending_link" }),
        appt({ id: "gone", scheduledFor: new Date("2026-11-06T15:00:00Z"), status: "cancelled" }),
      ],
      { now: NOW, timeZone: ZONE },
    );
    expect(week.count).toBe(2);
    expect(week.days[3]!.items.map((i) => i.deposit)).toEqual(["Deposit to collect", "Deposit not paid yet"]);
    expect(week.days[4]!.items[0]).toMatchObject({ id: "gone", inactive: true, deposit: null });
  });

  test("next week and an older week, by offset; today is still today", () => {
    const next = bookingsWeek([appt({ id: "n", scheduledFor: new Date("2026-11-10T15:00:00Z") })], {
      now: NOW,
      timeZone: ZONE,
      offset: 1,
    });
    expect(next.title).toBe("Next week");
    expect(next.days[0]!.date).toBe("2026-11-09");
    expect(next.days.some((d) => d.isToday)).toBe(false);
    expect(next.days[1]!.items.map((i) => i.id)).toEqual(["n"]);
    expect(bookingsWeek([], { now: NOW, timeZone: ZONE, offset: -1 }).title).toBe("Last week");
    expect(bookingsWeek([], { now: NOW, timeZone: ZONE, offset: 2 }).title).toBe("Week of 16 November");
  });
});

describe("weekOffsetOf", () => {
  test("a bounded whole number of weeks, anything else is this week", () => {
    expect(weekOffsetOf("1")).toBe(1);
    expect(weekOffsetOf("-2")).toBe(-2);
    expect(weekOffsetOf("99")).toBe(WEEK_OFFSET_MAX);
    expect(weekOffsetOf("-99")).toBe(WEEK_OFFSET_MIN);
    expect(weekOffsetOf("1.5")).toBe(0);
    expect(weekOffsetOf("x")).toBe(0);
    expect(weekOffsetOf(undefined)).toBe(0);
    expect(weekOffsetOf(["1"])).toBe(0);
  });
});
