import { describe, expect, test } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { amountsIn, cardNumberIn, guardAssistantReply } from "@/lib/assistant/guard";
import { buildAssistantPrompt, priceText } from "@/lib/assistant/prompt";
import { answerTurn, EMPTY_CAPTURE, FAILURE_LINE, mergeCapture, messagesFor, parseModelAnswer, type AssistantResponder } from "@/lib/assistant/turn";

/**
 * The brain calls and web chats share (lib/assistant): the urgent screen
 * before the model, the guard after it, card numbers cut, and the model's
 * answer read without trusting it. No database, no network.
 */

const FACTS: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-000000000001",
  clinicName: "Radiance Med Spa",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Monday: 09:00-17:00"],
  services: [
    { name: "Botox", priceFromUsd: 12, priceToUsd: 12, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: 50 },
    { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, priceKind: "exact", unit: null, durationMinutes: 30, depositUsd: null },
    { name: "Lip filler", priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null, durationMinutes: 45, depositUsd: null },
  ],
  policies: ["24 hours' notice to cancel."],
  quickAnswers: [{ question: "Parking?", answer: "Free parking behind the building." }],
  promotions: null,
  notes: null,
  escalationHours: "Weekdays 9 to 5",
  neverSay: ["guaranteed results", "painless", "Dr. Smith is the best"],
  requirements: [],
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
};

const reply = (text: string, extra: object = {}): AssistantResponder => async () => JSON.stringify({ reply: text, ...extra });

describe("the guard", () => {
  test("only configured prices and deposits may be named", () => {
    expect(guardAssistantReply("A consultation is $150.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("Botox is $12 a unit with a $50 deposit.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("Lip filler is $650.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(guardAssistantReply("About 600 dollars.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(guardAssistantReply("It's $1.5k.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(amountsIn("$1,200.50 and 99 dollars")).toEqual([120050, 9900]);
  });

  test("the never-say list, whatever the case, quotes or dashes", () => {
    expect(guardAssistantReply("You'll get Guaranteed   Results!", FACTS)).toEqual({ ok: false, reason: "never_say" });
    expect(guardAssistantReply("It's practically painless.", FACTS)).toEqual({ ok: false, reason: "never_say" });
    expect(guardAssistantReply("Dr. Smith is the best", FACTS)).toEqual({ ok: false, reason: "never_say" });
  });

  test("never asks for card details, never claims HIPAA compliance", () => {
    expect(guardAssistantReply("Could you read me your card number?", FACTS)).toEqual({ ok: false, reason: "payment_details" });
    expect(guardAssistantReply("We're fully HIPAA-compliant.", FACTS)).toEqual({ ok: false, reason: "hipaa_claim" });
    expect(guardAssistantReply("The practice takes payment at the visit.", FACTS)).toEqual({ ok: true });
  });

  test("a card number is cut; a phone number is not", () => {
    expect(cardNumberIn("card 4242-4242-4242-4242 thanks")).toEqual({ text: "card [card number removed] thanks", found: true });
    expect(cardNumberIn("call me on 415 555 0192")).toEqual({ text: "call me on 415 555 0192", found: false });
  });
});

describe("the prompt", () => {
  test("states the menu's prices as written and the never-say list, and nothing to edit", () => {
    const prompt = buildAssistantPrompt(FACTS, "web_chat", new Date("2026-10-13T16:00:00Z"));
    expect(prompt).toContain("Botox: $12 per unit");
    expect(prompt).toContain("Lip filler: no price is quoted: offer a consultation");
    expect(prompt).toContain("- painless");
    expect(prompt).toContain("you do not book appointments yourself");
    expect(prompt).toContain("(415) 555-0199");
    expect(buildAssistantPrompt(FACTS, "voice", new Date()).toLowerCase()).toContain("this is a phone call");
    expect(priceText({ name: "x", priceFromUsd: 100, priceToUsd: null, priceKind: "from", unit: null, durationMinutes: null, depositUsd: null })).toBe("from $100");
  });
});

describe("answerTurn", () => {
  test("urgent content gets 911 and the urgent number, and the model is never asked", async () => {
    let asked = false;
    const result = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "I think I'm having an allergic reaction to the filler",
      responder: async () => {
        asked = true;
        return "{}";
      },
    });
    expect(asked).toBe(false);
    expect(result).toMatchObject({ source: "urgent", urgent: true });
    expect(result.reply).toMatch(/call 911/);
    expect(result.reply).toContain("four one five"); // spoken digits on a call
  });

  test("a refused reply becomes a fixed line, and the capture still counts", async () => {
    const result = await answerTurn({
      facts: FACTS,
      channel: "web_chat",
      history: [],
      text: "How much is filler?",
      responder: reply("It's $650 and guaranteed results.", { booking: { wants: true, first_name: "Dana" } }),
    });
    expect(result.source).toBe("guard");
    expect(result.reply).not.toContain("$650");
    expect(result.capture.firstName).toBe("Dana");
  });

  test("no model, or a model that throws, gives the failure line", async () => {
    expect((await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "hi", responder: null })).reply).toBe(FAILURE_LINE);
    const throwing: AssistantResponder = async () => {
      throw new Error("timeout");
    };
    expect((await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "hi", responder: throwing })).source).toBe("fallback");
  });

  test("the model's answer is read leniently and cleaned", () => {
    expect(parseModelAnswer('Sure! {"reply": "Hi\\u0007 there", "end": true}')).toMatchObject({ reply: "Hi there", end: true });
    expect(parseModelAnswer("just text")).toMatchObject({ reply: "just text", handoff: false });
    const answer = parseModelAnswer(JSON.stringify({ reply: "ok", booking: { wants: true, fields: { last_name: "Okonkwo", "bad key!": "x" } } }));
    expect(answer.booking.fields).toEqual({ last_name: "Okonkwo" });
  });

  test("captures merge, and an empty value never erases one", () => {
    const first = mergeCapture(EMPTY_CAPTURE, { wants: true, firstName: "Dana", window: "Thursday" });
    const second = mergeCapture(first, { firstName: null, phone: "415 555 0192" });
    expect(second).toMatchObject({ wants: true, firstName: "Dana", window: "Thursday", phone: "415 555 0192" });
  });

  test("the model sees alternating turns, starting with the person", () => {
    const messages = messagesFor(
      [
        { speaker: "assistant", text: "Hi, I'm an AI assistant." },
        { speaker: "person", text: "a" },
        { speaker: "person", text: "b" },
        { speaker: "assistant", text: "c" },
      ],
      "d",
    );
    expect(messages).toEqual([
      { role: "user", content: "a\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
  });
});
