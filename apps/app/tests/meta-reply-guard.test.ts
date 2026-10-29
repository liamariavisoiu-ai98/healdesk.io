import { describe, expect, test } from "vitest";

import { guardReply, PRICE_REFUSAL, publishedTimesOf } from "@/lib/meta/front-door";

/**
 * The Meta reply guard: BAA 1.3.0 clause 16's automated filters, which check
 * every reply the model writes there to keep treatment names and appointment
 * details out, replacing a refused one with a fixed reply, whatever the model
 * wrote and whether or not the clinic has a menu configured. They catch the
 * wordings below; the clause says no filter catches every wording. A clock
 * time passes only when it is one of the clinic's own opening or closing
 * times, which is how the front door answers "when are you open?"; every
 * other time, and every calendar date, gives the fixed hand-off.
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
/** The menu's figures the fixtures below quote: since 19 October a reply may name no other (the price check). */
const CLINIC = { clinicName: "Radiance", publishedTimes: PUBLISHED, prices: [450, 4.5] };

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
    // The clinic must be what is open: "the front desk is open" is its
    // hours, "the front desk is in" is not (the C19 re-audit's B3).
    expect(guardReply("The front desk is open from 9.", CLINIC)).toEqual({ ok: true });
    expect(guardReply("The front desk is in from 9.", CLINIC)).toEqual({
      ok: false,
      reason: "an appointment time",
    });
  });

  // The C19 re-audit's B3: an hours word in a sentence that isn't the
  // clinic's hours, and day and time forms the guard didn't read.
  test.each([
    "Your visit can be Tuesday from 9am.",
    "We have availability Tuesday from 9am.",
    "There's availability on the 14th from 9am.",
    "We have Tuesday open.",
    "Thanks, noted: 2 in the afternoon.",
    "Thanks, noted: two in the afternoon.",
    "Thanks, noted: the afternoon of the third.",
    "Noted: the first, in the morning.",
    "2 in the afternoon",
    "the afternoon of the third",
    "We have you for Tuesday.",
    "We have Tuesday morning free.",
    "Tuesday looks clear from 9am.",
    "I can pass along that you'd like Tuesday afternoon.",
    "Got it, mornings.",
    "We'll be open Tuesday from 9am if you'd like to come then.",
    "Thanks, I've noted 2.",
    "Thanks, I've noted your time of 2.",
  ])("refuses, from the re-audit: %j", (reply) => {
    const verdict = guardReply(reply, CLINIC);
    expect(verdict.ok, reply).toBe(false);
    expect(verdict.ok ? null : verdict.reason).toMatch(
      /^(an appointment (time|date|day)|a booking confirmation)$/,
    );
  });

  test.each([
    "We're open Tuesday from 9am.",
    "We are open until 5pm today.",
    "Our hours are 9am to 5pm on weekdays.",
    "The clinic opens at 9am on Saturdays and closes at 2pm.",
    "We close at 5pm on Fridays.",
    "Thank you! We're open Monday to Friday, 9am to 5pm.",
    "Good morning! Call the practice to book.",
  ])("passes, the clinic's hours: %j", (reply) => {
    expect(guardReply(reply, CLINIC)).toEqual({ ok: true });
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
      { prices: [120] },
      { clinicName: "Radiance", prices: [120] },
      { clinicName: "Radiance", serviceNames: ["Neurotoxin", "Dermal fillers"], prices: [120] },
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
    expect(guardReply("Our peels start from $120.", { ...CLINIC, address, prices: [120] })).toEqual({
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

describe("the reply guard: a named person presented as staff or a provider", () => {
  // The Meta channels name no provider and the front door books nothing, so
  // no reply has reason to name anyone who works at the practice. The old
  // provider pattern caught only "with Dr Chen".
  const context = { ...CLINIC, clinicName: "Glow Clinic", address: "1200 Peel Street, Suite 4" };

  test.each([
    ["Dr. Chen can help.", "a provider"],
    ["Doctor Patel sees new clients on weekdays.", "a provider"],
    ["Nurse Jane can answer that by phone.", "a provider"],
    ["Jane, our nurse, will call.", "a named member of staff"],
    ["Our injector Maria will call you back.", "a named member of staff"],
    ["Maria (one of our injectors) can help with that.", "a named member of staff"],
    ["Our lead nurse, Jane, will be in touch.", "a named member of staff"],
    ["The receptionist is Amy; call the practice to book.", "a named member of staff"],
    ["Jane at the front desk can help with that.", "a named member of staff"],
    ["Sarah from Glow Clinic will call you to confirm.", "a named member of staff"],
    ["Maria will call you back to confirm.", "a named member of staff"],
    ["Ask for Maria when you call the practice.", "a named member of staff"],
    ["Please speak to Jane about prices.", "a named member of staff"],
  ])("refuses: %j", (reply, reason) => {
    expect(guardReply(reply, context)).toEqual({ ok: false, reason });
  });

  test.each([
    // The person's own first name, which the booking request asks for.
    "Thanks, Jane! What's the best number for the practice to call?",
    "Got it, Maria. The practice will call you to confirm.",
    // No one named: a role on its own, the team, someone.
    "Our team will call you to confirm.",
    "Someone at the practice will call you to confirm.",
    "A person at the practice can help with the rest.",
    "Our front desk can help: call the practice to book.",
    // The clinic's own name and address, which may look like a person's.
    "Thanks for messaging Dr. Chen Aesthetics! Call the practice to book.",
    "We're at 1200 Peel Street, Suite 4. Call the practice to book.",
  ])("passes: %j", (reply) => {
    const clinicName = reply.includes("Dr. Chen Aesthetics") ? "Dr. Chen Aesthetics" : "Glow Clinic";
    expect(guardReply(reply, { ...context, clinicName })).toEqual({ ok: true });
  });
});

describe("the reply guard: the person's own words", () => {
  // The C19 re-audit's B4: a reply saying back what the person wrote can
  // name their condition or reason, which no list is complete enough to
  // catch. A content word of theirs, four letters or more, may not come
  // back unless it is everyday, a time word or one of the clinic's facts.
  const context = {
    ...CLINIC,
    clinicName: "Glow Clinic",
    address: "1200 Peel Street, Suite 4",
    ownFacts: "Free parking behind the building. Wheelchair access at the side door.",
  };

  test.each([
    ["I'm on chemo, can I still come in?", "Please call the practice about your chemo."],
    ["I have diabetes, is that ok?", "Happy to help with your diabetes questions by phone."],
    ["Waiting on my biopsy results", "We can help after your biopsy, call the practice."],
    ["My psoriasis is flaring", "Sorry, flaring skin needs a call to the practice."],
    ["Do you see people with eczema?", "Call the practice about eczema."],
  ])("refuses an echo: %j then %j", (inbound, reply) => {
    expect(guardReply(reply, { ...context, inbound })).toMatchObject({ ok: false });
  });

  test.each([
    ["Is there parking nearby?", "Yes, there's free parking behind the building."],
    ["Where are you located?", "We're at 1200 Peel Street, Suite 4."],
    ["What are your hours on Saturday?", "Saturday hours are 10am to 2pm."],
    ["How much does it cost?", "Prices start from $450. Call the practice to book."],
    ["Do you take new clients?", "Yes, new clients are welcome. Call the practice to book."],
    ["Is there wheelchair access?", "Yes, there's wheelchair access at the side door."],
    ["Hello! Can I book an appointment?", "Call the practice to book an appointment."],
    [
      "Can I message you about something?",
      "Of course. For anything personal, please call the practice.",
    ],
  ])("passes an ordinary reply: %j then %j", (inbound, reply) => {
    expect(guardReply(reply, { ...context, inbound })).toEqual({ ok: true });
  });
});

// The 19 October audit: the prompt invites a price ("its published price")
// and the guard never read one, so any figure went out on Instagram,
// Messenger and WhatsApp; this file expected "Prices start from $450." to
// pass whatever the menu said.
describe("the reply guard: the menu's prices", () => {
  const context = { clinicName: "Glow Clinic", prices: [150, 300, 600] };

  test.each([
    "Prices start from $450. Call the practice to book.",
    "That one is $199. Call the practice to book.",
    "That's about four hundred and fifty dollars. Call the practice to book.",
    "It's two hundred dollars. Call the practice to book.",
    "That's 10 per unit. Call the practice to book.",
  ])("a figure not on the menu is refused, written or said: %j", (reply) => {
    expect(guardReply(reply, context)).toEqual({ ok: false, reason: PRICE_REFUSAL });
  });

  test.each([
    "Yes, the practice offers that: it's $150. Call the practice to book.",
    "That's $300 to $600. Call the practice to book.",
    "That's three hundred dollars. Call the practice to book.",
  ])("a figure on the menu passes: %j", (reply) => {
    expect(guardReply(reply, context)).toEqual({ ok: true });
  });

  test("with no menu, no figure passes", () => {
    expect(guardReply("Prices start from $450. Call the practice to book.", { clinicName: "Glow Clinic" })).toEqual({
      ok: false,
      reason: PRICE_REFUSAL,
    });
  });
});

// Round 2 of the 19 October guardrails: the claim to be a person that a call
// and a web chat refuse is refused here too, with the same check.
describe("the reply guard: a claim to be a person", () => {
  const context = { clinicName: "Glow Clinic" };

  test.each([
    "No, I'm not a bot. Call the practice to book.",
    "I'm not an AI. Call the practice to book.",
    "You're talking to Sarah at the front desk. Call the practice to book.",
    "This is a human. Call the practice to book.",
    "You're talking to a real person. Call the practice to book.",
    "No soy un bot. Llame a la clínica.",
  ])("refused: %j", (reply) => {
    expect(guardReply(reply, context)).toEqual({ ok: false, reason: "a human claim" });
  });

  test.each([
    "No, I'm an automated assistant, not a real person. Call the practice and someone on the team can help.",
    "A person from our team will call you to confirm.",
    "If you'd rather talk to a real person, call the practice.",
    "Our staff can help: call the practice to book.",
    "Thanks for messaging Glow Clinic! Call the practice to book.",
  ])("passes: %j", (reply) => {
    expect(guardReply(reply, context)).toEqual({ ok: true });
  });
});


/**
 * The 22 October 2026 diagnosis against the real model: the guard refused
 * honest hand-offs, so a clinic's patient got the fixed line where a good
 * answer had been written. Each relaxation below is paired with the unsafe
 * replies it must still refuse.
 */
describe("the reply guard: honest hand-offs pass, and what each relaxation must still refuse", () => {
  /** The QA gate's clinic: open Monday to Friday 9 to 5, Saturday 10 to 2. */
  const GATE = { clinicName: "Radiance Med Spa", publishedTimes: [540, 1020, 600, 840], prices: [0, 300, 900, 150, 400] };

  test.each([
    // The hours a person answers the phone, quoted in a hand-off.
    "The team can help with that on the phone at +1 415 555 0199, Monday to Friday 9 to 5.",
    "Please call +1 415 555 0199 (Monday to Friday 9 to 5) or use radiancemedspa.example. I can also take a booking request here and the practice will call you to confirm.",
    "A person answers the phone Mon-Fri, from 9am until 5pm. Call the practice to book.",
    // "Visit" as a word, away from any day.
    "We're open Monday to Friday 9 to 5. There's free parking behind the building if you're planning a visit.",
    // "You can" that only says how to reach the practice.
    "You can reach the practice by phone at +1 415 555 0199.",
    "You can also call the team on +1 415 555 0199 or visit radiancemedspa.example.",
    "You can also visit radiancemedspa.example, or talk to the team on +1 415 555 0199.",
    "You can find more on the website, radiancemedspa.example.",
    // The booking question the prompt asks for.
    "Are there one or two other times that could also work for you? The practice will call you to confirm.",
    "Any other days that might work for you would help. The practice will call you to confirm.",
  ])("passes: %s", (reply) => {
    expect(guardReply(reply, GATE)).toEqual({ ok: true });
  });

  test.each([
    // A day after a booking word, a visit or a confirmation.
    ["See you Tuesday", /appointment day|booking/],
    ["Your visit is Tuesday afternoon", /appointment day/],
    ["We're open Tuesday, so we look forward to your visit then", /appointment day/],
    ["We have you down for Monday to Friday 9 to 5", /booking confirmation|appointment/],
    // A span whose times are not the clinic's.
    ["Please call (Monday to Friday 7 to 9)", /appointment/],
    ["Call us Monday to Friday 9 to 7.", /appointment/],
    // A span outside any sentence about reaching the practice or its hours.
    ["See you Monday to Friday 9 to 5", /appointment day/],
    // A day agreed to, or a suitability claim.
    ["Tuesday works for you", /suitability|appointment day/],
    ["It works well for you", /suitability/],
    ["Does Tuesday work for you?", /suitability|appointment day/],
    ["That treatment works for you.", /suitability/],
    // Guidance.
    ["You can apply ice", /guidance/],
    ["You can take ibuprofen", /guidance/],
    ["You can also try a cold compress.", /guidance/],
    ["You can find that a cold compress helps.", /guidance/],
    ["You can speak up if it stings.", /guidance/],
    ["You can visit a pharmacy for that.", /guidance/],
    // A part of the day said back.
    ["Got it, mornings", /appointment day/],
  ])("refuses: %s", (reply, reason) => {
    const verdict = guardReply(reply, GATE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });

  test("a long run of near-spans is read in linear time", () => {
    // Up to the 700-character cap, each built to start a span and fail it late.
    const inputs = [
      `Call us ${"Monday to Friday 9 to ".repeat(40)}`,
      `Call us ${"Mon - Fri, from 9:00 ".repeat(40)}`,
      `Phone ${"mon-tue-wed-thu-".repeat(60)}`,
      `Call ${"9 ".repeat(400)}`,
    ].map((text) => text.slice(0, 699));
    const started = performance.now();
    for (let i = 0; i < 25; i++) for (const text of inputs) guardReply(text, GATE);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("the reply guard: deposits stay out of the model's words (DEP-META slice 1)", () => {
  // The clinic's deposit link is sent only by the fixed tool layer after
  // staff confirm a request (lib/meta/deposit-link.ts), never by the model:
  // a reply that talks about a deposit, or copies the fixed line, is refused.
  test.each([
    "Sure, you can pay your deposit here: https://checkout.stripe.com/c/pay/cs_test_x",
    "Your deposit is all set once you pay the link I sent.",
    "To hold your request, please pay the deposit through this secure link: https://checkout.stripe.com/c/pay/cs_test_x",
    "I can take the deposit for you now.",
  ])("refuses: %s", (reply) => {
    expect(guardReply(reply, CLINIC).ok).toBe(false);
  });

  test("the hand-off to the phone still passes", () => {
    expect(guardReply("The team can help with that on the phone.", CLINIC)).toEqual({ ok: true });
  });
});
