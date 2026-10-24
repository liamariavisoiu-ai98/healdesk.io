import { describe, expect, test, vi } from "vitest";

// The empty-menu alert and the ops lane are not what these tests are about.
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
// No database: the start reads the facts handed back here.
const tenant = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    if (tenant.result !== undefined) return tenant.result;
    throw new Error("connect ECONNREFUSED");
  },
}));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import type { AssistantFacts } from "@/lib/assistant/facts";
import { parseModelAnswer, type AssistantResponder } from "@/lib/assistant/turn";
import { voiceKeywords } from "@/lib/voice/provision";
import { ACKNOWLEDGEMENTS, interruptedAt, RETRY_LINE, RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * How a call sounds while the model thinks, and around it (owner's brief,
 * 24 October 2026, after a test call that was slow, misheard "nails" three
 * times and ended on "I'm having trouble on my end"):
 *
 *   - a short fixed acknowledgement is sent as the first part of a response
 *     the moment the caller's words go to the model, and the reply is
 *     appended to it, as Retell's protocol appends the parts of a response;
 *   - never before an urgent reply, an owed opening line, or a lone word,
 *     and never in another language than the caller's;
 *   - the opening line is sent uninterruptible, so its disclosure is heard;
 *   - an interruption reaches the model as what the caller heard;
 *   - the first failure in a row is a person's reset, not an error message;
 *   - the clinic's own words are boosted for the transcriber.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-0000000ac0c1";
const FACTS: AssistantFacts = {
  clinicId: CLINIC,
  clinicName: "Lumen Aesthetics",
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+15125550100",
  urgentPhone: null,
  vetReferralPhone: null,
  directLine: null,
  address: null,
  hours: [],
  openingHours: null,
  services: [{ name: "Nails", priceFromUsd: 40, priceToUsd: 40, priceKind: "exact", unit: null, durationMinutes: 45, depositUsd: null }],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: [],
  requirements: [],
  greeting: { phone: "Are you looking to book, or do you have a question?", chat: "How can I help?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};

type Response = Extract<RetellOutbound, { response_type: "response" }>;
const said = (id: number, transcript: { role: string; content: string }[]) =>
  JSON.stringify({ interaction_type: "response_required", response_id: id, transcript });

function session(responder: AssistantResponder | null, facts: AssistantFacts = FACTS) {
  tenant.result = facts;
  const sent: RetellOutbound[] = [];
  const seen: { turn: string }[] = [];
  const recorded: { turns?: readonly { speaker: string; text: string }[] } = {};
  const wrapped: AssistantResponder | null = responder
    ? async (prompt) => {
        seen.push({ turn: prompt.system.turn });
        return responder(prompt);
      }
    : null;
  const s = new RetellCallSession(CLINIC, "call_ack", (m) => sent.push(m), {
    responder: wrapped,
    gate: async () => ({ decision: "answer" }) as never,
    ingest: async (event) => {
      recorded.turns = event.transcriptTurns;
      return { conversationId: "c", duplicate: false } as never;
    },
    realCalls: true,
    tools: () => null,
    redial: async () => null,
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  return { s, raw, heard: () => spokenResponses(raw()), seen, recorded };
}

const reply = (text: string) => async () => JSON.stringify({ reply: text, handoff: false, end: false });

describe("the acknowledgement while the model thinks", () => {
  test("is sent first, unfinished, and the reply is appended to the same response", async () => {
    const { s, raw, heard, seen, recorded } = session(reply("Lovely, which day suits you?"));
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "I'd like to book my nails please" }]));
    const parts = raw().filter((r) => r.response_id === 1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ content: ACKNOWLEDGEMENTS.en[0], content_complete: false, end_call: false });
    expect(parts[1]).toMatchObject({ content: " Lovely, which day suits you?", content_complete: true });
    expect(heard()[1]!.content).toBe(`${ACKNOWLEDGEMENTS.en[0]} Lovely, which day suits you?`);
    // The model was told, so it does not open with another.
    expect(seen[0]!.turn).toContain(`You have already said "${ACKNOWLEDGEMENTS.en[0]}" out loud`);
    await s.finish();
    // The clinic's transcript keeps what the caller heard.
    expect(recorded.turns?.find((t) => t.text.startsWith(ACKNOWLEDGEMENTS.en[0]!))?.text).toBe(`${ACKNOWLEDGEMENTS.en[0]} Lovely, which day suits you?`);
  });

  test("is never the same twice in a row", async () => {
    const { s, raw, heard } = session(reply("Sure thing."));
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "what time do you open tomorrow" }]));
    await s.handle(said(2, [{ role: "agent", content: heard()[1]!.content }, { role: "user", content: "and is there parking nearby" }]));
    const acks = raw().filter((r) => r.content_complete === false).map((r) => r.content);
    expect(acks).toHaveLength(2);
    expect(acks[0]).not.toBe(acks[1]);
    await s.finish();
  });

  test("is not said before an urgent reply, which goes before the model", async () => {
    const { s, raw } = session(reply("never asked"));
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "my lip went white after the filler" }]));
    expect(raw().filter((r) => r.content_complete === false)).toEqual([]);
    expect(raw()[1]!.content).toMatch(/^I'm an AI assistant/);
    await s.finish();
  });

  test("is not said for a word or two, nor before an opening line the caller never heard", async () => {
    const { s, raw } = session(reply("Thanks, John."));
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "John." }]));
    expect(raw().filter((r) => r.content_complete === false)).toEqual([]);
    await s.finish();

    // Retell dropped the opening line (the caller spoke first): it is owed, and nothing goes ahead of it.
    const owed = session(reply("Of course."));
    await owed.s.open();
    await owed.s.handle(said(1, [{ role: "user", content: "hi I would like to book an appointment" }]));
    expect(owed.raw().filter((r) => r.content_complete === false)).toEqual([]);
    expect(owed.raw()[1]!.content).toMatch(/^Hi, this is the AI assistant at Lumen Aesthetics\./);
    await owed.s.finish();
  });

  test("is never English for a caller speaking Spanish", async () => {
    const { s, raw } = session(reply("Sorry, I can only help in English."));
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "hola quiero hacer una cita para mañana por favor" }]));
    expect(raw().filter((r) => r.content_complete === false)).toEqual([]);
    await s.finish();
  });
});

describe("around the reply", () => {
  test("the opening line is sent uninterruptible, so its disclosure is heard; replies are not", async () => {
    const { s, raw } = session(reply("Sure."));
    await s.open();
    expect(raw()[0]).toMatchObject({ response_id: 0, no_interruption_allowed: true });
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "what time do you open" }]));
    expect(raw().slice(1).some((r) => "no_interruption_allowed" in r)).toBe(false);
    await s.finish();
  });

  test("an interruption reaches the model as what the caller heard", async () => {
    const turns = [{ speaker: "assistant" as const, text: "Thanks, John. What day works for you, and is there another time or two that could also work?" }];
    expect(interruptedAt([{ role: "agent", content: "Thanks, John. What day works" }, { role: "user", content: "what other services" }], turns)).toBe("Thanks, John. What day works");
    // The whole reply heard, or only a word or two missing: not an interruption.
    expect(interruptedAt([{ role: "agent", content: turns[0]!.text }], turns)).toBeNull();
    expect(interruptedAt([{ role: "agent", content: "Thanks, John. What day works for you, and is there another time or two that could" }], turns)).toBeNull();
    // Words that are not how the reply began: not ours to read.
    expect(interruptedAt([{ role: "agent", content: "Something else entirely" }], turns)).toBeNull();
    expect(interruptedAt(undefined, turns)).toBeNull();
  });

  test("the first failure in a row asks again like a person, never with an error message", async () => {
    const { s, raw, heard } = session(async () => {
      throw new Error("upstream 529");
    });
    await s.open();
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "what other services do you have" }]));
    expect(heard()[1]!.content).toBe(`${ACKNOWLEDGEMENTS.en[0]} ${RETRY_LINE}`);
    expect(heard()[1]!.content).not.toMatch(/trouble on my end/);
    await s.finish();
  });
});

describe("hearing the clinic's words", () => {
  test("the clinic's name, services and providers are boosted for the transcriber, cleaned to what Retell takes", () => {
    expect(voiceKeywords(["Lumen Aesthetics", "Nails", "nails", "Lip filler", " Dr  Chen ", "", "x".repeat(81), "{{caller}}"])).toEqual([
      "Lumen Aesthetics",
      "Nails",
      "Lip filler",
      "Dr Chen",
      "consultation",
    ]);
    expect(voiceKeywords(Array.from({ length: 150 }, (_, i) => `service ${i}`))).toHaveLength(100);
  });
});

describe("a model answer that does not parse whole", () => {
  test("keeps its intact reply string, and nothing else it held", () => {
    const broken = '{"reply": "Sure, we do nails! Which day suits you?", "booking": {"wants": true, "first_name": "Jo';
    expect(parseModelAnswer(broken)).toEqual({ reply: "Sure, we do nails! Which day suits you?", booking: {}, handoff: false, end: false, action: null });
    // With no reply string to keep, still malformed: the failure path, never the raw text.
    expect(parseModelAnswer('{"booking": {"wants": tru')).toMatchObject({ reply: "", malformed: true });
  });
});
