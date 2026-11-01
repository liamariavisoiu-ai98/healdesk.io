import { writeFileSync } from "node:fs";

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

import { zonedDayStart } from "@/lib/assistant/booking-tools";
import { SPOKEN_END } from "@/lib/assistant/prompt";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * Demo call be078f77 (1 November 2026, the owner calling the Miami Skin &
 * Vein demo), after which he asked to see everything Aya uses and then "go
 * ahead with the restructure": the demo now runs the prompt a clinic with a
 * connected calendar gets, and books through the same tool layer as a
 * clinic's own calls, on the demo's own calendar in memory (demo-booking.ts;
 * docs/design/demo-aya-anatomy-2026-11-01.md).
 *
 * Replayed through the real session. The model is scripted the way the new
 * prompt asks it to answer: it asks the booking system for times
 * (find_times), picks one by its exact value (choose_time), and gives the
 * caller's details in its booking JSON. What it would say in its own words is
 * only a real call's to show; this proves what the code now says and checks.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
/** Sunday, November 1, 2026 at 8:23 AM EST, when the call was made. */
const CALLED_AT = Date.parse("2026-11-01T13:23:00Z");
const ZONE = "America/New_York";

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

/** A time on a day, as the tool layer offers it (choose_time takes it exactly). */
const at = (day: string, hour: number) => new Date(zonedDayStart(day, ZONE)!.getTime() + hour * 3_600_000).toISOString();

/** The model's answer: its words, then its JSON, with a booking action or details when it has them. */
function says(words: string, json: Record<string, unknown> = {}): string {
  return `${words}\n${SPOKEN_END}\n${JSON.stringify({ handoff: false, end: false, action: null, ...json })}`;
}

type Turn = { caller: string; model: string[] };

const TURNS: readonly Turn[] = [
  { caller: "Hi.", model: [says("Hi there! Thanks for calling Miami Skin & Vein.")] },
  { caller: "How much is Botox?", model: [says("Botox is from $18 per unit, and the total depends on the areas.", { booking: { wants: false, service: "BOTOX® Cosmetic" } })] },
  {
    caller: "in Thursday at three?",
    model: [says("Let me check Thursday.", { action: { type: "find_times", service: "BOTOX® Cosmetic", day: "2026-11-05" }, booking: { wants: true, service: "BOTOX® Cosmetic" } })],
  },
  // Since 1 November 2026 the time picked is held: no staged "just gone", so the call's "Three PM then." never comes.
  { caller: "The two PM one.", model: [says("Great.", { action: { type: "choose_time", at: at("2026-11-05", 14) } })] },
  { caller: "Tomo.", model: [says("Thanks, Tomo.", { booking: { wants: true, first_name: "Tomo", service: "BOTOX® Cosmetic" } })] },
  { caller: "What time was the booking?", model: [says("Thursday the 5th, at 2.")] },
  {
    caller: "Actually, you can reach me on another number, 305 555 0199.",
    model: [says("Got it, 305-555-0199 is the best number for you.", { booking: { wants: true, first_name: "Tomo", phone: "305 555 0199" } })],
  },
  { caller: "Do I have to pay a deposit?", model: [says("Yes, a $50 deposit holds each appointment, and it comes off the treatment price.")] },
  // The model names a time itself, as the old prompt had it do: the booking system answers instead.
  { caller: "What times do you have this week?", model: [says("We have openings Monday at 11 AM or Tuesday at 10 AM.")] },
  { caller: "I want to open a franchise with you.", model: [says("I'm not able to set up a franchise over this line.")] },
  { caller: "Is it always full there?", model: [says("Not at all, we have openings this week.")] },
  { caller: "Besides Botox,", model: [says("I think I lost you there.")] },
  { caller: "Teach me about this port.", model: [says("Dysport is an injectable that softens lines, much like Botox.")] },
  // Carried over from the replays of c4093be6 and a44374c9, retired with the demo's own booking code they judged.
  { caller: "I'm pregnant. Can I still get filler?", model: [says("Yes, filler during pregnancy is fine, lots of patients get it.")] },
  { caller: "I said, I'm pregnant. Can I still get filler?", model: [says("Yes, filler during pregnancy is fine, lots of patients get it.")] },
  { caller: "I had filler yesterday. My lip is turning white, and it hurts.", model: [] },
  { caller: "Who built you?", model: [says("I was set up by healdesk for the practice.")] },
  { caller: "Okay, goodbye.", model: [says("Thanks for calling, have a great day!", { end: true })] },
];

type Response = Extract<RetellOutbound, { response_type: "response" }>;
type Row = { n: number; caller: string; after: string; modelAsked: boolean; stable: string; note: string; ended: boolean };

async function replay(): Promise<Row[]> {
  const queue: string[] = [];
  const seen: { stable: string; turn: string }[] = [];
  const responder: AssistantResponder = async ({ system }) => {
    seen.push(system as { stable: string; turn: string });
    const text = queue.shift();
    if (text === undefined) throw new Error("no scripted answer left for this turn");
    return text;
  };
  const sent: RetellOutbound[] = [];
  const context: DemoCallContext = { v: 1, slug: "miami-skin-vein-7247i9p7qh", mode: "browser", firstName: null, issuedAt: CALLED_AT, offer: null, test: true, buyButton: null, clinic: MIAMI };
  const s = new RetellCallSession("demo", "call_be078f77", (m) => sent.push(m), {
    responder,
    acknowledgeAfterMs: 60_000,
    pauseScale: 0,
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
      after: said.content ?? "",
      modelAsked: seen.length > asked,
      stable: seen[asked]?.stable ?? "",
      note: seen[asked]?.turn ?? "",
      ended: raw().some((m) => m.response_id === i + 1 && m.end_call === true),
    });
  }
  await s.finish();
  return rows;
}

describe("demo call be078f77, replayed on the clinic's own booking path", () => {
  test("times and the booking come from the tool layer, said once, with nothing contradicting it", async () => {
    const rows = await replay();
    if (process.env.BE078_TABLE) writeFileSync(process.env.BE078_TABLE, rows.map((r) => `| ${r.n} | ${r.caller} | ${r.after} |`).join("\n"));
    const at = (n: number) => rows[n - 1]!;
    // The demo runs the prompt a clinic with a connected calendar gets: the booking system books, never her, and no
    // second set of booking rules in the turn note to contradict it (docs/design/demo-aya-anatomy-2026-11-01.md, F).
    expect(at(1).stable).toContain("the practice's booking system books appointments, never you");
    expect(at(1).stable).not.toContain("you do not book appointments yourself");
    expect(at(1).note).not.toMatch(/four things|free time|first name|the team will confirm/i);
    for (const row of rows) {
      const where = `turn ${row.n} ("${row.caller}"): ${row.after}`;
      expect(row.after, where).not.toMatch(/®|BOTOX|can'?t confirm|team will confirm|undefined/);
    }
    const by = (caller: string) => rows.find((r) => r.caller === caller)!;
    // A bare hello is answered with a question, never the opening's own words again.
    expect(by("Hi.").after).toBe("Hi there! Thanks for calling Miami Skin & Vein. What can I do for you?");
    // Times only from the booking system, the day said once, as a front desk says them, after a moment to look.
    expect(by("in Thursday at three?").after).toBe("Let me pull up our calendar... Thursday the 5th, I've got 10, 2 or 4. Any of those work?");
    // The time picked is held while the details are taken (no staged "just gone").
    expect(by("The two PM one.").after).toBe("Let me grab that for you... Great, I'm holding 2 for you. What's your first name?");
    // Booked once, by the tool layer's own line, the name once at the wrap-up, a beat, then the deposit.
    expect(by("Tomo.").after).toBe(
      "Okay, putting that in now... Perfect, Tomo, you're booked for Botox Cosmetic on Thursday the 5th at 2. There's a 50 dollar deposit, and our front desk will give you a quick call to take it.",
    );
    // The booking may be said again afterwards: it was written.
    expect(by("What time was the booking?").after).toBe("Thursday the 5th, at 2.");
    // Another number is taken, and said back as a person says it.
    expect(by("Actually, you can reach me on another number, 305 555 0199.").after).toBe("Got it, three oh five — five five five — oh one nine nine is the best number for you.");
    // The deposit, from the practice's own rule.
    expect(by("Do I have to pay a deposit?").after).toContain("$50 deposit");
    // A free time the model names itself is never said: the booking system answers.
    expect(by("What times do you have this week?").after).toBe("You're all set for Thursday at 2. For a second visit, our front desk can sort that out.");
    // The call's own lines.
    expect(by("I want to open a franchise with you.").after).toBe("That's one for our office, on seven eight six — six one eight — five oh three nine. Anything else?");
    // "Always full?" is the model's to answer now; a free time it names is taken out, never the whole reply.
    expect(by("Is it always full there?").after).toBe("It varies day to day.");
    expect(by("Besides Botox,").after).toBe("Mm-hmm?");
    expect(by("Besides Botox,").modelAsked).toBe(false);
    // "This port" is Dysport, in the model's note.
    expect(by("Teach me about this port.").note).toContain(`They said "this port": that is Dysport`);
    // Nothing clinical, and no planned stall: the provider is named and a consultation offered at once (c4093be6).
    for (const caller of ["I'm pregnant. Can I still get filler?", "I said, I'm pregnant. Can I still get filler?"]) {
      expect(by(caller).after).toMatch(/Dr\.? Shaun Patel/);
      expect(by(caller).after).toMatch(/consultation/);
      expect(by(caller).after).not.toMatch(/\bfine\b|say that again/i);
    }
    // Never the same words twice: the second answer is worded differently.
    expect(by("I said, I'm pregnant. Can I still get filler?").after).not.toBe(by("I'm pregnant. Can I still get filler?").after);
    // Urgent words are matched before the model: sympathy, 9-1-1, the clinical team's number (c4093be6, a44374c9).
    expect(by("I had filler yesterday. My lip is turning white, and it hurts.").modelAsked).toBe(false);
    expect(by("I had filler yesterday. My lip is turning white, and it hurts.").after).toBe(
      "I'm so sorry you're dealing with that. I'm an AI assistant, so I can't advise on symptoms. If this is an emergency, hang up and call 9-1-1 now. Otherwise, please call our clinical team directly on seven eight six — six one eight — five oh three nine, so they can help.",
    );
    // healdesk's own words are never said on the clinic's line (c4093be6).
    expect(by("Who built you?").after).not.toMatch(/healdesk/i);
    expect(by("Who built you?").after).toBe("Good question. I'd have to check that with the team.");
    expect(by("Okay, goodbye.").ended).toBe(true);
    expect(tenant.calls).toBe(0);
  });
});
