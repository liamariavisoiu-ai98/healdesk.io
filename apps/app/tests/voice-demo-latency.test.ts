import { describe, expect, test, vi } from "vitest";

// No database, and none may be asked for: a demo call keeps nothing, and books on its own calendar in memory.
const tenant = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    tenant.calls += 1;
    throw new Error("a demo call must never reach the database");
  },
}));
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import { sealDemoCallContext, type DemoCallClinic, type DemoCallContext } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";
import { asksForTimes, type AssistantResponder } from "@/lib/assistant/turn";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

/**
 * The demo's latency (owner, 1 November 2026: "latency the lowest possible").
 * Since the restructure (PR 95) the demo runs with the booking tools live,
 * and a turn with the tools live was read whole before a word was said. Now
 * it streams until times are offered, a free time she names is held back for
 * the tool layer, and "what do you have Thursday?" with the treatment known
 * is answered by the tool layer with no model turn.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
/** Sunday, November 1, 2026 at 8:23 AM EST. */
const CALLED_AT = Date.parse("2026-11-01T13:23:00Z");

const CLINIC: DemoCallClinic = {
  clinicName: "Miami Skin & Vein",
  summary: "A physician-led med spa in Coral Gables.",
  specialty: "med-spa",
  phone: "(786) 618-5039",
  address: "6705 Red Rd, Suite 608, Coral Gables, FL 33143",
  hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
  services: [
    { name: "BOTOX® Cosmetic", description: null, price: "$18/unit", duration: null },
    { name: "Dysport", description: null, price: "$6/unit", duration: null },
    { name: "Hydrafacial", description: null, price: "from $300", duration: null },
  ],
  providers: [{ name: "Dr. Shaun Patel", title: "Medical Director" }],
  faqs: [],
  policies: ["A $50 deposit holds each appointment and comes off the treatment price. Cancel or move it at least 24 hours ahead to keep the deposit."],
  booking: null,
  highlights: [],
};

function says(words: string, json: Record<string, unknown> = {}): string {
  return `${words}\n${SPOKEN_END}\n${JSON.stringify({ handoff: false, end: false, action: null, ...json })}`;
}

type Response = Extract<RetellOutbound, { response_type: "response" }>;

/** A demo session whose model streams each scripted answer in small pieces, as the API does. */
async function session(options: { fillers?: boolean } = {}) {
  const queue: string[] = [];
  let asked = 0;
  let stable = "";
  let turnNote = "";
  const responder: AssistantResponder = async ({ onText, system }) => {
    asked += 1;
    stable = (system as { stable: string }).stable;
    turnNote = (system as { turn: string }).turn;
    const text = queue.shift();
    if (text === undefined) throw new Error("no scripted answer left for this turn");
    for (let i = 0; i < text.length; i += 6) onText?.(text.slice(i, i + 6));
    return text;
  };
  const sent: RetellOutbound[] = [];
  const context: DemoCallContext = { v: 1, slug: "miami-skin-vein-test", mode: "browser", firstName: null, issuedAt: CALLED_AT, offer: null, test: true, buyButton: null, clinic: CLINIC };
  const s = new RetellCallSession("demo", "call_latency", (m) => sent.push(m), {
    responder,
    // Fillers off unless the test asks for them (they go at once by default, FILLER_AFTER_MS).
    ...(options.fillers ? {} : { acknowledgeAfterMs: 60_000 }),
    pauseScale: 0,
    now: () => new Date(CALLED_AT),
    random: () => 0,
    demo: { secret: SECRET, detailsWaitMs: 200 },
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  await s.open();
  await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context, SECRET) } } }));
  await vi.waitFor(() => expect(raw()).toHaveLength(1));
  let n = 0;
  return {
    asked: () => asked,
    stable: () => stable,
    turnNote: () => turnNote,
    async turn(caller: string, model: string[]) {
      queue.length = 0;
      queue.push(...model);
      n += 1;
      const last = raw().filter((m) => m.content).at(-1)?.content ?? "";
      await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: n, transcript: [{ role: "agent", content: last }, { role: "user", content: caller }] }));
      const parts = raw().filter((m) => m.response_id === n);
      return { parts: parts.map((m) => m.content ?? "").filter(Boolean), whole: parts.map((m) => m.content ?? "").join("").replace(/\s+/g, " ").trim() };
    },
    finish: () => s.finish(),
  };
}

describe("the demo's latency with the booking tools live", () => {
  test("before any time is offered, her reply is spoken sentence by sentence", async () => {
    const call = await session();
    const { parts } = await call.turn("How much is Botox?", [
      says("Botox is from $18 per unit. The total depends on the areas, which Dr. Shaun Patel works out with you at a consultation.", { booking: { wants: false, service: "BOTOX® Cosmetic" } }),
    ]);
    // Two pieces, not one: the first sentence went out before the second was written.
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]).toContain("Botox is from $18 per unit.");
    // The model is asked for its words first, then the details with the action: a JSON reply could not be spoken
    // until the whole of it was written, which is how every turn with the tools live was answered until now.
    expect(call.stable()).toContain(`Answer in two parts and nothing else`);
    expect(call.stable()).toContain(`"type": "find_times"`);
    expect(call.stable()).not.toContain(`{"reply":`);
    await call.finish();
    expect(tenant.calls).toBe(0);
  });

  test("a find_times she asks for follows the words she has already said", async () => {
    const call = await session();
    const { parts, whole } = await call.turn("Can I book Botox on Thursday?", [
      says("Let me pull up our calendar.", { action: { type: "find_times", service: "BOTOX® Cosmetic", day: "2026-11-05" }, booking: { wants: true, service: "BOTOX® Cosmetic" } }),
    ]);
    expect(parts[0]).toContain("Let me pull up our calendar.");
    expect(whole).toBe("Let me pull up our calendar. Thursday the 5th, I've got 10, 2 or 4. Any of those work?");
    await call.finish();
  });

  test("a free time she names herself is never said: the tool layer answers", async () => {
    const call = await session();
    const { whole } = await call.turn("Can I come in Thursday for Botox?", [
      says("Oh, for sure. We have Thursday at 11 AM open.", { booking: { wants: true, service: "BOTOX® Cosmetic" } }),
    ]);
    expect(whole).toMatch(/^Oh, for sure\. Thursday the 5th, I've got /);
    expect(whole).not.toContain("11 AM open");
    await call.finish();
  });

  test("once times are offered, a reply is read whole: a picked time is the tool layer's line alone", async () => {
    const call = await session();
    await call.turn("Can I book Botox on Thursday?", [says("Let me check.", { action: { type: "find_times", service: "BOTOX® Cosmetic", day: "2026-11-05" }, booking: { wants: true, service: "BOTOX® Cosmetic" } })]);
    const { parts, whole } = await call.turn("Is there anything after three?", [says("Let me look at the afternoon.", { action: { type: "find_times", service: "BOTOX® Cosmetic", day: "2026-11-05", after: "15:00" } })]);
    // Her words are never spoken once times are offered: the tool layer's own lookup line leads, then its times.
    expect(whole).not.toContain("Let me look at the afternoon");
    expect(parts[0]).toMatch(/^(?:Let me check\.\.\.|One sec, let me look\.\.\.|Let me take another look\.\.\.)$/);
    await call.finish();
  });

  test("'what do you have Thursday?' with the treatment known is answered with no model turn", async () => {
    const call = await session();
    await call.turn("How much is Botox?", [says("Botox is from $18 per unit.", { booking: { wants: true, service: "BOTOX® Cosmetic" } })]);
    const before = call.asked();
    const { whole } = await call.turn("What do you have Thursday?", [says("unused")]);
    expect(call.asked()).toBe(before);
    // The tool layer's own lookup line, then the times: no model turn, and still the moment a person takes to look.
    expect(whole).toBe("Let me pull up our calendar... Thursday the 5th, I've got 10, 2 or 4. Any of those work?");
    await call.finish();
  });

  test("another treatment named, or no day, goes to the model as before", async () => {
    const call = await session();
    await call.turn("How much is Botox?", [says("Botox is from $18 per unit.", { booking: { wants: true, service: "BOTOX® Cosmetic" } })]);
    const before = call.asked();
    await call.turn("What do you have Thursday for a Hydrafacial?", [says("Happy to look for a Hydrafacial.")]);
    expect(call.asked()).toBe(before + 1);
    await call.turn("What do you have?", [says("We have Botox, Dysport and Hydrafacial.")]);
    expect(call.asked()).toBe(before + 2);
    await call.finish();
  });

  test("asksForTimes reads a question about free times, not about the menu", () => {
    for (const yes of ["What do you have Thursday?", "Any openings Friday?", "Is there anything after five?", "What's your availability tomorrow?", "What times on Monday?"]) {
      expect(asksForTimes(yes), yes).toBe(true);
    }
    for (const no of ["Do you have Botox?", "How much is Dysport?", "Thursday works.", "I'll take three PM."]) {
      expect(asksForTimes(no), no).toBe(false);
    }
  });

  test("a filler that fits what they said goes first, the model is told it was said, and none comes for a thank-you", async () => {
    const call = await session({ fillers: true });
    const worried = await call.turn("I'm really nervous about needles, is Botox bad?", [says("Totally normal to feel that. Dr. Shaun Patel goes through it all with you first.")]);
    expect(worried.parts.length).toBeGreaterThanOrEqual(2);
    expect(["Oh no,", "Aw,", "Oh, I hear you,"]).toContain(worried.parts[0]);
    expect(call.turnNote()).toContain(`"${worried.parts[0]}" is being said out loud for you first`);
    const thanks = await call.turn("Thanks so much.", [says("You're welcome! Anything else?")]);
    expect(thanks.whole).toBe("You're welcome! Anything else?");
    await call.finish();
  });
});
