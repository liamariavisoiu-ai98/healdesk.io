import { afterEach, describe, expect, test, vi } from "vitest";

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
import { guardedLine, movingOnLine } from "@/lib/assistant/guard";
import { SPOKEN_END } from "@/lib/assistant/prompt";
import {
  answerTurn,
  askedAgain,
  voiceHabits,
  withoutLeadingFiller,
  type AssistantResponder,
} from "@/lib/assistant/turn";
import type { AssistantMessage } from "@/lib/assistant/responder";
import { heardTurns, RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * The owner's test call of 25 October 2026 ("it was not natural, the
 * conversation was odd"), turned into the cases it showed:
 *
 *   - a caller who paused mid-thought and carried on was answered twice, and
 *     the reply they never heard stayed in the record, so Aya "doesn't
 *     remember anything I say" and the transcript had the caller saying
 *     everything twice;
 *   - a sound or a one-word filler opened every reply ("the emotions are in
 *     a loop");
 *   - "Wait. What did you say?" had the repeat taken out, leaving "Sorry,
 *     let me repeat that." and silence;
 *   - a budget said back was refused as an off-menu price, three times;
 *   - "sorry" and the caller's name in nearly every reply.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-0000000ac0c3";
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
  services: [
    { name: "Nails", priceFromUsd: 40, priceToUsd: 40, priceKind: "exact", unit: null, durationMinutes: 45, depositUsd: null },
    { name: "HydraFacial", priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null, durationMinutes: 60, depositUsd: null },
  ],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: [],
  requirements: [],
  greeting: { phone: "Looking to book, or got a question?", chat: "How can I help?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};

type Response = Extract<RetellOutbound, { response_type: "response" }>;
const said = (id: number, transcript: { role: string; content: string }[]) =>
  JSON.stringify({ interaction_type: "response_required", response_id: id, transcript });
const answer = (text: string) => `${text}\n${SPOKEN_END}\n{"handoff": false, "end": false}`;

function session(replies: string[]) {
  tenant.result = FACTS;
  const sent: RetellOutbound[] = [];
  const asked: { messages: AssistantMessage[]; turn: string }[] = [];
  const recorded: { turns?: readonly { speaker: string; text: string }[] } = {};
  const responder: AssistantResponder = async (prompt) => {
    asked.push({ messages: prompt.messages.map((m) => ({ ...m })), turn: prompt.system.turn });
    return answer(replies[asked.length - 1] ?? "Okay.");
  };
  const s = new RetellCallSession(CLINIC, `call_${Math.random().toString(36).slice(2)}`, (m) => sent.push(m), {
    responder,
    gate: async () => ({ decision: "answer" }) as never,
    ingest: async (event) => {
      recorded.turns = event.transcriptTurns;
      return { conversationId: "c", duplicate: false } as never;
    },
    realCalls: true,
    tools: () => null,
    redial: async () => null,
    acknowledgeAfterMs: 10_000,
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  return { s, raw, heard: () => spokenResponses(raw()), asked, recorded };
}

afterEach(() => {
  tenant.result = undefined;
  vi.restoreAllMocks();
});

describe("the record is what the caller heard (heardTurns)", () => {
  const opening = { speaker: "assistant" as const, text: "Hi, thanks for calling Lumen Aesthetics, this is Aya, the AI assistant. How can I help?" };
  const first = { speaker: "assistant" as const, text: "Generally, how many calls do you get a day?" };

  test("a reply dropped unheard goes, with the half sentence it answered", () => {
    const turns = [opening, { speaker: "person" as const, text: "Hi" }, first, { speaker: "person" as const, text: "I already answered" }, { speaker: "assistant" as const, text: "Fair enough, let's keep it moving." }];
    const transcript = [
      { role: "agent", content: opening.text },
      { role: "user", content: "Hi" },
      { role: "agent", content: first.text },
      { role: "user", content: "I already answered that question, and I am tired of repeating myself." },
    ];
    expect(heardTurns(transcript, turns)).toEqual([opening, { speaker: "person", text: "Hi" }, first]);
  });

  test("a reply cut short is kept as far as it was heard", () => {
    const long = { speaker: "assistant" as const, text: "We offer injectables, dermal fillers, facials, microneedling and peels. Which one are you curious about?" };
    const turns = [opening, { speaker: "person" as const, text: "what services do you have" }, long];
    const transcript = [
      { role: "agent", content: opening.text },
      { role: "user", content: "what services do you have" },
      { role: "agent", content: "We offer injectables, dermal fillers," },
      { role: "user", content: "wait, what did you say" },
    ];
    expect(heardTurns(transcript, turns)!.at(-1)).toEqual({ speaker: "assistant", text: "We offer injectables, dermal fillers," });
  });

  test("untouched when the last reply was heard whole, when nothing matches, and for a lone word heard", () => {
    const turns = [opening, { speaker: "person" as const, text: "Hi" }, first];
    expect(heardTurns([{ role: "agent", content: opening.text }, { role: "user", content: "Hi" }, { role: "agent", content: first.text }, { role: "user", content: "Five" }], turns)).toBeNull();
    expect(heardTurns([{ role: "agent", content: "Something we never said." }, { role: "user", content: "Five" }], turns)).toBeNull();
    expect(heardTurns([{ role: "user", content: "Hello?" }], turns)).toBeNull();
    // "Mm." heard from a reply that was dropped must not match a reply that opened with it.
    const acked = [opening, { speaker: "person" as const, text: "Hi" }, { speaker: "assistant" as const, text: "Mm. We open at nine tomorrow." }];
    expect(heardTurns([{ role: "agent", content: "Mm." }, { role: "user", content: "and parking?" }], acked)).toBeNull();
    expect(heardTurns("not a transcript", turns)).toBeNull();
  });

  test("on a call: a caller who carries on after a pause is answered once, from their whole sentence, and recorded once", async () => {
    const { s, raw, heard, asked, recorded } = session([
      "Generally, how many calls do you get a day?",
      "Fair enough, let's keep it moving.",
      "Got it, I won't ask again. So what happens with the after-hours calls?",
    ]);
    await s.open();
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "hi there" }]));
    const question = heard().at(-1)!.content;
    // They pause mid-thought: answered...
    await s.handle(said(2, [{ role: "agent", content: opening }, { role: "user", content: "hi there" }, { role: "agent", content: question }, { role: "user", content: "I already answered that question." }]));
    // ...then carry on before that answer was heard: Retell asks again with the whole sentence.
    const whole = "I already answered that question, and I am tired of repeating myself.";
    await s.handle(said(3, [{ role: "agent", content: opening }, { role: "user", content: "hi there" }, { role: "agent", content: question }, { role: "user", content: whole }]));
    // The model never reads the half sentence or the reply nobody heard.
    const last = asked.at(-1)!.messages;
    expect(last.at(-1)).toEqual({ role: "user", content: whole });
    expect(JSON.stringify(last)).not.toContain("let's keep it moving");
    expect(last.filter((m) => m.role === "user" && m.content.includes("I already answered"))).toHaveLength(1);
    await s.finish();
    // The clinic's transcript has the caller saying it once.
    const said3 = recorded.turns!.filter((t) => t.speaker === "person" && t.text.includes("I already answered"));
    expect(said3).toEqual([{ speaker: "person", text: whole }]);
    expect(recorded.turns!.some((t) => t.text.includes("let's keep it moving"))).toBe(false);
  });
});

describe("no habit openers, no loops", () => {
  test("a reply's opening sound or one-word filler goes; words that carry meaning stay", () => {
    expect(withoutLeadingFiller("Hmm. Hey, great to meet you!")).toBe("Hey, great to meet you!");
    expect(withoutLeadingFiller("Mm-hmm. Mm-hmm. Great, the owner.")).toBe("Great, the owner.");
    expect(withoutLeadingFiller("Ha, got it!")).toBe("Got it!");
    expect(withoutLeadingFiller("Sure. Mm. You're right.")).toBe("You're right.");
    expect(withoutLeadingFiller("Right. Ring ring!")).toBe("Ring ring!");
    expect(withoutLeadingFiller("Sure thing! We do.")).toBe("Sure thing! We do.");
    expect(withoutLeadingFiller("Oh no, that sounds rough.")).toBe("Oh no, that sounds rough.");
    expect(withoutLeadingFiller("Right, that makes sense.")).toBe("Right, that makes sense.");
    expect(withoutLeadingFiller("Hmm.")).toBe("");
  });

  test("on a call the filler never reaches the caller, streamed or not", async () => {
    const plain = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "do you do nails", responder: async () => answer("Mm-hmm. Sure. Yep, we do nails!") });
    expect(plain.reply).toBe("Yep, we do nails!");
    const speak = vi.fn();
    const streamed = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "do you do nails",
      speak,
      responder: async ({ onText }) => {
        for (const piece of ["Hmm. ", "Yep, we do nails here! ", "Want to book?\n", `${SPOKEN_END}\n{}`]) onText?.(piece);
        return answer("Hmm. Yep, we do nails here! Want to book?");
      },
    });
    expect(speak.mock.calls.map(([s]) => s).join(" ")).toBe("Yep, we do nails here! Want to book?");
    expect(streamed.reply).toBe("Yep, we do nails here! Want to book?");
    // Web chat is untouched.
    expect((await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "do you do nails", responder: async () => JSON.stringify({ reply: "Sure. We do!" }) })).reply).toBe("Sure. We do!");
  });

  test("asked to say it again after a 'wait', the key part is said again, not taken out", async () => {
    expect(askedAgain("Wait. Wait. What did you say?")).toBe(true);
    expect(askedAgain("I mean, yeah. You were telling me about your services.")).toBe(true);
    expect(askedAgain("I'd like to book nails for Friday at ten please, if you have it.")).toBe(false);
    const history = [
      { speaker: "assistant" as const, text: "Hi, this is Aya, the AI assistant for Lumen Aesthetics." },
      { speaker: "person" as const, text: "what do you offer" },
      { speaker: "assistant" as const, text: "We offer nails and HydraFacials. Which one are you curious about?" },
    ];
    const turn = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history,
      text: "Wait. Wait. What did you say?",
      responder: async () => answer("Sorry, let me repeat that. We offer nails and HydraFacials."),
    });
    expect(turn.reply).toBe("Sorry, let me repeat that. We offer nails and HydraFacials.");
  });

  test("a budget said back is asked again without the figure, once, before any fixed line", async () => {
    const seen: string[] = [];
    const replies = ["With a budget of $500, a HydraFacial is a lovely pick.", "Within your budget, a HydraFacial is a lovely pick, and the team can tailor it at a consultation."];
    const turn = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "my budget is roughly five hundred dollars, what do you suggest",
      responder: async ({ system }) => {
        seen.push(system.turn);
        return answer(replies[seen.length - 1]!);
      },
    });
    expect(turn).toMatchObject({ source: "model", reply: replies[1] });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("Write it again with no dollar amount at all, not even one the caller said");
    // A second refusal is the fixed line: one retry, never more.
    let calls = 0;
    const twice = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "how much is a HydraFacial", responder: async () => (calls++, answer("A HydraFacial is $250.")) });
    expect(calls).toBe(2);
    expect(twice).toMatchObject({ source: "guard", guard: "price", reply: guardedLine("price", "Lumen Aesthetics", "en", true) });
  });

  test("streamed, the second try starts the moment the figure is refused, not after the first reply is written", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const speak = vi.fn();
    const turn = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "my budget is about five hundred dollars, what should I get",
      speak,
      responder: async ({ onText }) => {
        calls += 1;
        if (calls === 1) {
          onText?.("With $500 you could get a HydraFacial. ");
          await hung; // the rest of a reply nobody will hear
          return answer("With $500 you could get a HydraFacial. Want to book?");
        }
        for (const piece of ["Within your budget, a HydraFacial is a lovely pick. ", "Want me to request a consultation?\n", `${SPOKEN_END}\n{}`]) onText?.(piece);
        return answer("Within your budget, a HydraFacial is a lovely pick. Want me to request a consultation?");
      },
    });
    expect(calls).toBe(2);
    expect(turn).toMatchObject({ source: "model", reply: "Within your budget, a HydraFacial is a lovely pick. Want me to request a consultation?" });
    expect(speak.mock.calls.map(([s]) => s).join(" ")).toBe(turn.spoken);
    expect(speak.mock.calls.flat().join(" ")).not.toContain("$500");
    release();
  });

  test("the price line said once (after an acknowledgement or not) is never said again: the turn moves on", async () => {
    const line = guardedLine("price", "Lumen Aesthetics", "en", true);
    const history = [
      { speaker: "assistant" as const, text: "Hi, this is Aya, the AI assistant for Lumen Aesthetics." },
      { speaker: "person" as const, text: "how much is a HydraFacial" },
      { speaker: "assistant" as const, text: `Mm. ${line}` },
    ];
    const turn = await answerTurn({ facts: FACTS, channel: "voice", history, text: "what does it cost though", responder: async () => answer("It's $250.") });
    expect(turn).toMatchObject({ source: "guard", handoff: true, reply: movingOnLine("Lumen Aesthetics", "en", true) });
    // Streamed, the same.
    const streamed = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history,
      text: "what does it cost though",
      speak: () => {},
      responder: async ({ onText }) => {
        for (const piece of ["It's $250 for one session. ", "Want to book?\n", `${SPOKEN_END}\n{}`]) onText?.(piece);
        return answer("It's $250 for one session. Want to book?");
      },
    });
    expect(streamed).toMatchObject({ source: "guard", handoff: true, reply: movingOnLine("Lumen Aesthetics", "en", true) });
  });

  test("the model is told, from the record, what it keeps doing: sorry, the name, the same openers", async () => {
    const history = [
      { speaker: "assistant" as const, text: "Hi! This is Aya, the AI assistant for Lumen Aesthetics. Am I speaking with Josh?" },
      { speaker: "person" as const, text: "yeah" },
      { speaker: "assistant" as const, text: "Hey Josh, great to meet you! What's your role?" },
      { speaker: "person" as const, text: "owner" },
      { speaker: "assistant" as const, text: "Hmm, sorry about that, Josh! Want to hear more?" },
    ];
    const habits = voiceHabits(history, "Josh");
    expect(habits).toContain(`You have already apologised on this call: no more "sorry", just carry on.`);
    expect(habits).toContain("Do not say their name in this reply.");
    expect(habits).toContain(`Your last replies began "Hey", "Hmm": begin this one differently, straight with what you have to say.`);
    // Nothing before the first reply, and nothing about a name never said.
    expect(voiceHabits(history.slice(0, 2), "Josh")).toEqual([]);
    expect(voiceHabits(history.slice(0, 3), "Josh")).not.toContain(`You have already apologised on this call: no more "sorry", just carry on.`);
    let turn = "";
    await answerTurn({ facts: FACTS, channel: "voice", history, text: "sure tell me more", callerFirstName: "Josh", responder: async ({ system }) => ((turn = system.turn), answer("We answer every call.")) });
    expect(turn).toContain("Do not say their name in this reply.");
  });
});
