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
  DEMO_CALLBACK_OFFER,
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
  afterDemoReply,
  DEMO_START_PROGRESS,
  DEMO_TIME_ZONE,
  demoAssistantFacts,
  demoContextFromCall,
  demoDuration,
  demoOpenDays,
  demoPitchFacts,
  demoPrice,
  demoPriceList,
  bareCount,
  DEMO_BEATS,
  DEMO_OPENED_PROGRESS,
  demoRecovery,
  demoRoleplayOpener,
  shortClinicName,
  demoStateFrom,
  demoSalesPrompt,
  demoStageNote,
  demoTimeZone,
  nextDemoStage,
  ROLEPLAY_MAX_TURNS,
  withDemoAnswer,
  ANNOYED,
  DELEGATED,
  ROLE_SAID,
  buyingSignal,
  selling,
  type DemoProgress,
  type DemoStage,
} from "@/lib/voice/demo-facts";
import { CLOSE_WORDS } from "@/lib/voice/demo-cases";
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

/**
 * What the model is told on a demo turn: outside the role-play, healdesk's
 * own prompt and then the turn's note; in it, the note over the clinic's
 * front-desk prompt (demoSalesPrompt, demoStageNote).
 */
function told(ctx: DemoCallContext, stage: DemoStage, now: number, progress?: DemoProgress): string {
  const note = demoStageNote(ctx, stage, now, progress);
  return stage === "roleplay" ? note : `${demoSalesPrompt(ctx)}\n${note}`;
}

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

/** A demo's progress with the discovery questions answered: the close and the live discount are in its notes only from here. */
const COVERED: DemoProgress = {
  asked: null,
  answers: { goal: "missed calls", volume: "Five", volumeCheck: "yeah", missed: "voicemail", coverage: "after hours" },
  roleplayTurns: 0,
  said: [],
};

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

  test("one identity and a short prompt outside the role-play: healdesk's Aya, every standing rule said once, no close word before selling", () => {
    const now = Date.now();
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    const prompt = demoSalesPrompt(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }));
    // Owner, 31 October 2026, items 2, 3 and 16: no front-desk prompt and no second identity outside the role-play.
    expect(prompt).not.toContain("You are the AI assistant answering");
    expect(prompt).not.toMatch(/front desk who is good at their job/);
    expect(prompt.startsWith("You are healdesk's Aya, and the product they are hearing is you")).toBe(true);
    // The same text every turn of a call, so it is cached: no clock, no discount, no price list, no button.
    expect(prompt).toBe(demoSalesPrompt(context({ offer: null })));
    for (const word of CLOSE_WORDS) expect(prompt).not.toContain(word);
    expect(prompt).not.toMatch(/\$80 a month/);
    // Each turn carried about 2,500 words of front-desk prompt plus a 1,500 to 2,550 word note before; these bounds
    // keep the prompt and the notes from growing back one patch at a time (item 5): raising one is a deliberate change.
    expect(words(prompt)).toBeLessThan(2_300);
    // The note carries only the step and what this turn knows.
    const discovering = { asked: null, answers: { role: "owner", choice: "role-play", goal: "missed calls" }, roleplayTurns: 0, said: [], lastRoleplay: { caller: "bye", aya: "Take care!" } };
    expect(words(demoStageNote(context(), "intro", now))).toBeLessThan(300);
    expect(words(demoStageNote(context(), "pitch", now, discovering))).toBeLessThan(300);
    // Selling adds the price list and the close, still far short of the old note.
    const sellingNote = demoStageNote(context(), "pitch", now, { ...discovering, buying: true });
    expect(words(sellingNote)).toBeLessThan(600);
    // The priority, written once, so no two rules leave her guessing (item 4).
    expect(prompt).toContain("When two instructions seem to pull apart: the rules you never break come first, then this turn's note, then what they just said, then style.");
    // The human voice kept: the mood word, mirroring, the say-again, the name used at most twice.
    for (const kept of ["Feel first", "Mirror their energy and pace", 'say only something like "Sorry, say that again?"', "Use their first name at most twice"]) expect(prompt).toContain(kept);
  });

  test("a buying signal opens the value points and the close at any step, never inside the role-play", () => {
    const now = Date.now();
    for (const yes of ["How much does it cost?", "What's the price?", "How do we get started?", "What's next?", "What makes you better than the competition?", "If you were to improve yourself, what would you change?", "Honestly, we need this.", "Sounds great!", "How do I sign up?"]) {
      expect([yes, buyingSignal(yes)]).toEqual([yes, true]);
    }
    for (const no of ["I'm the owner.", "We get about five calls a day.", "They go to voicemail.", "I'm in Austin.", "I'm not interested.", "Pretty good.", "Yes, please."]) {
      expect([no, buyingSignal(no)]).toEqual([no, false]);
    }
    // In the intro: kept, and the stage moves on to the value and the close.
    const intro = withDemoAnswer({ ...DEMO_OPENED_PROGRESS, asked: "choice", answers: { identity: "yes", role: "owner" } }, "intro", "Before that, how much does it cost?");
    expect(intro.buying).toBe(true);
    expect(selling(intro)).toBe(true);
    expect(nextDemoStage("intro", "Voice starts at eighty dollars a month.", { buying: true })).toBe("pitch");
    expect(nextDemoStage("intro", "Let's do it, you be the patient.", { buying: true, roleplay: "start" })).toBe("roleplay");
    const note = demoStageNote(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "intro", now, intro);
    expect(note).toContain("They showed a buying signal: now value and the close.");
    expect(note).toContain("after answering what they just asked in one sentence");
    expect(note).toContain('"Want to get Lumen set up?"');
    expect(note).toContain("Aya Voice is $80 a month for every 100 minutes");
    expect(note).not.toContain("What's your role");
    // And the guard lets healdesk's prices through as soon as the note gives them.
    const facts = demoPitchFacts(demoAssistantFacts(context()), { offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }, now, intro);
    expect(guardAssistantReply("Setup is $697, and with your 50% off it's $349.", facts)).toEqual({ ok: true });
    // In the role-play "how much is it?" is the patient's question: nothing opens.
    const rp = withDemoAnswer({ ...DEMO_START_PROGRESS, roleplayTurns: 1 }, "roleplay", "How much is a HydraFacial?");
    expect(rp.buying).toBeUndefined();
    // Her own ear counts too, outside the role-play only.
    const heard = afterDemoReply(DEMO_START_PROGRESS, "pitch", "pitch", { asked: null, beats: [], callback: null, buying: true });
    expect(heard.buying).toBe(true);
    expect(afterDemoReply(DEMO_START_PROGRESS, "roleplay", "roleplay", { asked: null, beats: [], callback: null, buying: true }).buying).toBeUndefined();
    // A value point said in the intro, in the reply that moves the call on, is counted as said.
    expect(afterDemoReply(intro, "intro", "pitch", { asked: null, beats: ["anchor"], callback: null }).said).toEqual(["anchor"]);
    // A buyer reaches the close after three value points, not nine.
    const three = demoStageNote(context(), "pitch", now, { ...intro, said: ["pain", "reveal", "value"] });
    expect(three).toContain(`Next, the tie-down: "Anything that'd stop you from getting that running today?"`);
  });

  test("the intro note asks one thing at a time, the role then the owner's A/B choice, and starts the role-play in the same reply", () => {
    const now = Date.now();
    // The full name once, in the opening line; the short one after it (6i).
    // What she is told outside the role-play: healdesk's own prompt, then the turn's note (demoSalesPrompt, demoStageNote).
    const note = told(context(), "intro", now);
    expect(note).toContain("On the line: Sam, from Lumen Aesthetics");
    // One identity: healdesk's Aya, never the clinic's front desk outside the role-play.
    expect(note).not.toContain("You are the AI assistant answering the phone");
    expect(note).toContain('Call the clinic "Lumen": its full name, "Lumen Aesthetics", was said once in your opening line');
    expect(note).toContain("Next: greet them by name in a few words and ask their role at Lumen");
    // The opening line asked who it has: never again (owner's test call, 25 October 2026: "Am I speaking with Josh?", then "is this Josh?").
    expect(note).toContain("Your opening line already asked whether you're speaking with Sam: never ask it again");
    // Channels answered whole, from the catalog, and her structured state asked for.
    expect(note).toContain("If channels come up, however they ask");
    expect(note).toContain('"state": {"asked": the one question this reply asks');
    expect(note).toContain("What's your role at Lumen?");
    expect(note).toContain(`start it in the same reply, never a later one.`);
    expect(note).toContain(`To start one, write one short handover`);
    expect(note).toContain(`the call then says the opener itself, word for word ("${demoRoleplayOpener("Lumen Aesthetics")}")`);
    expect(note).toContain("ask which one they mean in a few words instead of choosing for them");
    expect(note).toContain('Say "your patients", never "our patients"');
    expect(note).toContain('write it exactly "Aya", never "AYA"');
    expect(note).toMatch(/no flirting/);
    // A buying signal skips ahead to the value and the close (owner, 31 October 2026).
    expect(note).toContain("Buying signals skip ahead:");
    expect(told(context({ firstName: null }), "intro", now)).toContain("On the line: the caller, from Lumen Aesthetics");

    // Their role is known: the A/B choice, never the role again, and no congratulations (owner's test call, 25 October 2026).
    const role = told(context(), "intro", now, { asked: null, answers: { role: "the owner" }, roleplayTurns: 0, said: [] });
    expect(role).toContain('- their role: "the owner"');
    expect(role).toContain("Never ask any of it again");
    expect(role).toContain("never congratulate them");
    expect(role).toContain("or jump straight into a quick role-play where you call in as a patient?");
    expect(role).not.toContain("Next: greet them by name");

    // Their choice is known, or left to Aya: she starts the role-play in that reply.
    const chose = told(context(), "intro", now, { asked: null, answers: { role: "the owner", choice: "whatever is best" }, roleplayTurns: 0, said: [] });
    expect(chose).toContain(`or leave it to you ("whatever's best"), start it in this same reply`);
    expect(chose).toMatch(/English and Spanish/);
    expect(chose).toMatch(/never mention a website, scraping or how you learned anything/);
  });

  test("the role-play note is brisk, takes a request with its name and number, ends only when they end it and never ends the call", () => {
    const note = demoStageNote(context(), "roleplay", Date.now());
    expect(note).toContain("Role-play: you are healdesk's Aya, playing Lumen's front desk to show Sam");
    expect(note).toContain("Every reply is at most one short sentence of reaction, and often none, then one short sentence of content");
    // c4093be6: the request "passed to the team" with no name or number.
    expect(note).toContain("you need four things, asked one at a time: the treatment, a day and time, their first name, and the best number to reach them");
    expect(note).toContain("Still needed before the request goes in: treatment, day and time, first name, number");
    expect(note).toContain("never a figure they said");
    // c4093be6: she ended the role-play herself while the patient was moving their booking.
    expect(note).toContain("The role-play ends only when they end it");
    expect(note).toContain("Never wrap it up or say goodbye on your own");
    expect(note).not.toContain("As soon as the request is taken");
    expect(note).toContain('add "roleplay": "end" to the state; the call then steps out of character itself with "And that\'s the role-play! So, how was that?"');
    expect(note).toContain('add "roleplay": "cancel"');
    expect(note).toContain('Never set "end" to true during the role-play');
    expect(note).not.toContain("run long enough");
    // No stage's script runs into another.
    expect(note).not.toMatch(/how many calls|What made you/);
    // A pushback on a price just quoted is about that price.
    expect(note).toContain("the pushback is about that price");
    expect(note).toContain('Never answer it with "I don\'t have a price for that one": you just gave one.');
    // Past the ceiling (a guard against a stuck role-play, never the way it ends), one exchange resolves where it stands, then it wraps.
    const long = demoStageNote(context(), "roleplay", Date.now(), { asked: null, answers: {}, roleplayTurns: ROLEPLAY_MAX_TURNS, said: [] });
    expect(long).toContain("The role-play has run long enough: resolve where it stands in this reply");
    expect(long).toContain('offer to take the booking request ("Want me to put that request in for you?"); the next reply then wraps up');
    const over = demoStageNote(context(), "roleplay", Date.now(), { asked: null, answers: {}, roleplayTurns: ROLEPLAY_MAX_TURNS + 1, said: [] });
    expect(over).toContain("The role-play is over now: in this reply, close where it stands in character");
  });

  test("after the role-play, discovery comes before the pitch, one next step at a time, never asking what was answered", () => {
    const now = Date.now();
    const lastRoleplay = { caller: "Sure, Friday morning.", aya: "Perfect, the team will confirm Friday morning." };
    const at = (answers: DemoProgress["answers"]) => told(context(), "pitch", now, { asked: null, answers, roleplayTurns: 0, said: [], lastRoleplay });
    const first = at({});
    expect(first).toContain("Learn what they need as a conversation");
    expect(first).toContain("No price, package or sign-up talk yet, unless they show a buying signal");
    expect(first).toContain('Next: take their reaction to the role-play in a few words (if they are unsure or not convinced, ask what would make it convincing for them), then find out what they are after: "What made you want to look at an AI assistant for Lumen?"');
    expect(first).toContain("never during a phone call, where you book and flag the deposit for the team, and after a booking call a clinic can turn on one text with its payment link, designed to go only if the caller agrees; nothing else is ever texted.");
    // Owner, 29 October 2026: no claim that she sends no texts at all, and she still never promises one herself.
    expect(first).not.toContain("never by text message");
    expect(first).toContain("Never say you will send a link, an email or a text");
    // No pitch until the questions are answered, or a buying signal.
    expect(first).not.toContain("Next: one value point");
    expect(first).not.toContain('"Want to get Lumen set up?"');
    // Capitals only in the rule against them, so nothing she copies spells it out.
    expect(first.replace('never "AYA"', "")).not.toContain("AYA");
    expect(first).toContain(`To start one, write one short handover`);

    const goal = at({ goal: "we miss calls when we're busy" });
    expect(goal).toContain(`- what they are after: "we miss calls when we're busy"`);
    expect(goal).toContain('Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"');

    // "Five" was heard: never "how many calls" again (owner's test call, 25 October 2026); Mon-Fri on the website: five days.
    const volume = at({ goal: "missed calls", volume: "Five." });
    expect(volume).toContain('- calls a day: "Five."');
    expect(volume).not.toContain('then ask: "Generally, how many calls do you get a day?"');
    expect(volume).toContain(`Next: Check the total with them, close to these words: "I see you're open 5 days a week, so would it be fair to say about [their calls a day times 5] calls a week`);

    const checked = at({ goal: "missed calls", volume: "Five.", volumeCheck: "yeah" });
    expect(checked).toContain(`Next: ask: "What happens with those calls after hours, or when your team's busy with patients?"`);
    const missed = at({ goal: "missed calls", volume: "Five.", volumeCheck: "yeah", missed: "they go missed" });
    expect(missed).toContain("after-hours only, picking up when the lines are busy, or handling everything that comes in?");

    // Only now the pitch: what she does, in their terms, the package, and the ask.
    const pitch = at({ goal: "missed calls", volume: "Five.", volumeCheck: "yeah", missed: "they go missed", coverage: "after hours" });
    expect(pitch).toContain('Next: one value point. Pick the unsaid one that best fits what they just said; if none fits better, "pain".');
    expect(pitch).toContain("The value points (each said once");
    expect(pitch).toContain("Aya Voice, Aya Web Chat, Aya Meta Chat");
    expect(pitch).toContain('"Want to get Lumen set up?"');

    // Hours it cannot read: no number of days is said, and the check is skipped.
    const unread = told(context({ clinic: { ...context().clinic, hours: [{ days: "Most days", hours: "by arrangement" }] } }), "pitch", now, {
      asked: null,
      answers: { goal: "x", volume: "Five." },
      roleplayTurns: 0,
      said: [],
    });
    expect(unread).not.toMatch(/you're open \d days/);
    expect(unread).toContain(`Next: ask: "What happens with those calls after hours`);
  });

  test("the owner's pitch: beat by beat in order, each once, then the tie-down, the close and a truthful way out", () => {
    const now = Date.now();
    const offer = { percentOfSetupFee: 50, endsAt: now + 47 * 3_600_000 };
    const discovered = { goal: "missed calls", volume: "Five.", volumeCheck: "yeah", missed: "they go to voicemail", coverage: "after hours" };
    const at = (said: DemoProgress["said"], extra: DemoProgress["answers"] = {}) =>
      told(context({ offer }), "pitch", now, { asked: null, answers: { ...discovered, ...extra }, roleplayTurns: 0, said });
    const start = at([]);
    // In the owner's order.
    const order = ["are the ones I'd pick up", "it's not just the phone", "you keep your own number", "quick read of your public website", "a receptionist runs $3,900 to $4,800 a month", "a HydraFacial at $199", "looks like the fit", "no strings attached", "cancel within your first 14 days"];
    const positions = order.map((words) => start.indexOf(words));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // The discount is the live one checkout applies, said exactly.
    expect(start).toContain(`When you say "finish", add: "And finishing now gets you 50% off the setup fee, for the next 47 hours."`);
    // Booking and the deposit link are still being built: what she is designed to do.
    expect(start).toContain("I'm designed to book straight into your calendar");
    expect(start).toContain("I'm designed to send your own deposit link as they book");
    // The terms' refund, never more generous; the setup fee is never refunded.
    expect(start).toContain("cancel within your first 14 days and your first subscription period is refunded in full; only the setup fee is firm");
    expect(start).not.toMatch(/first month's subscription is fully refundable/);

    // Each beat said is marked and the next one named.
    const twoSaid = at(["pain", "reveal"]);
    expect(twoSaid).toContain('if none fits better, "number".');
    expect(twoSaid).toContain("Value points already said (never again): pain, reveal. Unsaid: number, finish, anchor, value, recommend, noStrings, refund.");
    // After every beat: the tie-down, then the ask.
    expect(at([...DEMO_BEATS])).toContain(`Next, the tie-down: "Anything that'd stop you from getting that running today?"`);
    expect(at([...DEMO_BEATS], { tiedown: "not really" })).toContain('then ask for it plainly: "Want to get Lumen set up?"');
    // The close repeats the live discount; a hesitant owner is offered a call
    // from the team (demo-callback.ts), and turning it down gets the page's
    // button and hello@. The note never lets her say the team has it: the
    // call says so itself, once apps/web took it.
    expect(start).toContain("Say the discount exactly so: 50% off the setup fee, for the next 47 hours.");
    expect(start).toContain("you can reach the team at hello at healdesk dot io");
    expect(start).toContain(`say exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback)`);
    expect(start).toContain("never say the team has been told, has their number or will call (the call says so itself when they have)");
    // No live discount: none is named.
    const noOffer = told(context({ offer: null }), "pitch", now, { asked: null, answers: discovered, roleplayTurns: 0, said: [] });
    expect(noOffer).not.toMatch(/real discount|% off the setup fee/);
  });

  test("every line of the pitch passes the guard in the pitch, and the cost anchor is refused anywhere else", () => {
    const now = Date.now();
    const facts = demoAssistantFacts(context());
    const pitch = demoPitchFacts(facts, { offer: { percentOfSetupFee: 50, endsAt: now + 47 * 3_600_000 } }, now);
    const lines = [
      "So those 100 calls a month that go to voicemail after hours, those are the ones I'd be picking up.",
      "Here's what you haven't seen on this call: I answer 24/7, bilingual, English and Spanish, and it's not just the phone. The same me is built to cover your website chat, Instagram, Messenger and WhatsApp. One assistant, every way a patient reaches you.",
      "And you keep your own number: your calls just forward to me, nothing to switch.",
      "Right now I'm working off a quick read of your public website, so you're only seeing part of what I can do. Finishing it takes about fifteen minutes of your time: we connect your calendar and your real menu, and from then on I work from your actual systems and I'm designed to book straight into your calendar, not just take a request.",
      "And there's a real discount on finishing it right now: 50% off the setup fee, for the next 47 hours.",
      "For context, a full-time receptionist runs $3,900 to $4,800 a month loaded, and most answering services are $400 to $1,500 and still can't book or quote your menu.",
      "Every one of those calls that books is, say, a HydraFacial at $199. Can't promise a number, but that's the shape of it.",
      "In chat and messages I'm designed to send your own deposit link as they book.",
      "Based on what you've told me, Aya Voice at 300 minutes looks like the fit.",
      "You've already tried it, no strings attached.",
      "If it's not a fit once you're live, cancel within your first 14 days and your first subscription period is refunded in full; only the setup fee is firm.",
      "Anything that'd stop you from getting that running today?",
      "Want to get Lumen set up? Just tap Book Onboarding at the top of your demo page, and your 50% off the setup fee is already applied, for the next 47 hours.",
      "No problem at all. Whenever you're ready, Book Onboarding is right there on your demo page, and you can reach the team at hello at healdesk dot io if you'd like to talk it through.",
    ];
    for (const line of lines) expect([line, guardAssistantReply(line, pitch)]).toEqual([line, { ok: true }]);
    // The anchor's figures are healdesk's context, never a treatment price: refused outside the pitch.
    expect(guardAssistantReply(lines[5]!, facts)).toMatchObject({ ok: false, reason: "price" });
    // A bare count of their calls is no dose here (the unit-less dose pattern stands aside for business talk only).
    expect(guardAssistantReply("Five a day, got it. So about 25 calls a week, or around 110 a month?", pitch)).toEqual({ ok: true });
    expect(guardAssistantReply("Five a day, got it. So about 25 calls a week, or around 110 a month?", facts)).toMatchObject({ ok: false, reason: "clinical" });
  });

  test("the session keeps each answer from her structured state update and the caller's next words, never from her prose", () => {
    // The state update in the details, each value checked against the lists.
    expect(demoStateFrom({ asked: "volume", beats: [] }, "Generally, how many calls do you get a day?")).toEqual({ asked: "volume", beats: [], callback: null, pushback: null, skip: null, resume: false, quirks: [], roleplay: null, answered: [], impatient: false, booking: null, buying: false });
    expect(demoStateFrom({ asked: "coverage", beats: ["pain", "nonsense"] }, "How do you see me helping you best?")).toEqual({ asked: "coverage", beats: ["pain"], callback: null, pushback: null, skip: null, resume: false, quirks: [], roleplay: null, answered: [], impatient: false, booking: null, buying: false });
    // A question counts only in a reply that asks one; an unknown or the opening's own question never.
    expect(demoStateFrom({ asked: "volume" }, "Got it, five a day.")).toEqual({ asked: null, beats: [], callback: null, pushback: null, skip: null, resume: false, quirks: [], roleplay: null, answered: [], impatient: false, booking: null, buying: false });
    expect(demoStateFrom({ asked: "bogus" }, "What?")).toEqual({ asked: null, beats: [], callback: null, pushback: null, skip: null, resume: false, quirks: [], roleplay: null, answered: [], impatient: false, booking: null, buying: false });
    expect(demoStateFrom({ asked: "identity" }, "Is this Josh?")).toEqual({ asked: null, beats: [], callback: null, pushback: null, skip: null, resume: false, quirks: [], roleplay: null, answered: [], impatient: false, booking: null, buying: false });
    // No state at all is not a state.
    expect(demoStateFrom(null, "Generally, how many calls do you get a day?")).toBeNull();
    expect(demoStateFrom(["volume"], "How many?")).toBeNull();

    // Her prose alone moves nothing: "how many calls" with no state asks nothing.
    let p = afterDemoReply(DEMO_START_PROGRESS, "pitch", "pitch", null);
    expect(p.asked).toBeNull();
    p = afterDemoReply(p, "pitch", "pitch", { asked: "volume", beats: [], callback: null });
    expect(p.asked).toBe("volume");
    p = withDemoAnswer(p, "pitch", "Five.");
    expect(p.answers.volume).toBe("Five.");
    p = afterDemoReply(p, "pitch", "pitch", { asked: null, beats: [], callback: null });
    expect(p).toMatchObject({ asked: null, answers: { volume: "Five." } });
    // A role-play counts the caller's turns from its start.
    p = afterDemoReply(p, "pitch", "roleplay", { asked: null, beats: [], callback: null });
    p = withDemoAnswer(withDemoAnswer(p, "roleplay", "hi"), "roleplay", "botox please");
    expect(p.roleplayTurns).toBe(2);
    expect(p.answers.volume).toBe("Five.");
    // The opening line's question is answered by the caller's first words.
    expect(withDemoAnswer(DEMO_OPENED_PROGRESS, "intro", "Yeah, that's me.").answers.identity).toBe("Yeah, that's me.");
    // A bare count reads as a number; anything more does not.
    expect([bareCount("Five."), bareCount("12"), bareCount("about 20"), bareCount("five or six"), bareCount(undefined)]).toEqual([5, 12, 20, null, null]);
  });

  test("a greeting in answer to \"Who am I speaking with?\" is answered and the question asked once more (transcript a17b5aff)", () => {
    const greeted = withDemoAnswer(DEMO_OPENED_PROGRESS, "intro", "Hey. How are you?");
    expect(greeted.answers.identity).toBeUndefined();
    expect(greeted.greetedOnly).toBe(true);
    // Her reply asks again with no state question: the opening question stays asked.
    const after = afterDemoReply(greeted, "intro", "intro", { asked: null, beats: [], callback: null });
    expect(after.asked).toBe("identity");
    expect(demoStageNote(context({ firstName: null }), "intro", Date.now(), greeted)).toContain("they greeted you without saying who they are");
    // With a name on the demo, the opening already asked for them by name: no second ask.
    expect(demoStageNote(context(), "intro", Date.now(), greeted)).not.toContain("they greeted you without saying who they are");
    // Asked once more only: a second greeting is taken as it comes.
    expect(withDemoAnswer(after, "intro", "Hi!").answers.identity).toBe("Hi!");
    expect(withDemoAnswer(DEMO_OPENED_PROGRESS, "intro", "Hey, it's Dana.").answers.identity).toBe("Hey, it's Dana.");
  });

  test("a role, annoyance and a choice left to her are read in code (transcript 8c19fd93)", () => {
    for (const words of ["Hey. I'm the owner.", "I already told you I'm the owner. Are you deaf?", "This is the practice manager.", "I run the place."]) expect(ROLE_SAID.test(words), words).toBe(true);
    for (const words of ["Yeah, that's me.", "Hi, how are you?", "I'm good, thanks.", "I run late most days."]) expect(ROLE_SAID.test(words), words).toBe(false);
    for (const words of ["Are you deaf?", "Are you daft?", "I already told you.", "How many times do I have to say it?"]) expect(ANNOYED.test(words), words).toBe(true);
    for (const words of ["Tell me more.", "Sure, let's do the role play.", "We miss a lot of calls."]) expect(ANNOYED.test(words), words).toBe(false);
    for (const words of ["Yeah. Whatever.", "Up to you.", "Either is fine", "You pick", "I don't mind."]) expect(DELEGATED.test(words), words).toBe(true);
    for (const words of ["Tell me what you do.", "The role-play.", "Whatever you do, don't sell me."]) expect(DELEGATED.test(words), words).toBe(false);
    // Annoyance answers nothing, but the role in it is kept.
    const asked = { ...DEMO_OPENED_PROGRESS, asked: "role" as const };
    const told = withDemoAnswer(asked, "intro", "I already told you I'm the owner. Are you deaf?");
    expect(told.annoyed).toBe(true);
    expect(told.answers.role).toBe("I already told you I'm the owner. Are you deaf?");
    const choice = withDemoAnswer({ ...DEMO_OPENED_PROGRESS, asked: "choice", answers: { role: "owner" }, choiceAsks: 1 }, "intro", "Are you deaf?");
    expect(choice.answers.choice).toBeUndefined();
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

  test("before coverage is answered no note at any stage holds the close or the live discount, and the guard refuses a discounted fee", () => {
    const now = Date.now();
    const offer = { percentOfSetupFee: 50, endsAt: now + 40 * 3_600_000 };
    const partial: DemoProgress = { asked: "missed", answers: { goal: "missed calls", volume: "Five", volumeCheck: "yeah" }, roleplayTurns: 0, said: [...DEMO_BEATS] };
    for (const stage of ["intro", "roleplay", "pitch"] as const) {
      for (const ctx of [context({ offer }), context({ offer, buyButton: "Get AYA" }), context({ offer: null })]) {
        const note = demoStageNote(ctx, stage, now, partial);
        for (const words of CLOSE_WORDS) expect([stage, words, note.includes(words)]).toEqual([stage, words, false]);
        expect(note).not.toContain("Get Aya");
        expect(note).not.toMatch(/50%|\$349|\$697 with/);
      }
    }
    // The discounted fee is refused before coverage, let through after.
    const facts = demoAssistantFacts(context({ offer }));
    expect(guardAssistantReply("Setup is $697, and with your 50% off it's $349.", demoPitchFacts(facts, { offer }, now, partial))).toMatchObject({ ok: false, reason: "price" });
    const covered: DemoProgress = { ...partial, answers: { ...partial.answers, missed: "voicemail", coverage: "after hours" } };
    expect(guardAssistantReply("Setup is $697, and with your 50% off it's $349.", demoPitchFacts(facts, { offer }, now, covered))).toEqual({ ok: true });
    expect(demoStageNote(context({ offer }), "pitch", now, covered)).toContain('"Want to get Lumen set up?"');
  });

  test("twice refused after the role-play: an honest skip, then the next question, never the clinicians' line", () => {
    const at = (answers: DemoProgress["answers"]) => demoRecovery(context(), { asked: null, answers, roleplayTurns: 0, said: [] });
    // An honest skip and a real question, never filler (c4093be6: "Anyway, where were we?" in place of ten answers).
    expect(at({ goal: "x", volume: "Five" })).toEqual({
      line: "I'll skip that one. You said 5 calls a day, so would it be fair to say about 25 calls a week?",
      alternate: "Let me not guess at that one. You said 5 calls a day, so would it be fair to say about 25 calls a week?",
      bridge: "So would it be fair to say about 25 calls a week?",
      asks: "volumeCheck",
    });
    expect(at({}).asks).toBe("goal");
    expect(at({ goal: "x", volume: "a lot" }).line).toContain("Roughly how many calls a week would you say that comes to?");
    expect(at({ goal: "x", volume: "5", volumeCheck: "y" }).asks).toBe("missed");
    expect(at({ goal: "x", volume: "5", volumeCheck: "y", missed: "z" }).asks).toBe("coverage");
    expect(at({ goal: "x", volume: "5", volumeCheck: "y", missed: "z", coverage: "all" }).asks).toBe("tiedown");
    for (const r of [at({}), at({ goal: "x", volume: "Five" })]) expect(r.line).not.toMatch(/clinician|consultation/);
  });

  test("the pitch note mentions a live discount only while it is live, as a percentage, a window and the discounted fees", () => {
    const now = Date.now();
    const live = demoStageNote(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "pitch", now, COVERED);
    expect(live).toMatch(/50% off healdesk's setup fee, with about 10 hours left on it/);
    expect(live).toMatch(/already applied at checkout/);
    expect(live).toMatch(/never a different number or a different amount of time/);
    const almostOver = demoStageNote(context({ offer: { percentOfSetupFee: 30, endsAt: now + 30 * 60_000 } }), "pitch", now, COVERED);
    expect(almostOver).toMatch(/30% off healdesk's setup fee, with about 1 hour left on it\b/);
    for (const offer of [{ percentOfSetupFee: 50, endsAt: now - 1_000 }, null]) {
      expect(demoStageNote(context({ offer }), "pitch", now, COVERED)).not.toMatch(/% off healdesk's setup fee/);
    }
    // Only the pitch carries it.
    const intro = demoStageNote(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "intro", now);
    expect(intro).not.toMatch(/% off/);
  });

  test("the closer quotes healdesk's real prices, closes on the page's own button, and promises nothing it cannot send", () => {
    const now = Date.now();
    const note = told(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "pitch", now, COVERED);
    // From the catalog: $80, $40 and $60 for every 100; setup per package, discounted per package as checkout rounds it.
    expect(note).toContain("Aya Voice is $80 a month for every 100 minutes; Aya Web Chat $40 a month for every 100 conversations; Aya Meta Chat, website chat included, $60 a month for every 100 conversations");
    expect(note).toContain("Aya Voice $697 ($349 with their 50% off)");
    expect(note).toContain("Aya Voice plus Meta Chat $1,394 ($697 with their 50% off)");
    expect(note).toContain("The monthly price only starts the day you first answer one of their patients");
    expect(note).toContain('"Want to get Lumen set up?"');
    expect(note).toContain('"Just tap Book Onboarding at the top of your demo page, and your 50% off the setup fee is already applied, for the next 10 hours."');
    // Asked, and they hesitated: one doubt answered, asked once more.
    const asked = told(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "pitch", now, {
      asked: null,
      answers: { goal: "x", volume: "5", volumeCheck: "yes", missed: "voicemail", coverage: "after hours", tiedown: "no", ask: "maybe" },
      roleplayTurns: 0,
      said: [...DEMO_BEATS],
    });
    expect(asked).toContain("If they hesitate, answer the one thing holding them back and ask once more.");
    // Prepared answers to the doubts that recur, never improvised.
    for (const doubt of ["- Price:", "- Checking with a partner, or they already have someone on the phones:", "- Patients minding an AI:", "- Not convinced:", 'Owner: "I\'d have to check with my partner."', 'Owner: "We already have a receptionist."']) expect(asked).toContain(doubt);
    expect(note).toContain("Never say you will send a link, an email or a text, and never take payment details on the call.");
    expect(note).toContain('"We sign a business associate agreement and handle patient data under it", never "HIPAA compliant"');
    // A booking's value in the clinic's own terms, never revenue.
    // The pitch, once discovery is done: a booking's value in the clinic's own terms, never revenue.
    const pitched = told(context({ offer: { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 } }), "pitch", now, {
      asked: null,
      answers: { goal: "x", volume: "5", volumeCheck: "yes", missed: "voicemail", coverage: "after hours" },
      roleplayTurns: 0,
      said: [],
    });
    expect(pitched).toContain("a HydraFacial at $199");
    expect(pitched).toContain("Never call it revenue, profit or money they will make");
    // The homepage demo's button is "Get AYA" on the page, said "Get Aya"; a browser demo points at the chat on the page.
    const selfServe = told(context({ buyButton: "Get AYA", offer: null }), "pitch", now, COVERED);
    expect(selfServe).toContain('"Just tap Get Aya at the top of your demo page."');
    const discovered = { asked: null, answers: { goal: "x", volume: "5", volumeCheck: "yes", missed: "voicemail", coverage: "after hours" }, roleplayTurns: 0, said: [] };
    expect(told(context({ buyButton: "Get AYA", offer: null }), "pitch", now, discovered)).toContain("try you in chat too, right there on their demo page");
    expect(told(context({ mode: "phone" }), "pitch", now, discovered)).not.toContain("try you in chat too");
    // No button on the page: nothing to tap.
    expect(told(context({ buyButton: null }), "pitch", now, COVERED)).toContain("the healdesk team will help them get started");
  });

  test("healdesk's prices pass the guard only in the pitch, exactly, and never during the role-play", () => {
    const now = Date.now();
    const offer = { percentOfSetupFee: 50, endsAt: now + 10 * 3_600_000 };
    const facts = demoAssistantFacts(context());
    const pitch = demoPitchFacts(facts, { offer }, now, COVERED);
    for (const line of [
      "Aya Voice is $80 a month for every 100 minutes.",
      "For 500 minutes that's $400 a month, and with 300 chats on Meta it's $580.",
      "Setup is $697, and with your 50% off it's $349.",
      "Voice plus Meta Chat is $1,394 to set up, $697 with your discount.",
    ]) {
      expect([line, guardAssistantReply(line, pitch)]).toEqual([line, { ok: true }]);
      // In the intro or the role-play the same figures are an off-menu price.
      expect(guardAssistantReply(line, facts)).toMatchObject({ ok: false });
    }
    // A figure the catalog does not give is refused even in the pitch: $348 is not 50% off $697, and $698 is not the package's discount.
    expect(guardAssistantReply("Setup is just $348 with your discount.", pitch)).toMatchObject({ ok: false });
    expect(guardAssistantReply("Voice plus Meta Chat is $698 with your discount.", pitch)).toMatchObject({ ok: false });
    // Checkout rounds each package's discount up, and so does the list.
    expect(demoPriceList(offer, now).amounts).toEqual(expect.arrayContaining([349, 130, 478, 697, 1394, 956, 64, 32, 48]));
    expect(demoPriceList({ percentOfSetupFee: 30, endsAt: now + 1_000 }, now).amounts).toEqual(expect.arrayContaining([488, 182, 670, 976]));
    expect(demoPriceList(null, now).amounts).not.toContain(349);
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

  test("the stage moves on her state's signal or the whole scripted line, never a phrase in passing (72dc66b7), and the open days come from hours it can read", () => {
    expect(nextDemoStage("intro", "Would you like to hear more, or jump into a role-play?")).toBe("intro");
    expect(nextDemoStage("intro", demoRoleplayOpener("Lumen Aesthetics"))).toBe("roleplay");
    expect(nextDemoStage("intro", "Let's do it, you be the patient.", { roleplay: "start" })).toBe("roleplay");
    // A bare "Ring ring!" no longer starts one, nor a passing "how was that?" ends one.
    expect(nextDemoStage("intro", "Sure! Ring ring!")).toBe("intro");
    // Her handover said as a statement starts one with no signal (084f10d4); offered in a question, never.
    expect(nextDemoStage("intro", "Let's do it, you be the patient. Go ahead and call in whenever you're ready.")).toBe("roleplay");
    expect(nextDemoStage("intro", "Want a quick role-play where you're the patient?")).toBe("intro");
    expect(nextDemoStage("intro", "Let's do it, you be the patient.", { roleplay: "cancel" })).toBe("intro");
    // Past the wrap-up turn it ends, whatever she wrote.
    expect(nextDemoStage("roleplay", "Sure, see you then.", {}, "intro", ROLEPLAY_MAX_TURNS + 2)).toBe("pitch");
    expect(nextDemoStage("roleplay", "Sure, see you then.", {}, "intro", 6)).toBe("roleplay");
    expect(nextDemoStage("roleplay", "Sure, Friday at 3 works. Anything else?")).toBe("roleplay");
    expect(nextDemoStage("roleplay", "See you then! Ok, how was that? Haha!")).toBe("roleplay");
    expect(nextDemoStage("roleplay", "See you then!", { roleplay: "end" }, "intro", 2)).toBe("pitch");
    expect(nextDemoStage("roleplay", "See you then! And that's the role-play! So, how was that?")).toBe("pitch");
    // An end with no in-character exchange, or a cancel, goes back where it came from, with no exit line.
    expect(nextDemoStage("roleplay", "Oh, sorry!", { roleplay: "end" }, "intro", 0)).toBe("intro");
    expect(nextDemoStage("roleplay", "My mistake!", { roleplay: "cancel" }, "pitch", 1)).toBe("pitch");
    // A second role-play from the pitch, and the pitch straight from the intro when the role-play is skipped.
    expect(nextDemoStage("pitch", demoRoleplayOpener("Lumen Aesthetics"))).toBe("roleplay");
    // From the intro to the pitch only on a declared discovery question, never on her words alone.
    expect(nextDemoStage("intro", "Sure! Generally, how many calls do you get a day?", { asked: "volume" })).toBe("pitch");
    expect(nextDemoStage("intro", "Sure! What made you want to look at an AI assistant for Lumen Aesthetics?", { asked: "goal" })).toBe("pitch");
    expect(nextDemoStage("intro", "Sure! Generally, how many calls do you get a day?")).toBe("intro");
    expect(nextDemoStage("intro", "Great! What's your role?", { asked: "role" })).toBe("intro");
    expect(nextDemoStage("roleplay", "Generally, how many calls do you get a day?")).toBe("roleplay");
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
    expect(m.seen[0]!.turn).toContain("Where the call is: the start. Sam is on Lumen's team");
    expect(m.seen[0]!.turn).toContain(`You opened the conversation with: "Hi! This is Aya`);
    // Outside the role-play she is healdesk's Aya on healdesk's own prompt, never the clinic's front desk
    // (owner, 31 October 2026); the guard reads her words against the clinic's facts as on any call.
    expect(m.seen[0]!.stable).toContain("You are healdesk's Aya, and the product they are hearing is you");
    expect(m.seen[0]!.stable).toContain("Treatments: Botox ($12/unit)");
    expect(m.seen[0]!.stable).not.toContain("You are the AI assistant answering the phone");

    // No role-play until its opener is said; "how much" was a buying signal, so the call is selling.
    await s.handle(said(2, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: "can I book one for Friday" }]));
    expect(m.seen).toHaveLength(2);
    expect(m.seen[1]!.turn).toContain("They showed a buying signal: now value and the close.");
    expect(m.seen[1]!.turn).not.toContain("Role-play: you are healdesk's Aya");
    expect(m.seen[1]!.stable).toContain("You are healdesk's Aya");

    expect(await s.finish()).toBeNull();
    expect(touched).toEqual([]);
    expect(tenant.calls).toBe(0);
    expect(ops.calls).toEqual([]);
  });

  test("walks intro, role-play and pitch on Aya's own lines, and a goodbye inside the role-play never hangs up", async () => {
    const replies: [string, boolean, Record<string, unknown>?][] = [
      ["Great to meet you, Sam! What's your role at Lumen Aesthetics?", false],
      // The start is her state's signal; the call says the opener itself (72dc66b7).
      ["Let's do it, you be the patient.", false, { asked: null, beats: [], roleplay: "start" }],
      // The patient says bye and the model marks the end: the demo goes on, and the call says the exit line.
      ["Perfect, we'll see you Friday!", true, { asked: null, beats: [], roleplay: "end" }],
      ["Generally, how many calls do you get a day?", false],
      ["Thanks so much, Sam, have a great day!", true],
    ];
    const seen: string[] = [];
    const responder: AssistantResponder = async ({ system }) => {
      seen.push((system as { turn: string }).turn);
      const [text, end, state] = replies[seen.length - 1]!;
      return `${text}\n###\n${JSON.stringify({ handoff: false, end, ...(state ? { state } : {}) })}`;
    };
    const { s, raw, heard } = demoSession(responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    const words = ["yes it's me", "I'm the owner, let's do the role-play", "hi, can I book a HydraFacial Friday? bye!", "that was great", "about 20, thanks, bye"];
    for (const [i, text] of words.entries()) {
      await s.handle(said(i + 1, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: text }]));
    }
    expect(seen[0]).toContain("Where the call is: the start.");
    expect(seen[1]).toContain("Where the call is: the start.");
    expect(seen[2]).toContain("Role-play: you are healdesk's Aya, playing Lumen's front desk");
    expect(seen[3]).toContain("Where the call is: after the role-play");
    expect(seen[4]).toContain("Where the call is: after the role-play");
    const spoken = heard();
    expect(spoken.map((r) => r.content).join(" ")).toContain(`Let's do it, you be the patient. ${demoRoleplayOpener("Lumen Aesthetics")}`);
    expect(spoken.find((r) => r.content.includes("how was that"))!.content).toContain("Perfect, we'll see you Friday! And that's the role-play! So, how was that?");
    expect(spoken.find((r) => r.content.includes("how was that"))!.end_call).toBe(false);
    expect(spoken.at(-1)).toMatchObject({ content: "Thanks so much, Sam, have a great day!", end_call: true });
    await s.finish();
  });

  test("an answer is never asked for again: the next turn's note carries it, and the role-play runs until it is done, not on a count of four", async () => {
    const replies: [string, string | null][] = [
      ["Great to meet you, Sam! What's your role at Lumen Aesthetics?", "role"],
      ["Would you like to hear what I can do for Lumen Aesthetics, or jump straight into a quick role-play where you call in as a patient?", "choice"],
      [`Let's do it, you be the patient. ${demoRoleplayOpener("Lumen Aesthetics")}`, null],
      ["We have HydraFacials and Botox. Which one are you after?", null],
      ["Lovely, what day suits you?", null],
      ["Perfect, Friday it is.", null],
      ["The team will confirm the time. Take care! And that's the role-play! So, how was that?", null],
      ["Glad you liked it. What made you want to look at an AI assistant for Lumen Aesthetics?", "goal"],
      ["Makes sense. Generally, how many calls do you get a day?", "volume"],
      ["Five a day, got it.", null],
    ];
    const seen: string[] = [];
    const responder: AssistantResponder = async ({ system }) => {
      seen.push((system as { turn: string }).turn);
      const [text, asked] = replies[seen.length - 1]!;
      return `${text}\n###\n${JSON.stringify({ handoff: false, end: false, state: { asked, beats: [] } })}`;
    };
    const { s, raw, heard } = demoSession(responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    const words = ["yes it's me", "I'm the owner", "whatever is best", "hi, what do you have", "a HydraFacial", "Friday", "morning please, that's all, thanks", "pretty good", "we miss calls when we're busy", "Five."];
    for (const [i, text] of words.entries()) {
      await s.handle(said(i + 1, [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: text }]));
    }
    // The role, once said, is known and never asked again.
    expect(seen[1]).toContain('- their role: "I\'m the owner"');
    expect(seen[1]).not.toContain("Next: greet them by name");
    // Four of the patient's turns is no longer a wrap-up (step 4): the role-play ends when the patient signs off (c4093be6).
    expect(seen[5]).not.toContain("run long enough");
    expect(seen[6]).not.toContain("run long enough");
    // After it, discovery first, and "Five" is kept: never "how many calls" again.
    expect(seen[7]).toContain("Next: take their reaction to the role-play");
    expect(seen[8]).toContain(`- what they are after: "we miss calls when we're busy"`);
    expect(seen[9]).toContain('- calls a day: "Five."');
    expect(seen[9]).not.toContain('then ask: "Generally, how many calls do you get a day?"');
    await s.finish();
  });

  test("a reply dropped unheard takes back the stage it moved: a 'Ring ring!' nobody heard starts no role-play", async () => {
    const replies: [string, string | null][] = [
      ["Great to meet you, Sam! What's your role at Lumen Aesthetics?", "role"],
      [`Let's do it, you be the patient. ${demoRoleplayOpener("Lumen Aesthetics")}`, null],
      ["Got it. Would you like to hear what I can do for Lumen Aesthetics, or jump straight into a quick role-play where you call in as a patient?", "choice"],
    ];
    const seen: string[] = [];
    const responder: AssistantResponder = async ({ system }) => {
      seen.push((system as { turn: string }).turn);
      const [text, asked] = replies[seen.length - 1]!;
      return `${text}\n###\n${JSON.stringify({ handoff: false, end: false, state: { asked, beats: [] } })}`;
    };
    const { s, raw, heard } = demoSession(responder);
    await s.open();
    await s.handle(details({ retell_llm_dynamic_variables: { demo_context: sealed() } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    const opening = raw()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "yes it's me" }]));
    const question = heard().at(-1)!.content;
    await s.handle(said(2, [{ role: "agent", content: opening }, { role: "user", content: "yes it's me" }, { role: "agent", content: question }, { role: "user", content: "I'm the owner" }]));
    // They carried on before the role-play opener was heard: it never happened.
    const whole = "I'm the owner, but before any role-play I'd like to hear what you do";
    await s.handle(said(3, [{ role: "agent", content: opening }, { role: "user", content: "yes it's me" }, { role: "agent", content: question }, { role: "user", content: whole }]));
    expect(seen[2]).toContain("Where the call is: the start.");
    expect(seen[2]).not.toContain("Role-play: you are healdesk's Aya");
    expect(seen[2]).toContain(`- their role: "${whole}"`);
    await s.finish();
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
    expect(warms[0]!.stable).toContain("You are healdesk's Aya, and the product they are hearing is you");
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
