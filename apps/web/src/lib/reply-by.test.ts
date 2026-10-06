import { describe, expect, test } from "vitest";

import { replyByDate } from "./reply-by";

/**
 * "We'll reply by …" names the next business day in New York, where the
 * buyers are, whatever the server's clock says.
 */
describe("replyByDate", () => {
  test("Monday to Thursday reply the next day", () => {
    expect(replyByDate(new Date("2026-10-05T15:00:00Z"))).toBe("Tuesday 6 October");
    expect(replyByDate(new Date("2026-10-08T15:00:00Z"))).toBe("Friday 9 October");
  });

  test("Friday, Saturday and Sunday reply on Monday", () => {
    expect(replyByDate(new Date("2026-10-09T15:00:00Z"))).toBe("Monday 12 October");
    expect(replyByDate(new Date("2026-10-10T15:00:00Z"))).toBe("Monday 12 October");
    expect(replyByDate(new Date("2026-10-11T15:00:00Z"))).toBe("Monday 12 October");
  });

  test("the day is New York's, not UTC's", () => {
    // 02:00 UTC on Friday is still Thursday evening in New York.
    expect(replyByDate(new Date("2026-10-09T02:00:00Z"))).toBe("Friday 9 October");
  });

  test("a month boundary is crossed cleanly", () => {
    expect(replyByDate(new Date("2026-10-30T15:00:00Z"))).toBe("Monday 2 November");
  });
});
