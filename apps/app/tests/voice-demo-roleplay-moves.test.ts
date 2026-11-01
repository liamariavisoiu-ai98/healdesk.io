import { describe, expect, test } from "vitest";

import { routedAgainLine, guardedLine, routingProvider } from "@/lib/assistant/guard";
import { endsWithAbbreviation } from "@/lib/assistant/turn";
import {
  DEMO_START_PROGRESS,
  demoAssistantFacts,
  demoRoleplayFacts,
  requestedTime,
  roleplayCheckedReply,
  roleplayTimeLine,
  withDemoAnswer,
  type DemoProgress,
} from "@/lib/voice/demo-facts";

import { DEMO_CASE_CLINIC } from "./setup/demo-clinic";

/**
 * The booking's checks that a demo call makes in code since demo call
 * c4093be6 (31 October 2026), each against the words
 * that must trigger it and the owner's words that must not. The whole call
 * is replayed in voice-demo-c4093be6.test.ts.
 */

const at = (over: Partial<DemoProgress> = {}): DemoProgress => ({ ...DEMO_START_PROGRESS, ...over });
/** Friday, October 30, 2026, 11 AM in Austin. */
const ISSUED = Date.parse("2026-10-30T16:00:00Z");
const context = { clinic: DEMO_CASE_CLINIC, issuedAt: ISSUED };

describe("the role-play's booking, in code", () => {
  test("a time is read from the caller's words, never from a passing number", () => {
    expect(requestedTime("Let's say nine PM.")).toEqual({ minutes: 21 * 60, part: null, said: "9 PM" });
    expect(requestedTime("Tuesday at 10:30 a.m. please")).toEqual({ minutes: 10 * 60 + 30, part: null, said: "10:30 AM" });
    expect(requestedTime("Do you have anything Thursday afternoon?")).toEqual({ minutes: null, part: "afternoon", said: "afternoon" });
    expect(requestedTime("I get about ten calls a day")).toBeNull();
  });

  test("a closed day, a time outside the hours and a question about free times are answered from the hours", () => {
    // After the first look at the calendar of the call, a short "let me look" (calendarLead).
    const heard = (words: string, over: Partial<DemoProgress> = {}) => roleplayTimeLine(context, withDemoAnswer(at({ lookedUp: true, takenShown: true, ...over }), "roleplay", words), words);
    expect(heard("Do you have anything Thursday afternoon?")).toBe("Let me take a look... On Thursday, November 5, I have 2 PM or 4 PM. Would either of those work?");
    expect(heard("Let's say nine PM.", { rpDay: 4 })).toBe("Let me take a look... We're open 9 AM to 6 PM on Thursdays, so 9 PM is outside our hours. Would Thursday, November 5 at 4 PM or 5 PM work instead?");
    expect(heard("Can I come in Saturday at ten AM?")).toBe("Let me take a look... We're closed on Saturdays. Would Monday, November 2 at 10 AM or 11 AM work instead?");
    expect(heard("What's your earliest opening?")).toBe("Let me take a look... The earliest I have is Monday, November 2 at 11 AM. Would that work?");
    // A time inside the hours, and anything that is not about a time, is hers to answer.
    expect(heard("Thursday at 3 PM works.")).toBeNull();
  });

  test("the first look of the call carries the day's pleasantry, and the first time asked for is taken, with two near it", () => {
    // Owner, 1 November 2026: "she should use the filler to look into it, and find that it's already booked, but come up with 2 alternatives (show that she's proactive)".
    const first = (words: string, over: Partial<DemoProgress> = {}) => roleplayTimeLine(context, withDemoAnswer(at(over), "roleplay", words), words);
    // The call began on a Friday.
    expect(first("Do you have anything Thursday afternoon?")).toBe(`Happy Friday! Let's get this sorted so you can head into the weekend. Let me see what we have open... On Thursday, November 5, I have 2 PM or 4 PM. Would either of those work?`);
    expect(first("Can I come in Thursday at 3 PM?")).toBe(`Happy Friday! Let's get this sorted so you can head into the weekend. Let me see what we have open... Ah, 3 PM on Thursday, November 5 is already taken, but I can do 2 PM or 4 PM that day. Would either of those work?`);
    // Once a call: the next time asked for, or one she just offered, is hers to take.
    expect(first("Thursday at 3 PM then.", { lookedUp: true, takenShown: true })).toBeNull();
    expect(first("2 PM is great.", { rpDay: 4, lastQuestion: "Ah, 3 PM on Thursday, November 5 is already taken, but I can do 2 PM or 4 PM that day. Would either of those work?" })).toBeNull();
    expect(first("Do you have parking available?")).toBeNull();
    expect(first("Do you have any Botox deals?")).toBeNull();
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


});

describe("the receptionist's manner (owner, 1 November 2026)", () => {
  test("is in the voice prompt a clinic's calls and a demo share, and every line it puts in her mouth passes the guard", async () => {
    const { buildAssistantPrompt } = await import("@/lib/assistant/prompt");
    const { guardAssistantReply } = await import("@/lib/assistant/guard");
    const facts = demoRoleplayFacts(demoAssistantFacts({ slug: "lumen-aesthetics-austin", clinic: DEMO_CASE_CLINIC }));
    const prompt = buildAssistantPrompt(facts, "voice");
    const manner = prompt.slice(prompt.indexOf("How you run a booking"), prompt.indexOf("they make the call feel looked after"));
    expect(manner).toContain("I hope your week's off to a great start! Let me pull up our calendar...");
    expect(manner).toContain("Happy Thursday! Let's get this sorted so you can head into the weekend.");
    expect(prompt).toContain("- Providers: Dr. Maya Chen");
    // Never a claim the booking is made by her words, and no email asked for on a call.
    expect(manner).toContain("Never say a time is booked, locked in, confirmed or held unless the booking line has said so.");
    expect(manner).not.toMatch(/email|most popular/i);
    // His hospitality lines (owner, 1 November 2026): the name once, at the wrap-up; the consultation's reassurance; a closer that sends nothing.
    expect(manner).toContain('"Excellent. Well, [first name], I\'ve put that in for you."');
    expect(manner).toContain("the consultation is really relaxed and conversational");
    expect(manner).toContain("We're always here to help!");
    expect(manner).toContain("Never say you are sending them a confirmation or any message.");
    expect(prompt).toContain("use it once in the call, in the wrap-up");
    expect(prompt).not.toContain("at most twice");
    const lines = [...manner.matchAll(/"([^"]{8,})"/g)].map((m) => m[1]!.replace(/\[provider\]/g, "Dr. Maya Chen").replace(/\[first name\]/g, "Josh").replace(/\[their day\]/g, "Thursday"));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect([line, guardAssistantReply(line, facts, { bookingWritten: false }).ok]).toEqual([line, true]);
    // The chat prompt is untouched: the manner is for calls.
    expect(buildAssistantPrompt(facts, "web_chat")).not.toContain("How you run a booking");
  });
});
