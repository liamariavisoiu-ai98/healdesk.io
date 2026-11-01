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
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";
import { isStallReply, pickUnsaid, STALL_LINES, STALL_SORRY } from "@/lib/voice/stall";

import { DEMO_CASE_CLINIC } from "./setup/demo-clinic";
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
  /** Three caller turns at the front desk, past the first turns where no jump-in comes. */
  const toRoleplay = async () => {
    await turn("Hi, I have a quick question.", says("Of course! What can I help with?"));
    await turn("Do you do HydraFacials?", says("We do! The HydraFacial is $199."));
    await turn("How long does it take?", says("About an hour."));
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
  // Off since 1 November 2026 (owner, approving docs/design/demo-aya-simpler-2026-11-01.md row 20 and review point
  // 4): a planned "Sorry, say that again?" cost the caller a turn and ended on the same refusal.
  test("the stall is off: a refused reply is answered at once, never with a planned 'say that again', and no note offers one", async () => {
    const c = await demoCall();
    await c.toRoleplay();
    const peel = "A chemical peel is $350.";
    const first = await c.turn("How much is a chemical peel?", says(peel), says(peel));
    expect(STALL_LINES.en).not.toContain(first);
    expect(first).not.toContain("$350");
    expect(c.seen.at(-1)).not.toContain("You have not used it yet");
    const second = await c.turn("How much is a chemical peel?", says(peel), says(peel));
    expect(STALL_SORRY.en.some((o) => second.startsWith(`${o} `))).toBe(false);
    expect(c.seen.at(-1)).not.toContain("You just asked them to say it again");
    const urgent = await c.turn("My face is swelling up and I can't breathe.");
    expect(urgent).toMatch(/9-1-1/);
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
  // No day named: a day with a booking ask is answered by the call itself from the hours (c4093be6, a44374c9), never by a jump-in.
  const FRIDAY = "Hi, I'd love to try a HydraFacial, a friend of mine raved about how good her skin looked after.";

  test("at the end of a sentence, now and then, the jump-in is said over the caller and kept", async () => {
    const c = await demoCall({ random: () => 0 });
    await c.toRoleplay();
    // Never a free time: those are the booking system's to name (the restructure, 1 November 2026).
    const jump = "Oh, a HydraFacial is a lovely pick - is it for something special?";
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
    const slow = () => new Promise<string>((resolve) => (release = () => resolve(says("Oh, lovely pick!"))));
    await late.live(FRIDAY, slow);
    await vi.waitFor(() => expect(late.queue).toHaveLength(0));
    // Retell asks for the ordinary reply before the guess is ready: the guess is dropped unsaid.
    const answered = late.turn(FRIDAY, says("Oh, I love that - is it for something special?"));
    release();
    expect(await answered).toBe("Oh, I love that - is it for something special?");
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
