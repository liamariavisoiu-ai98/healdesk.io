import { describe, expect, test } from "vitest";

import {
  cleanAlternatives,
  cleanBookingFields,
  requestReceivedLine,
  windowIsClean,
} from "@/lib/meta/booking-requests";
import { guardReply } from "@/lib/meta/front-door";
import { isTimeWindow } from "@/lib/meta/time-window";

/**
 * A Meta booking window keeps nothing but a time (BAA 1.3.0 clause 11,
 * "Clinical content sent on Instagram, Messenger or WhatsApp is not kept at
 * all"). The grammar is closed: every word must be a word for a time, so a
 * reason, a drug, a condition or a word in another language is refused
 * without anyone having listed it first, and the window is asked for again.
 */

const META = { conditions: true, timeGrammar: true } as const;
/** Next year, so a full date in these cases is never a past one, whenever the suite runs. */
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

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
    `10/21/${NEXT_YEAR}`,
    `${NEXT_YEAR}-10-21`,
    `10/21/${String(NEXT_YEAR).slice(2)}`,
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
    // A small closed set of filler around a time (the branch review's R10).
    "in 3 months",
    "a year from now",
    "anytime this week is fine",
    "I'm free Tuesday",
    "Saturday morning works",
    "after 5 if that's ok",
    "the day after tomorrow",
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
    // Every word a time word, and still something about the person (R10):
    // a cycle day, a past full date shaped like a date of birth, an "after"
    // with no time after it, and a number no clock shows.
    "day 3 or day 21",
    "day three",
    "10/21/1985",
    "1985-10-21",
    "the morning after",
    "2 weeks after",
    "4 weeks after the last time",
    "after 250",
    // A two-digit year read in this century, or a year past next: shaped
    // like a date of birth, never like a booking (the verification of 3a6de11).
    "03/12/90",
    "12/03/1990",
    `10/21/${NEXT_YEAR + 5}`,
    `${NEXT_YEAR + 5}-10-21`,
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

describe("the first name a Meta request keeps and says back", () => {
  // The C19 re-audit's B1: any letters-and-spaces string under 40 characters
  // was kept, and said back unguarded ("Thanks, Botox!").
  test.each([
    "Maria with diabetes",
    "Sue HIV",
    "Cancer Patient",
    "Diabetic Jane",
    "Maria semaglutide",
    "Botox",
    "Maria pregnant",
    "Pregnant Sue",
    "Chemo",
    "Biopsy",
    "Ann Surgery",
    "Maria IVF",
    "Ozempic Ann",
    "Maria (pregnant)",
    "Maria Ann Lopez",
    "Sue has HIV",
  ])("%j is dropped", (name) => {
    expect(cleanBookingFields({ first_name: name }).firstName).toBeNull();
  });

  test.each(["Maria", "Maria Lopez", "José", "Mary-Jane", "O'Brien", "Ann"])(
    "%j is kept",
    (name) => {
      expect(cleanBookingFields({ first_name: name }).firstName).toBe(name);
    },
  );

  test("the request line says a name back only when the reply guard passes it", () => {
    const context = { clinicName: "Glow Clinic", serviceNames: ["Neurotoxin"] };
    expect(guardReply(requestReceivedLine("Glow Clinic", "Maria"), context)).toEqual({ ok: true });
    expect(guardReply(requestReceivedLine("Glow Clinic", "Botox"), context)).toMatchObject({
      ok: false,
    });
    expect(requestReceivedLine("Glow Clinic", null)).toMatch(/^Thanks! I've passed that along/);
    expect(guardReply(requestReceivedLine("Glow Clinic", null), context)).toEqual({ ok: true });
  });
});
