import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

// No database, and none may be asked for: every tenant read or write counts and fails.
const tenant = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    tenant.calls += 1;
    throw new Error("a demo call must never reach the database");
  },
}));
const ops = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/ops/notify", () => ({
  notifyOps: async (event: string) => {
    ops.calls.push(event);
  },
  notifyOpsOnce: async (event: string) => {
    ops.calls.push(event);
  },
}));
const outbox = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/email/outbox", () => ({
  deliverCriticalAfterCommit: async () => {
    outbox.calls += 1;
  },
}));

import {
  NEVER_SAY_DEFAULTS,
  resolveBookingRequirements,
  sealDemoCallContext,
  type DemoCallContext,
} from "@healdesk/catalog";

import { guardAssistantReply } from "@/lib/assistant/guard";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { demoVoiceOpening, voiceDisclosureEs } from "@/lib/compliance/disclosure";
import { log } from "@/lib/log";
import {
  DEMO_TIME_ZONE,
  demoAssistantFacts,
  demoContextFromCall,
  demoDuration,
  demoOpenDays,
  demoPrice,
  demoRoleplayOpener,
  demoStageNote,
  demoTimeZone,
  nextDemoStage,
} from "@/lib/voice/demo-facts";
import { DEMO_EXPIRED_LINE, RetellCallSession, type RetellOutbound, type RetellSessionDeps } from "@/lib/voice/retell";
import { createVoiceServer } from "@/voice/server";

import { spokenResponses } from "./setup/retell-responses";

/**
 * A personalised demo call on AYA's own engine (owner, 24 October 2026: "the
 * demo AYAs and the client AYA should be THE SAME, only difference should be
 * the start"): the clinic's facts from the sealed context Retell hands over in
 * call details, the demo's opening line and its note on every turn, the same
 * guard and urgent screen, and nothing read or written anywhere. No database,
 * no model, no Retell: a fake responder and a local socket.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
const LLM_SECRET = "test-retell-llm-secret-0123456789";

function context(overrides: Partial<DemoCallContext> = {}): DemoCallContext {
  return {
    v: 1,
    slug: "lumen-aesthetics-austin",
    mode: "browser",
    firstName: "Sam",
    issuedAt: Date.now(),
    offer: null,
    clinic: {
      clinicName: "Lumen Aesthetics",
      summary: "A boutique med spa in downtown Austin.",
      specialty: "med-spa",
      phone: "+15125550100",
      address: "200 Congress Ave, Austin, TX 78701",
      hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
      services: [
        { name: "Botox", description: null, price: "$12/unit", duration: "30 min" },
        { name: "HydraFacial", description: null, price: "$199", duration: "1 hour" },
        { name: "Lip Filler", description: null, price: "from $650", duration: null },
        { name: "Laser Hair Removal", description: null, price: "Call for pricing", duration: "varies" },
      ],
      providers: [{ name: "Dr. Maya Chen", title: "Medical Director" }],
      faqs: [{ question: "Is there parking?", answer: "Yes, free parking behind the building." }],
      policies: ["24-hour cancellation policy."],
      booking: "Book online or by phone.",
      highlights: ["Voted best med spa in Austin", "20% off your first HydraFacial"],
    },
    ...overrides,
  };
}

const sealed = (ctx: DemoCallContext = context(), secret = SECRET) => sealDemoCallContext(ctx, secret);

describe("a demo clinic's prices, read from its website", () => {
  test.each([
    ["$450", { priceFromUsd: 450, priceToUsd: 450, priceKind: "exact", unit: null }],
    ["$1,200", { priceFromUsd: 1200, priceToUsd: 1200, priceKind: "exact", unit: null }],
    ["$12.50", { priceFromUsd: 12.5, priceToUsd: 12.5, priceKind: "exact", unit: null }],
    ["$150 per session", { priceFromUsd: 150, priceToUsd: 150, priceKind: "exact", unit: null }],
    ["$450 USD", { priceFromUsd: 450, priceToUsd: 450, priceKind: "exact", unit: null }],
    ["from $200", { priceFromUsd: 200, priceToUsd: null, priceKind: "from", unit: null }],
    ["Starting at $200", { priceFromUsd: 200, priceToUsd: null, priceKind: "from", unit: null }],
    ["$200+", { priceFromUsd: 200, priceToUsd: null, priceKind: "from", unit: null }],
    ["$200 and up", { priceFromUsd: 200, priceToUsd: null, priceKind: "from", unit: null }],
    ["$500-$700", { priceFromUsd: 500, priceToUsd: 700, priceKind: "range", unit: null }],
    ["$500 – 700", { priceFromUsd: 500, priceToUsd: 700, priceKind: "range", unit: null }],
    ["$500 to $700", { priceFromUsd: 500, priceToUsd: 700, priceKind: "range", unit: null }],
    ["$12/unit", { priceFromUsd: 12, priceToUsd: null, priceKind: "per_unit", unit: "unit" }],
    ["from $12 per unit", { priceFromUsd: 12, priceToUsd: null, priceKind: "per_unit", unit: "unit" }],
    ["$600 per syringe", { priceFromUsd: 600, priceToUsd: null, priceKind: "per_unit", unit: "syringe" }],
    ["$14.50 / pulse", { priceFromUsd: 14.5, priceToUsd: null, priceKind: "per_unit", unit: "pulse" }],
  ])("%s", (raw, expected) => {
    expect(demoPrice(raw)).toEqual(expected);
  });

  test.each([
    null,
    "",
    "450",
    "Call for pricing",
    "Varies",
    "Complimentary",
    "$450 for 3 areas",
    "2 for $300",
    "20% off",
    "$99/month",
    "$99 a month",
    "up to $500",
    "$700-$500",
    "$450 with Dr. Lee",
    "$2k",
    "$100 members / $150 non-members",
    "Was $300, now $250",
    "$300 consultation fee credited toward treatment",
    "About $400",
  ])("no price for %j: the prompt offers a consultation", (raw) => {
    expect(demoPrice(raw)).toEqual({ priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null });
  });
});

describe("a demo clinic's durations and time zone", () => {
  test.each([
    ["45 min", 45],
    ["60 minutes", 60],
    ["1 hour", 60],
    ["1.5 hours", 90],
    ["1 hr 30 min", 90],
    ["1h30m", 90],
    ["30-45 min", null],
    ["45 to 60 minutes", null],
    ["varies", null],
    ["", null],
    [null, null],
  ])("%j is %j minutes", (raw, minutes) => {
    expect(demoDuration(raw)).toBe(minutes);
  });

  test("the zone comes from the state and ZIP code the address ends with, never guessed", () => {
    expect(demoTimeZone("200 Congress Ave, Austin, TX 78701")).toBe("America/Chicago");
    expect(demoTimeZone("1 Main St, Los Angeles, CA 90001-1234")).toBe("America/Los_Angeles");
    expect(demoTimeZone("Suite 200, Denver CO 80202")).toBe("America/Denver");
    expect(demoTimeZone("12 Broadway, Nashville, TN 37201")).toBe(DEMO_TIME_ZONE);
    expect(demoTimeZone("Somewhere in Ohio")).toBe(DEMO_TIME_ZONE);
    expect(demoTimeZone(null)).toBe(DEMO_TIME_ZONE);
  });
});

describe("a demo call's facts", () => {
  const facts = demoAssistantFacts(context());

  test("come from the profile alone, with no clinic id, no number and no alert", () => {
    expect(facts.clinicId).toBe("demo:lumen-aesthetics-austin");
    expect(facts.clinicName).toBe("Lumen Aesthetics");
    expect(facts.specialty).toBe("med-spa");
    expect(facts.timeZone).toBe("America/Chicago");
    expect([facts.phone, facts.assistantNumber, facts.urgentPhone, facts.vetReferralPhone, facts.directLine]).toEqual([null, null, null, null, null]);
    expect(facts.urgentAlertsReady).toBe(false);
    expect(facts.hours).toEqual(["Mon-Fri: 9am-6pm"]);
    expect(facts.services).toEqual([
      { name: "Botox", priceFromUsd: 12, priceToUsd: null, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: null },
      { name: "HydraFacial", priceFromUsd: 199, priceToUsd: 199, priceKind: "exact", unit: null, durationMinutes: 60, depositUsd: null },
      { name: "Lip Filler", priceFromUsd: 650, priceToUsd: null, priceKind: "from", unit: null, durationMinutes: null, depositUsd: null },
      { name: "Laser Hair Removal", priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null, durationMinutes: null, depositUsd: null },
    ]);
    expect(facts.menu).toBe("said");
    expect(facts.quickAnswers).toEqual([{ question: "Is there parking?", answer: "Yes, free parking behind the building." }]);
    expect(facts.policies).toEqual(["24-hour cancellation policy."]);
    expect(facts.promotions).toBe("20% off your first HydraFacial");
    expect(facts.notes).toContain("A boutique med spa in downtown Austin.");
    expect(facts.notes).toContain("Voted best med spa in Austin");
    expect(facts.notes).toContain("Dr. Maya Chen (Medical Director)");
    expect(facts.notes).not.toContain("20% off");
    expect(facts.providerNames).toEqual(["Dr. Maya Chen"]);
    expect(facts.neverSay).toEqual([...NEVER_SAY_DEFAULTS]);
    expect(facts.requirements).toEqual(resolveBookingRequirements("med-spa", null));
    expect(facts.languages).toEqual(["en", "es"]);
    expect(facts.tone).toBe("warm");
    expect(facts.greeting.phone).toBe("Looking to book, or got a question?");
  });

  test("hold the guard to the website's prices", () => {
    expect(guardAssistantReply("Botox is $12 per unit.", facts)).toEqual({ ok: true });
    expect(guardAssistantReply("The HydraFacial is $199.", facts)).toEqual({ ok: true });
    expect(guardAssistantReply("Botox is $15 per unit.", facts)).toEqual({ ok: false, reason: "price" });
    expect(guardAssistantReply("Laser hair removal is $300.", facts)).toEqual({ ok: false, reason: "price" });
  });

  test("read the sealed context from Retell's call object", () => {
    expect(demoContextFromCall({ retell_llm_dynamic_variables: { demo_context: " abc.def " } })).toBe("abc.def");
    expect(demoContextFromCall({ metadata: { demo_context: "abc.def" } })).toBe("abc.def");
    expect(demoContextFromCall({ retell_llm_dynamic_variables: { demo_context: 7 } })).toBeNull();
    expect(demoContextFromCall({ retell_llm_dynamic_variables: {} })).toBeNull();
    expect(demoContextFromCall(null)).toBeNull();
  });

  test("the opening line says AI assistant and transcribed first, writes 'Aya', and asks who it has", () => {
    const named = demoVoiceOpening({ clinicName: "Lumen Aesthetics", firstName: "Sam" });
    expect(named).toBe("Hi! This is Aya, the AI assistant for Lumen Aesthetics, and this call's transcribed. Am I speaking with Sam?");
    const unnamed = demoVoiceOpening({ clinicName: "Lumen Aesthetics", firstName: null });
    expect(unnamed).toBe("Hi! This is Aya, the AI assistant for Lumen Aesthetics, and this call's transcribed. Who am I speaking with?");
    for (const line of [named, unnamed]) {
      expect(line).toContain("AI assistant");
      expect(line).toContain("transcribed");
      // A voice spells capitals out letter by letter (owner, 25 October 2026: "A-Y-A").
      expect(line).not.toContain("AYA");
    }
  });

  test("the intro note asks the role, then gives the owner's A/B choice, and starts the role-play with its opener", () => {
    const note = demoStageNote(context(), "intro", Date.now());
    expect(note).toContain("live demo for Sam");
    expect(note).toContain("What's your role at Lumen Aesthetics?");
    expect(note).toContain("I'll keep this super brief. Would you like to hear what I can do for Lumen Aesthetics and how that helps your team, or jump straight into a quick role-play");
    expect(note).toContain(`start it by saying exactly: "${demoRoleplayOpener("Lumen Aesthetics")}"`);
    expect(note).toMatch(/English and Spanish/);
    expect(note).toMatch(/never mention a website, scraping/);
    expect(note).toContain('Say "your patients", never "our patients"');
    expect(note).toContain('write it exactly "Aya", never "AYA"');
    expect(note).toMatch(/no flirting/);
    expect(demoStageNote(context({ firstName: null }), "intro", Date.now())).toContain("live demo for the caller");
  });

  test("the role-play note keeps her in character, wraps up on its own and never ends the call", () => {
    const note = demoStageNote(context(), "roleplay", Date.now());
    expect(note).toContain("The role-play is on: Sam");
    expect(note).toContain("Keep in mind everything said earlier, their name included");
    expect(note).toContain('step out of character with exactly: "Ok, how was that? Haha!"');
    expect(note).toContain('Never set "end" to true during the role-play');
    // No stage's script runs into another.
    expect(note).not.toMatch(/super brief|how many calls/);
  });

  test("the pitch note makes the point, asks the discovery questions from the open days, and pitches without a price", () => {
    const now = Date.now();
    const note = demoStageNote(context(), "pitch", now);
    expect(note).toContain("I'm built to do that 24/7, on the phone and in your website chat, Instagram, Messenger and WhatsApp");
    expect(note).toContain("never on a call and never by text message");
    expect(note).toContain('"Generally, how many calls do you get a day?"');
    // Mon-Fri on the website: five days, said as a fact only because the hours say so plainly.
    expect(note).toContain(`"I see you're open 5 days a week, so would it be fair to say about [their number times 5] calls a week`);
    expect(note).toContain("after-hours calls only, taking over when the lines are busy, or handling all your incoming calls?");
    expect(note).toContain("Aya Voice, Aya Web Chat, Aya Meta Chat");
    // Capitals only in the rule against them, so nothing she copies spells it out.
    expect(note.replace('never "AYA"', "")).not.toContain("AYA");
    expect(note).not.toMatch(/super brief|Ring ring/);
    // Hours it cannot read: it asks rather than says a number of days.
    const unread = demoStageNote(context({ clinic: { ...context().clinic, hours: [{ days: "Most days", hours: "by arrangement" }] } }), "pitch", now);
    expect(unread).toContain("ask how many days a week they are open");
    expect(unread).not.toMatch(/you're open \d days/);
  });

  test("the pitch note mentions a live discount only while it is live, as a percentage and a window, never a dollar amount", () => {
    const now = Date.now();
    const live = demoStageNote(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "pitch", now);
    expect(live).toMatch(/50% off healdesk's setup fee, with about 10 hours left on it/);
    expect(live).toMatch(/never a dollar amount/);
    const almostOver = demoStageNote(context({ offer: { percentOfSetupFee: 30, endsAt: now + 30 * 60_000 } }), "pitch", now);
    expect(almostOver).toMatch(/30% off healdesk's setup fee, with about 1 hour left on it\b/);
    for (const offer of [{ percentOfSetupFee: 50, endsAt: now - 1_000 }, null]) {
      expect(demoStageNote(context({ offer }), "pitch", now)).not.toMatch(/% off healdesk's setup fee/);
    }
    // Only the pitch carries it.
    const intro = demoStageNote(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "intro", now);
    expect(intro).not.toMatch(/% off/);
  });

  test("every line the notes put in Aya's mouth passes the guard, a number of calls included", () => {
    const facts = demoAssistantFacts(context());
    const lines = [
      "Great to meet you, Sam! What's your role at Lumen Aesthetics?",
      "Awesome, look, I'll keep this super brief. Would you like to hear what I can do for Lumen Aesthetics and how that helps your team, or jump straight into a quick role-play to see how I handle a live patient call?",
      demoRoleplayOpener("Lumen Aesthetics"),
      "Perfect, we'll see you Friday! Ok, how was that? Haha!",
      "I'm built to do that 24/7, on the phone and in your website chat, Instagram, Messenger and WhatsApp: taking bookings, sending your own deposit link in chat, and answering patient questions automatically.",
      "Generally, how many calls do you get a day?",
      "I see you're open 5 days a week, so would it be fair to say about 100 calls a week, or around 430 calls a month?",
      "What happens with after-hours calls, or when your team's busy with patients?",
      "How do you see me helping you best: after-hours calls only, taking over when the lines are busy, or handling all your incoming calls?",
      "Sounds like Voice plus Web Chat would fit you best.",
      "There's actually a 50% discount on healdesk's setup fee, with about 10 hours left on it.",
    ];
    for (const line of lines) expect([line, guardAssistantReply(line, facts)]).toEqual([line, { ok: true }]);
    // A count without "calls" after it is still read as a dose: "about 2 a day".
    expect(guardAssistantReply("Most people take about 2 a day.", facts)).toMatchObject({ ok: false });
  });

  test("the stage moves on only on the scripted lines, and the open days come from hours it can read", () => {
    expect(nextDemoStage("intro", "Would you like to hear more, or jump into a role-play?")).toBe("intro");
    expect(nextDemoStage("intro", demoRoleplayOpener("Lumen Aesthetics"))).toBe("roleplay");
    expect(nextDemoStage("roleplay", "Sure, Friday at 3 works. Anything else?")).toBe("roleplay");
    expect(nextDemoStage("roleplay", "See you then! Ok, how was that? Haha!")).toBe("pitch");
    expect(nextDemoStage("pitch", "Ring ring!")).toBe("pitch");
    expect(demoOpenDays(context())).toBe(5);
    expect(demoOpenDays(context({ clinic: { ...context().clinic, hours: [{ days: "Mon-Fri", hours: "9am-6pm" }, { days: "Saturday", hours: "10am-2pm" }, { days: "Sunday", hours: "Closed" }] } }))).toBe(6);
    expect(demoOpenDays(context({ clinic: { ...context().clinic, hours: [] } }))).toBeNull();
  });
});

type Response = Extract<RetellOutbound, { response_type: "response" }>;
const said = (id: number, transcript: { role: string; content: string }[]) =>
  JSON.stringify({ interaction_type: "response_required", response_id: id, transcript });
const details = (call: Record<string, unknown>) => JSON.stringify({ interaction_type: "call_details", call });

/** A responder that answers `text` and records what it was told. */
function model(text: string) {
  const seen: { stable: string; turn: string }[] = [];
  const responder: AssistantResponder = async ({ system }) => {
    seen.push(system as { stable: string; turn: string });
    return `${text}\n###\n{"handoff": false, "end": false}`;
  };
  return { responder, seen };
}

/** Every dependency that could reach the database, a vendor or the mail, each failing the test if it is called. */
function forbidden() {
  const touched: string[] = [];
  const no = (name: string) => () => {
    touched.push(name);
    throw new Error(`${name} must not run on a demo call`);
  };
  const deps: Partial<RetellSessionDeps> = {
    gate: no("gate"),
    ingest: no("ingest"),
    screen: no("screen"),
    fallbackLine: no("fallbackLine"),
    tools: no("tools"),
    redial: no("redial"),
  };
  return { deps, touched };
}

function demoSession(responder: AssistantResponder, secret: string | null = SECRET, extra: Partial<RetellSessionDeps> = {}) {
  const sent: RetellOutbound[] = [];
  const guard = forbidden();
  const s = new RetellCallSession("demo", `call_${Math.random().toString(36).slice(2)}`, (m) => sent.push(m), {
    responder,
    ...guard.deps,
    acknowledgeAfterMs: 10_000,
    demo: { secret, detailsWaitMs: 200 },
    ...extra,
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  return { s, sent, raw, heard: () => spokenResponses(raw()), touched: guard.touched };
}

afterEach(() => {
  tenant.calls = 0;
  ops.calls = [];
  outbox.calls = 0;
  vi.restoreAllMocks();
});

describe("a demo call on the voice engine", () => {
  test("opens with the requester's name, carries the note into every turn and answers through the guard", async () => {
    const m = model("Doing great, thanks for asking! Botox is $12 per unit here.");
    const { s, sent, raw, heard, touched } = demoSession(m.responder);
    await s.open();
    expect(sent[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    await s.handle(details({ call_id: "call_1", direction: "inbound", retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    expect(raw()[0]).toMatchObject({
      response_id: 0,
      content: "Hi! This is Aya, the AI assistant for Lumen Aesthetics, and this call's transcribed. Am I speaking with Sam?",
      end_call: false,
      no_interruption_allowed: true,
    });

    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "yes that's me, how much is botox" }]));
    expect(heard().at(-1)!.content).toBe("Doing great, thanks for asking! Botox is $12 per unit here.");
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]!.turn).toContain("This call is a live demo for Sam, who is on Lumen Aesthetics's team");
    expect(m.seen[0]!.turn).toContain(`You opened the conversation with: "Hi! This is Aya`);
    expect(m.seen[0]!.stable).toContain("- Botox: from $12 per unit, about 30 minutes");
    expect(m.seen[0]!.stable).toContain("- Laser Hair Removal: no price is quoted: offer a consultation");
    // The same rules as a clinic's call: the opener says Aya is an AI, and it is the same prompt.
    expect(m.seen[0]!.stable).toContain("You are the AI assistant answering the phone for Lumen Aesthetics, a med spa.");

    // Still the intro until the role-play opener is said.
    await s.handle(said(2, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: "can I book one for Friday" }]));
    expect(m.seen).toHaveLength(2);
    expect(m.seen[1]!.turn).toContain("This call is a live demo for Sam");
    expect(m.seen[1]!.turn).not.toContain("The role-play is on");

    expect(await s.finish()).toBeNull();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
    expect(ops.calls).toEqual([]);
  });

  test("walks intro, role-play and pitch on Aya's own lines, and a goodbye inside the role-play never hangs up", async () => {
    const replies: [string, boolean][] = [
      ["Great to meet you, Sam! What's your role at Lumen Aesthetics?", false],
      [demoRoleplayOpener("Lumen Aesthetics"), false],
      // The patient says bye and the model marks the end: the demo goes on.
      ["Perfect, we'll see you Friday! Ok, how was that? Haha!", true],
      ["Generally, how many calls do you get a day?", false],
      ["Thanks so much, Sam, have a great day!", true],
    ];
    const seen: string[] = [];
    const responder: AssistantResponder = async ({ system }) => {
      seen.push((system as { turn: string }).turn);
      const [text, end] = replies[seen.length - 1]!;
      return `${text}\n###\n{"handoff": false, "end": ${end}}`;
    };
    const { s, raw, heard } = demoSession(responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    const words = ["yes it's me", "I'm the owner, let's do the role-play", "hi, can I book a HydraFacial Friday? bye!", "that was great", "about 20, thanks, bye"];
    for (const [i, text] of words.entries()) {
      await s.handle(said(i + 1, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: text }]));
    }
    expect(seen[0]).toContain("This call is a live demo for Sam");
    expect(seen[1]).toContain("This call is a live demo for Sam");
    expect(seen[2]).toContain("The role-play is on");
    expect(seen[3]).toContain("The role-play is over");
    expect(seen[4]).toContain("The role-play is over");
    const spoken = heard();
    expect(spoken.find((r) => r.content.includes("how was that"))!.end_call).toBe(false);
    expect(spoken.at(-1)).toMatchObject({ content: "Thanks so much, Sam, have a great day!", end_call: true });
    await s.finish();
  });

  test("a price off the website is refused by the guard, as on any call", async () => {
    const { s, raw, heard } = demoSession(model("Botox is just $9 a unit this week!").responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "how much is botox" }]));
    expect(heard()).toHaveLength(2);
    expect(heard()[1]!.content).not.toContain("$9");
    expect(heard()[1]!.content).not.toBe("");
    await s.finish();
  });

  test("urgent words get the fixed 9-1-1 line, with no alert, no transfer and no database", async () => {
    const m = model("never asked");
    const { s, raw, heard, touched } = demoSession(m.responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "I can't breathe" }]));
    const urgent = heard().at(-1)!;
    expect(urgent.content).toMatch(/9-1-1/);
    expect(urgent.content).not.toMatch(/told the team|let the team know/i);
    expect(urgent.transfer_number).toBeUndefined();
    expect(urgent.end_call).toBe(false);
    expect(m.seen).toHaveLength(0);
    await s.finish();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
    expect(outbox.calls).toBe(0);
    expect(ops.calls).toEqual([]);
  });

  test("a caller asking for a person raises no handover", async () => {
    const responder: AssistantResponder = async () => `Sure, I'll pass your details to the team.\n###\n{"handoff": true, "end": false}`;
    const { s, raw, touched } = demoSession(responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "can I talk to a real person please" }]));
    expect(spokenResponses(raw())).toHaveLength(2);
    expect(spokenResponses(raw())[1]!.transfer_number).toBeUndefined();
    await s.finish();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
  });

  test("a call-back demo is an outbound call, and goes on", async () => {
    const { s, raw } = demoSession(model("Hi!").responder);
    await s.open();
    await s.handle(details({ direction: "outbound", retell_llm_dynamic_variables: { demo_context: sealed(context({ mode: "phone" })) } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    expect(raw()[0]!.content).toMatch(/^Hi! This is Aya, .*Am I speaking with Sam\?$/);
    expect(raw()[0]!.end_call).toBe(false);
    await s.finish();
  });

  test("Spanish takes the call into Spanish, with the Spanish AI line once", async () => {
    const { s, raw, heard } = demoSession(model("¡Claro! El Botox cuesta $12 por unidad.").responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "hola, quiero saber cuánto cuesta el botox en su clínica por favor" }]));
    expect(heard().at(-1)!.content.startsWith(voiceDisclosureEs({ clinicName: "Lumen Aesthetics" }))).toBe(true);
    await s.finish();
  });

  test.each([
    ["forged", () => sealed(context(), "some-other-secret-0123456789abcdef"), SECRET],
    ["stale", () => sealed(context({ issuedAt: Date.now() - 3 * 60 * 60_000 })), SECRET],
    ["malformed", () => "not-a-sealed-context", SECRET],
    ["missing", () => null, SECRET],
    ["unopenable without the secret", () => sealed(), null],
  ])("a %s context hears the expired line and the call ends, keeping nothing", async (_name, make, secret) => {
    const m = model("never asked");
    const { s, raw, touched } = demoSession(m.responder, secret);
    const warn = vi.spyOn(log, "warn");
    await s.open();
    const value = make();
    await s.handle(details(value ? { retell_llm_dynamic_variables: { demo_context: value } } : { retell_llm_dynamic_variables: {} }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    expect(raw()[0]).toMatchObject({ content: DEMO_EXPIRED_LINE, end_call: true });
    expect(warn).toHaveBeenCalledWith("retell demo call refused: its context did not open", expect.objectContaining({ clinicId: "demo" }));
    // Speaking again hears the same goodbye, never the model.
    await s.handle(said(1, [{ role: "agent", content: DEMO_EXPIRED_LINE }, { role: "user", content: "hello? anyone there" }]));
    expect(raw().at(-1)).toMatchObject({ content: DEMO_EXPIRED_LINE, end_call: true });
    expect(m.seen).toHaveLength(0);
    expect(await s.finish()).toBeNull();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
  });

  test("call details that never come end in the expired line, not silence", async () => {
    const { s, raw } = demoSession(model("never asked").responder);
    await s.open();
    await vi.waitFor(() => expect(raw()).toHaveLength(1), { timeout: 2_000 });
    expect(raw()[0]).toMatchObject({ content: DEMO_EXPIRED_LINE, end_call: true });
    await s.finish();
  });

  test("a caller who hangs up before the details says nothing more", async () => {
    const { s, raw } = demoSession(model("never asked").responder);
    await s.open();
    s.socketClosed();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(raw()).toEqual([]);
    expect(await s.finish()).toBeNull();
  });
});

describe("the voice server's demo path", () => {
  let port = 0;
  let server: ReturnType<typeof createVoiceServer>;
  const m = model("Doing great, thanks!");

  beforeAll(async () => {
    server = createVoiceServer({ secret: LLM_SECRET, demoSecret: SECRET, responder: m.responder, sessionDeps: { acknowledgeAfterMs: 10_000 } });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.drain();
  });

  async function connect(path: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const received: Record<string, unknown>[] = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    const opened = await new Promise<boolean>((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
      ws.on("unexpected-response", () => resolve(false));
    });
    return { ws, opened, received };
  }

  test("routes /demo to a demo session that opens from the sealed context and touches nothing", async () => {
    const c = await connect(`/llm-websocket/${LLM_SECRET}/demo/call_demo_1`);
    expect(c.opened).toBe(true);
    await vi.waitFor(() => expect(c.received[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: true } }));
    c.ws.send(details({ call_id: "call_demo_1", retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(c.received.filter((r) => r.response_type === "response")).toHaveLength(1));
    const opening = c.received.find((r) => r.response_type === "response")!;
    expect(opening.content).toMatch(/^Hi! This is Aya, the AI assistant for Lumen Aesthetics, and this call's transcribed\./);
    c.ws.send(said(1, [{ role: "agent", content: String(opening.content) }, { role: "user", content: "good thanks, and you?" }]));
    await vi.waitFor(() => expect(spokenResponses(c.received as never[]).length).toBe(2));
    await new Promise<void>((resolve) => {
      c.ws.on("close", () => resolve());
      c.ws.close();
    });
    await vi.waitFor(() => expect(server.sessions.size).toBe(0));
    expect(tenant.calls).toBe(0);
    expect(ops.calls).toEqual([]);
  });

  test("refuses a wrong secret, and a path that is neither a clinic id nor demo", async () => {
    expect((await connect(`/llm-websocket/wrong-secret-0123456789abcdef/demo/call_x`)).opened).toBe(false);
    expect((await connect(`/llm-websocket/${LLM_SECRET}/demos/call_x`)).opened).toBe(false);
    expect((await connect(`/llm-websocket/${LLM_SECRET}/demo`)).opened).toBe(false);
  });

  test("a demo session opened without the provision secret ends with the expired line", async () => {
    const bare = createVoiceServer({ secret: LLM_SECRET, demoSecret: null, responder: m.responder, sessionDeps: { demo: { secret: null, detailsWaitMs: 200 } } });
    await new Promise<void>((resolve) => bare.server.listen(0, "127.0.0.1", () => resolve()));
    const ws = new WebSocket(`ws://127.0.0.1:${(bare.server.address() as AddressInfo).port}/llm-websocket/${LLM_SECRET}/demo/call_y`);
    const received: Record<string, unknown>[] = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(received.find((r) => r.response_type === "response")).toMatchObject({ content: DEMO_EXPIRED_LINE, end_call: true }));
    ws.close();
    await bare.drain();
    expect(tenant.calls).toBe(0);
  });
});
