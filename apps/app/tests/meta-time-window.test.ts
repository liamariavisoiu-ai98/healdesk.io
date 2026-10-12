import { describe, expect, test } from "vitest";

import { cleanAlternatives, cleanBookingFields, windowIsClean } from "@/lib/meta/booking-requests";
import { isTimeWindow } from "@/lib/meta/time-window";

/**
 * A Meta booking window keeps nothing but a time (BAA 1.3.0 clause 11,
 * "Clinical content sent on Instagram, Messenger or WhatsApp is not kept at
 * all"). The grammar is closed: every word must be a word for a time, so a
 * reason, a drug, a condition or a word in another language is refused
 * without anyone having listed it first, and the window is asked for again.
 */

const META = { conditions: true, timeGrammar: true } as const;

describe("the closed time grammar", () => {
  test.each([
    "Tues after 3",
    "next Monday morning",
    "any weekday after 5:30pm",
    "Oct 21 or 22",
    "tomorrow lunchtime",
    "Tuesday",
    "Tuesday 2pm",
    "tuesday at 2 pm",
    "Monday or Wednesday afternoon",
    "weekends",
    "this weekend",
    "next week",
    "today after 4",
    "Sat 10am",
    "anytime Thursday",
    "any time",
    "after 4 on weekdays",
    "between 9 and 11",
    "from 10 until noon",
    "10am-12pm",
    "2-4",
    "early next week",
    "end of the month",
    "the 3rd at 2",
    "12/10",
    "10/21/2026",
    "2026-10-21",
    "Friday 3ish",
    "Thursday evening, or Friday morning",
    "mornings before 11",
    "half past four",
    "quarter to five on Tuesday",
    "Mon/Wed after work",
    "first thing tomorrow",
    "asap",
    "Nov 3rd or 4th",
    "Wed 5.30",
    "the twenty-second",
    "late afternoon",
    "around midday",
    "sometime next month",
    "Tuesday a.m.",
    "after 6 p.m. please",
    "Thurs 1030",
  ])("%s is a time", (window) => {
    expect(isTimeWindow(window)).toBe(true);
    expect(windowIsClean(window, META)).toBe(true);
  });

  test.each([
    "Tuesday after my chemo",
    "after my semaglutide shot",
    "I have diabetes",
    // Clinical words the old word list never named.
    "Tuesday before my dialysis",
    "Friday, I'm pregnant",
    "after ozempic",
    "Monday once the swelling goes down",
    "morning, fasting",
    // A word in another language is outside the grammar too.
    "martes después de la quimio",
    "mañana",
    // Names, numbers and anything that is not a time.
    "ask for Dr Patel",
    "500mg",
    "call 4155550100",
    "Tuesday 🙂",
    // Joiners alone name no time.
    "after",
    "please",
    "or",
    "",
    // Out-of-range numbers are not times or dates.
    "99",
    "45:00",
  ])("%s is refused", (window) => {
    expect(isTimeWindow(window)).toBe(false);
    expect(windowIsClean(window, META)).toBe(false);
  });

  test("a Meta booking drops a window outside the grammar, and every alternative that is, and asks again", () => {
    const fields = cleanBookingFields({
      first_name: "Maria",
      phone: "+1 415 555 0123",
      window: "Tuesday after my chemo",
      alternatives: [
        "after my semaglutide shot",
        "Oct 21 or 22",
        "I have diabetes",
        "tomorrow lunchtime",
      ],
    });
    expect(fields.preferredWindow).toBeNull();
    expect(fields.alternativeWindows).toEqual(["Oct 21 or 22", "tomorrow lunchtime"]);

    expect(
      cleanBookingFields({ first_name: "Maria", phone: "+1 415 555 0123", window: "Tues after 3" })
        .preferredWindow,
    ).toBe("Tues after 3");
  });

  test("a voice request's alternatives, from a call the BAA covers, are not held to Meta's grammar", () => {
    expect(cleanAlternatives(["the week after my sister's wedding", "Friday after 2"], [])).toEqual(
      ["the week after my sister's wedding", "Friday after 2"],
    );
  });
});
