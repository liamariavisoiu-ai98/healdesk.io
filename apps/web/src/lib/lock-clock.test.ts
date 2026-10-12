import { describe, expect, test } from "vitest";

import { englishLocale, lockDate, lockTime, noteTimes } from "@/lib/lock-clock";
import { OUTCOMES } from "@/lib/outcomes";

/** A local time on Monday 12 October 2026. */
const monday = (h: number, m: number) => new Date(2026, 9, 12, h, m);
/** The same, a day later. */
const tuesday = (h: number, m: number) => new Date(2026, 9, 13, h, m);

const times = (now: Date, cycle = "h12") => noteTimes(OUTCOMES, now, "en-US", cycle);

describe("the lock screen's clock is the visitor's", () => {
  test("the visitor's English, and American English for anyone else", () => {
    expect(englishLocale(["en-GB", "fr-FR"])).toBe("en-GB");
    expect(englishLocale(["fr-FR", "en"])).toBe("en");
    expect(englishLocale(["de-DE"])).toBe("en-US");
    expect(englishLocale(["eng-x"])).toBe("en-US");
    // A Linux locale, which Intl refuses: skipped, not thrown.
    expect(englishLocale(["en-US@posix", "en-GB"])).toBe("en-GB");
    expect(englishLocale(["en-US@posix"])).toBe("en-US");
  });

  test("the date and the time, the way a phone shows them", () => {
    expect(lockDate(monday(9, 41), "en-US")).toBe("Monday, October 12");
    expect(lockDate(monday(9, 41), "en-GB")).toBe("Monday 12 October");
    expect(lockTime(monday(21, 41), "en-US", "h12")).toBe("9:41");
    expect(lockTime(monday(21, 41), "en-US", "h23")).toBe("21:41");
    expect(lockTime(monday(7, 5), "en-US", "h12")).toBe("7:05");
  });
});

describe("the notifications' times make sense against it", () => {
  test("mid-morning: the screen as written, this morning's and last night's times", () => {
    const at = times(tuesday(9, 41));
    expect(at["one-voice"]).toBe("now");
    expect(at["by-morning"]).toBe("7:02 AM");
    expect(at["answered"]).toBe("11:48 PM");
    expect(at["recovered"]).toBe("Yesterday");
    expect(at["named"]).toBe("Yesterday");
  });

  test("before seven: no morning that has not happened", () => {
    const at = times(tuesday(3, 10));
    expect(at["by-morning"]).toBe("Yesterday");
    expect(at["answered"]).toBe("Yesterday");
  });

  test("late in the evening: last night's call is yesterday's, not one above this morning's", () => {
    const at = times(tuesday(23, 55));
    expect(at["by-morning"]).toBe("7:02 AM");
    expect(at["answered"]).toBe("Yesterday");
  });

  test("on a Monday, the Monday report is a week ago, not today", () => {
    expect(times(monday(9, 41))["named"]).toBe("Oct 5");
    expect(times(new Date(2026, 9, 15, 9, 41))["named"]).toBe("Monday");
  });

  test("a 24-hour device sees 24-hour times", () => {
    const at = times(tuesday(22, 0), "h23");
    expect(at["by-morning"]).toBe("07:02");
    expect(at["answered"]).toBe("23:48");
  });

  test("never a time later than the clock", () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        const now = tuesday(h, m);
        const at = times(now, "h23");
        for (const value of Object.values(at)) {
          const clock = /^(\d{2}):(\d{2})$/.exec(value);
          if (!clock) continue;
          const t = Number(clock[1]) * 60 + Number(clock[2]);
          // A time of day is either already past today, or an evening one
          // read as last night's.
          expect(t <= h * 60 + m || t >= 18 * 60, `${value} at ${h}:${m}`).toBe(true);
        }
      }
    }
  });
});
