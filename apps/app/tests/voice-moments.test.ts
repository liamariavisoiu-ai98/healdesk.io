import { describe, expect, test, vi } from "vitest";

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import { EMPTY_CAPTURE, offeredTimeNamed, withoutFreeTimeClaims } from "@/lib/assistant/turn";
import { BOOKING_LINES_VOICE_EN } from "@/lib/booking/lines";
import { lookupLine, pause, PAUSE_MS, speakingMs, splitPauses, withoutPauses } from "@/lib/voice/pauses";
import { fillerFor, FILLER_MAX_PER_CALL } from "@/lib/voice/fillers";
import { keyFactOf } from "@/lib/voice/retell";
import { spokenHourEn, spokenSlotEn } from "@/lib/voice/spoken";

/**
 * The call's moments (owner, 1 November 2026; docs/design/demo-aya-simpler-2026-11-01.md):
 * times as a front desk says them, the pauses a person takes, a given number
 * read back before it is used, an offered time picked by its hour, and a
 * repeat said as its key fact alone.
 */

const TZ = "America/New_York";

describe("times as a front desk says them", () => {
  test("the bare hour through the working day; AM or PM only where it could be read either way", () => {
    expect(spokenHourEn(10, 0)).toBe("10");
    expect(spokenHourEn(14, 0)).toBe("2");
    expect(spokenHourEn(14, 30)).toBe("2:30");
    expect(spokenHourEn(7, 0)).toBe("7 AM");
    expect(spokenHourEn(20, 0)).toBe("8 PM");
    expect(spokenHourEn(12, 0)).toBe("12");
    expect(spokenSlotEn(new Date("2026-11-05T19:00:00Z"), TZ)).toBe("Thursday the 5th at 2");
    expect(spokenSlotEn(new Date("2026-11-01T15:00:00Z"), TZ)).toBe("Sunday the 1st at 10");
    expect(spokenSlotEn(new Date("2026-11-12T15:00:00Z"), TZ)).toBe("Thursday the 12th at 10");
    expect(spokenSlotEn(new Date("2026-11-23T15:00:00Z"), TZ)).toBe("Monday the 23rd at 10");
  });

  test("the call's lines: the day once, one question each, the name once at the wrap-up", () => {
    const L = BOOKING_LINES_VOICE_EN;
    expect(L.offer(["Thursday the 5th at 10", "2", "4"])).toBe("Thursday the 5th, I've got 10, 2 or 4. Any of those work?");
    expect(L.offer(["Thursday the 5th at 10"])).toBe("Thursday the 5th, I've got 10. Does that work?");
    expect(L.offer(["Monday the 2nd at 2", "Monday the 2nd at 4", "Tuesday the 3rd at 2"])).toBe("I've got Monday the 2nd at 2 or 4, or Tuesday the 3rd at 2. Any of those work?");
    expect(L.slotGone(["Thursday the 5th at 1", "3"], "Thursday the 5th at 2")).toBe("Ah, 2 just went. I've got 1 or 3?");
    expect(L.heldAsk("first_name", "Thursday the 5th at 3")).toBe("Great, I'm holding 3 for you. What's your first name?");
    expect(L.booked("Thursday the 5th at 3", "Botox", "Tomo")).toBe("Perfect, Tomo, you're booked for Botox on Thursday the 5th at 3.");
    expect(L.deposit({ action: "book_and_flag", amountUsd: 50, scope: "booking" })).toBe("There's a 50 dollar deposit, and our front desk will give you a quick call to take it.");
    expect(L.oneBookingPerCall("Thursday the 5th at 3")).toBe("You're all set for Thursday at 3. For a second visit, our front desk can sort that out.");
    for (const line of [L.noFreeTime, L.missing.first_name, L.missing.phone, L.heldAsk("phone", "Thursday the 5th at 3")]) {
      expect(line.split("?").length - 1, line).toBeLessThanOrEqual(1);
    }
  });
});

describe("pauses", () => {
  test("a marker cuts the reply into pieces, each with the silence before it, and is never said", () => {
    const reply = `Let me pull up our calendar... ${pause("lookup")} Thursday the 5th, I've got 10.`;
    expect(splitPauses(reply)).toEqual([
      { text: "Let me pull up our calendar...", pauseMs: 0 },
      { text: "Thursday the 5th, I've got 10.", pauseMs: PAUSE_MS.lookup },
    ]);
    expect(withoutPauses(reply)).toBe("Let me pull up our calendar... Thursday the 5th, I've got 10.");
    expect(splitPauses(`${pause("beat")} Then this.`)).toEqual([{ text: "Then this.", pauseMs: PAUSE_MS.beat }]);
    expect(splitPauses("No pause here.")).toEqual([{ text: "No pause here.", pauseMs: 0 }]);
    expect(speakingMs("one two three four five six seven eight nine ten eleven")).toBe(4000);
  });

  test("the lookup line is never the day (the times line says it) and never twice in a call", () => {
    const first = lookupLine("Thursday", [], false);
    expect(first).not.toMatch(/Thursday/);
    const second = lookupLine("Thursday", [first], false);
    expect(second).not.toBe(first);
  });
});

describe("a number the caller gives is read back before it is used", () => {
  const AT = "2026-11-05T19:00:00.000Z";
  const STATE: BookingToolState = { ...EMPTY_TOOL_STATE, offered: [{ at: AT, providerId: null }], chosen: { at: AT, providerId: null }, held: true };
  const book = vi.fn(async (_c: string, input: { startsAt: Date; phoneE164: string }) => ({
    kind: "booked" as const, startsAt: input.startsAt, minutes: 30, canonicalService: null, providerId: null, replayed: false, appointmentId: "a", requestId: "r", deposit: null,
  }));
  const engine = { offerTimes: vi.fn(), placeHold: vi.fn(), bookConversation: book, chatDepositFor: vi.fn(), logRequest: vi.fn() } as unknown as BookingEngine;
  const tools = bookingTools(
    { clinicId: "c", channel: "voice", holderKey: "retell:x", bookingKey: "retell:x:1", conversationId: null, timeZone: TZ, budgetMs: 1000, actor: { kind: "system", id: "t" } as never },
    engine,
    (async () => ({ decision: "answer" })) as never,
  );
  const capture = { ...EMPTY_CAPTURE, firstName: "Sam", phone: "305 555 0199" };

  test("read back, booked only on the yes, with the confirmed number", async () => {
    const read = await tools.run({ action: null, capture, state: STATE, now: new Date("2026-11-01T13:00:00Z"), words: "Sam, 305 555 0199." });
    expect(read!.reply).toBe("305-555-0199, right?");
    expect(book).not.toHaveBeenCalled();
    const booked = await tools.run({ action: null, capture, state: read!.state, now: new Date("2026-11-01T13:00:00Z"), words: "Yes, that's right." });
    expect(booked!.bookingWritten).toBe(true);
    expect(book.mock.calls[0]![1].phoneE164).toBe("+13055550199");
  });

  test("a no asks for the number again; a new number is read back afresh", async () => {
    const read = await tools.run({ action: null, capture, state: STATE, now: new Date(), words: "305 555 0199" });
    const no = await tools.run({ action: null, capture, state: read!.state, now: new Date(), words: "No, that's wrong." });
    expect(no!.reply).toBe(BOOKING_LINES_VOICE_EN.missing.phone);
    const again = await tools.run({ action: null, capture: { ...capture, phone: "305 555 0177" }, state: no!.state, now: new Date(), words: "305 555 0177" });
    expect(again!.reply).toBe("305-555-0177, right?");
  });
});

describe("an offered time picked by its hour", () => {
  const offered = [{ at: "2026-11-02T19:00:00.000Z" }, { at: "2026-11-02T21:00:00.000Z" }, { at: "2026-11-03T19:00:00.000Z" }];
  const now = new Date("2026-11-01T13:00:00Z");
  test("one match is picked; two (the same hour on two days) or none is left to the model", () => {
    expect(offeredTimeNamed("Four PM would work.", offered, TZ, now)).toBe("2026-11-02T21:00:00.000Z");
    expect(offeredTimeNamed("the 4 o'clock", offered, TZ, now)).toBe("2026-11-02T21:00:00.000Z");
    expect(offeredTimeNamed("Two works.", offered, TZ, now)).toBeNull();
    expect(offeredTimeNamed("Tuesday at two", offered, TZ, now)).toBe("2026-11-03T19:00:00.000Z");
    expect(offeredTimeNamed("Five then.", offered, TZ, now)).toBeNull();
    expect(offeredTimeNamed("Sounds good.", offered, TZ, now)).toBeNull();
  });
});

describe("never the same thing twice", () => {
  test("a repeat is its key fact alone, keeping its yes or no", () => {
    expect(keyFactOf("Yes, a $50 deposit holds each appointment, and it comes off the treatment price.")).toBe("Yes, $50.");
    expect(keyFactOf("Botox is from $18 per unit, and the total depends on the areas.")).toBe("From $18 per unit.");
    expect(keyFactOf("You're booked for Thursday the 5th at 3, and we can't wait to see you.")).toBe("Thursday the 5th at 3.");
    expect(keyFactOf("Okay.")).toBeNull();
  });

  test("a free time named to a question that asked for none is taken out, the rest kept", () => {
    expect(withoutFreeTimeClaims("Full? Not at all, we have openings this week.")).toBe("It varies day to day.");
    expect(withoutFreeTimeClaims("We do stay busy. We have openings Thursday at 2 PM. Want me to check?")).toBe("We do stay busy. Want me to check?");
  });
});

describe("fillers", () => {
  const first = () => 0;
  test("fit what they said: sympathy for a worry, delight for an occasion, a thinking word for a question", () => {
    expect(fillerFor("Ugh, I'm so frustrated with my skin lately", "en", [], first)).toBe("Oh no,");
    expect(fillerFor("It's for my wedding in June", "en", [], first)).toBe("Oh, nice!");
    expect(fillerFor("How much is a HydraFacial?", "en", [], first)).toBe("So,");
    expect(fillerFor("I'd like to book Botox please", "en", [], first)).toBe("Sure,");
    expect(fillerFor("¿Cuánto cuesta el Botox?", "es", [], first)).toBe("A ver,");
  });

  test("none for a thank-you, a goodbye, a word or two, or a number", () => {
    for (const words of ["Thanks so much.", "Okay, bye now.", "Yes please", "Sam.", "It's 305 555 0199."]) expect(fillerFor(words, "en", [], first), words).toBeNull();
  });

  test("never the one said last, each at most twice a call, and 'Hmm' once", () => {
    expect(fillerFor("How much is a HydraFacial?", "en", ["So,"], first)).not.toBe("So,");
    const twice = Array.from({ length: FILLER_MAX_PER_CALL }, () => "So,");
    expect(fillerFor("How much is a HydraFacial?", "en", [...twice, "Okay,"], first)).not.toBe("So,");
    expect(fillerFor("What about Dysport then?", "en", ["Hmm,", "Okay,"], () => 0.99)).not.toBe("Hmm,");
  });
});
