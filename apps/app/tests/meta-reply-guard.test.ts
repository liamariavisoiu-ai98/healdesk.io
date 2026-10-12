import { describe, expect, test } from "vitest";

import { guardReply, publishedTimesOf } from "@/lib/meta/front-door";

/**
 * The Meta reply guard names no treatment and confirms no appointment
 * details (BAA 1.3.0 clause 16), whatever the model wrote and whether or not
 * the clinic has a menu configured. A clock time passes only when it is one
 * of the clinic's own opening or closing times, which is how the front door
 * answers "when are you open?"; every other time, and every calendar date,
 * gives the fixed hand-off.
 */

const HOURS = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "19:30"]],
  fri: [["09:00", "17:00"]],
  sat: [["10:00", "14:00"]],
};
const PUBLISHED = publishedTimesOf(HOURS);
const CLINIC = { clinicName: "Radiance", publishedTimes: PUBLISHED };

describe("the reply guard: appointment details", () => {
  test("the clinic's hours are read as its opening and closing times", () => {
    expect([...PUBLISHED].sort((a, b) => a - b)).toEqual([540, 600, 840, 1020, 1170]);
    expect(publishedTimesOf(null)).toEqual([]);
    expect(publishedTimesOf({ not: "hours" })).toEqual([]);
  });

  test.each([
    "We're open Monday to Friday 9 to 5, Thursdays until 7:30pm, and Saturday 10am to 2pm.",
    "We open at 9am and close at 5pm on weekdays.",
    "Our hours are 9:00-17:00 on weekdays, 10-2 on Saturdays.",
    "The front desk is in from 9 until 5. Call the practice to book.",
    "Saturdays we're open until 2pm.",
    "We're here 24/7 on the website, and a person picks up the phone in opening hours.",
    "Speak to one of our team: call the practice to book.",
    "That starts from $450, or $4.50 for parking. Call the practice to book.",
    "Most people book 2 weeks ahead; call the practice to book.",
  ])("passes: %s", (reply) => {
    expect(guardReply(reply, CLINIC)).toEqual({ ok: true });
  });

  test.each([
    "Tuesday at 2pm works",
    "How about 3pm on Tuesday?",
    "Our team can see you at 3.",
    "Thursday at 11:15 is free.",
    "We could fit you in at noon.",
    "Three o'clock would be fine.",
    "We're open until 5:45pm.",
    "How about Oct 21?",
    "The 22nd is open.",
    "We have room on 10/21.",
    "21st of October could work.",
    "Tuesday works for the team.",
    "You're all set!",
  ])("refuses: %s", (reply) => {
    const verdict = guardReply(reply, CLINIC);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toMatch(
      /^(an appointment (time|date|day)|a booking confirmation)$/,
    );
  });

  test("a time that is one of the clinic's own, said to confirm a booking, is still refused", () => {
    // 2pm is Saturday's closing time, so the clock time alone would pass; the
    // day agreed to is what the guard refuses.
    expect(guardReply("Tuesday at 2pm works", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment day",
    });
    expect(guardReply("Another time: 3pm.", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment time",
    });
  });

  test("with no hours on file, no clock time passes", () => {
    expect(guardReply("We open at 9am.", { clinicName: "Radiance" })).toEqual({
      ok: false,
      reason: "an appointment time",
    });
  });
});

describe("the reply guard: treatment names off the menu", () => {
  test("a treatment word is refused whether or not the clinic has a menu, and whatever its menu calls it", () => {
    for (const context of [
      {},
      { clinicName: "Radiance" },
      { clinicName: "Radiance", serviceNames: ["Neurotoxin", "Dermal fillers"] },
    ]) {
      for (const reply of [
        "Yes, we do Botox — call the practice to book.",
        "Our peels start from $120. Call the practice to book.",
        "We have semaglutide programs; call the practice.",
        "IV therapy is available. Call the practice to book.",
        "Laser treatments are popular here. Call the practice.",
      ]) {
        expect(guardReply(reply, context), reply).toEqual({
          ok: false,
          reason: "a treatment name",
        });
      }
    }
  });

  test("whole words only, and the clinic's own name may carry one", () => {
    expect(guardReply("We'd appeal to you to call the practice to book.", CLINIC)).toEqual({
      ok: true,
    });
    expect(
      guardReply("Thanks for messaging Glow Laser Studio! Call the practice to book.", {
        clinicName: "Glow Laser Studio",
        publishedTimes: PUBLISHED,
      }),
    ).toEqual({ ok: true });
    expect(
      guardReply("Glow Laser Studio offers laser hair removal — call the practice.", {
        clinicName: "Glow Laser Studio",
      }),
    ).toEqual({ ok: false, reason: "a treatment name" });
  });
});
