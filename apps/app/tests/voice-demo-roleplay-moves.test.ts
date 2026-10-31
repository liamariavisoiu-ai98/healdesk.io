import { describe, expect, test } from "vitest";

import { routedAgainLine, guardedLine, routingProvider } from "@/lib/assistant/guard";
import { endsWithAbbreviation, shapeVoiceReply } from "@/lib/assistant/turn";
import { DEMO_CASE_CLINIC } from "@/lib/voice/demo-cases";
import {
  DEMO_START_PROGRESS,
  demoAssistantFacts,
  demoRoleplayFacts,
  demoStageNote,
  DISCOUNT_SAID,
  PATIENT_BYE,
  requestedTime,
  roleplayCheckedReply,
  roleplayEndAllowed,
  roleplayMove,
  roleplayTimeLine,
  speaksAsPatient,
  withDemoAnswer,
  type DemoProgress,
} from "@/lib/voice/demo-facts";

/**
 * The role-play's moves and the booking's checks that the call makes in
 * code since demo call c4093be6 (31 October 2026), each against the words
 * that must trigger it and the owner's words that must not. The whole call
 * is replayed in voice-demo-c4093be6.test.ts.
 */

const at = (over: Partial<DemoProgress> = {}): DemoProgress => ({ ...DEMO_START_PROGRESS, ...over });
const SERVICES = DEMO_CASE_CLINIC.services.map((s) => s.name);
/** Friday, October 30, 2026, 11 AM in Austin. */
const ISSUED = Date.parse("2026-10-30T16:00:00Z");
const context = { clinic: DEMO_CASE_CLINIC, issuedAt: ISSUED };

describe("the role-play's moves, in code", () => {
  test("in a role-play: a stop ends it, an ask restarts it, a patient's words do neither", () => {
    for (const w of ["Stop the role play.", "Okay, enough role play.", "Let's end the role-play now", "I'm done with the role play", "break character for a sec"]) {
      expect(roleplayMove("roleplay", w, at()), w).toBe("stop");
    }
    for (const w of ["I want to do the role play again.", "Let's do the role play.", "Can we start the role play over?"]) expect(roleplayMove("roleplay", w, at()), w).toBe("restart");
    for (const w of ["I need to cancel my appointment.", "How much is Botox?", "No, I didn't mean that."]) expect(roleplayMove("roleplay", w, at()), w).toBeNull();
  });

  test("outside one: their ask starts it, a no does not, and patient talk after one ran goes back into it", () => {
    expect(roleplayMove("intro", "Let's go with the role play.", at())).toBe("start");
    expect(roleplayMove("pitch", "I want to do the role play.", at())).toBe("start");
    expect(roleplayMove("intro", "No, I don't want to do the role play.", at())).toBeNull();
    const after = at({ lastRoleplay: { caller: "x", aya: "y" } });
    for (const w of ["need I need to cancel my appointment.", "I'm pregnant. Can I still get filler?", "How much is Botox?", "Can I book an appointment for Friday?"]) {
      expect(roleplayMove("pitch", w, after, SERVICES), w).toBe("resume");
    }
    // An owner talking about their own business is never taken for the patient.
    for (const w of ["Can I cancel the subscription anytime?", "I'd like to book a call with your team.", "My front desk misses calls.", "Our booking system is Mindbody.", "How much is it?"]) {
      expect(roleplayMove("pitch", w, after, SERVICES), w).toBeNull();
    }
    // Never before a role-play has run, and never over a call back's read-back.
    expect(roleplayMove("pitch", "I need to cancel my appointment.", at(), SERVICES)).toBeNull();
    expect(roleplayMove("pitch", "I need to cancel my appointment.", { ...after, asked: "callbackNote" }, SERVICES)).toBeNull();
    // The listener's "back to the patient" moves it too.
    expect(roleplayMove("pitch", "Hmm, okay.", { ...after, rpResume: true }, SERVICES)).toBe("resume");
    expect(speaksAsPatient("Is Lip Filler available Friday?", SERVICES)).toBe(true);
  });

  test("her end stands only once the owner ended it: a goodbye, the listener, a held end, or past the ceiling", () => {
    expect(roleplayEndAllowed(at({ roleplayTurns: 3 }), "Okay. Oh, actually, can we move that to Friday morning?")).toBe(false);
    for (const w of ["Thanks, bye!", "That's all, thanks.", "No, I'm good, thanks.", "Have a great day!"]) expect(roleplayEndAllowed(at({ roleplayTurns: 3 }), w), w).toBe(true);
    expect(PATIENT_BYE.test("$18 a unit, that's it?")).toBe(false);
    expect(roleplayEndAllowed(at({ roleplayTurns: 3, rpOut: true }), "Hmm")).toBe(true);
    expect(roleplayEndAllowed(at({ roleplayTurns: 3, rpEndPending: true }), "Josh.")).toBe(true);
    expect(roleplayEndAllowed(at({ roleplayTurns: 41 }), "And parking?")).toBe(true);
  });
});

describe("the role-play's booking, in code", () => {
  test("a time is read from the caller's words, never from a passing number", () => {
    expect(requestedTime("Let's say nine PM.")).toEqual({ minutes: 21 * 60, part: null, said: "9 PM" });
    expect(requestedTime("Tuesday at 10:30 a.m. please")).toEqual({ minutes: 10 * 60 + 30, part: null, said: "10:30 AM" });
    expect(requestedTime("Do you have anything Thursday afternoon?")).toEqual({ minutes: null, part: "afternoon", said: "afternoon" });
    expect(requestedTime("I get about ten calls a day")).toBeNull();
  });

  test("a closed day, a time outside the hours and a question about free times are answered from the hours", () => {
    const heard = (words: string, over: Partial<DemoProgress> = {}) => roleplayTimeLine(context, withDemoAnswer(at(over), "roleplay", words), words);
    expect(heard("Do you have anything Thursday afternoon?")).toBe("On Thursday, November 5, I have 2 PM or 4 PM. Would either of those work?");
    expect(heard("Let's say nine PM.", { rpDay: 4 })).toBe("We're open 9 AM to 6 PM on Thursdays, so 9 PM is outside our hours. Would Thursday, November 5 at 4 PM or 5 PM work instead?");
    expect(heard("Can I come in Saturday at ten AM?")).toBe("We're closed on Saturdays. Would Monday, November 2 at 10 AM or 11 AM work instead?");
    expect(heard("What's your earliest opening?")).toBe("The earliest I have is Monday, November 2 at 11 AM. Would that work?");
    // A time inside the hours, and anything that is not about a time, is hers to answer.
    expect(heard("Thursday at 3 PM works.")).toBeNull();
    expect(heard("Do you have parking available?")).toBeNull();
    expect(heard("Do you have any Botox deals?")).toBeNull();
  });

  test("no request is said to be in before a treatment, a day and time, a name and a number; a cancelled one is never pending", () => {
    const partial = { service: "Botox", day: "Thursday" };
    expect(roleplayCheckedReply("Friday morning, got it. The team will confirm that within a day.", partial)).toBe("Friday morning, got it. What time on Thursday suits you best?");
    expect(roleplayCheckedReply("Got it. I'll pass your request to the team.", { ...partial, time: "3 PM" })).toBe("Got it. Can I get your first name?");
    const full = { ...partial, time: "3 PM", name: "Josh", phone: "the one I'm calling from" };
    expect(roleplayCheckedReply("Perfect. The team will confirm Thursday at 3 within a day.", full)).toBe("Perfect. The team will confirm Thursday at 3 within a day.");
    // A cancellation needs the name and the number only, and the cancelled request is never "your request" again.
    expect(roleplayCheckedReply("I'll pass that cancellation to the team.", { status: "cancelled" })).toBe("Sure. Can I get your first name for the cancellation?");
    expect(roleplayCheckedReply("Parking's behind the building. The team can tell you when they confirm your Friday morning request.", { status: "cancelled", name: "Josh", phone: "this one" })).toBe(
      "Parking's behind the building.",
    );
    // Her end that did not stand takes its goodbye with it.
    expect(roleplayCheckedReply("Friday works. Thanks for calling, and have a great day!", full, { endRefused: true })).toBe("Friday works. Anything else I can help with?");
    // The guard's booking line asks for what is missing, or, after routing to the provider, offers the consultation.
    expect(roleplayCheckedReply("x", partial, { guard: "booking_confirmation" })).toBe("I can't confirm it myself, but I can put the request in. What time on Thursday suits you best?");
    expect(roleplayCheckedReply("x", partial, { guard: "booking_confirmation", spokenBefore: "That's a question for Dr. Maya Chen." })).toBe(
      "That's a question for Dr. Maya Chen. Want me to put in a request for a consultation?",
    );
  });

  test("a cancel and a name or a number are kept in code from the caller's words", () => {
    const cancelled = withDemoAnswer(at({ rpBooking: { service: "Botox", day: "Friday" } }), "roleplay", "I need to cancel my appointment.");
    expect(cancelled.rpBooking).toMatchObject({ status: "cancelled" });
    const named = withDemoAnswer(at({ lastQuestion: "Can I get your first name?" }), "roleplay", "It's Josh.");
    expect(named.rpBooking).toMatchObject({ name: "Josh" });
    const number = withDemoAnswer(at({ lastQuestion: "What's the best number to reach you on?" }), "roleplay", "The one I'm calling from.");
    expect(number.rpBooking).toMatchObject({ phone: "The one I'm calling from" });
    // "your cancellation policy" is a question, not a cancel.
    expect(withDemoAnswer(at({ rpBooking: { service: "Botox" } }), "roleplay", "What's your cancellation policy?").rpBooking?.status).toBeUndefined();
  });
});

describe("what she may say, in code", () => {
  test("in the role-play healdesk's words are on the never-say list; the provider is named in a refusal, and in other words when asked again", () => {
    const facts = demoRoleplayFacts(demoAssistantFacts({ slug: "lumen-aesthetics-austin", clinic: DEMO_CASE_CLINIC }));
    expect(facts.neverSay).toEqual(expect.arrayContaining(["healdesk", "setup fee", "onboarding", "Aya Voice", "on our side", "Lumen Aesthetics set up", "Lumen set up"]));
    expect(routingProvider(facts.providerNames)).toBe("Dr. Maya Chen");
    expect(guardedLine("clinical", facts.clinicName, "en", true, "Dr. Maya Chen")).toBe(
      "That's a great question for Dr. Maya Chen. Want me to put in a request for a consultation so you can go through it together?",
    );
    expect(routedAgainLine("clinical", facts.providerNames, "en", true)).toBe("Dr. Maya Chen is the right person for that one. Want me to request a consultation with them?");
    expect(routedAgainLine("clinical", ["Dr. A", "Dr. B"], "en", true)).toBeNull();
    // The urgent reply has the practice's own number to read out; nothing to put a call through to.
    expect([facts.urgentPhone, facts.directLine, facts.phone]).toEqual(["+15125550100", null, null]);
  });

  test('"Dr." and the like never end a sentence', () => {
    for (const t of ["a question for Dr.", "at 9 a.m.", "on Red Rd.", "e.g.", "Suite 6, Ste."]) expect(endsWithAbbreviation(t), t).toBe(true);
    for (const t of ["see the doctor.", "That's all.", "in Austin."]) expect(endsWithAbbreviation(t), t).toBe(false);
  });

  test("the discount is said once: a sentence that says it again is dropped", () => {
    expect(DISCOUNT_SAID.test("And there's 50% off the setup fee for the next 47 hours.")).toBe(true);
    expect(DISCOUNT_SAID.test("The HydraFacial is $199.")).toBe(false);
    const shaped = shapeVoiceReply("Totally fair. Your 50% off is still there for the next 46 hours. Want to get set up?", { name: null, nameUses: 0, apologised: false, first: true, noSignOff: false, drop: DISCOUNT_SAID });
    expect(shaped).toBe("Totally fair. Want to get set up?");
  });

  test("a hostile or emotional turn sells nothing, and no package is recommended in a role-play", () => {
    const ctx = { firstName: "Josh", clinic: DEMO_CASE_CLINIC, offer: { percentOfSetupFee: 50, endsAt: ISSUED + 40 * 3_600_000 }, buyButton: "Book Onboarding", mode: "phone" as const, issuedAt: ISSUED };
    const buyer = at({ buying: true, answers: { identity: "x", role: "owner", coverage: "everything" } });
    const hostile = demoStageNote(ctx, "pitch", ISSUED, withDemoAnswer(buyer, "pitch", "Do you think I'm stupid?"));
    expect(hostile).toContain("Their last words were upset or rude");
    expect(hostile).not.toMatch(/% off the setup fee|Book Onboarding|Want to get Lumen set up/);
    const calm = demoStageNote(ctx, "pitch", ISSUED, withDemoAnswer(buyer, "pitch", "Okay, tell me more."));
    expect(calm).toContain("50% off the setup fee");
    // Said once: the note no longer carries it.
    expect(demoStageNote(ctx, "pitch", ISSUED, { ...withDemoAnswer(buyer, "pitch", "Okay."), offerSaid: true })).not.toContain("50% off the setup fee, for the next");
    const roleplay = demoStageNote(ctx, "roleplay", ISSUED, at({ impatient: true }));
    expect(roleplay).not.toMatch(/recommend the one package|get set up/);
  });
});
