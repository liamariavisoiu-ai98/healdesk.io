import { describe, expect, test } from "vitest";

import {
  isAfterHours,
  isOpenAt,
  OpeningHoursError,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";

/**
 * Opening hours, and the one failure mode that matters.
 *
 * Getting these wrong in the "we close earlier than we do" direction causes
 * calls the clinic's own staff answered to be counted as recovered, which
 * inflates the figure the customer judges us on. So the assertions here are
 * weighted towards refusing to answer rather than towards answering correctly.
 */

const NINE_TO_FIVE: OpeningHours = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
};

const NY = "America/New_York";

describe("isOpenAt / isAfterHours", () => {
  test("null when hours were never collected — never a guess", () => {
    // The whole point. An uncollected schedule must not resolve to "closed",
    // because that would claim every call as recovered.
    const noon = new Date("2026-08-19T16:00:00Z"); // Wed noon in New York
    expect(isOpenAt(null, noon, NY)).toBeNull();
    expect(isAfterHours(null, noon, NY)).toBeNull();
    expect(isAfterHours(undefined, noon, NY)).toBeNull();
  });

  test("inside opening hours is not after hours", () => {
    const noon = new Date("2026-08-19T16:00:00Z"); // Wed 12:00 EDT
    expect(isOpenAt(NINE_TO_FIVE, noon, NY)).toBe(true);
    expect(isAfterHours(NINE_TO_FIVE, noon, NY)).toBe(false);
  });

  test("an evening call is after hours", () => {
    const ninePm = new Date("2026-08-20T01:00:00Z"); // Wed 21:00 EDT
    expect(isAfterHours(NINE_TO_FIVE, ninePm, NY)).toBe(true);
  });

  test("a closed day is after hours all day", () => {
    const saturdayNoon = new Date("2026-08-22T16:00:00Z");
    expect(isAfterHours(NINE_TO_FIVE, saturdayNoon, NY)).toBe(true);
  });

  test("boundaries: open at the opening minute, shut at the closing minute", () => {
    const nineAm = new Date("2026-08-19T13:00:00Z"); // 09:00 EDT
    const fivePm = new Date("2026-08-19T21:00:00Z"); // 17:00 EDT
    expect(isOpenAt(NINE_TO_FIVE, nineAm, NY)).toBe(true);
    // A call landing exactly at closing time is after hours, matching how a
    // front desk actually behaves.
    expect(isOpenAt(NINE_TO_FIVE, fivePm, NY)).toBe(false);
  });

  test("respects the clinic's timezone, not the server's", () => {
    // 21:00 UTC is 17:00 in New York (shut) but 14:00 in Los Angeles (open).
    const instant = new Date("2026-08-19T21:00:00Z");
    expect(isAfterHours(NINE_TO_FIVE, instant, NY)).toBe(true);
    expect(isAfterHours(NINE_TO_FIVE, instant, "America/Los_Angeles")).toBe(
      false,
    );
  });

  test("survives a DST transition", () => {
    // US clocks go back on 1 Nov 2026. A fixed UTC offset would misclassify an
    // hour of calls on one side of this; Intl gets it right on both.
    const beforeDst = new Date("2026-10-30T20:30:00Z"); // Fri 16:30 EDT — open
    const afterDst = new Date("2026-11-06T21:30:00Z"); // Fri 16:30 EST — open
    expect(isOpenAt(NINE_TO_FIVE, beforeDst, NY)).toBe(true);
    expect(isOpenAt(NINE_TO_FIVE, afterDst, NY)).toBe(true);

    const afterDstShut = new Date("2026-11-06T22:30:00Z"); // Fri 17:30 EST
    expect(isOpenAt(NINE_TO_FIVE, afterDstShut, NY)).toBe(false);
  });

  test("handles a lunchtime closure", () => {
    const split: OpeningHours = {
      ...NINE_TO_FIVE,
      wed: [
        ["09:00", "12:30"],
        ["13:30", "18:00"],
      ],
    };
    const lunch = new Date("2026-08-19T17:00:00Z"); // Wed 13:00 EDT
    const afterLunch = new Date("2026-08-19T18:00:00Z"); // Wed 14:00 EDT
    expect(isOpenAt(split, lunch, NY)).toBe(false);
    expect(isOpenAt(split, afterLunch, NY)).toBe(true);
  });

  test("handles a range crossing midnight", () => {
    const late: OpeningHours = {
      ...NINE_TO_FIVE,
      fri: [["20:00", "02:00"]],
    };
    const oneAm = new Date("2026-08-22T05:00:00Z"); // Sat 01:00 EDT
    // Saturday itself is closed, but Friday's late session runs into it.
    expect(isOpenAt(late, oneAm, NY)).toBe(true);
  });
});

describe("parseOpeningHours", () => {
  test("accepts a well-formed schedule", () => {
    expect(parseOpeningHours(NINE_TO_FIVE)).toEqual(NINE_TO_FIVE);
  });

  test("empty array means closed, and is valid", () => {
    expect(parseOpeningHours(NINE_TO_FIVE).sun).toEqual([]);
  });

  test("rejects a missing day rather than assuming it closed", () => {
    const { sat: _sat, ...missing } = NINE_TO_FIVE;
    expect(() => parseOpeningHours(missing)).toThrow(OpeningHoursError);
  });

  test("rejects malformed times instead of coercing them", () => {
    for (const bad of ["9:00", "25:00", "09:60", "nine", ""]) {
      expect(() =>
        parseOpeningHours({ ...NINE_TO_FIVE, mon: [[bad, "17:00"]] }),
      ).toThrow(OpeningHoursError);
    }
  });

  test("rejects a range that is not a pair", () => {
    expect(() =>
      parseOpeningHours({ ...NINE_TO_FIVE, mon: [["09:00"]] }),
    ).toThrow(OpeningHoursError);
  });

  test("rejects non-objects", () => {
    for (const bad of [null, undefined, [], "09:00", 42]) {
      expect(() => parseOpeningHours(bad)).toThrow(OpeningHoursError);
    }
  });
});
