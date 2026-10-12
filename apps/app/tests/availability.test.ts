import { partsIn } from "@healdesk/connectors";
import { describe, expect, test } from "vitest";

import {
  candidateWindow,
  computeCandidates,
  nearestAlternatives,
  serviceDuration,
  type CandidateInput,
  type Span,
} from "@/lib/booking/availability";
import type { OpeningHours } from "@/lib/clinic/opening-hours";

/**
 * Availability's pure core (plan §6.2, §6.3; owner Q7): opening hours less
 * closed days, less what Google shows busy, less healdesk's own holds and
 * bookings, on the clinic's quarter-hours, at least two hours ahead, 14 days
 * out by default and never past 60. Every case here is a fixed instant, so
 * nothing depends on when the suite runs. The I/O around it (Google, the
 * holds, the closures, named providers) is tests/desk-calendar.test.ts.
 */

const CLOSED: OpeningHours = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
const every = (range: [string, string]): OpeningHours => ({
  sun: [range],
  mon: [range],
  tue: [range],
  wed: [range],
  thu: [range],
  fri: [range],
  sat: [range],
});
const day = (key: keyof OpeningHours, ...ranges: [string, string][]): OpeningHours => ({
  ...CLOSED,
  [key]: ranges,
});
const z = (iso: string) => new Date(iso);
const allFree = (from: string, to: string): Span[] => [{ startsAt: z(from), endsAt: z(to) }];
/** HH:MM on the clinic's own clock, for reading results the way the clinic would. */
const local = (at: Date, timeZone: string) => {
  const p = partsIn(at, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

function candidates(
  over: Partial<CandidateInput> & Pick<CandidateInput, "now" | "hours" | "timeZone">,
) {
  return computeCandidates({
    horizonDays: 14,
    noticeMinutes: 0,
    durationMinutes: 30,
    closedDates: new Set(),
    free: allFree("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
    blocked: [],
    ...over,
  });
}

describe("the window", () => {
  test("two hours' notice, then the horizon from there, never past 60 days from now", () => {
    const now = z("2026-10-12T12:00:00Z");
    expect(candidateWindow({ now, horizonDays: 14 })).toEqual({
      startsAt: z("2026-10-12T14:00:00Z"),
      endsAt: z("2026-10-26T14:00:00Z"),
    });
    // A named date further out moves the start, but not past 60 days.
    expect(candidateWindow({ now, from: z("2026-12-08T00:00:00Z"), horizonDays: 14 })).toEqual({
      startsAt: z("2026-12-08T00:00:00Z"),
      endsAt: z("2026-12-11T12:00:00Z"),
    });
    expect(candidateWindow({ now, from: z("2026-12-20T00:00:00Z"), horizonDays: 1 })).toBeNull();
  });
});

describe("computeCandidates", () => {
  const NY = "America/New_York";

  test("a quarter-hour grid inside the hours, each start fitting the whole service", () => {
    // Monday 12 October 2026, 09:00–11:00 EDT; a 45-minute service.
    const found = candidates({
      now: z("2026-10-11T12:00:00Z"),
      hours: day("mon", ["09:00", "11:00"]),
      timeZone: NY,
      durationMinutes: 45,
    });
    expect(found.slice(0, 6).map((at) => local(at, NY))).toEqual([
      "09:00",
      "09:15",
      "09:30",
      "09:45",
      "10:00",
      "10:15",
    ]);
    expect(found.filter((at) => at < z("2026-10-13T00:00:00Z"))).toHaveLength(6);
  });

  test("two hours' notice: nothing before now plus 120 minutes", () => {
    const found = computeCandidates({
      now: z("2026-10-12T12:00:00Z"), // 08:00 EDT
      horizonDays: 1,
      durationMinutes: 30,
      timeZone: NY,
      hours: day("mon", ["09:00", "17:00"]),
      closedDates: new Set(),
      free: allFree("2026-10-12T00:00:00Z", "2026-10-14T00:00:00Z"),
      blocked: [],
    });
    expect(local(found[0]!, NY)).toBe("10:00");
  });

  test("a 09:10 opening starts at 09:15", () => {
    const found = candidates({
      now: z("2026-10-11T12:00:00Z"),
      horizonDays: 2,
      hours: day("mon", ["09:10", "10:00"]),
      timeZone: NY,
    });
    expect(found.map((at) => local(at, NY))).toEqual(["09:15", "09:30"]);
  });

  test("every closed local date is left out, whatever its hours", () => {
    const found = candidates({
      now: z("2026-10-11T12:00:00Z"),
      horizonDays: 3,
      hours: every(["09:00", "10:00"]),
      timeZone: NY,
      closedDates: new Set(["2026-10-12"]),
    });
    const dates = new Set(found.map((at) => at.toISOString().slice(0, 10)));
    expect(dates.has("2026-10-12")).toBe(false);
    expect(dates.has("2026-10-13")).toBe(true);
  });

  test("busy time in Google and healdesk's own holds and bookings block, half-open", () => {
    const found = candidates({
      now: z("2026-10-11T12:00:00Z"),
      horizonDays: 2,
      hours: day("mon", ["09:00", "12:00"]),
      timeZone: NY,
      // Google: busy 10:00–10:30 EDT.
      free: [
        { startsAt: z("2026-10-12T00:00:00Z"), endsAt: z("2026-10-12T14:00:00Z") },
        { startsAt: z("2026-10-12T14:30:00Z"), endsAt: z("2026-10-13T00:00:00Z") },
      ],
      // A reserved hold 11:00–11:30 EDT.
      blocked: [{ startsAt: z("2026-10-12T15:00:00Z"), endsAt: z("2026-10-12T15:30:00Z") }],
    });
    expect(found.map((at) => local(at, NY))).toEqual([
      "09:00",
      "09:15",
      "09:30", // ends 10:00, where the busy time starts
      "10:30",
      "11:30",
    ]);
  });

  test("a range from the evening before, past midnight, is found on the next day's window", () => {
    // Saturday 20:00–02:00 EDT; the window opens Sunday 00:30.
    const found = candidates({
      now: z("2026-10-11T00:00:00Z"),
      from: z("2026-10-11T04:30:00Z"), // Sunday 00:30 EDT
      horizonDays: 1,
      hours: day("sat", ["20:00", "02:00"]),
      timeZone: NY,
    });
    expect(found.map((at) => local(at, NY))).toEqual(["00:30", "00:45", "01:00", "01:15", "01:30"]);
  });

  test("New York, clocks forward (8 March 2026): the skipped hour is never offered, each instant once", () => {
    const found = candidates({
      now: z("2026-03-07T00:00:00Z"),
      horizonDays: 2,
      hours: day("sun", ["01:00", "04:00"]),
      timeZone: NY,
    });
    expect(found.map((at) => local(at, NY))).toEqual([
      "01:00",
      "01:15",
      "01:30",
      "01:45",
      "03:00",
      "03:15",
      "03:30",
    ]);
    // 01:45 EST and 03:00 EDT are fifteen real minutes apart.
    expect(found[4]!.getTime() - found[3]!.getTime()).toBe(15 * 60_000);
  });

  test("New York, clocks back (1 November 2026): the repeated hour gives each instant once", () => {
    const found = candidates({
      now: z("2026-10-31T00:00:00Z"),
      horizonDays: 2,
      hours: day("sun", ["00:00", "03:00"]),
      timeZone: NY,
      durationMinutes: 60,
    });
    // 00:00 EDT to 03:00 EST is four real hours: starts every 15 minutes
    // from 04:00Z to 07:00Z.
    expect(found).toHaveLength(13);
    expect(new Set(found.map((at) => at.getTime())).size).toBe(13);
    expect(found[0]!.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(found.at(-1)!.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  test("a 20:00–02:00 range across the night the clocks go back", () => {
    const found = candidates({
      now: z("2026-10-30T00:00:00Z"),
      horizonDays: 3,
      hours: day("sat", ["20:00", "02:00"]),
      timeZone: NY,
      durationMinutes: 60,
    });
    // Saturday 20:00 EDT (00:00Z) to Sunday 02:00 EST (07:00Z): seven hours.
    expect(found[0]!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(found.at(-1)!.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(found).toHaveLength(25);
  });

  test("Europe/London, clocks forward (28 March 2027)", () => {
    const found = candidates({
      now: z("2027-03-26T00:00:00Z"),
      horizonDays: 3,
      hours: day("sun", ["00:00", "03:00"]),
      timeZone: "Europe/London",
      durationMinutes: 60,
    });
    // 00:00 GMT to 03:00 BST is two real hours.
    expect(found.map((at) => at.toISOString())).toEqual([
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T00:15:00.000Z",
      "2027-03-28T00:30:00.000Z",
      "2027-03-28T00:45:00.000Z",
      "2027-03-28T01:00:00.000Z",
    ]);
  });

  test("America/Phoenix keeps no daylight saving", () => {
    const summer = candidates({
      now: z("2026-07-05T00:00:00Z"),
      horizonDays: 2,
      hours: day("mon", ["09:00", "09:30"]),
      timeZone: "America/Phoenix",
    });
    const winter = candidates({
      now: z("2026-12-06T00:00:00Z"),
      horizonDays: 2,
      hours: day("mon", ["09:00", "09:30"]),
      timeZone: "America/Phoenix",
    });
    expect(summer.map((at) => at.toISOString())).toEqual(["2026-07-06T16:00:00.000Z"]);
    expect(winter.map((at) => at.toISOString())).toEqual(["2026-12-07T16:00:00.000Z"]);
  });

  test("Australia/Lord_Howe's thirty-minute shift (4 October 2026) stays on the quarter-hours", () => {
    const zone = "Australia/Lord_Howe";
    const found = candidates({
      now: z("2026-10-02T00:00:00Z"),
      horizonDays: 3,
      hours: day("sun", ["01:00", "04:00"]),
      timeZone: zone,
    });
    // 01:00 at +10:30 to 04:00 at +11:00 is two and a half real hours.
    expect(found).toHaveLength(9);
    expect(found.every((at) => partsIn(at, zone).minute % 15 === 0)).toBe(true);
    expect(found.map((at) => local(at, zone))).not.toContain("02:00");
    expect(found.map((at) => local(at, zone))).toContain("02:30");
  });

  test("nothing past the 60-day horizon, and nothing for a closed week", () => {
    expect(
      candidates({
        now: z("2026-10-12T00:00:00Z"),
        from: z("2026-12-15T00:00:00Z"),
        hours: every(["09:00", "17:00"]),
        timeZone: NY,
      }),
    ).toEqual([]);
    expect(candidates({ now: z("2026-10-12T00:00:00Z"), hours: CLOSED, timeZone: NY })).toEqual([]);
  });
});

describe("services and alternatives", () => {
  test("a service is matched by name ignoring case; unknown is 30 minutes; lengths are clamped", () => {
    const services = [
      { name: "Consultation", durationMinutes: 45 },
      { name: "Quick check", durationMinutes: 2 },
      { name: "Full day", durationMinutes: 900 },
      { name: "Unsized", durationMinutes: null },
    ];
    expect(serviceDuration(services, "  consultation ")).toEqual({
      minutes: 45,
      canonicalName: "Consultation",
    });
    expect(serviceDuration(services, "Quick check")).toEqual({
      minutes: 5,
      canonicalName: "Quick check",
    });
    expect(serviceDuration(services, "full day")).toEqual({
      minutes: 480,
      canonicalName: "Full day",
    });
    expect(serviceDuration(services, "Unsized")).toEqual({ minutes: 30, canonicalName: "Unsized" });
    expect(serviceDuration(services, "Botox")).toEqual({ minutes: 30, canonicalName: null });
    expect(serviceDuration(services, null)).toEqual({ minutes: 30, canonicalName: null });
  });

  test("the three nearest other times, in order", () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 12, h, m));
    const list = [at(9), at(9, 30), at(10), at(10, 30), at(11), at(14)];
    expect(nearestAlternatives(list, at(10, 30))).toEqual(
      [at(10), at(11), at(9, 30)].sort((a, b) => +a - +b),
    );
    expect(nearestAlternatives(list, at(15))).toEqual([at(10, 30), at(11), at(14)]);
  });
});
