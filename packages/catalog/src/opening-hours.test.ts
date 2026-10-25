import { describe, expect, test } from "vitest";

import { openDaysPerWeek, parseDays, parseSpans } from "./opening-hours";

describe("opening hours as a website writes them", () => {
  test("reads days, ranges and spans in their usual shapes", () => {
    expect([...parseDays("Mon–Fri")!]).toEqual([0, 1, 2, 3, 4]);
    expect([...parseDays("Monday to Wednesday, Sat")!]).toEqual([0, 1, 2, 5]);
    expect([...parseDays("Fri - Mon")!].sort()).toEqual([0, 4, 5, 6]);
    expect(parseDays("daily")!.size).toBe(7);
    expect(parseDays("Mon-Sun")!.size).toBe(7);
    expect(parseDays("Most days")).toBeNull();
    expect(parseSpans("9am–6pm")).toEqual([[540, 1080]]);
    expect(parseSpans("9 AM to 7 PM")).toEqual([[540, 1140]]);
    expect(parseSpans("9am-1pm, 2pm-6pm")).toEqual([[540, 780], [840, 1080]]);
    expect(parseSpans("10-4")).toEqual([[600, 960]]);
    expect(parseSpans("Closed")).toEqual([]);
    expect(parseSpans("by arrangement")).toBeNull();
    expect(openDaysPerWeek([{ days: "Mon-Fri", hours: "9am-6pm" }, { days: "Saturday", hours: "10am-2pm" }, { days: "Sunday", hours: "Closed" }])).toBe(6);
    expect(openDaysPerWeek([])).toBeNull();
  });

  test("a long label built to make a pattern backtrack is read in linear time", () => {
    // The hours reach the demo call through Retell's socket (demo-facts.ts).
    const hostile = [`${"a".repeat(20_000)}!`, `${"to".repeat(10_000)}1`, `9${" ".repeat(20_000)}x`, `${"-".repeat(20_000)}a`];
    const started = performance.now();
    for (const label of hostile) {
      parseDays(label);
      parseSpans(label);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});
