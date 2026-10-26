import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
// No database: the start reads the facts handed back here, or waits forever.
const tenant = vi.hoisted(() => ({ result: undefined as unknown, hang: false }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    if (tenant.hang) return new Promise(() => {});
    if (tenant.result !== undefined) return tenant.result;
    throw new Error("connect ECONNREFUSED");
  },
}));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import type { AssistantFacts } from "@/lib/assistant/facts";
import { guardAssistantReply, guardedLine, movingOnLine, type GuardRefusal } from "@/lib/assistant/guard";
import { buildAssistantPrompt, SPOKEN_END } from "@/lib/assistant/prompt";
import { answerTurn, SpokenStream, withoutRepeats, type AssistantResponder } from "@/lib/assistant/turn";
import { log } from "@/lib/log";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * A call's reply spoken as it is written (owner, 24 October 2026, after a
 * third test call that was "way too slow"): the model streams, each sentence
 * goes out once the guard has read it with everything said before it, the
 * first sentence the guard refuses becomes its fixed line and nothing after
 * it is said, and only the end of the reply goes with the response's last
 * part. Also the opening on a recent call's facts, and the turn's timing log.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-0000000ac0c2";
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
  greeting: { phone: "Looking to book, or got a question?", chat: "How can I help?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};

type Response = Extract<RetellOutbound, { response_type: "response" }>;
const said = (id: number, transcript: { role: string; content: string }[]) =>
  JSON.stringify({ interaction_type: "response_required", response_id: id, transcript });

/** A responder that streams `pieces` as deltas, then answers with all of them. */
function streaming(pieces: string[]): AssistantResponder {
  return async ({ onText }) => {
    for (const piece of pieces) onText?.(piece);
    return pieces.join("");
  };
}

function session(responder: AssistantResponder, deps: { cacheFacts?: boolean } = {}) {
  const sent: RetellOutbound[] = [];
  const recorded: { turns?: readonly { speaker: string; text: string }[] } = {};
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
    startDeadlineMs: 2_000,
    ...deps,
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  return { s, raw, heard: () => spokenResponses(raw()), recorded };
}

afterEach(() => {
  tenant.result = undefined;
  tenant.hang = false;
  vi.restoreAllMocks();
});

describe("the reply spoken as it is written", () => {
  test("each guarded sentence goes out as it comes, and only the end of the reply goes last", async () => {
    tenant.result = FACTS;
    const { s, raw, heard, recorded } = session(
      streaming(["Sure, we do nai", "ls here at the clinic! They are forty dollars. Which d", "ay suits you best?\n", `${SPOKEN_END}\n`, '{"handoff": false, "end": false}'],),
    );
    await s.open();
    // Short words, so no acknowledgement: the sentences alone.
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "nails" }]));
    const parts = raw().filter((r) => r.response_id === 1);
    expect(parts.map((p) => p.content_complete)).toEqual([false, false, true]);
    expect(parts[0]!.content).toBe("Sure, we do nails here at the clinic! They are forty dollars.");
    expect(parts[1]!.content).toBe(" Which day suits you best?");
    expect(parts[2]!.content).toBe("");
    expect(heard()[1]!.content).toBe("Sure, we do nails here at the clinic! They are forty dollars. Which day suits you best?");
    await s.finish();
    expect(recorded.turns?.at(-1)?.text).toBe("Sure, we do nails here at the clinic! They are forty dollars. Which day suits you best?");
  });

  test("the first sentence the guard refuses becomes its fixed line, and nothing after it is said", async () => {
    tenant.result = FACTS;
    const { s, raw, heard } = session(
      streaming(["Happy to help with that today. ", "Results last about six months. ", "You will love them!\n", `${SPOKEN_END}\n{}`]),
    );
    await s.open();
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "tell me about it" }]));
    const text = heard()[1]!.content;
    expect(text).toContain("Happy to help with that today.");
    expect(text).not.toMatch(/six months|love them/);
    expect(text.endsWith(guardedLine("clinical", FACTS.clinicName, "en", true))).toBe(true);
    await s.finish();
  });

  test("an answer in the JSON form is never spoken as it comes, and is read whole as before", async () => {
    tenant.result = FACTS;
    const { s, raw, heard } = session(streaming(['{"reply": "We open at nine on weekdays.", ', '"handoff": false, "end": false}']));
    await s.open();
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "when" }]));
    expect(raw().filter((r) => r.response_id === 1)).toHaveLength(1);
    expect(heard()[1]!.content).toBe("We open at nine on weekdays.");
    await s.finish();
  });

  test("the turn's timing is logged as numbers only", async () => {
    tenant.result = FACTS;
    const info = vi.spyOn(log, "info");
    const { s, raw } = session(streaming(["We open at nine on weekdays.\n", `${SPOKEN_END}\n{}`]));
    await s.open();
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "when do you open" }]));
    const timing = info.mock.calls.find(([message]) => message === "retell turn timing");
    expect(timing?.[1]).toEqual({ clinicId: CLINIC, callId: expect.stringMatching(/^call_/), source: "model", ms: expect.any(Number), totalMs: expect.any(Number), modelMs: expect.any(Number) });
    await s.finish();
  });
});

describe("the sentence splitter", () => {
  test("holds a sentence too short to judge alone, and sends whatever is left at the delimiter", () => {
    const out: string[] = [];
    const stream = new SpokenStream((sentence) => out.push(sentence));
    for (const piece of ["Mm-hmm. ", "Got it. ", "Let me check that for you. ", "Okay?\n", `${SPOKEN_END}\n{}`]) stream.push(piece);
    expect(out).toEqual(["Mm-hmm. Got it.", "Let me check that for you.", "Okay?"]);
    expect(stream.remainder()).toBe("");
  });

  test("words the language check cannot place yet wait for the next sentence instead of cutting the reply", async () => {
    const speak = vi.fn();
    // "Mm-hmm. Got it." alone reads as no language; with what follows it is
    // plain English. The opening "Mm-hmm." goes (withoutLeadingFiller).
    const turn = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "I want nails please",
      responder: streaming(["Mm-hmm. Got it. ", "We can do nails on any weekday. ", "Which day suits you?\n", `${SPOKEN_END}\n{}`]),
      speak,
    });
    expect(turn.source).toBe("model");
    expect(turn.reply).toBe("Got it. We can do nails on any weekday. Which day suits you?");
    expect(speak.mock.calls.map(([s]) => s).join(" ")).toBe(turn.spoken);
  });

  test("a turn without `speak`, or a responder that does not stream, reads the answer whole", async () => {
    const speak = vi.fn();
    const whole = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "when do you open", responder: async () => `We open at nine.\n${SPOKEN_END}\n{}`, speak });
    expect(speak).not.toHaveBeenCalled();
    expect(whole).toMatchObject({ source: "model", reply: "We open at nine." });
    expect(whole.spoken).toBeUndefined();
  });
});

describe("the opening on a recent call's facts", () => {
  test("a second call opens while its own read is still out, and only with cacheFacts", async () => {
    tenant.result = { ...FACTS, clinicName: "Lumen Cached" };
    const first = session(streaming(["Okay.\n###\n{}"]), { cacheFacts: true });
    await first.s.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.raw()[0]!.content).toMatch(/^Hi! I'm the AI assistant at Lumen Cached,/);
    await first.s.finish();

    // The database now hangs: a call with the cache opens at once on the recent facts.
    tenant.hang = true;
    const second = session(streaming(["Okay.\n###\n{}"]), { cacheFacts: true });
    await second.s.open();
    expect(second.raw()[0]!.content).toMatch(/^Hi! I'm the AI assistant at Lumen Cached,/);

    // Without the cache, the same call waits for its own read and falls through.
    const third = session(streaming(["Okay.\n###\n{}"]));
    await third.s.open();
    expect(third.raw().some((r) => /AI assistant at Lumen Cached/.test(r.content))).toBe(false);
  });
});

describe("never the same sentence twice in a row (owner, 24 October 2026)", () => {
  test("a sentence said in the turn before, or twice in one reply, is left out; a word or two may repeat", () => {
    const before = ["Okay. Are you looking to book, or do you have a question?"];
    expect(withoutRepeats("Okay. Are you looking to book or do you have a question? We do nails on weekdays.", before)).toBe("Okay. We do nails on weekdays.");
    expect(withoutRepeats("We do nails. We do nails. Which day suits you?", [])).toBe("We do nails. Which day suits you?");
    expect(withoutRepeats("Are you looking to book, or do you have a question?", before)).toBe("");
  });

  test("a call drops the repeated sentence as it streams, and a whole repeat is still said rather than silence", async () => {
    const history = [{ speaker: "assistant" as const, text: "Lovely. Which day suits you best?" }];
    const speak = vi.fn();
    const streamed = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history,
      text: "nails please",
      responder: streaming(["Which day suits you best? ", "We have lots of space on Friday mornings.\n", `${SPOKEN_END}\n{}`]),
      speak,
    });
    expect(streamed.reply).toBe("We have lots of space on Friday mornings.");
    expect(speak.mock.calls.map(([s]) => s).join(" ")).not.toMatch(/Which day/);

    const whole = await answerTurn({ facts: FACTS, channel: "voice", history, text: "sorry?", responder: async () => `Which day suits you best?\n${SPOKEN_END}\n{}` });
    expect(whole.reply).toBe("Which day suits you best?");

    // Website chat is not a call: left as written.
    const chat = await answerTurn({ facts: FACTS, channel: "web_chat", history, text: "nails", responder: async () => JSON.stringify({ reply: "Which day suits you best? Friday is open." }) });
    expect(chat.reply).toBe("Which day suits you best? Friday is open.");
  });
});

describe("on a call, nothing said earlier is said again, and the fixed lines are spoken ones", () => {
  test("a whole sentence from earlier in the call is left out; a short one may come back", () => {
    const earlier = ["We do nails Monday to Saturday, nine to six. Anything else I can help with?"];
    expect(withoutRepeats("We do nails Monday to Saturday, nine to six. Friday works.", ["Lovely."], earlier)).toBe("Friday works.");
    expect(withoutRepeats("Anything else I can help with?", ["Lovely."], earlier)).toBe("Anything else I can help with?");
  });

  test("the guard's lines on a call are short, never name the clinic, and keep their offer", () => {
    const reasons: GuardRefusal[] = ["price", "clinical", "payment_details", "human_claim", "booking_confirmation", "never_say", "empty"];
    for (const language of ["en", "es"] as const) {
      for (const reason of reasons) {
        const spoken = guardedLine(reason, "Lumen Aesthetics", language, true);
        expect(spoken, reason).not.toContain("Lumen Aesthetics");
        expect(spoken.split(" ").length, reason).toBeLessThanOrEqual(25);
        expect(spoken, reason).not.toMatch(/\b(sorry|lo siento)\b/i);
      }
      expect(movingOnLine("Lumen Aesthetics", language, true)).not.toContain("Lumen Aesthetics");
    }
    expect(guardedLine("clinical", "Lumen Aesthetics", "en", true)).toMatch(/consultation/);
    expect(guardedLine("human_claim", "Lumen Aesthetics", "en", true)).toMatch(/AI assistant, not a person/);
    // Written channels keep the written lines.
    expect(guardedLine("clinical", "Lumen Aesthetics")).toContain("Lumen Aesthetics");
  });

  test("the prompt names the kind of practice", () => {
    expect(buildAssistantPrompt(FACTS, "voice")).toMatch(/for Lumen Aesthetics, a med spa\./);
    expect(buildAssistantPrompt({ ...FACTS, specialty: null }, "voice")).toMatch(/for Lumen Aesthetics, a practice\./);
  });
});

describe("borrowed from full-duplex speech (owner, 24 October 2026)", () => {
  const history = [{ speaker: "assistant" as const, text: "Lovely. We have Friday at ten or Saturday at noon." }];

  test("a caller who asks to hear it again hears the key part again, and only then", async () => {
    const again = `We have Friday at ten or Saturday at noon.\n${SPOKEN_END}\n{}`;
    for (const text of ["sorry?", "What?", "can you speak up", "sorry, I couldn't hear you", "¿perdón?"]) {
      const turn = await answerTurn({ facts: FACTS, channel: "voice", history, text, responder: async () => `Sure! ${again}` });
      // The habitual "Sure!" goes; the key part is said again.
      expect(turn.reply, text).toBe("We have Friday at ten or Saturday at noon.");
    }
    // An ordinary answer still drops the repeat.
    const on = await answerTurn({ facts: FACTS, channel: "voice", history, text: "Friday works for me", responder: async () => `Great! ${again}` });
    expect(on.reply).toBe("Great!");
  });

  test("Retell's pause, a dash with a space on each side, is spoken through as written", async () => {
    const speak = vi.fn();
    const turn = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "do you have anything friday",
      responder: streaming(["Let me see - Friday morning works for nails. ", "Which time suits you?\n", `${SPOKEN_END}\n{}`]),
      speak,
    });
    expect(turn.reply).toBe("Let me see - Friday morning works for nails. Which time suits you?");
    expect(speak.mock.calls.map(([s]) => s).join(" ")).toContain("Let me see - Friday");
  });

  test("the prompt asks for the half-remembered name from the menu, a calm 'No rush', and the pause", () => {
    const prompt = buildAssistantPrompt(FACTS, "voice");
    expect(prompt).toMatch(/finish the thought for them with the closest service from the list/);
    expect(prompt).toMatch(/Only ever name services on the list/);
    expect(prompt).toMatch(/"No rush\."/);
    expect(prompt).toContain('(" - ")');
  });

  test("the prompt asks for the answer word first, matched energy, short small talk, and a bad line picked back up", () => {
    const prompt = buildAssistantPrompt(FACTS, "voice");
    expect(prompt).toMatch(/Lead with the answer itself/);
    expect(prompt).toMatch(/match their energy/);
    expect(prompt).toMatch(/and their pace/);
    expect(prompt).toMatch(/never claim a body, a life, or experiences you cannot have/);
    expect(prompt).toMatch(/pick the thread back up/);
    // Website chat is not a call: none of it.
    expect(buildAssistantPrompt(FACTS, "web_chat")).not.toMatch(/Lead with the answer itself|breaking up/);
  });

  test("the prompt asks for confidence, relating to something personal, laughter only when it's earned, and asking again instead of giving up (owner, 24 October 2026)", () => {
    const prompt = buildAssistantPrompt(FACTS, "voice");
    expect(prompt).toMatch(/Sound confident and glad to help, never flat, hedging or unsure of yourself/);
    expect(prompt).toMatch(/If they mention something personal in passing/);
    expect(prompt).toMatch(/relate to what that must be like for them, without claiming any experience of your own/);
    expect(prompt).toMatch(/Only laugh, or say "ha" or "haha", when they have actually said something funny/);
    expect(prompt).toMatch(/never say you can't help, or offer to pass things to the team, just because you missed a word or two/);
    expect(prompt).not.toContain("Ha, sounds brutal");
    expect(prompt).not.toContain("Ha, fair enough");
    expect(prompt).not.toContain("Ha, no worries");
  });
});

describe("shared emotion, never a promised result (owner, 24 October 2026)", () => {
  test("an outcome promised in plain English is refused, as the Spanish always was", () => {
    for (const line of [
      "You're going to look amazing for your wedding!",
      "You'll look stunning.",
      "you are going to look ten years younger",
      "You'll love your results.",
      "The results will be perfect.",
      "Oh, totally understandable! First time nerves are so normal, but you are going to look absolutely amazing for your wedding.",
    ]) {
      const verdict = guardAssistantReply(line, FACTS, { bookingWritten: false });
      expect(verdict.ok ? "ok" : verdict.reason, line).toBe("clinical");
    }
  });

  test("excitement about the occasion, nerves met, small talk and a bad line all still pass", () => {
    for (const line of [
      "Oh, a wedding, how exciting! First-time nerves are so normal. Want to start with a consultation?",
      "Ha, sounds brutal! Perfect excuse to stay in the AC. Were you looking to book, or got a question?",
      "Yeah, totally. Can you hear me okay?",
      "You're going to love the clinic, it's right by the park.",
      "You'll look forward to it, I'm sure!",
    ]) {
      const verdict = guardAssistantReply(line, FACTS, { bookingWritten: false });
      expect(verdict.ok ? "ok" : verdict.reason, line).toBe("ok");
    }
  });

  test("the prompt shares the occasion, never the result, and never claims to hear the room", () => {
    const prompt = buildAssistantPrompt(FACTS, "voice");
    expect(prompt).toMatch(/Share the excitement about the occasion, never about the result/);
    expect(prompt).toMatch(/Never claim to hear wind, traffic or anything else/);
  });
});

describe("a declined idea, a known menu, and a peer on the line (owner, 24 October 2026)", () => {
  const history = [{ speaker: "assistant" as const, text: "Lovely. Want me to add a consultation while you're in?" }];
  const told = async (text: string) => {
    let turn = "";
    await answerTurn({
      facts: FACTS,
      channel: "voice",
      history,
      text,
      responder: async ({ system }) => {
        turn = system.turn;
        return `Sure thing.\n${SPOKEN_END}\n{}`;
      },
    });
    return turn;
  };

  test("a no to the last offer is passed to the model, so it drops the idea", async () => {
    for (const text of ["no thanks", "Nah, I'm good", "not really", "no, gracias"]) {
      expect(await told(text), text).toMatch(/They just turned down what you last asked or offered/);
    }
    expect(await told("yes please, Friday")).not.toMatch(/turned down/);
  });

  test("the prompt lets her describe a listed service generally, never invent the practice, and never open on a filler", () => {
    const prompt = buildAssistantPrompt(FACTS, "voice");
    expect(prompt).toMatch(/You may say what a listed service generally is/);
    expect(prompt).toMatch(/never anything about risks, safety, downtime or results/);
    expect(prompt).toMatch(/Do not invent facts about the practice: its staff, equipment, brands/);
    expect(prompt).toMatch(/Start every reply's words with what you have to say, never with a filler sound or a one-word filler/);
    expect(prompt).not.toMatch(/Think out loud/);
    expect(prompt).toMatch(/Be the person callers love talking to/);
    expect(prompt).toMatch(/no flirting, no compliments on how they look/);
  });
});
