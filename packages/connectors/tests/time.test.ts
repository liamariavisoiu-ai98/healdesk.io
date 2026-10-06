import { describe, expect, test } from "vitest";

import { partsIn, zonedToUtc } from "../src/time";

/**
 * Wall-clock arithmetic the availability code builds opening hours on.
 *
 * The dates are the real transitions of 2026 and 2027. A skipped wall time
 * moves forward by the gap and a repeated one is the earlier instant, in every
 * zone alike. The two-pass guess this replaced sent New York's skipped 02:00
 * back to 01:00 and London's forward to 02:00, so a night range closing at
 * 02:00 lost an hour that exists in one zone and not the other.
 */

const at = (iso: string) => new Date(iso).toISOString();
const utc = (...args: Parameters<typeof zonedToUtc>) => zonedToUtc(...args).toISOString();

describe("partsIn", () => {
  test("reads the zone's wall clock and weekday for an instant", () => {
    expect(partsIn(new Date("2026-10-06T16:05:09Z"), "America/New_York")).toEqual({
      year: 2026,
      month: 10,
      day: 6,
      hour: 12,
      minute: 5,
      second: 9,
      weekday: 2,
    });
    // Midnight is hour 0, never 24.
    expect(partsIn(new Date("2026-10-06T04:00:00Z"), "America/New_York").hour).toBe(0);
  });

  test("an unknown zone throws rather than passing for UTC", () => {
    expect(() => partsIn(new Date(), "Europe/Nowhere")).toThrow(RangeError);
    expect(() => zonedToUtc(2026, 10, 6, 9, 0, "Europe/Nowhere")).toThrow(RangeError);
  });
});

describe("zonedToUtc", () => {
  test("an ordinary wall time is the one instant that reads it", () => {
    expect(utc(2026, 1, 15, 9, 0, "America/New_York")).toBe(at("2026-01-15T14:00:00Z"));
    expect(utc(2026, 7, 15, 9, 0, "America/New_York")).toBe(at("2026-07-15T13:00:00Z"));
    expect(utc(2026, 7, 15, 9, 10, "Europe/London")).toBe(at("2026-07-15T08:10:00Z"));
    // Phoenix keeps no daylight time: New York's change day is an ordinary day there.
    expect(utc(2026, 3, 8, 2, 30, "America/Phoenix")).toBe(at("2026-03-08T09:30:00Z"));
    // 24:00 is the midnight that ends the day.
    expect(utc(2026, 3, 7, 24, 0, "America/New_York")).toBe(at("2026-03-08T05:00:00Z"));
  });

  test("New York, 8 March 2026: the skipped hour moves forward by the gap", () => {
    expect(utc(2026, 3, 8, 1, 59, "America/New_York")).toBe(at("2026-03-08T06:59:00Z"));
    // 02:00 and 02:30 do not exist; they are read as 03:00 and 03:30 EDT.
    expect(utc(2026, 3, 8, 2, 0, "America/New_York")).toBe(at("2026-03-08T07:00:00Z"));
    expect(utc(2026, 3, 8, 2, 30, "America/New_York")).toBe(at("2026-03-08T07:30:00Z"));
    expect(utc(2026, 3, 8, 3, 0, "America/New_York")).toBe(at("2026-03-08T07:00:00Z"));
    expect(utc(2026, 3, 8, 9, 0, "America/New_York")).toBe(at("2026-03-08T13:00:00Z"));
  });

  test("New York, 1 November 2026: the repeated hour is the earlier instant", () => {
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    expect(utc(2026, 11, 1, 1, 30, "America/New_York")).toBe(at("2026-11-01T05:30:00Z"));
    expect(utc(2026, 11, 1, 0, 59, "America/New_York")).toBe(at("2026-11-01T04:59:00Z"));
    expect(utc(2026, 11, 1, 2, 0, "America/New_York")).toBe(at("2026-11-01T07:00:00Z"));
  });

  test("London, 28 March 2027 and 25 October 2026: the same rule in the other hemisphere's hour", () => {
    expect(utc(2027, 3, 28, 1, 0, "Europe/London")).toBe(at("2027-03-28T01:00:00Z"));
    expect(utc(2027, 3, 28, 1, 30, "Europe/London")).toBe(at("2027-03-28T01:30:00Z"));
    expect(partsIn(zonedToUtc(2027, 3, 28, 1, 30, "Europe/London"), "Europe/London").hour).toBe(2);
    // 01:30 happens at 00:30Z (BST) and again at 01:30Z (GMT).
    expect(utc(2026, 10, 25, 1, 30, "Europe/London")).toBe(at("2026-10-25T00:30:00Z"));
  });

  test("Lord Howe, 4 October 2026 and 4 April 2027: a thirty-minute shift both ways", () => {
    // 02:00 to 02:30 is skipped: 02:00 reads as 02:30 (+11:00), 02:15 as 02:45.
    expect(utc(2026, 10, 4, 2, 0, "Australia/Lord_Howe")).toBe(at("2026-10-03T15:30:00Z"));
    expect(utc(2026, 10, 4, 2, 15, "Australia/Lord_Howe")).toBe(at("2026-10-03T15:45:00Z"));
    // 01:30 to 02:00 is repeated: 01:45 is the earlier, at +11:00.
    expect(utc(2027, 4, 4, 1, 45, "Australia/Lord_Howe")).toBe(at("2027-04-03T14:45:00Z"));
  });

  test("a night range that closes at 02:00 as the clocks go forward keeps the hour that exists", () => {
    // 20:00 on 7 March to 02:00 on 8 March in New York: the clock passes 02:00
    // at 07:00Z (it jumps from 01:59:59 EST to 03:00 EDT), so the range is
    // six hours long, not five.
    const open = zonedToUtc(2026, 3, 7, 20, 0, "America/New_York");
    const close = zonedToUtc(2026, 3, 8, 2, 0, "America/New_York");
    expect((close.getTime() - open.getTime()) / 3_600_000).toBe(6);
  });

  test("every quarter hour of a change day reads back as itself, or forward by the gap", () => {
    for (const [zone, year, month, day, gapMinutes] of [
      ["America/New_York", 2026, 3, 8, 60],
      ["America/New_York", 2026, 11, 1, 0],
      ["Europe/London", 2027, 3, 28, 60],
      ["Europe/London", 2026, 10, 25, 0],
      ["Australia/Lord_Howe", 2026, 10, 4, 30],
      ["Australia/Lord_Howe", 2027, 4, 4, 0],
    ] as const) {
      let skipped = 0;
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const hour = Math.floor(minutes / 60);
        const minute = minutes % 60;
        const read = partsIn(zonedToUtc(year, month, day, hour, minute, zone), zone);
        const readMinutes = read.hour * 60 + read.minute;
        expect(read.day).toBe(day);
        if (readMinutes !== minutes) {
          skipped += 1;
          expect(readMinutes - minutes, `${zone} ${hour}:${minute}`).toBe(gapMinutes);
        }
      }
      expect(skipped, zone).toBe(gapMinutes / 15);
    }
  });
});
