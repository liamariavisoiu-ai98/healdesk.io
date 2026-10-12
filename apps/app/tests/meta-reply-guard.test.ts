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
    "The front desk is open from 9 until 5. Call the practice to book.",
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

  // The branch review's probe (R2): each of these passed the guard before.
  test.each([
    // The opening-hours exception, in a sentence that books.
    "Great, Tuesday at 9am it is.",
    "Perfect, we'll pencil you in for Thursday at 9.",
    "We have an opening tomorrow at 9.",
    "The team can fit you in at 9 on Thursday.",
    // Word-form and 24-hour times and dates.
    "How about half past two on Tuesday?",
    "We have a slot at quarter to three on Friday.",
    "We can do two thirty Tuesday.",
    "We have a slot at 14h on Friday.",
    "We have a slot at 1430 on Friday.",
    "We'll see you on October twenty first.",
    "See you 21.10.",
    "half past two",
    "quarter to three",
    "at 14h",
    "at 1430",
    "October twenty first",
    "21.10",
    "Your appointment is confirmed for the twenty-first.",
    // A confirmation with no "you're" or "it's" in it.
    "Your appointment on Tuesday is confirmed.",
    "Your consultation is booked for next Tuesday afternoon.",
    "You're booked in for next Tuesday afternoon.",
    "We have you down for Tuesday afternoon.",
    "We've reserved Tuesday afternoon for you.",
    // And the rest of the probe's appointment lines.
    "We'll see you Tuesday at 9am.",
    "See you on Tuesday at 9am!",
    "Your appointment is Tuesday at 5pm.",
    "Tuesday morning works.",
    "We can do 2pm Tuesday.",
    "We'll see you on the 21st.",
    "See you on 21 October.",
    "Our team will see you Tuesday.",
    "We'll call you back tomorrow at 9am.",
    "We're open for you Tuesday at 9am, so come in then.",
  ])("refuses, from the review's probe: %s", (reply) => {
    const verdict = guardReply(reply, CLINIC);
    expect(verdict.ok, reply).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toMatch(
      /^(an appointment (time|date|day)|a booking confirmation)$/,
    );
  });

  test.each([
    "We're open Monday to Friday, 9am to 5pm.",
    "We're open 9-5 on weekdays.",
    "We are open until 5 today.",
    "Saturdays we close at 2pm.",
    "We're closed on Sundays.",
    "Thanks! The practice will call you to confirm a time.",
    "Got it. The practice will call to confirm; what day suits you best?",
    "We'll pass your request to the team, and they'll call you to confirm.",
    "It takes about 45 minutes, and the practice will call you to confirm.",
    // The hand-off is not a booking word.
    "We're open weekdays 9 to 5 — call the practice to book.",
    "We open at 9am; call us to book.",
  ])("passes, from the review's probe: %s", (reply) => {
    expect(guardReply(reply, CLINIC)).toEqual({ ok: true });
  });

  test("a published time passes only in a sentence about opening hours with no booking word", () => {
    // 9am is the clinic's own opening time: about the hours, it passes; in
    // a sentence that books, or one that isn't about the hours, it doesn't.
    expect(guardReply("We open at 9am on Tuesday.", CLINIC)).toEqual({ ok: true });
    expect(guardReply("Tuesday at 9am it is.", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment day",
    });
    expect(guardReply("We're open at 9am, so your appointment can be then.", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment time",
    });
    // "from" and "until" make a sentence about the hours, as "open" does.
    expect(guardReply("The front desk is in from 9.", CLINIC)).toEqual({ ok: true });
    expect(guardReply("The front desk is in from 3.", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment time",
    });
  });

  // The verification of 3a6de11: phrasings the sentence rules let through.
  // The rule now is not a list of phrasings: a day, a date or a time appears
  // only in a sentence about the opening hours, and only with no booking word
  // anywhere in the reply.
  test.each([
    "Tuesday afternoon it is.",
    "All sorted for Tuesday afternoon.",
    "We look forward to seeing you on Tuesday afternoon.",
    "Your visit is Tuesday afternoon.",
    "Booked! Tuesday afternoon.",
    "Confirmed. Tuesday afternoon.",
    "Confirmed for\nTuesday afternoon.",
    "Tuesday afternoon it is!\nSee you then.",
    "See you at two.",
    "We'll expect you at two-thirty.",
    "See you at 1430h.",
    "Tuesday 1430.",
    "Tuesday at fourteen hundred.",
    "Tuesday afternoon has been held for you.",
    "We've got Tuesday afternoon sorted.",
    "The team will meet you Tuesday afternoon.",
    "Tuesday afternoon's in the calendar.",
    "Your appointment is set.\nTuesday, 2pm.",
    "Lovely. Tuesday afternoon, see you then.",
    "Thursday, ten to four.",
    "See you at 0930.",
    // A day, a date or a time on offer is not the clinic's hours.
    "Tuesday is open from 9am.",
    "The 22nd is open until 5pm.",
    "9am is still free, we open then.",
    // An hours sentence in a reply that also books is no hours answer.
    "We're open Tuesday from 9am. See you then!",
    "We open at 9am tomorrow, and your appointment is then.",
  ])("refuses, from the verification: %j", (reply) => {
    const verdict = guardReply(reply, CLINIC);
    expect(verdict.ok, reply).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toMatch(
      /^(an appointment (time|date|day)|a booking confirmation)$/,
    );
  });

  test.each([
    "We're open Monday to Friday, 9am to 5pm.",
    "Our opening hours are 9 to 5, and 10 to 2 on Saturdays.",
    "We're open late on Thursdays until 7:30pm.",
    "We have a late opening on Thursdays until 7:30pm.",
    "We're closed on Sundays.",
    "We're closed today.",
    "We open at 9 tomorrow.",
    "We're open until 5 today.",
    "Saturday hours are 10am to 2pm.",
    "We're open weekdays 9:00-17:00 and Saturdays 10:00-14:00.",
    "Our hours change on public holidays, so please call the practice.",
    "Opening times are 9-5 weekdays, call the practice to book.",
    "Hours: Mon-Fri 9-5, Sat 10-2.",
    "We open at nine on weekdays.",
    "We're open weekdays 9 to 5.\nCall the practice to book.",
    "We're open 9 to 5; the practice will call you to confirm.",
    "The practice is open from 9am on Tuesdays.",
    "Reception's open until 5pm today.",
  ])("passes, an hours answer: %j", (reply) => {
    expect(guardReply(reply, CLINIC)).toEqual({ ok: true });
  });

  test("an ordinal that is a floor, a street or part of the clinic's address is no date", () => {
    // The verification of 3a6de11, low: the date check read the raw reply.
    const address = "120 5th Avenue, Suite 4, New York, NY 10011";
    for (const reply of [
      "We're at 120 5th Avenue, Suite 4.",
      "The entrance is on 5th Avenue.",
      "We're between 4th and 5th Avenue.",
    ]) {
      expect(guardReply(reply, { ...CLINIC, address }), reply).toEqual({ ok: true });
    }
    for (const reply of [
      "We're on the 2nd floor.",
      "We're on the 2nd floor, Suite 4.",
      "Take the F train to 14th St.",
      "The entrance is on 5th Avenue.",
      "We're between 4th and 5th Avenue.",
    ]) {
      expect(guardReply(reply, CLINIC), reply).toEqual({ ok: true });
    }
    // A day of the month is still one.
    expect(guardReply("Come in on the 2nd.", CLINIC)).toMatchObject({ ok: false });
    expect(guardReply("The 5th is free.", { ...CLINIC, address })).toMatchObject({ ok: false });
  });

  test("a day or a time outside a sentence about the hours gives the hand-off, even an honest one", () => {
    // The cost of not chasing phrasings: the front door states the hours,
    // and anything else timed goes to the practice.
    expect(guardReply("Parking is free after 6pm.", CLINIC)).toMatchObject({ ok: false });
    expect(guardReply("Street parking is free on Sundays.", CLINIC)).toMatchObject({ ok: false });
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

  test("a place named after a treatment word passes, the clinic's own address passes, and accents hide nothing", () => {
    // The branch review's R8: honest answers about where the clinic is.
    for (const reply of [
      "We're at 1200 Peel Street, Suite 4.",
      "Free parking is behind the building on Laser Lane.",
      "We're on Rue Peel, by the metro.",
      "Turn left onto Potenza Ave.",
      "Our team is laser-focused on getting you an answer.",
    ]) {
      expect(guardReply(reply, CLINIC), reply).toEqual({ ok: true });
    }
    // An address with no road word in it passes only as the clinic's own.
    const address = "Unit 4, The Peel Centre, Leeds";
    expect(guardReply("We're in the Peel Centre, in Leeds.", CLINIC)).toEqual({
      ok: false,
      reason: "a treatment name",
    });
    expect(guardReply("We're in The Peel Centre, in Leeds.", { ...CLINIC, address })).toEqual({
      ok: true,
    });
    // It exempts the address, not the word: a peel is still a treatment there.
    expect(guardReply("Our peels start from $120.", { ...CLINIC, address })).toEqual({
      ok: false,
      reason: "a treatment name",
    });
    expect(guardReply("Your Juvéderm appointment is set.", CLINIC)).toEqual({
      ok: false,
      reason: "a treatment name",
    });
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

describe("the reply guard: who is writing", () => {
  // The C19 re-audit: after the channel's line says an AI assistant is
  // writing, the model introduced a person. Refused, whatever the greeting.
  test.each([
    "Hi, it's Sarah from Glow Clinic!",
    "Hi, it's Sarah from Glow Clinic! We're open 9 to 5.",
    "I'm Sarah, a member of the team.",
    "My name is Sarah and I can help.",
    "Sarah here, happy to help.",
    "Hi, this is the front desk at Glow Clinic.",
    "I'm the receptionist here.",
    "I'm on the team at Glow Clinic.",
  ])("refuses: %j", (reply) => {
    expect(guardReply(reply, { ...CLINIC, clinicName: "Glow Clinic" })).toEqual({
      ok: false,
      reason: "a human claim",
    });
  });

  test.each([
    "I'm happy to help with that.",
    "I'm afraid I can't say here; call the practice.",
    "This is Glow Clinic's messaging line. Call the practice to book.",
    "It's best to call the practice to book.",
    "Our team will call you to confirm.",
  ])("passes: %j", (reply) => {
    expect(guardReply(reply, { ...CLINIC, clinicName: "Glow Clinic" })).toEqual({ ok: true });
  });
});
