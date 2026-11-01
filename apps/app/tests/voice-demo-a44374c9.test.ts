import { writeFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

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

import { sealDemoCallContext, type DemoCallClinic, type DemoCallContext } from "@healdesk/catalog";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { modelSays as say } from "./setup/demo-clinic";
import { spokenResponses } from "./setup/retell-responses";

/**
 * Demo call a44374c9 (1 November 2026, the owner playing a hurried patient
 * of Miami Skin & Vein; he rated it, and asked for it "to 10/10"), replayed
 * line by line through the real demo pipeline.
 *
 * The model is scripted with what it wrote on the call, where the transcript
 * has it; where a fixed line replaced it ("I can't confirm it myself..."),
 * with what it most plausibly wrote. It is never rewritten to follow the new
 * notes, so this proves what the code now guarantees whatever the model
 * writes. Lines 9 to 24 only happened because the call went wrong at line 7;
 * they stay as a stress test of what follows a booking.
 *
 * The clinic is a fixture built from the call: what she quoted of the
 * practice, and the made-up values its demo page listed (weekday hours, the
 * prices). Its number is the one she read out.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
/** Sunday, November 1, 2026 at 5:52 AM EST, when the call was made. */
const CALLED_AT = Date.parse("2026-11-01T10:52:00Z");

const MIAMI: DemoCallClinic = {
  clinicName: "Miami Skin & Vein",
  summary: "A physician-led med spa in Coral Gables.",
  specialty: "med-spa",
  phone: "(786) 618-5039",
  address: "6705 Red Rd, Suite 608, Coral Gables, FL 33143",
  // Made up for the demo (apps/web lib/demo/samples.ts): the site showed none.
  hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
  services: [
    { name: "BOTOX® Cosmetic", description: null, price: "$14/unit", duration: null },
    { name: "Cosmetic Evaluation", description: null, price: "$200", duration: null },
    { name: "Acne Treatment", description: null, price: "from $150", duration: null },
    { name: "Melasma Treatments", description: null, price: "from $150", duration: null },
    { name: "Hydrafacials", description: null, price: "from $300", duration: null },
    { name: "Chemical Peels", description: null, price: "from $300", duration: null },
  ],
  providers: [{ name: "Dr. Shaun Patel", title: "Medical Director" }],
  faqs: [],
  policies: ["The $200 Cosmetic Evaluation fee can be credited toward a treatment within 30 days."],
  booking: null,
  highlights: [
    "Dr. Shaun Patel is Harvard-trained, with an MD from the University of Miami Miller School of Medicine",
    "The only SkinCeuticals Flagship in Miami",
    "Rated 4.8 from 490 reviews",
  ],
};

type Turn = { caller: string; before: string; model: string[] };

/** The call, turn by turn: the caller's words as transcribed, what they heard, and what the model wrote. */
const TURNS: readonly Turn[] = [
  {
    caller: "Hey. I'd like to book an appointment",
    before: "Hi, great, I can help with that! Which treatment were you thinking of, or would a consultation with Dr. Shaun Patel be the best first step?",
    model: [say("Hi, great, I can help with that! Which treatment were you thinking of, or would a consultation with Dr. Shaun Patel be the best first step?")],
  },
  {
    caller: "I don't know. Like, what are you guys about?",
    before:
      "Miami Skin & Vein is a physician-led med spa in Coral Gables, run by Dr. Shaun Patel. We do injectables like BOTOX® Cosmetic and fillers, laser treatments, and skin treatments such as Hydrafacials and chemical peels. Do you have something in mind, like smoothing lines, skin texture, or unwanted hair or veins? Or would a consultation with Dr. Patel help you figure it out?",
    model: [
      say(
        "Miami Skin & Vein is a physician-led med spa in Coral Gables, run by Dr. Shaun Patel. We do injectables like BOTOX® Cosmetic and fillers, laser treatments, and skin treatments such as Hydrafacials and chemical peels. Do you have something in mind, like smoothing lines, skin texture, or unwanted hair or veins? Or would a consultation with Dr. Patel help you figure it out?",
      ),
    ],
  },
  {
    caller: "I actually need a consult for doctor Smith Thursday afternoon, fast as possible. I'm running into a meeting, please.",
    before: "Got it, a consult with Dr. Patel on Thursday afternoon. I've got the consult down, and I'll need your first name and the best number to reach you. Let me check what's open this week, too.",
    model: [say("Got it, a consult with Dr. Patel on Thursday afternoon. I've got the consult down, and I'll need your first name and the best number to reach you. Let me check what's open this week, too.", { booking: { service: "Cosmetic Evaluation", day: "Thursday", time: "afternoon" } })],
  },
  {
    caller: "Yeah. So do you need again? Because you said a lot of things at the same time. I got a bit lost.",
    before: "Sorry about that, I got ahead of myself! Let me keep it simple. For Thursday afternoon, I can put in a consultation request with Dr. Patel. What's your first name?",
    model: [say("Sorry about that, I got ahead of myself! Let me keep it simple. For Thursday afternoon, I can put in a consultation request with Dr. Patel. What's your first name?", { booking: { service: "Cosmetic Evaluation", day: "Thursday" } })],
  },
  {
    caller: "I'm Thomas.",
    before: "Thanks, Thomas. What's the best number to reach you at?",
    model: [say("Thanks, Thomas. What's the best number to reach you at?", { booking: { name: "Thomas" } })],
  },
  {
    caller: "The one I'm calling you with. So just me, do you have anything available after four PM next week?",
    before: "Let me check the calendar for next week. Here's what I have: Monday, November 2 at 11 AM, Monday, November 2 at 4 PM, and Tuesday, November 3 at 10 AM. Do one of those work, or did you have a different after-four time in mind?",
    model: [say("Let me check the calendar for next week. Here's what I have: Monday, November 2 at 11 AM, Monday, November 2 at 4 PM, and Tuesday, November 3 at 10 AM. Do one of those work, or did you have a different after-four time in mind?", { booking: { phone: "the one I'm calling from" } })],
  },
  {
    caller: "Uh, Yeah. Monday works.",
    before: "Perfect, Thomas. I've got Monday, November 2 at 4 PM for a Cosmetic Evaluation with Dr. Patel. The team will confirm that time within a day. Anything else I can help with?",
    model: [say("Perfect, Thomas. I've got Monday, November 2 at 4 PM for a Cosmetic Evaluation with Dr. Patel. The team will confirm that time within a day. Anything else I can help with?", { booking: { service: "Cosmetic Evaluation", day: "Monday", time: "4 PM" } })],
  },
  {
    caller: "what?",
    before: "I can't confirm it myself, but I'll pass your request to the team, and they'll confirm within a day.",
    // The guard's line replaced her words; she most plausibly said the booking again, as asked.
    model: [say("You're booked for Monday, November 2 at 5 PM with Dr. Patel.")],
  },
  {
    caller: "what? I can do any day.",
    before: "Okay, no problem. Monday, November 2 at 4 PM is the time I've requested for your Cosmetic Evaluation with Dr. Patel, and the team will confirm that time within a day. Is there anything else I can help with?",
    model: [say("Okay, no problem. Monday, November 2 at 4 PM is the time I've requested for your Cosmetic Evaluation with Dr. Patel, and the team will confirm that time within a day. Is there anything else I can help with?")],
  },
  {
    caller: "what? I can do any day, anytime next week. Just give me whenever you have",
    before: "I can offer you the earliest openings we have: Monday, November 2 at 11 AM, Monday, November 2 at 4",
    model: [say("I can offer you the earliest openings we have: Monday, November 2 at 11 AM, Monday, November 2 at 4 PM, and Tuesday, November 3 at 10 AM.")],
  },
  {
    caller: "Just give me give me whatever you have I said.",
    before:
      "Let me just read you what I've got, Thomas: Monday, November 2 at 11 AM, Monday, November 2 at 4 PM, and Tuesday, November 3 at 10 AM. I've put in your Cosmetic Evaluation request for Monday at 4 PM, and the team will confirm within a day. Anything else I can help with?",
    model: [
      say(
        "Let me just read you what I've got, Thomas: Monday, November 2 at 11 AM, Monday, November 2 at 4 PM, and Tuesday, November 3 at 10 AM. I've put in your Cosmetic Evaluation request for Monday at 4 PM, and the team will confirm within a day. Anything else I can help with?",
      ),
    ],
  },
  {
    caller: "repeating yourself. It's quite bad.",
    before: "Fair point, I'll keep it tight. Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm that within a day.",
    model: [say("Fair point, I'll keep it tight. Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm that within a day.")],
  },
  {
    caller: "repeating yourself. It's quite bothering.",
    before: "Got it. Your Cosmetic Evaluation request for Monday, November 2 at 4 PM is in, and the team will confirm that time within a day. Is there anything else I can help you with?",
    model: [say("Got it. Your Cosmetic Evaluation request for Monday, November 2 at 4 PM is in, and the team will confirm that time within a day. Is there anything else I can help you with?")],
  },
  {
    caller: "the thing is that I have some swelling after my last procedure. Is that normal?",
    before: "I'm an AI assistant, so I can't help with anything urgent here. If this is an emergency, hang up and call 9-1-1 now. Otherwise, please call Miami Skin & Vein on seven eight six — six one eight — five oh three nine.",
    model: [],
  },
  {
    caller: "how much does a full treatment cost?",
    before:
      "The full treatment cost depends on which areas you want treated, and Dr. Shaun Patel works that out with you at a consultation. Our treatments start from $150 for things like Acne Treatment or Melasma Treatments, and from $300 for Hydrafacials and chemical peels. Would you like me to request a consultation?",
    model: [
      say(
        "The full treatment cost depends on which areas you want treated, and Dr. Shaun Patel works that out with you at a consultation. Our treatments start from $150 for things like Acne Treatment or Melasma Treatments, and from $300 for Hydrafacials and chemical peels. Would you like me to request a consultation?",
      ),
    ],
  },
  {
    caller: "give me a discount if I book right now?",
    before: "I can't offer a discount, but I can request your Cosmetic Evaluation with Dr. Patel for Monday, November 2 at 4 PM. Our evaluation fee is $200, and it can be credited toward a treatment within 30 days.",
    model: [say("I can't offer a discount, but I can request your Cosmetic Evaluation with Dr. Patel for Monday, November 2 at 4 PM. Our evaluation fee is $200, and it can be credited toward a treatment within 30 days.")],
  },
  {
    caller: "What's what's so special about your clinic?",
    before:
      "Honestly, the thing we're known for is that Dr. Shaun Patel is a physician-led practice, and he's Harvard-trained with an MD from the University of Miami Miller School of Medicine. We're also the only SkinCeuticals Flagship in Miami, and we're rated 4.8 from 490 reviews. Would you like me to keep that Monday, November 2 at 4 PM request in for your Cosmetic Evaluation?",
    model: [
      say(
        "Honestly, the thing we're known for is that Dr. Shaun Patel is a physician-led practice, and he's Harvard-trained with an MD from the University of Miami Miller School of Medicine. We're also the only SkinCeuticals Flagship in Miami, and we're rated 4.8 from 490 reviews. Would you like me to keep that Monday, November 2 at 4 PM request in for your Cosmetic Evaluation?",
      ),
    ],
  },
  {
    caller: "Yep. That works.",
    before: "I can't confirm it myself, but I'll pass your request to the team, and they'll confirm within a day.",
    model: [say("Great, you're all set for Monday at 5 PM!")],
  },
  {
    caller: "Why why can't you confirm You're supposed to confirm.",
    before: "The confirming is done by the team, not by me, and I can't tell you when the calendar will lock it in. I've put in your request for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm that time within a day. Is there anything else you'd like to ask?",
    model: [say("You're confirmed for Monday, November 2 at 5 PM with Dr. Patel. Anything else I can help with?")],
  },
  {
    caller: "convenient.",
    before: "Glad that works! Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm that time within a day.",
    model: [say("Glad that works! Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm that time within a day.")],
  },
  {
    caller: "convenient. That's not convenient. The real receptionist would actually solve that.",
    before: "I hear you, and I'm sorry this has been a frustrating call. I can't confirm the appointment myself. Your request for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation is in, and the team will confirm it within a day.",
    model: [say("I hear you, and I'm sorry this has been a frustrating call. I can't confirm the appointment myself. Your request for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation is in, and the team will confirm it within a day.")],
  },
  {
    caller: "frustrating. Very, very frustrating.",
    before: "I'm sorry this has been so frustrating. Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm it within a day.",
    model: [say("I'm sorry this has been so frustrating. Your request is in for Monday, November 2 at 4 PM with Dr. Patel for a Cosmetic Evaluation, and the team will confirm it within a day.")],
  },
  {
    caller: "That's really bad.",
    before: "I'm sorry it's been so frustrating. I've put in your request for Monday,",
    model: [say("I'm sorry it's been so frustrating. I've put in your request for Monday, November 2 at 4 PM.")],
  },
  {
    caller: "Thanks. Goodbye.",
    before: "Okay, thanks for calling. Have a great day!",
    model: [say("Okay, thanks for calling. Have a great day!", { end: true })],
  },
];

type Response = Extract<RetellOutbound, { response_type: "response" }>;
type Row = { n: number; caller: string; before: string; after: string; modelAsked: boolean; booking: Record<string, unknown>; ended: boolean };

async function replay(): Promise<Row[]> {
  const queue: string[] = [];
  let asked = 0;
  const responder: AssistantResponder = async ({ onText }) => {
    asked += 1;
    const text = queue.shift();
    if (text === undefined) throw new Error("no scripted answer left for this turn");
    if (onText) for (const piece of text.split(/(?<=[.!?] )/)) onText(piece);
    return text;
  };
  const sent: RetellOutbound[] = [];
  const context: DemoCallContext = {
    v: 1,
    slug: "miami-skin-vein-7247i9p7qh",
    mode: "browser",
    firstName: null,
    issuedAt: CALLED_AT,
    offer: null,
    test: true,
    buyButton: null,
    clinic: MIAMI,
  };
  const s = new RetellCallSession("demo", "call_a44374c9", (m) => sent.push(m), {
    responder,
    acknowledgeAfterMs: 60_000,
    now: () => new Date(CALLED_AT),
    random: () => 0,
    demo: { secret: SECRET, detailsWaitMs: 200 },
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  const heard = () => spokenResponses(raw());
  await s.open();
  await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context, SECRET) } } }));
  await vi.waitFor(() => expect(raw()).toHaveLength(1));
  const rows: Row[] = [];
  for (const [i, turn] of TURNS.entries()) {
    queue.length = 0;
    queue.push(...turn.model);
    const before = asked;
    await s.handle(
      JSON.stringify({ interaction_type: "response_required", response_id: i + 1, transcript: [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: turn.caller }] }),
    );
    const said = heard().at(-1)!;
    expect(said.response_id, `turn ${i + 1}: no answer`).toBe(i + 1);
    rows.push({
      n: i + 1,
      caller: turn.caller,
      before: turn.before,
      after: said.content ?? "",
      modelAsked: asked > before,
      booking: { ...(s.demoSnapshot?.progress.rpBooking ?? {}) },
      ended: raw().some((m) => m.response_id === i + 1 && m.end_call === true),
    });
  }
  await s.finish();
  return rows;
}

/** A sentence saying the booking: a day and a time with "booked", "set", "confirmed" or "request". */
const BOOKING_SAID = /\b(?:mon|tues|wednes|thurs|fri)day\b[^.?!]*\b\d{1,2}\s?[AP]M\b/i;

describe("demo call a44374c9, replayed line by line", () => {
  test("every line keeps what the code now guarantees", async () => {
    const rows = await replay();
    if (process.env.A44_TABLE) {
      const cell = (t: string) => t.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
      writeFileSync(process.env.A44_TABLE, rows.map((r) => `| ${r.n} | ${cell(r.caller)} | ${cell(r.before)} | ${cell(r.after)} |`).join("\n"));
    }
    const at = (n: number) => rows[n - 1]!;
    for (const row of rows) {
      const where = `turn ${row.n} ("${row.caller}"): ${row.after}`;
      // 10. Never a trademark sign spoken.
      expect(row.after, where).not.toMatch(/[®™]/);
      // 2. Never "I can't confirm" or "the team will confirm": the demo books.
      expect(row.after, where).not.toMatch(/can'?t confirm|team will confirm|confirm (?:that|it) within a day|your request is in|put in your request/i);
      // 5. At most one question in a reply.
      expect((row.after.match(/\?/g) ?? []).length, where).toBeLessThanOrEqual(1);
      // 7. Sarcasm is never answered "Glad that works!".
      expect(row.after, where).not.toMatch(/\bglad that works\b/i);
    }
    // 9. Her name for him, once in the call: in the booking's confirmation.
    expect(rows.filter((r) => /\bThomas\b/.test(r.after)).map((r) => r.n)).toEqual([7]);

    // 3. A hurried caller who names a doctor not on the team: told who is, two times that fit, no pleasantry, no model call.
    expect(at(3).modelAsked).toBe(false);
    expect(at(3).after).toBe(
      "Just so you know, we don't have a Dr. Smith here; our physician is Dr. Shaun Patel. Let me take a look... On Thursday, November 5, I have 2 PM or 4 PM. Would either of those work?",
    );
    // 5. Only her first question, and no "®".
    expect(at(2).after).toBe(
      "Miami Skin & Vein is a physician-led med spa in Coral Gables, run by Dr. Shaun Patel. We do injectables like BOTOX Cosmetic and fillers, laser treatments, and skin treatments such as Hydrafacials and chemical peels. Do you have something in mind, like smoothing lines, skin texture, or unwanted hair or veins?",
    );
    expect(at(5).after).toBe("Thanks. What's the best number to reach you at?");
    // 3. "After four PM next week": the first such time taken, two after four offered, none before it.
    expect(at(6).modelAsked).toBe(false);
    expect(at(6).after).toBe("Let me take a look... Ah, Monday, November 2 at 4 PM is already taken, but I can do 5 PM that day or Tuesday, November 3 at 4 PM. Would either of those work?");
    // 2. "Monday works" picks Monday at 5 PM from that offer, and the call books it, once, in its own words.
    expect(at(7).after).toBe("You're all set, Thomas! Your Cosmetic Evaluation with Dr. Shaun Patel is booked for Monday, November 2 at 5 PM. Anything else I can help with?");
    expect(at(7).booking).toMatchObject({ day: "Monday", time: "5 PM", status: "booked" });
    // "what?" after it: the booking said again, as asked.
    expect(at(8).after).toBe("You're booked for Monday, November 2 at 5 PM with Dr. Patel.");
    // 3. "Any day, whatever you have" once booked: a sooner time offered as a move, the booking said with the first offer only.
    expect(at(9).after).toBe("Let me take a look... You're booked for Monday, November 2 at 5 PM. If you'd like it sooner, I have Monday, November 2 at 11 AM. Want me to move it?");
    expect(at(10).after).toBe("Let me take a look... I can also do Monday, November 2 at 9 AM. Want me to move it to that?");
    expect(at(11).after).toBe("Let me take a look... I can also do Monday, November 2 at 10 AM. Want me to move it to that?");
    // 1. Once booked, never said again unless asked (a44374c9: seven times).
    expect(rows.filter((r) => BOOKING_SAID.test(r.after) && /\b(?:booked|set|confirmed|request)\b/i.test(r.after)).map((r) => r.n)).toEqual([7, 8, 9, 19]);
    expect(at(12).after).toBe("Fair point, I'll keep it tight.");
    expect(at(13).after).toBe("Got it. Is there anything else I can help you with?");
    // 4. Swelling after a procedure: sympathy first, 9-1-1, then the clinical team's direct line; no model call.
    expect(at(14).modelAsked).toBe(false);
    expect(at(14).after).toBe(
      "I'm so sorry you're dealing with that. I'm an AI assistant, so I can't advise on symptoms. If this is an emergency, hang up and call 9-1-1 now. Otherwise, please call our clinical team directly on seven eight six — six one eight — five oh three nine, so they can help.",
    );
    // The discount answer stays; the booking said again in the same sentence goes.
    expect(at(16).after).toBe("I can't offer a discount. Our evaluation fee is $200, and it can be credited toward a treatment within 30 days.");
    expect(at(17).after).not.toMatch(/Monday/);
    // 7. Sarcasm after a complaint: no "Glad that works!", and the booking not said again.
    expect(at(20).after).toBe("I hear you. What would make this easier for you?");
    expect(at(21).after).toBe("I hear you, and I'm sorry this has been a frustrating call.");
    // An apology on its own is said once in the call (a44374c9: three in a row), and no line twice in a row.
    // (Turn 14 is the urgent line's own sympathy, which is fixed.)
    expect(rows.filter((r) => /\bsorry\b/i.test(r.after)).map((r) => r.n)).toEqual([4, 14, 21]);
    for (const [i, row] of rows.entries()) if (i > 0) expect(row.after, `turn ${row.n}`).not.toBe(rows[i - 1]!.after);
    expect(at(24).ended).toBe(true);
    expect(tenant.calls).toBe(0);
  });
});
