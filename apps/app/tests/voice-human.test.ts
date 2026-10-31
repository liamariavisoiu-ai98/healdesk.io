import { afterEach, describe, expect, test, vi } from "vitest";

// No database, and none may be asked for: a demo call keeps nothing.
const tenant = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    tenant.calls += 1;
    throw new Error("a demo call must never reach the database");
  },
}));
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import { sealDemoCallContext, type DemoCallContext } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";
import { MOODS, parseModelAnswer, SpokenStream, withoutMood, type AssistantResponder } from "@/lib/assistant/turn";
import { DEMO_CASE_CLINIC } from "@/lib/voice/demo-cases";
import { demoRoleplayOpener } from "@/lib/voice/demo-facts";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";
import { isStallReply, pickUnsaid, STALL_LINES, STALL_SORRY } from "@/lib/voice/stall";

import { spokenResponses } from "./setup/retell-responses";

/**
 * The owner's three asks of 26 October 2026 for a call that sounds human
 * (VOICE-T16), each through the real call session:
 *
 *   - mood-first replies: a one-word mood before the words, never said;
 *   - the human stall: "say that again?" once per call before a reply she
 *     cannot give, then the refusal with a sorry opener;
 *   - jumping in: now and then, at the end of a caller's sentence, an answer
 *     said over them (agent_interrupt), gated in code.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
const CLINIC = DEMO_CASE_CLINIC.clinicName;

function says(words: string, state: Record<string, unknown> | null = null): string {
  return `${words}\n${SPOKEN_END}\n${JSON.stringify({ handoff: false, end: false, ...(state ? { state } : {}) })}`;
}

function context(): DemoCallContext {
  return { v: 1, slug: "lumen-aesthetics-austin", mode: "phone", firstName: "Josh", issuedAt: Date.now(), offer: null, test: false, buyButton: "Book Onboarding", clinic: DEMO_CASE_CLINIC };
}

type Response = Extract<RetellOutbound, { response_type: "response" }>;
type Interrupt = Extract<RetellOutbound, { response_type: "agent_interrupt" }>;

async function demoCall(options: { anticipate?: boolean; random?: () => number } = {}) {
  const queue: (string | (() => Promise<string>))[] = [];
  const seen: string[] = [];
  const responder: AssistantResponder = async ({ system, onText }) => {
    seen.push((system as { turn: string }).turn);
    const next = queue.shift();
    if (next === undefined) throw new Error("no more scripted answers");
    const text = typeof next === "string" ? next : await next();
    if (onText) for (const piece of text.split(/(?<=[.!?\]] )/)) onText(piece);
    return text;
  };
  const sent: RetellOutbound[] = [];
  const s = new RetellCallSession("demo", "call_human", (m) => sent.push(m), {
    responder,
    acknowledgeAfterMs: 60_000,
    demo: { secret: SECRET, detailsWaitMs: 200 },
    random: options.random ?? (() => 0.99),
    ...(options.anticipate !== undefined ? { anticipate: options.anticipate } : {}),
  });
  const transcript: { role: string; content: string }[] = [];
  const heard = () => spokenResponses(sent.filter((m): m is Response => m.response_type === "response"));
  const interrupts = () => sent.filter((m): m is Interrupt => m.response_type === "agent_interrupt");
  await s.open();
  await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context(), SECRET) } } }));
  await vi.waitFor(() => expect(heard()).toHaveLength(1));
  transcript.push({ role: "agent", content: heard()[0]!.content });
  let id = 0;
  /** The caller says `words`; the model writes `model`, in order. What the caller heard comes back. */
  const turn = async (words: string, ...model: (string | (() => Promise<string>))[]) => {
    queue.push(...model);
    id += 1;
    transcript.push({ role: "user", content: words });
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: id, transcript }));
    const said = heard().find((r) => r.response_id === id)?.content ?? "";
    transcript.push({ role: "agent", content: said });
    return said;
  };
  /** The caller is still talking: Retell's live update with `words` as their utterance so far. */
  const live = async (words: string, ...model: (string | (() => Promise<string>))[]) => {
    queue.push(...model);
    await s.handle(JSON.stringify({ interaction_type: "update_only", turntaking: "user_turn", transcript: [...transcript, { role: "user", content: words }] }));
  };
  /** Through the intro into the role-play: three caller turns. */
  const toRoleplay = async () => {
    await turn("Yeah, that's me.", says(`Great to meet you! What's your role at ${CLINIC}?`, { asked: "role" }));
    await turn("I'm the owner.", says("Nice. Want to hear what I can do, or jump into a quick role-play as a patient?", { asked: "choice" }));
    await turn("Whatever is best.", says(`Let's do it, you be the patient. ${demoRoleplayOpener(CLINIC)}`));
  };
  return { s, turn, live, toRoleplay, queue, seen, heard, interrupts, nextId: () => id + 1 };
}

afterEach(() => {
  tenant.calls = 0;
  vi.restoreAllMocks();
});

describe("mood-first replies (VOICE-T16b)", () => {
  test("the mood written first is never said, streamed or whole, and never reaches the guard as words", async () => {
    expect(withoutMood("[sympathetic] Oh no, that sounds rough.")).toBe("Oh no, that sounds rough.");
    expect(withoutMood("Got it. [cheerful] See you Friday!")).toBe("Got it. See you Friday!");
    expect(withoutMood("No mood here.")).toBe("No mood here.");
    expect(parseModelAnswer(says("[warm] Happy to help with that!")).reply).toBe("Happy to help with that!");
    expect(parseModelAnswer(JSON.stringify({ reply: "[focused] We open at nine." })).reply).toBe("We open at nine.");
    const out: string[] = [];
    const stream = new SpokenStream((sentence) => out.push(sentence));
    for (const piece of ["[che", "erful] Oh", " nice, a wedding! ", "When is it? ", SPOKEN_END]) stream.push(piece);
    expect(out.join(" ")).toBe("Oh nice, a wedding! When is it?");
    expect(MOODS).toContain("sympathetic");
  });

  test("on a call, the caller hears the words and never the bracket", async () => {
    const c = await demoCall();
    const said = await c.turn("Yeah, that's me.", says(`[cheerful] Oh nice! What's your role at ${CLINIC}?`, { asked: "role" }));
    expect(said).toBe(`Oh nice! What's your role at ${CLINIC}?`);
    expect(said).not.toContain("[");
    expect(tenant.calls).toBe(0);
  });
});

describe("the human stall (VOICE-T16a)", () => {
  test("a reply refused for something she cannot say is heard as a stall once, then as the refusal with a sorry opener", async () => {
    const c = await demoCall();
    await c.toRoleplay();
    const peel = "A chemical peel is $350.";
    // The price is refused and asked again (PRICE_AGAIN), refused again: the stall is said instead of the fixed line.
    const first = await c.turn("How much is a chemical peel?", says(peel), says(peel));
    expect(STALL_LINES.en).toContain(first);
    expect(first).not.toContain("$350");
    expect(c.seen.at(-1)).toContain("You have not used it yet");
    // Said again: the refusal, opened with warmth, and the model told why.
    const second = await c.turn("How much is a chemical peel?", says(peel), says(peel));
    const opener = STALL_SORRY.en.find((o) => second.startsWith(`${o} `));
    expect(opener, second).toBeDefined();
    expect(second).toContain("I don't have a price for that one");
    expect(c.seen.at(-2)).toContain("You just asked them to say it again");
    expect(c.seen.at(-2)).not.toContain("You have not used it yet");
    // Never a second stall in the call, and the sorry opener only the turn after it.
    const third = await c.turn("And a chemical peel for my sister?", says(peel), says(peel));
    expect(STALL_LINES.en).not.toContain(third);
    expect(STALL_SORRY.en.some((o) => third.startsWith(o))).toBe(false);
    expect(third).not.toContain("$350");
  });

  test("a stall she writes herself is kept as said, and the stall is then used up", async () => {
    const c = await demoCall();
    const said = await c.turn("Yeah, that's me. Do you plug into Zenoti?", says("Sorry, what was that?", { stall: true, asked: null }));
    expect(said).toBe("Sorry, what was that?");
    await c.turn("Zenoti, the booking software.", says(`Ah, that's one for the team. What's your role at ${CLINIC}?`, { asked: "role" }));
    expect(c.seen.at(-1)).toContain("You just asked them to say it again");
    await c.turn("I'm the owner.", says("Nice. Hear more, or a role-play?", { asked: "choice" }));
    expect(c.seen.at(-1)).not.toContain("You have not used it yet");
    expect(c.seen.at(-1)).not.toContain("You just asked them to say it again");
  });

  test("urgent words never stall: the fixed urgent line, and the stall is still there for later", async () => {
    const c = await demoCall();
    await c.toRoleplay();
    const before = c.seen.length;
    const urgent = await c.turn("My face is swelling up and I can't breathe.");
    expect(urgent).toMatch(/9-1-1/);
    expect(c.seen.length).toBe(before);
    const peel = "A chemical peel is $350.";
    expect(STALL_LINES.en).toContain(await c.turn("How much is a chemical peel?", says(peel), says(peel)));
  });

  test("the lines: one this call has not said, and what counts as a stall", () => {
    expect(pickUnsaid(STALL_LINES.en, ["Sorry, say that again?"], () => 0)).toBe(STALL_LINES.en[1]);
    expect(pickUnsaid(["a", "b"], ["x a", "y b"], () => 0.9)).toBe("b");
    expect(isStallReply("Sorry, could you repeat that?")).toBe(true);
    expect(isStallReply("Perdón, ¿me lo repite?")).toBe(true);
    expect(isStallReply("We open at nine. Sorry, could you repeat that for me and tell me more about your day?")).toBe(false);
    expect(isStallReply("We open at nine.")).toBe(false);
  });
});

describe("jumping in (VOICE-T16c)", () => {
  // Friday: the clinic is closed on Saturdays, and a closed day is answered by the call itself (c4093be6), never by a jump-in.
  const FRIDAY = "Hi, I'd love to book a HydraFacial for this Friday morning if you have anything.";

  test("at the end of a sentence, now and then, the jump-in is said over the caller and kept", async () => {
    const c = await demoCall({ random: () => 0 });
    await c.toRoleplay();
    const jump = "Oh, Friday morning works great - want the ten o'clock?";
    await c.live(FRIDAY, says(jump));
    await vi.waitFor(() => expect(c.interrupts()).toHaveLength(1));
    expect(c.interrupts()[0]).toMatchObject({ response_type: "agent_interrupt", content: jump, content_complete: true, no_interruption_allowed: false });
    expect(c.seen.at(-1)).toContain("The caller has NOT finished talking");
    // The jump counts as said: the next turn's record has it, and no second try comes for a while.
    await c.live("Actually, can I also ask about the lip filler you do there.");
    expect(c.queue).toHaveLength(0);
    expect(c.interrupts()).toHaveLength(1);
  });

  test("WAIT, a guess the ordinary reply overtakes, and urgent words are never said over anyone", async () => {
    const waits = await demoCall({ random: () => 0 });
    await waits.toRoleplay();
    await waits.live(FRIDAY, says("WAIT"));
    await vi.waitFor(() => expect(waits.queue).toHaveLength(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(waits.interrupts()).toHaveLength(0);

    const late = await demoCall({ random: () => 0 });
    await late.toRoleplay();
    let release!: () => void;
    const slow = () => new Promise<string>((resolve) => (release = () => resolve(says("Oh, Friday works!"))));
    await late.live(FRIDAY, slow);
    await vi.waitFor(() => expect(late.queue).toHaveLength(0));
    // Retell asks for the ordinary reply before the guess is ready: the guess is dropped unsaid.
    const answered = late.turn(FRIDAY, says("Friday morning works - want ten?"));
    release();
    expect(await answered).toBe("Friday morning works - want ten?");
    await new Promise((r) => setTimeout(r, 20));
    expect(late.interrupts()).toHaveLength(0);

    const urgent = await demoCall({ random: () => 0 });
    await urgent.toRoleplay();
    const before = urgent.seen.length;
    await urgent.live("My lips are swelling and my throat feels tight right now.");
    await new Promise((r) => setTimeout(r, 20));
    expect(urgent.seen.length).toBe(before);
    expect(urgent.interrupts()).toHaveLength(0);
  });

  test("gated: off when switched off, never in the first turns, never mid-sentence, and only by chance", async () => {
    for (const [label, options, prepare] of [
      ["switched off", { anticipate: false, random: () => 0 }, true],
      ["by chance", { random: () => 0.99 }, true],
      ["first turns", { random: () => 0 }, false],
    ] as const) {
      const c = await demoCall(options);
      if (prepare) await c.toRoleplay();
      else await c.turn("Yeah, that's me.", says("Great! What's your role?", { asked: "role" }));
      const before = c.seen.length;
      await c.live(FRIDAY);
      await new Promise((r) => setTimeout(r, 20));
      expect(c.seen.length, label).toBe(before);
    }
    const midway = await demoCall({ random: () => 0 });
    await midway.toRoleplay();
    const before = midway.seen.length;
    await midway.live("Hi, I'd love to book a HydraFacial for this Friday morning and");
    await new Promise((r) => setTimeout(r, 20));
    expect(midway.seen.length).toBe(before);
  });
});
