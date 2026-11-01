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
import { soundAlikes, soundKey } from "@/lib/voice/sound-alike";

import { modelSays as say } from "./setup/demo-clinic";
import { spokenResponses } from "./setup/retell-responses";

/**
 * The owner's test call of 1 November 2026 to the Miami Skin & Vein demo
 * (after a44374c9 was fixed): "Aya is not understanding relatively close
 * pronunciations of the same subject meaning that she gets stuck in
 * pronunciation loops", then "go ahead with all of it". Replayed line by
 * line through the real demo pipeline, the model scripted with what it wrote
 * on the call (where a fixed line replaced it, what it most plausibly wrote),
 * never rewritten to follow the new notes: this proves what the code now
 * says itself and what it now tells the model.
 *
 * The clinic is a fixture from the call: the menu, prices and practice she
 * quoted, and the demo's made-up hours and deposit rule.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
/** Sunday, November 1, 2026 at 7:05 AM EST. */
const CALLED_AT = Date.parse("2026-11-01T12:05:00Z");

const MIAMI: DemoCallClinic = {
  clinicName: "Miami Skin & Vein",
  summary: "A physician-led med spa in Coral Gables.",
  specialty: "med-spa",
  phone: "(786) 618-5039",
  address: "6705 Red Rd, Suite 608, Coral Gables, FL 33143",
  hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
  services: [
    { name: "BOTOX® Cosmetic", description: null, price: "$18/unit", duration: null },
    { name: "Dysport", description: null, price: "$6/unit", duration: null },
    { name: "Daxxify", description: null, price: "$14/unit", duration: null },
    { name: "Restylane", description: null, price: "from $950", duration: null },
    { name: "Sculptra", description: null, price: "from $1000", duration: null },
    { name: "PicoWay", description: null, price: "from $300", duration: null },
    { name: "Hydrafacial", description: null, price: "from $300", duration: null },
    { name: "Microneedling", description: null, price: "$900", duration: null },
    { name: "Chemical Peels", description: null, price: "from $300", duration: null },
  ],
  providers: [{ name: "Dr. Shaun Patel", title: "Medical Director" }],
  faqs: [],
  // Made up for the demo (apps/web lib/demo/samples.ts), as the page says.
  policies: ["A $50 deposit holds each appointment and comes off the treatment price. Cancel or move it at least 24 hours ahead to keep the deposit."],
  booking: null,
  highlights: [],
};

type Turn = { caller: string; before: string; model: string[] };

const PRICE_DUMP =
  "Sure, let's look at the rest of the menu. Our other injectables are Dysport from $6 per unit, Daxxify from $14 per unit, and Restylane fillers from $950 per syringe, with Sculptra from $1000 per vial. For skin, we have Hydrafacial from $300, chemical peels from $300, and microneedling for $900. Which one should I tell you more about?";

const TURNS: readonly Turn[] = [
  { caller: "Hi.", before: "Hi there! / Still with me?", model: [say("Hi there!")] },
  {
    caller: "Tell me about your treatments. Please.",
    before: "Here's what we offer. Our main groups are injectables like BOTOX, Dysport, Daxxify and fillers such as Restylane and Sculptra. ...",
    model: [say("Botox is our most popular injectable. Our main groups are injectables like BOTOX, Dysport, Daxxify and fillers such as Restylane and Sculptra. Which area are you most interested in?")],
  },
  {
    caller: "much is Botox?",
    before: "Botox is from $18 per unit. The total depends on the areas you want treated, which Dr. Shaun Patel works out with you at a consultation. Want me to request one?",
    model: [say("Botox is from $18 per unit. The total depends on the areas you want treated, which Dr. Shaun Patel works out with you at a consultation. Want me to request one?", { booking: { service: "BOTOX Cosmetic" } })],
  },
  {
    caller: "this week?",
    before: "Yes, we have openings this week. I can offer Monday, November 2 at 11 AM, or Monday at 4 PM. Which works better for you? You can also tell me another day.",
    model: [say("Yes, we have openings this week. I can offer Monday, November 2 at 11 AM, or Monday at 4 PM. Which works better for you?")],
  },
  {
    caller: "want evening time.",
    before: "Evening is a bit tricky with what I have open right now. The times I can offer are Monday, November 2 at 11 AM, Monday at 4 PM, or Tuesday, November 3 at 10 AM. ...",
    model: [say("Evening is a bit tricky with what I have open right now. The times I can offer are Monday, November 2 at 11 AM, Monday at 4 PM, or Tuesday, November 3 at 10 AM.")],
  },
  {
    caller: "that. Why are you repeating? I don't want early morning.",
    before: "Got it, no early mornings. Evenings aren't open this week, and my calendar only has Monday at 11 AM, Monday at 4 PM, or Tuesday at 10 AM. ...",
    model: [say("Got it, no early mornings. Evenings aren't open this week, and my calendar only has Monday at 11 AM, Monday at 4 PM, or Tuesday at 10 AM.")],
  },
  {
    caller: "Four PM would work.",
    before: "Four PM on Monday, November 2 works. What's your first name?",
    model: [say("Four PM on Monday, November 2 works. What's your first name?", { booking: { service: "BOTOX Cosmetic", day: "Tuesday", time: "4 PM" } })],
  },
  {
    caller: "You do I have to pay deposit?",
    before: "Good question. I don't have a price for that one, but Dr. Shaun Patel can go through it with you at a consultation. Want me to request one?",
    // The guard refused her answer as an off-menu price: what she most plausibly wrote.
    model: [say("Yes, a $50 deposit holds each appointment, and it comes off the treatment price.")],
  },
  {
    caller: "Do you do I have to pay deposit or something?",
    before: "Okay, let me try that again. I don't have a price for that one, but Dr. Shaun Patel can go through it with you at a consultation. Want me to request one?",
    model: [say("Yes, a $50 deposit holds each appointment, and it comes off the treatment price.")],
  },
  {
    caller: "have to pay a deposit for the bottle?",
    before: "Oh, I wish I could help with that one. I don't have a price for that one, ...",
    model: [say("Yes, the $50 deposit holds your Botox appointment too, and it comes off the price.")],
  },
  {
    caller: "Okay. Yeah. I request one, but I wanna know how I can reach Miami Skin and Vein.",
    before: "Address: 6705 Red Rd, Suite 608, Coral Gables, FL 33143. Our number is (786) 618-5039 if you ever need to call us directly. ...",
    model: [say("We're at 6705 Red Rd, Suite 608, Coral Gables, FL 33143, and our number is (786) 618-5039.")],
  },
  {
    caller: "you have barking?",
    before: "Barking? No, there's no barking on my end, so the sound is probably coming from your side. ...",
    model: [say("I'd have to check that with the team.")],
  },
  { caller: "Alright.", before: "Sounds good! Before I put that in, what's the best phone number to reach you?", model: [say("Sounds good!")] },
  {
    caller: "Is it is it a full is Miami Skin and Veil full of clients?",
    before: "Full? Not at all, we have openings this week. You're all set, Alright! Your Botox with Dr. Shaun Patel is booked for Monday, November 2 at 4 PM. ...",
    model: [say("Full? Not at all, we have openings this week.")],
  },
  {
    caller: "told me about Botox before, so you shouldn't repeat yourself. Just say besides Botox, this, this, this.",
    before: "Got it, no more Botox. Besides Botox, we do Dysport and Daxxify, plus fillers like Restylane and Sculptra. For lasers, we have",
    model: [say("Got it. Besides Botox, we do Dysport and Daxxify, plus fillers like Restylane and Sculptra.")],
  },
  { caller: "Teach me about Ristalin. What is Ristalin?", before: "Ristalin isn't something we offer at Miami Skin & Vein, ...", model: [say("Restylane is a filler that adds volume, for lips and cheeks. It's from $950.")] },
  { caller: "I want the other ones.", before: PRICE_DUMP, model: [say(PRICE_DUMP)] },
  { caller: "Teach me about this port.", before: "I can't tell you about \"this port\" because I don't know what that refers to. ...", model: [say("Dysport is an injectable that relaxes lines, like Botox.")] },
  { caller: "This four.", before: "I'm not quite sure what you mean by \"this four.\" ...", model: [say("Dysport softens frown lines and crow's feet.")] },
  { caller: "Besides Botox,", before: "I think I lost you there. Is it Dysport you're thinking of, or one of the other injectables like Daxxify?", model: [say("I think I lost you there.")] },
  { caller: "is it", before: "Are you asking about the Botox deposit, or about the Dysport and Daxxify pricing we just went over? ...", model: [say("Are you asking about the Botox deposit?")] },
  {
    caller: "I want to offer champagne an opportunity to open a franchise with Miami Skin and Vein.",
    before: "I can't help with a franchise, but I can take a message for our team to follow up on that. ...",
    model: [say("I can't help with a franchise, but I can take a message for our team.")],
  },
  {
    caller: "No. I just told you. I want to know I want an opportunity to discuss with the doctor Sean",
    before: "I'm not with Dr. Sean. Our physician is Dr. Shaun Patel, ...",
    model: [say("Of course. Dr. Shaun Patel sees patients at consultations; for business, our office is the best place to start.")],
  },
];

type Response = Extract<RetellOutbound, { response_type: "response" }>;
type Row = { n: number; caller: string; before: string; after: string; modelAsked: boolean; note: string; booking: Record<string, unknown> };

async function replay(): Promise<Row[]> {
  const queue: string[] = [];
  const seen: string[] = [];
  const responder: AssistantResponder = async ({ system, onText }) => {
    seen.push((system as { turn: string }).turn);
    const text = queue.shift();
    if (text === undefined) throw new Error("no scripted answer left for this turn");
    if (onText) for (const piece of text.split(/(?<=[.!?] )/)) onText(piece);
    return text;
  };
  const sent: RetellOutbound[] = [];
  const context: DemoCallContext = { v: 1, slug: "miami-skin-vein-7247i9p7qh", mode: "browser", firstName: null, issuedAt: CALLED_AT, offer: null, test: true, buyButton: null, clinic: MIAMI };
  const s = new RetellCallSession("demo", "call_sound_alike", (m) => sent.push(m), {
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
    const asked = seen.length;
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
      modelAsked: seen.length > asked,
      note: seen[asked] ?? "",
      booking: { ...(s.demoSnapshot?.progress.rpBooking ?? {}) },
    });
  }
  await s.finish();
  return rows;
}

describe("sounds alike: what the line heard is taken as what they meant", () => {
  test("the sound keys of the call's mishearings", () => {
    expect([soundKey("this port"), soundKey("Dysport")]).toEqual(["tsprt", "tsprt"]);
    expect(soundKey("barking")).toBe(soundKey("parking"));
    expect(soundKey("Ristalin")).toBe(soundKey("Restylane"));
    expect(soundKey("Sean")).toBe(soundKey("Shaun"));
    const vocabulary = (recent: string[] = []) => ({ services: MIAMI.services.map((s) => s.name), providers: ["Dr. Shaun Patel"], recent });
    expect(soundAlikes("Teach me about this port.", vocabulary())).toEqual([{ heard: "this port", meant: "Dysport" }]);
    expect(soundAlikes("Teach me about Ristalin.", vocabulary())).toEqual([{ heard: "Ristalin", meant: "Restylane" }]);
    expect(soundAlikes("you have barking?", vocabulary())).toEqual([{ heard: "barking", meant: "parking" }]);
    expect(soundAlikes("discuss with the doctor Sean", vocabulary())).toEqual([{ heard: "doctor Sean", meant: "Dr. Shaun Patel" }]);
    // A looser match only for what she just said: "the bottle" right after Botox, never out of the blue.
    expect(soundAlikes("a deposit for the bottle?", vocabulary(["Botox is from $18 per unit."]))).toEqual([{ heard: "bottle", meant: "BOTOX Cosmetic" }]);
    expect(soundAlikes("a deposit for the bottle?", vocabulary())).toEqual([]);
    // Words that are what they say are left alone.
    for (const words of ["Four PM would work.", "Alright.", "I want evening time.", "What's a chemical peel?", "Give me another treatment you offer.", "Is Miami Skin and Veil full of clients?"]) {
      expect(soundAlikes(words, vocabulary()), words).toEqual([]);
    }
  });

  test("the call, replayed: code answers what it owns, and the model is told what was meant", async () => {
    const rows = await replay();
    if (process.env.SOUND_ALIKE_TABLE) {
      const cell = (t: string) => t.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
      writeFileSync(process.env.SOUND_ALIKE_TABLE, rows.map((r) => `| ${r.n} | ${cell(r.caller)} | ${cell(r.before)} | ${cell(r.after)} |`).join("\n"));
    }
    const at = (caller: string) => rows.find((r) => r.caller === caller)!;
    for (const row of rows) {
      const where = `turn ${row.n} ("${row.caller}"): ${row.after}`;
      expect(row.after, where).not.toMatch(/BOTOX|®|most popular|FL 33143|\(786\)|Not at all|I don't know what that refers to|isn't something we offer/);
      expect((row.after.match(/\$\d/g) ?? []).length, where).toBeLessThanOrEqual(2);
    }
    // A bare hello is answered with a question, so no silence and no "Still with me?".
    expect(at("Hi.").after).toBe("Hi there! How can I help you today?");
    // No popularity claim, and "BOTOX" said as a word.
    expect(at("Tell me about your treatments. Please.").after).toBe("Our main groups are injectables like Botox, Dysport, Daxxify and fillers such as Restylane and Sculptra. Which area are you most interested in?");
    // "This week?", "evening", "not mornings": two times that fit, from the call, never the same list again.
    expect(at("this week?").after).toBe("Let me pull up our calendar... I have Monday, November 2 at 11 AM or 4 PM. Would either of those work?");
    expect(at("want evening time.").after).toBe("Let me take a look... Ah, Monday, November 2 at 5 PM is already taken, but I can do Tuesday, November 3 at 4 PM or 5 PM. Would either of those work?");
    expect(at("that. Why are you repeating? I don't want early morning.").after).toBe("Let me take a look... I have Monday, November 2 at 12 PM or 1 PM. Would either of those work?");
    // The deposit, from the clinic's own rule, said; asked again, said again shorter, never the same line twice.
    expect(at("You do I have to pay deposit?").after).toBe("Yes, a $50 deposit holds each appointment, and it comes off the treatment price.");
    expect(at("Do you do I have to pay deposit or something?").after).toBe("Like I mentioned, yes, a $50 deposit holds each appointment, and it comes off the treatment price.");
    // "The bottle", with Botox on the booking: the model is told it is Botox.
    expect(at("have to pay a deposit for the bottle?").note).toContain(`They said "bottle": that is BOTOX Cosmetic`);
    // The address and the number as a person says them.
    expect(at("Okay. Yeah. I request one, but I wanna know how I can reach Miami Skin and Vein.").after).toBe(
      "We're at 6705 Red Road, Suite 608, Coral Gables, and our number is seven eight six — six one eight — five oh three nine.",
    );
    // "Barking" is parking; "Ristalin" is Restylane; "this port" and "This four" are Dysport; "doctor Sean" is Dr. Shaun Patel.
    expect(at("you have barking?").note).toContain(`They said "barking": that is parking`);
    expect(at("Teach me about Ristalin. What is Ristalin?").note).toContain(`They said "Ristalin": that is Restylane`);
    expect(at("Teach me about this port.").note).toContain(`They said "this port": that is Dysport`);
    expect(at("This four.").note).toContain(`They said "This four": that is Dysport`);
    const sean = at("No. I just told you. I want to know I want an opportunity to discuss with the doctor Sean");
    expect(sean.note).toContain(`They said "doctor Sean": that is Dr. Shaun Patel`);
    expect(sean.note).not.toMatch(/who is not on the team/);
    // No note anywhere asks them to say a word again.
    for (const row of rows) expect(row.note, `turn ${row.n}`).not.toMatch(/ask them to say it again or check what they meant/);
    // "Alright." is never a name, so nothing is booked on it.
    expect(at("Alright.").booking.name).toBeUndefined();
    // "Full of clients?": never an empty schedule, never booked on the side.
    expect(at("Is it is it a full is Miami Skin and Veil full of clients?").after).toBe("I can usually find you a time that works. Want me to take a look?");
    expect(at("Is it is it a full is Miami Skin and Veil full of clients?").booking.status).toBeUndefined();
    // "Besides Botox": what she has told them is left out.
    expect(at("told me about Botox before, so you shouldn't repeat yourself. Just say besides Botox, this, this, this.").note).toContain("They have already heard about:");
    // More than two prices in a sentence: the names stay, the prices go.
    expect(at("I want the other ones.").after).toBe(
      "Sure, let's look at the rest of the menu. Our other injectables are Dysport, Daxxify, and Restylane fillers, with Sculptra. For skin, we have Hydrafacial, chemical peels, and microneedling. Which one should I tell you more about?",
    );
    // A sentence they have not finished gets a nod, a different one the second time in a row; no model call.
    expect(at("Besides Botox,").after).toBe("Mm-hmm?");
    expect(at("is it").after).toBe("Take your time.");
    expect(at("is it").modelAsked).toBe(false);
    // A business ask: the office's number, nothing promised.
    expect(at("I want to offer champagne an opportunity to open a franchise with Miami Skin and Vein.").after).toBe(
      "For business inquiries, please call our office on seven eight six — six one eight — five oh three nine. Anything else I can help with?",
    );
    expect(tenant.calls).toBe(0);
  });
});
