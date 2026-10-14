import { URGENT_LEAVE_NUMBER_LINE, URGENT_TEAM_TOLD_LINE } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { amountsIn, cardNumberIn, guardAssistantReply, guardedLine } from "@/lib/assistant/guard";
import { assistantTurnContext, buildAssistantPrompt, priceText } from "@/lib/assistant/prompt";
import { MODEL_CONFIG, modelRequest, readModelResponse } from "@/lib/assistant/responder";
import {
  answerTurn,
  EMPTY_CAPTURE,
  FAILURE_LINE,
  mergeCapture,
  messagesFor,
  parseModelAnswer,
  refusalLine,
  type AssistantResponder,
} from "@/lib/assistant/turn";
import { URGENT_ALERT_DELIVERED } from "@/lib/notices/booking-alerts";
import { spokenPhone } from "@/lib/voice/spoken";

/**
 * The brain calls and web chats share (lib/assistant): the urgent screen
 * before the model, the guard after it, card numbers cut, and the model's
 * answer read without trusting it. No database, no network.
 */

const WEEKDAYS = [["09:00", "17:00"]] as [string, string][];
const FACTS: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-000000000001",
  clinicName: "Radiance Med Spa",
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  vetReferralPhone: null,
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Monday: 09:00-17:00"],
  openingHours: { sun: [], mon: WEEKDAYS, tue: WEEKDAYS, wed: WEEKDAYS, thu: WEEKDAYS, fri: WEEKDAYS, sat: [] },
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
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
};

/** A veterinary practice: its urgent set is an animal's, and its urgent line gives the emergency vet. */
const VET: AssistantFacts = {
  ...FACTS,
  clinicName: "Paws Animal Clinic",
  specialty: "veterinary",
  vetReferralPhone: "+14155550911",
  services: [{ name: "Senior diagnostics", priceFromUsd: 180, priceToUsd: 180, priceKind: "exact", unit: null, durationMinutes: 45, depositUsd: null }],
};

/** A Tuesday at 11:00 and a Sunday at 11:00 in New York. */
const OPEN = new Date("2026-10-13T15:00:00Z");
const CLOSED = new Date("2026-10-11T15:00:00Z");

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

  test("a clinical reply is refused after the model, and becomes the offer of a consultation", () => {
    for (const text of [
      "It's completely fine and very safe during pregnancy.",
      "Most people have little downtime and the side effects are mild.",
      "You'd need about 20 units for your forehead.",
      "You sound like a good candidate for it.",
      "That's a common symptom, nothing to worry about.",
      "Stop taking blood thinners a week before.",
    ]) {
      expect(guardAssistantReply(text, FACTS), text).toEqual({ ok: false, reason: "clinical" });
    }
    expect(guardedLine("clinical", FACTS.clinicName)).toMatch(/consultation/);
    expect(guardedLine("clinical", FACTS.clinicName)).toContain(FACTS.clinicName);
  });

  test("the clinical screen is the default one: no everyday condition, a price by the unit, the clinic's own service names", () => {
    // The Meta channels count everyday skin conditions; a call and a web chat do not.
    expect(guardAssistantReply("Yes, the practice treats acne and rosacea. Would you like a consultation?", FACTS)).toEqual({ ok: true });
    // A price by the unit, however it is said, is a price and not a dose.
    expect(guardAssistantReply("Botox is $12 per unit.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("It's 12 dollars each unit.", FACTS)).toEqual({ ok: true });
    // A veterinary menu's own names were screened for its specialty when saved.
    expect(guardAssistantReply("Senior diagnostics is $180 and takes about 45 minutes.", VET)).toEqual({ ok: true });
    expect(guardAssistantReply("His symptoms sound like a diagnosis for the vet.", VET)).toEqual({ ok: false, reason: "clinical" });
  });

  test("a card number is cut; a phone number is not", () => {
    expect(cardNumberIn("card 4242-4242-4242-4242 thanks")).toEqual({ text: "card [card number removed] thanks", found: true });
    expect(cardNumberIn("call me on 415 555 0192")).toEqual({ text: "call me on 415 555 0192", found: false });
  });
});

describe("the prompt", () => {
  test("states the menu's prices as written and the never-say list, and nothing to edit", () => {
    const prompt = buildAssistantPrompt(FACTS, "web_chat");
    expect(prompt).toContain("Botox: $12 per unit");
    expect(prompt).toContain("Lip filler: no price is quoted: offer a consultation");
    expect(prompt).toContain("- painless");
    expect(prompt).toContain("you do not book appointments yourself");
    expect(prompt).toContain("(415) 555-0199");
    expect(buildAssistantPrompt(FACTS, "voice").toLowerCase()).toContain("this is a phone call");
    expect(priceText({ name: "x", priceFromUsd: 100, priceToUsd: null, priceKind: "from", unit: null, durationMinutes: null, depositUsd: null })).toBe("from $100");
  });

  test("the stable prefix carries no clock: the same bytes at any minute, so the prompt cache can hold it", () => {
    const morning = buildAssistantPrompt(FACTS, "web_chat");
    expect(buildAssistantPrompt(FACTS, "web_chat")).toBe(morning);
    expect(morning).not.toMatch(/Now it is/);
    expect(morning).not.toMatch(/October|Tuesday|\d{1,2}:\d{2} (AM|PM)/);
    // The time, and how the conversation opened, come after it, per turn.
    const turn = assistantTurnContext(FACTS, OPEN, "Hi, I'm an AI assistant.");
    expect(turn).toBe(`Now it is Tuesday, October 13 at 11:00 AM in the practice's time zone.\nYou opened the conversation with: "Hi, I'm an AI assistant."`);
    expect(assistantTurnContext(FACTS, CLOSED)).not.toBe(assistantTurnContext(FACTS, OPEN));
  });

  test("the clinic's tone changes how it speaks", () => {
    expect(buildAssistantPrompt(FACTS, "voice")).toMatch(/Be warm, welcoming and unhurried/);
    const clinical = buildAssistantPrompt({ ...FACTS, tone: "clinical" }, "voice");
    expect(clinical).toMatch(/Be calm, brief and precise/);
    expect(clinical).not.toMatch(/Be warm/);
  });

  test("its languages: the caller's, if it is one of them, and it stays in it", () => {
    expect(buildAssistantPrompt(FACTS, "web_chat")).toMatch(/Language: answer in English\./);
    const several = buildAssistantPrompt({ ...FACTS, languages: ["en", "es", "vi"] }, "web_chat");
    expect(several).toContain("Languages: you answer in English, Spanish and Vietnamese.");
    expect(several).toMatch(/stay in it/);
  });

  test("Suggest add-on treatments: off keeps it to what was asked, on allows one", () => {
    expect(buildAssistantPrompt(FACTS, "voice")).toMatch(/Do not suggest other services or products/);
    const on = buildAssistantPrompt({ ...FACTS, suggestAddOns: true }, "voice");
    expect(on).toMatch(/you may suggest one complementary service/);
    expect(on).not.toMatch(/Do not suggest other services/);
  });

  test("Mention promotions: the box is said only while it is on (facts.ts leaves it out when off)", () => {
    const on = buildAssistantPrompt({ ...FACTS, promotions: "20% off peels in October" }, "web_chat");
    expect(on).toContain("Current offer you may mention: 20% off peels in October");
    const off = buildAssistantPrompt({ ...FACTS, promotions: null }, "web_chat");
    expect(off).not.toContain("20% off");
    expect(off).toMatch(/Do not mention discounts, deals or promotions/);
  });
});

describe("the model request", () => {
  const system = { stable: buildAssistantPrompt(FACTS, "web_chat"), turn: assistantTurnContext(FACTS, OPEN) };

  test("the cache breakpoint sits on the stable prefix, and the turn's own context follows it uncached", () => {
    const request = modelRequest({ channel: "web_chat", system, messages: [{ role: "user", content: "hi" }] });
    expect(request.system).toEqual([
      { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: system.turn },
    ]);
    // An empty turn context adds no block of its own.
    expect(modelRequest({ channel: "meta", system: { stable: "x", turn: "" }, messages: [] }).system).toEqual([
      { type: "text", text: "x", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("each channel keeps its own settings, on one client", () => {
    const at = (channel: "web_chat" | "voice" | "meta") => modelRequest({ channel, system, messages: [{ role: "user", content: "x".repeat(5_000) }] });
    expect(at("web_chat")).toMatchObject({ model: "claude-opus-5-5", max_tokens: 800, output_config: { effort: "low" } });
    expect(at("web_chat")).not.toHaveProperty("thinking");
    expect(at("voice")).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 400, output_config: { effort: "low" } });
    // The Meta front door moved onto this client from its own, on claude-opus-5.
    expect(at("meta")).toMatchObject({ model: "claude-opus-5-5", max_tokens: 800, thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(at("meta").messages[0]!.content).toHaveLength(2_000);
    expect(at("voice").messages[0]!.content).toHaveLength(4_000);
    expect(MODEL_CONFIG.voice).toMatchObject({ timeoutMs: 8_000, maxRetries: 0 });
    expect(MODEL_CONFIG.web_chat).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 });
  });

  test("a refusal is read as its own outcome, never as empty text", () => {
    const base = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, usage: {} } as const;
    const refused = readModelResponse("web_chat", { ...base, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: null } } as never);
    expect(refused).toEqual({ refused: true, category: "bio" });
    const answered = readModelResponse("web_chat", { ...base, content: [{ type: "text", text: " Hello ", citations: null }], stop_reason: "end_turn", stop_details: null } as never);
    expect(answered).toBe("Hello");
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
    expect(result.reply).toMatch(/^I'm an AI assistant/);
    expect(result.reply).toMatch(/hang up and call 911 now/);
    expect(result.reply).toContain("four one five"); // spoken digits on a call
    expect(result.reply).not.toContain(URGENT_LEAVE_NUMBER_LINE);
  });

  test("on the website chat the urgent line gives the number written out and asks for one to call back", async () => {
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "my lips are swelling", responder: null });
    expect(result.reply).toContain("If this is an emergency, call 911 now.");
    expect(result.reply).toContain("Otherwise, please call Radiance Med Spa on (415) 555-0123.");
    expect(result.reply).toContain(URGENT_LEAVE_NUMBER_LINE);
  });

  test("the urgent line says the team was told only once the urgent alert reaches it", async () => {
    // notifyBookingAlert only logs until package F sends L12 through the outbox.
    expect(URGENT_ALERT_DELIVERED).toBe(false);
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "it won't stop bleeding", responder: null });
    expect(result.reply).not.toContain(URGENT_TEAM_TOLD_LINE);
  });

  test("a veterinary practice: an animal's emergency gets the emergency vet, never 911, and its own number only while open", async () => {
    let asked = false;
    const responder: AssistantResponder = async () => {
      asked = true;
      return "{}";
    };
    const open = await answerTurn({ facts: VET, channel: "web_chat", history: [], text: "my cat can't pee and keeps straining", responder, now: OPEN });
    expect(asked).toBe(false);
    expect(open).toMatchObject({ source: "urgent", urgent: true });
    expect(open.reply).toContain("call the emergency vet now on (415) 555-0911");
    expect(open.reply).toContain("Otherwise, please call Paws Animal Clinic on (415) 555-0123.");
    expect(open.reply).not.toMatch(/\b911\b/);
    const closed = await answerTurn({ facts: VET, channel: "voice", history: [], text: "my dog ate a whole bar of chocolate", responder, now: CLOSED });
    expect(closed.reply).toMatch(/hang up and call the emergency vet on/);
    expect(closed.reply).not.toContain("Otherwise, please call");
    // The same words at a med spa are not urgent: the set is the practice's own.
    const medSpa = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "my cat can't pee and keeps straining", responder: reply("Please call the practice."), now: OPEN });
    expect(medSpa.source).toBe("model");
  });

  test("a model that declines is its own outcome: a fixed, honest line and the clinic's number, never the guard's", async () => {
    const refusing: AssistantResponder = async () => ({ refused: true, category: "bio" });
    const chat = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "hi", responder: refusing });
    expect(chat).toMatchObject({ source: "refusal", urgent: false, handoff: false });
    expect(chat.guard).toBeUndefined();
    expect(chat.reply).toBe(refusalLine(FACTS, "web_chat"));
    expect(chat.reply).toBe("Sorry, that's not something I can help with. The team at Radiance Med Spa can: please call them on (415) 555-0199.");
    expect(chat.reply).not.toBe(FAILURE_LINE);
    expect(refusalLine({ ...FACTS, phone: null, urgentPhone: null }, "web_chat")).toBe(
      "Sorry, that's not something I can help with. The team at Radiance Med Spa can help, and they get back to people within a day.",
    );
    // On a call, which came in on the main number, the number that reaches a person.
    const call = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "hi", responder: refusing });
    expect(call.source).toBe("refusal");
    expect(call.reply).toContain(spokenPhone("+14155550123"));
    expect(call.reply).not.toContain(spokenPhone("+14155550199"));
  });

  test("a clinical reply from the model is replaced by the consultation offer", async () => {
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "Is filler OK while pregnant?", responder: reply("Yes, it's safe during pregnancy.") });
    expect(result).toMatchObject({ source: "guard", guard: "clinical" });
    expect(result.reply).toBe(guardedLine("clinical", FACTS.clinicName));
  });

  test("the model is sent the stable prefix and the turn's own context apart", async () => {
    const seen: Parameters<AssistantResponder>[0][] = [];
    await answerTurn({
      facts: FACTS,
      channel: "web_chat",
      history: [{ speaker: "assistant", text: "Hi, I'm an AI assistant." }],
      text: "When are you open?",
      responder: async (request) => {
        seen.push(request);
        return JSON.stringify({ reply: "Weekdays 9 to 5." });
      },
      now: OPEN,
    });
    expect(seen[0]!.system.stable).toBe(buildAssistantPrompt(FACTS, "web_chat"));
    expect(seen[0]!.system.turn).toBe(assistantTurnContext(FACTS, OPEN, "Hi, I'm an AI assistant."));
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
