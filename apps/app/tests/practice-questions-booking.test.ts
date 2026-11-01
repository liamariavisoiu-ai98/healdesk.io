import { describe, expect, test } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { depositLinkText } from "@/lib/billing/deposit-link";
import { slotLabel } from "@/lib/booking/calendar";
import {
  bookedLine,
  DEPOSIT_REQUEST_LINE,

  forChat,
  REQUEST_TAKEN_LINE, BOOKING_LINES_VOICE_EN } from "@/lib/booking/lines";
import {
  bookingExpectation,
  emptyLedger,
  NO_DIRECT_BOOKING,
  PRACTICE_CHECKOUT_URL,
  type PracticeBookingFacts,
} from "@/lib/engine/practice/booking";
import { casesNotAskable, PRACTICE_CASES_VERSION } from "@/lib/engine/practice/cases";
import { bookingCaseChecks } from "@/lib/engine/practice/checks";
import { runPracticeChannel, type PracticeRunDeps } from "@/lib/engine/practice/runner";
import { recordsAnUnaskedCase } from "@/lib/engine/practice/store";
import type { PracticeCaseResult } from "@/lib/engine/practice/types";
import type { FrontDoorFacts } from "@/lib/meta/front-door";

import { bookingAnswer, metaBookingAnswer } from "./setup/practice";

/**
 * The practice questions' booking and deposit cases (Gate B piece 1, 29
 * October 2026): asked of the real fixed tool layer over the practice
 * engine, which writes nothing, with the model a script (never Anthropic)
 * and the booking switch passed in as the run's own facts, never through the
 * environment. Pure: no database. tests/practice-questions-db.test.ts asks
 * them through the job against the test database.
 */

const DAY = [["08:00", "20:00"]] as [string, string][];
const FACTS: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-0000000000b1",
  clinicName: "Radiance Med Spa",
  providerNames: [],
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  vetReferralPhone: null,
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Every day: 08:00-20:00"],
  openingHours: { sun: DAY, mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY },
  services: [
    { name: "Botox", priceFromUsd: 12, priceToUsd: 12, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: 50 },
    { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, priceKind: "exact", unit: null, durationMinutes: 30, depositUsd: null },
  ],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: "Weekdays 9 to 5",
  neverSay: [],
  requirements: [],
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
};

const NOW = new Date("2026-10-13T15:00:00Z");
const KNOWLEDGE = { texts: {}, ownNeverSay: [] };

/** A clinic that books live, takes deposits through its connected account, and books calls without one (flagged for the desk). */
const LIVE: PracticeBookingFacts = {
  directOpen: true,
  modeReasons: [],
  deposits: {
    depositsEnabled: true,
    isConnected: true,
    bookVoiceWithoutDeposit: true,
    bookChatWithoutDeposit: false,
    uncollectable: "decline_and_alert",
    holdMinutes: 60,
    services: [
      { name: "Botox", depositUsd: 50 },
      { name: "Consultation", depositUsd: null },
    ],
    policy: null,
  },
};

/** A careful model for every case, the booking cases by bookingAnswer; `twist` changes one turn's answer. */
function model(twist?: (last: string, turn: string) => Record<string, unknown> | null): AssistantResponder & { turns: string[] } {
  const turns: string[] = [];
  const fn = (async ({ system, messages }) => {
    const last = messages[messages.length - 1]!.content;
    turns.push(system.turn);
    const out = twist?.(last, system.turn) ?? bookingAnswer(last, system.turn);
    if (out) return JSON.stringify(out);
    if (/How much is/.test(last)) return JSON.stringify({ reply: "Botox is $12 per unit." });
    if (/How much does/.test(last))
      return JSON.stringify({ reply: "We don't list a price for that one, but the team can go through it at a consultation." });
    return JSON.stringify({ reply: "I can't advise on that here, but the team can help. Would you like a consultation?" });
  }) as AssistantResponder & { turns: string[] };
  fn.turns = turns;
  return fn;
}

function deps(responder: AssistantResponder, over: Partial<PracticeRunDeps> = {}): PracticeRunDeps {
  return { responder, metaResponder: null, judge: async () => ({ verdict: "pass", reason: "Fine." }), now: NOW, ...over };
}

const byId = (cases: readonly PracticeCaseResult[], id: string) => cases.find((c) => c.id === id)!;
const failing = (kase: PracticeCaseResult) => kase.checks.filter((c) => !c.ok).map((c) => c.name);

describe("every case can be asked", () => {
  test("no case is marked not askable, and the cases' version moved with them", () => {
    expect(casesNotAskable()).toEqual([]);
    expect(PRACTICE_CASES_VERSION).toBe("2026-11-01.1");
  });

  test("a result recording a case the runtime could not ask is told apart: such a pass opens nothing", () => {
    const old: PracticeCaseResult = {
      id: "booking",
      status: "not_applicable",
      asked: [],
      answered: [],
      sources: [],
      checks: [],
      notApplicable: "runtime_has_no_tools",
    };
    expect(recordsAnUnaskedCase([old])).toBe(true);
    expect(recordsAnUnaskedCase([{ ...old, status: "not_applicable", notApplicable: "serves_english_only" }])).toBe(false);
    expect(recordsAnUnaskedCase([])).toBe(false);
  });
});

describe("what the clinic's settings say a booking must come to", () => {
  test("per channel: the website chat links the deposit, a call says it, Meta takes a request and links on staff confirmation", () => {
    expect(bookingExpectation(LIVE, "web", "Consultation")).toMatchObject({ kind: "booked", collect: "none" });
    expect(bookingExpectation(LIVE, "web", "Botox")).toMatchObject({ kind: "booked", collect: "link" });
    expect(bookingExpectation(LIVE, "voice", "Botox")).toMatchObject({ kind: "booked", collect: "spoken" });
    expect(bookingExpectation(LIVE, "meta", "Botox")).toMatchObject({ kind: "meta_request", onConfirm: "link" });
    // The switch off: a request, on every channel.
    expect(bookingExpectation({ ...LIVE, directOpen: false }, "web", "Botox")).toMatchObject({ kind: "request", why: "tools_off" });
    // Auto-confirm off: times offered, the chosen one taken as a request.
    expect(bookingExpectation({ ...LIVE, modeReasons: ["auto_confirm_off"] }, "voice", "Consultation")).toMatchObject({
      kind: "request",
      why: "manual",
    });
    // "Book by phone without a deposit" off: the call passes the request to the team.
    const noVoiceDeposit = { ...LIVE, deposits: { ...LIVE.deposits, bookVoiceWithoutDeposit: false } };
    expect(bookingExpectation(noVoiceDeposit, "voice", "Botox")).toMatchObject({ kind: "request", why: "deposit_required" });
    // "Book by chat without a deposit" on: the chat books and leaves it to the desk.
    const chatWithout = { ...LIVE, deposits: { ...LIVE.deposits, bookChatWithoutDeposit: true } };
    expect(bookingExpectation(chatWithout, "web", "Botox")).toMatchObject({ kind: "booked", collect: "front_desk" });
  });
});

describe("the website chat, with the tools live for this run only", () => {
  test("the straightforward booking: real times offered, the one chosen held, written once (the retry writes nothing), and the tool layer's own line", async () => {
    const outcome = await runPracticeChannel({ channel: "web", facts: FACTS, booking: LIVE }, KNOWLEDGE, deps(model()));
    const booking = byId(outcome.cases, "booking");
    expect(failing(booking)).toEqual([]);
    expect(booking.status).toBe("passed");
    expect(booking.sources).toEqual(["tool", "tool", "tool", "model"]);
    // The offer is the engine's, and the third answer is the booked line for the first time offered.
    expect(booking.answered[0]).toMatch(/^I have .+\. Which would suit you\?$/);
    const at = new Date(NOW.getTime() + 24 * 3_600_000 + 13 * 3_600_000).toISOString();
    expect(booking.answered[2]).toBe(forChat(bookedLine(slotLabel(new Date(at), FACTS.timeZone), "Consultation")));
    expect(booking.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "times_offered_by_the_engine",
        "one_booking_written",
        "booked_an_offered_time",
        "held_before_it_was_written",
        "nothing_confirmed_before_the_write",
        "confirmed_in_the_tool_layer_words",
        "a_retry_writes_nothing_more",
        "no_card_number_asked_for",
      ]),
    );
    expect(outcome.status).toBe("passed");
  });

  test("the deposit booking: the booking, then the clinic's payment link in its fixed words, and no service in any payment field", async () => {
    const outcome = await runPracticeChannel({ channel: "web", facts: FACTS, booking: LIVE }, KNOWLEDGE, deps(model()));
    const deposit = byId(outcome.cases, "deposit_booking");
    expect(failing(deposit)).toEqual([]);
    expect(deposit.answered[2]!.endsWith(depositLinkText(PRACTICE_CHECKOUT_URL))).toBe(true);
    expect(deposit.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["sends_the_clinic_payment_link", "link_amount_is_the_deposit", "payment_fields_name_no_service"]),
    );
  });

  test("a model that skips the tools fails: it books nothing, so nothing the case asks of the booking holds", async () => {
    const lazy = model((last) =>
      /^I'd like to book/.test(last) ? { reply: "Sure, the clinic will call you.", booking: { wants: true } } : null,
    );
    const outcome = await runPracticeChannel({ channel: "web", facts: FACTS, booking: LIVE }, KNOWLEDGE, deps(lazy));
    const booking = byId(outcome.cases, "booking");
    expect(booking.status).toBe("failed");
    expect(failing(booking)).toEqual(expect.arrayContaining(["times_offered_by_the_engine", "one_booking_written"]));
    expect(booking.attribution).toEqual({ kind: "engine" });
  });

  test("a model that asks for a card number is never heard: the guard's line goes instead; a reply that carries the ask fails the check", async () => {
    const cardy = model((last, turn) =>
      last.startsWith("My first name")
        ? { reply: "Thanks Sam. What's your card number for the deposit?", booking: { first_name: "Sam", phone: "415 555 0100" } }
        : bookingAnswer(last, turn),
    );
    const outcome = await runPracticeChannel({ channel: "web", facts: FACTS, booking: { ...LIVE, directOpen: false } }, KNOWLEDGE, deps(cardy));
    const kase = byId(outcome.cases, "booking");
    expect(kase.sources[2]).toBe("guard");
    expect(kase.answered[2]).not.toMatch(/card number/);
    // The check itself, on a reply that did carry the ask.
    const checks = bookingCaseChecks({
      channel: "web",
      expectation: bookingExpectation({ ...LIVE, directOpen: false }, "web", "Consultation"),
      turns: [{ reply: "What's your card number?", source: "model", urgent: false, bookingWritten: false }],
      ledger: emptyLedger(),
      gathered: { firstName: "Sam", phone: "4155550100", window: "Tuesday" },
      serviceNames: ["Botox"],
      bookedLineFor: () => "",
    });
    expect(checks.find((c) => c.name === "no_card_number_asked_for")).toMatchObject({ ok: false });
  });

  test("the switch off for the run: the tools are never offered, the request is taken in words, and nothing is written", async () => {
    const m = model();
    const outcome = await runPracticeChannel({ channel: "web", facts: FACTS, booking: { ...LIVE, directOpen: false } }, KNOWLEDGE, deps(m));
    const booking = byId(outcome.cases, "booking");
    expect(failing(booking)).toEqual([]);
    expect(booking.sources.every((s) => s === "model")).toBe(true);
    expect(m.turns.some((t) => t.includes("Live booking is available"))).toBe(false);
  });

  test("Auto-confirm off: times offered, the chosen one passed to the clinic as one request", async () => {
    const outcome = await runPracticeChannel(
      { channel: "web", facts: FACTS, booking: { ...LIVE, modeReasons: ["auto_confirm_off"] } },
      KNOWLEDGE,
      deps(model()),
    );
    const booking = byId(outcome.cases, "booking");
    expect(failing(booking)).toEqual([]);
    expect(booking.answered).toContain(forChat(REQUEST_TAKEN_LINE));
  });
});

describe("a call, with the tools live for this run only", () => {
  test("the deposit booking: held as soon as it is chosen, written once, and the deposit the desk will take said; never a link", async () => {
    const outcome = await runPracticeChannel({ channel: "voice", facts: FACTS, booking: LIVE }, KNOWLEDGE, deps(model()));
    const deposit = byId(outcome.cases, "deposit_booking");
    expect(failing(deposit)).toEqual([]);
    // The call's own lines (BOOKING_LINES_VOICE_EN), after the moment a person takes to hold it (pauses.ts).
    expect(deposit.answered[1]).toMatch(/I'm holding .+ for you\./);
    // The number given is read back first (answered[2]); the booking and its deposit follow the caller's yes.
    expect(deposit.answered[2]).toMatch(/, right\?$/);
    expect(deposit.answered[3]).toContain(BOOKING_LINES_VOICE_EN.deposit({ action: "book_and_flag", amountUsd: 50, scope: "booking" }));
    expect(deposit.answered.join(" ")).not.toMatch(/https?:/);
    expect(byId(outcome.cases, "booking").status).toBe("passed");
  });

  test("'Book by phone without a deposit' off: the call says the team will arrange it, holds and writes nothing, and takes the request", async () => {
    const outcome = await runPracticeChannel(
      { channel: "voice", facts: FACTS, booking: { ...LIVE, deposits: { ...LIVE.deposits, bookVoiceWithoutDeposit: false } } },
      KNOWLEDGE,
      deps(model()),
    );
    const deposit = byId(outcome.cases, "deposit_booking");
    expect(failing(deposit)).toEqual([]);
    expect(deposit.answered[0]).toMatch(new RegExp(`${DEPOSIT_REQUEST_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });
});

describe("Instagram, Messenger and WhatsApp: a request for staff", () => {
  const META: FrontDoorFacts = {
    clinicName: "Radiance Med Spa",
    phone: "+14155550199",
    urgentPhone: "+14155550123",
    specialty: "med-spa",
    vetReferralPhone: null,
    openingHours: FACTS.openingHours,
    timeZone: "America/New_York",
    websiteHint: null,
    services: [{ name: "Botox", priceFromUsd: 12, priceToUsd: 12 }],
    serviceNames: ["Botox", "Consultation"],
    notes: null,
    escalationHours: null,
    requirements: [],
    deferredRequirements: [],
    address: "1 Main St",
    publishedTimes: [],
    neverSay: [],
  };

  test("the request completed in the fixed line, nothing written, no service or amount; the confirmed link line names nothing", async () => {
    const outcome = await runPracticeChannel(
      { channel: "meta", facts: META, languages: ["en"], booking: LIVE },
      KNOWLEDGE,
      deps(model(), {
        metaResponder: async (_system, text) => metaBookingAnswer(text) ?? JSON.stringify({ reply: "A person at the practice can tell you if you call." }),
      }),
    );
    for (const id of ["booking", "deposit_booking"]) {
      const kase = byId(outcome.cases, id);
      expect(failing(kase), id).toEqual([]);
      expect(kase.sources[1], id).toBe("booking");
    }
    expect(byId(outcome.cases, "deposit_booking").checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["the_confirmed_link_line_names_nothing", "payment_fields_name_no_service"]),
    );
  });
});

test("without booking facts a channel is read as booking by request with no deposits", () => {
  expect(NO_DIRECT_BOOKING.directOpen).toBe(false);
  expect(bookingExpectation(NO_DIRECT_BOOKING, "web", "Botox")).toMatchObject({ kind: "request", why: "tools_off" });
});
