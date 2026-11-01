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
  DEMO_START_PROGRESS,
  DEMO_TIME_ZONE,
  demoAssistantFacts,
  demoContextFromCall,
  demoDuration,
  demoPrice,
  shortClinicName,
  demoStageNote,
  demoTimeZone,
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
    test: false,
    buyButton: "Book Onboarding",
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

  test("come from the profile alone, with no clinic id, no number to put a call through to and no alert", () => {
    expect(facts.clinicId).toBe("demo:lumen-aesthetics-austin");
    expect(facts.clinicName).toBe("Lumen Aesthetics");
    expect(facts.specialty).toBe("med-spa");
    expect(facts.timeZone).toBe("America/Chicago");
    // The practice's published number is the one an urgent reply reads out (c4093be6), never a line to put the call through to.
    expect([facts.phone, facts.assistantNumber, facts.urgentPhone, facts.vetReferralPhone, facts.directLine]).toEqual([null, null, "+15125550100", null, null]);
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

  test("the opening line is the clinic's front desk, saying AI assistant and transcribed first, and writes 'Aya'", () => {
    // Owner, 1 November 2026: "Remove the sales pitch completely. Aya is now only a receptionist."
    const line = demoVoiceOpening({ clinicName: "Lumen Aesthetics" });
    expect(line).toBe("Thanks for calling Lumen Aesthetics, this is Aya, the AI assistant, and this call's transcribed. How can I help you today?");
    expect(line).toContain("AI assistant");
    expect(line).toContain("transcribed");
    // A voice spells capitals out letter by letter (owner, 25 October 2026: "A-Y-A").
    expect(line).not.toContain("AYA");
  });

  test("the note is a receptionist's: the booking's needs, the calendar, and nothing of healdesk's", () => {
    const note = demoStageNote(context(), "roleplay", Date.now(), DEMO_START_PROGRESS);
    expect(note).toContain("You are Aya, Lumen's AI receptionist, answering a caller.");
    expect(note).toContain("you need four things, asked one at a time: the treatment, a day and time, their first name, and the best number to reach them");
    // No list of times for her to read: the call offers times itself (a test call of 1 November 2026: the same three, three times).
    expect(note).toContain("You can't see the calendar yourself: never name a free time");
    expect(note).not.toMatch(/(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, \w+ \d{1,2} at \d/);
    expect(note).toContain('When they say goodbye, say a short, warm goodbye and set "end" to true.');
    expect(note).not.toMatch(/healdesk|setup fee|discount|role-?play|Book Onboarding|pitch|owner/i);
  });

  test("6i: the short name a person uses after the greeting, the full one kept when nothing short is left", () => {
    expect(shortClinicName("Lumen Aesthetics & Wellness")).toBe("Lumen");
    expect(shortClinicName("Lumen Aesthetics")).toBe("Lumen");
    expect(shortClinicName("Glow Med Spa of Austin")).toBe("Glow");
    expect(shortClinicName("Skin Deep Med Spa")).toBe("Skin Deep");
    expect(shortClinicName("Radiance MedSpa - Downtown")).toBe("Radiance");
    expect(shortClinicName("The Woodlands Laser Clinic")).toBe("Woodlands");
    expect(shortClinicName("SkinSpirit")).toBe("SkinSpirit");
    expect(shortClinicName("The Laser Clinic")).toBe("The Laser Clinic");
    expect(shortClinicName("Med Spa")).toBe("Med Spa");
    expect(shortClinicName("Jo Aesthetics")).toBe("Jo Aesthetics");
  });











  test("on a demo call only, the guard refuses her own workings and claims healdesk does not make (transcript a17b5aff)", () => {
    const demo = demoAssistantFacts({ slug: "lumen-aesthetics-austin", clinic: context().clinic });
    const clinic = { ...demo, demoCall: undefined };
    for (const reply of [
      "This isn't the caller and I'm not Aya for this flow, so I'll stop there.",
      "I answer your patients' calls, texts and social messages around the clock.",
      "Honestly, I can't actually check the schedule or book anything myself.",
      "The trick is to have two fresh session numbers, or start a new session for the pitch.",
      "For you as the owner, I can't show you a real comparison or a live demo from this chat.",
    ]) {
      expect(guardAssistantReply(reply, demo), reply).toEqual({ ok: false, reason: "off_script" });
      const onAClinicCall = guardAssistantReply(reply, clinic);
      expect(onAClinicCall.ok ? null : onAClinicCall.reason, reply).not.toBe("off_script");
    }
    for (const reply of [
      "After a booking call, a clinic can turn on one text with its payment link, designed to go only if the caller agrees.",
      "One Aya answers your phone, website chat, Instagram, Messenger and WhatsApp.",
      "Microneedling usually takes three sessions.",
      "I can't confirm it myself, but the team will confirm Friday morning.",
    ]) {
      expect(guardAssistantReply(reply, demo), reply).toEqual({ ok: true });
    }
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
  test("opens as the clinic's front desk, carries the receptionist note into every turn and answers through the guard", async () => {
    const m = model("Doing great, thanks for asking! Botox is $12 per unit here.");
    const { s, sent, raw, heard, touched } = demoSession(m.responder);
    await s.open();
    expect(sent[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    await s.handle(details({ call_id: "call_1", direction: "inbound", retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    expect(raw()[0]).toMatchObject({
      response_id: 0,
      content: "Thanks for calling Lumen Aesthetics, this is Aya, the AI assistant, and this call's transcribed. How can I help you today?",
      end_call: false,
      no_interruption_allowed: true,
    });

    await s.handle(said(1, [{ role: "agent", content: raw()[0]!.content }, { role: "user", content: "hi, how much is botox" }]));
    expect(heard().at(-1)!.content).toBe("Doing great, thanks for asking! Botox is $12 per unit here.");
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]!.turn).toContain("You are Aya, Lumen's AI receptionist, answering a caller.");
    // The clinic's own front-desk prompt, the one its patients get, with the receptionist's manner; never a sales prompt
    // (owner, 1 November 2026: "Remove the sales pitch completely. Aya is now only a receptionist").
    expect(m.seen[0]!.stable).toContain("You are the AI assistant answering the phone for Lumen Aesthetics");
    expect(m.seen[0]!.stable).toContain("How you run a booking");
    expect(m.seen[0]!.stable).not.toMatch(/healdesk.s Aya|Book Onboarding|the product they are hearing/);

    // A day with a booking ask is answered by the call itself, from the hours, with no model call (a44374c9).
    await s.handle(said(2, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: "can I book one for Friday" }]));
    expect(heard().at(-1)!.content).toMatch(/^Let me pull up our calendar\.\.\. On Friday, November \d+, I have \d+ [AP]M or \d+ [AP]M\. Would either of those work\?$/);
    expect(m.seen).toHaveLength(1);
    await s.handle(said(3, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: "and what's your cancellation policy" }]));
    expect(m.seen).toHaveLength(2);
    expect(m.seen[1]!.turn).toContain("You are Aya, Lumen's AI receptionist");
    expect(m.seen[1]!.turn).not.toMatch(/buying signal|the close|pitch/);

    expect(await s.finish()).toBeNull();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
    expect(ops.calls).toEqual([]);
  });




  test("an operator's test call emails its transcript to hello@, as a clinic's goes to the clinic, and keeps nothing", async () => {
    const mails: { to: string; subject: string; text: string; phiClass: unknown }[] = [];
    const transport = {
      name: "ses-fake",
      send: async (target: { to: string }, message: { subject: string; text: string; phiClass?: unknown }) => {
        mails.push({ to: target.to, subject: message.subject, text: message.text, phiClass: message.phiClass });
        return { status: "sent" as const, messageId: "ses-1" };
      },
    };
    const info = vi.spyOn(log, "info");
    const { s, raw, heard, touched } = demoSession(model("Botox is $12 per unit here.").responder, SECRET, { transport });
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed(context({ test: true })) } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: heard()[0]!.content }, { role: "user", content: "how much is botox" }]));
    expect(await s.finish()).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("hello@healdesk.io");
    expect(mails[0]!.phiClass).toBe("may-carry-phi");
    expect(mails[0]!.text).toContain("how much is botox");
    expect(mails[0]!.text).toContain("Botox is $12 per unit here.");
    expect(info).toHaveBeenCalledWith("retell demo call ended", expect.objectContaining({ status: "transcript_sent" }));
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
  });

  test("the model is readied while the opening line plays, kept warm while idle, never mid-turn, and let go when the call ends", async () => {
    const warms: { stable: string; turn: string; channel: string; answering: boolean }[] = [];
    let answering = false;
    const base = model("Botox is $12 per unit here.");
    const responder: AssistantResponder = Object.assign(
      async (request: Parameters<AssistantResponder>[0]) => {
        answering = true;
        await new Promise((r) => setTimeout(r, 120));
        answering = false;
        return base.responder(request);
      },
      {
        prewarm: async (system: { stable: string; turn: string }, channel: string) => {
          warms.push({ ...system, channel, answering });
        },
      },
    );
    const { s, raw, heard } = demoSession(responder, SECRET, { keepWarmMs: 60 });
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    // At once, with the opening line: the stable prompt the turns will send, and nothing of the turn's own.
    expect(warms).toHaveLength(1);
    expect(warms[0]!).toMatchObject({ turn: "", channel: "voice", answering: false });
    expect(warms[0]!.stable).toContain("You are the AI assistant answering the phone for Lumen Aesthetics");
    await vi.waitFor(() => expect(warms.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
    await s.handle(said(1, [{ role: "agent", content: heard()[0]!.content }, { role: "user", content: "how much is botox" }]));
    expect(warms.every((w) => !w.answering)).toBe(true);
    await s.finish();
    const after = warms.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(warms.length).toBe(after);
  });

  test("a prospect's demo call sends no transcript anywhere", async () => {
    const transport = { name: "ses-fake", send: vi.fn(async () => ({ status: "sent" as const, messageId: "x" })) };
    const info = vi.spyOn(log, "info");
    const { s, raw, heard } = demoSession(model("Botox is $12 per unit here.").responder, SECRET, { transport });
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    await s.handle(said(1, [{ role: "agent", content: heard()[0]!.content }, { role: "user", content: "how much is botox" }]));
    await s.finish();
    expect(transport.send).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("retell demo call ended", expect.objectContaining({ status: "nothing_kept" }));
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
    expect(raw()[0]!.content).toMatch(/^Thanks for calling Lumen Aesthetics, this is Aya, the AI assistant, and this call's transcribed\./);
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
    expect(opening.content).toMatch(/^Thanks for calling Lumen Aesthetics, this is Aya, the AI assistant, and this call's transcribed\./);
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
