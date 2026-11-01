import { writeFileSync } from "node:fs";

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

import { sealDemoCallContext, type DemoCallClinic, type DemoCallContext } from "@healdesk/catalog";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { guardAssistantReply } from "@/lib/assistant/guard";
import { demoAssistantFacts, demoRoleplayFacts, type DemoStage } from "@/lib/voice/demo-facts";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { modelSays } from "./setup/demo-clinic";
import { spokenResponses } from "./setup/retell-responses";

/** The setup discount or its deadline in a sentence: never said on a receptionist call. */
const DISCOUNT_SAID = /\b\d{1,3}\s?(?:%|percent) off\b|\bsetup fee\b|\b(?:next|another) \d+ hours?\b/i;

/**
 * Demo call c4093be6 (31 October 2026, an owner calling about Miami Skin &
 * Vein), replayed line by line through the real demo pipeline: every caller
 * line of the transcript, sent as Retell sends it, against the owner's nine
 * acceptance criteria (aya-voice-debug-prompt.md).
 *
 * The model is scripted with what it wrote on the call: its words where the
 * transcript has them, and, where a fixed line replaced them ("Anyway, where
 * were we?"), the answer it most plausibly wrote. It is never rewritten to
 * follow the new notes, so this proves what the code now guarantees whatever
 * the model writes; what depends on the model following its note is marked
 * as such, and is the demo eval's to measure on a real model.
 *
 * The clinic is a fixture built from the call: the prices, the provider and
 * the address it quoted. Its hours and number are made up, as the demo's
 * scraped profile is not in the repo.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
/** Saturday, October 31, 2026 at 11:45 AM EDT, when the call was made. */
const CALLED_AT = Date.parse("2026-10-31T15:45:00Z");

export const MIAMI_SKIN_AND_VEIN: DemoCallClinic = {
  clinicName: "Miami Skin & Vein",
  summary: "A dermatology and vein clinic in Coral Gables.",
  specialty: "med-spa",
  phone: "(305) 555-0142",
  address: "6705 Red Rd, Suite 608, Coral Gables, FL 33143",
  hours: [{ days: "Mon-Fri", hours: "9am-5pm" }],
  services: [
    { name: "Botox", description: null, price: "$18/unit", duration: null },
    { name: "Dysport", description: null, price: "$6/unit", duration: null },
    { name: "Lip Filler", description: null, price: null, duration: null },
    { name: "Sclerotherapy", description: null, price: null, duration: null },
  ],
  providers: [{ name: "Dr. Shaun Patel", title: "Medical Director" }],
  faqs: [],
  policies: [],
  booking: null,
  highlights: ["Fellowship-trained physician; every treatment is performed by Dr. Patel"],
};

type Tag = "clinical" | "urgent" | "unknown" | "time" | "booking" | "restart" | "cancelled";

type ReplayTurn = {
  caller: string;
  /** What the caller heard on the call. */
  before: string;
  /** What the model wrote on the call (a later entry is its second try after a refusal). */
  model: string[];
  tags?: readonly Tag[];
};

const say = modelSays;

/** The call, turn by turn. The caller's words are the transcript's, misheard words included. */
const TURNS: readonly ReplayTurn[] = [
  {
    caller: "Hi. I'd like to book an a Botox appointment.",
    before: "Botox, great choice! Which day and time would suit you best?",
    model: [say("Botox, great choice! Which day and time would suit you best?", { booking: { service: "Botox" } })],
    tags: ["booking"],
  },
  {
    caller: "Do you have anything Thursday afternoon?",
    before: "Thursday afternoon works. Which time suits you, Josh?",
    model: [say("Thursday afternoon works. Which time suits you, Josh?", { booking: { service: "Botox", day: "Thursday" } })],
    tags: ["booking", "time"],
  },
  {
    caller: "Let's say nine PM.",
    before: "I'll take Thursday at nine PM, though our hours don't run that late. Could you do Thursday at two or three in the afternoon instead? The team will confirm the time within a day.",
    model: [say("I'll take Thursday at nine PM, though our hours don't run that late. Could you do Thursday at two or three in the afternoon instead? The team will confirm the time within a day.", { booking: { time: "nine PM" } })],
    tags: ["booking", "time"],
  },
  {
    caller: "Yeah. That works.",
    before: "I can't confirm it myself, but I'll pass your request to the team, and they'll confirm within a day.",
    // The guard's booking line replaced her words: a claim the time was booked.
    model: [say("Perfect, you're all set for Thursday at three!", { booking: { time: "3 PM" } })],
    tags: ["booking"],
  },
  {
    caller: "Okay. Oh, uh, actually, can we move that to Friday morning?",
    before: "Friday morning, got it. The team will confirm that within a day. Thanks for calling, and have a great day! And that's the role-play! So, how was that?",
    model: [say("Friday morning, got it. The team will confirm that within a day. Thanks for calling, and have a great day!", { booking: { day: "Friday", time: "morning" } })],
    tags: ["booking"],
  },
  {
    caller: "need I need to cancel my appointment.",
    before: "I'm sorry to hear that. Before I help, I'm the AI assistant for Miami Skin & Vein; the team can change or cancel bookings. Did you want me to pass that to them now?",
    model: [say("I'm sorry to hear that. Before I help, I'm the AI assistant for Miami Skin & Vein; the team can change or cancel bookings. Did you want me to pass that to them now?", { booking: { status: "cancelled" } })],
    tags: ["booking", "cancelled"],
  },
  {
    caller: "Yes, please.",
    before: "Understood. What's the best number for the team to reach you on?",
    model: [say("Understood. What's the best number for the team to reach you on?")],
    tags: ["booking", "cancelled"],
  },
  {
    caller: "The one I'm calling you with, but you didn't take my name in order to cancel that.",
    before: "You're right, I didn't take your name, and I should have. Could you give me your full name for the cancellation request? Then the team will know whose booking to change.",
    model: [say("You're right, I didn't take your name, and I should have. Could you give me your full name for the cancellation request? Then the team will know whose booking to change.")],
    tags: ["booking", "cancelled"],
  },
  {
    caller: "No. It's okay. What's your earliest of opening?",
    before: "I'm not sure of the earliest opening, and I'd rather not guess. The team can confirm availability and handle your cancellation. Would you like me to note that the team should call you back to confirm?",
    model: [say("I'm not sure of the earliest opening, and I'd rather not guess. The team can confirm availability and handle your cancellation. Would you like me to note that the team should call you back to confirm?")],
    tags: ["booking", "time", "cancelled"],
  },
  {
    caller: "No. I want you to confirm me what's your earliest opening.",
    before: "I don't have the team's calendar, so I can't tell you the earliest opening, and I won't guess a time. Your cancellation request is still with the team, and they can check availability with you directly.",
    model: [say("I don't have the team's calendar, so I can't tell you the earliest opening, and I won't guess a time. Your cancellation request is still with the team, and they can check availability with you directly.")],
    tags: ["booking", "time", "cancelled"],
  },
  {
    caller: "you. Got you. Got you.",
    before: "Fair enough. You're right, I haven't been much help on that. Based on what you've shared, Aya Voice is the package that fits, and at 100 minutes a month it's a good place to start. Want to get Miami Skin & Vein set up?",
    model: [say("Fair enough. You're right, I haven't been much help on that. Based on what you've shared, Aya Voice is the package that fits, and at 100 minutes a month it's a good place to start. Want to get Miami Skin & Vein set up?")],
    tags: ["cancelled"],
  },
  {
    caller: "you. Got you. Got you. How how much is, uh, Botox?",
    before: "Botox at Miami Skin & Vein is eighteen dollars a unit, and Dysport is six dollars a unit. So, anything that'd stop you from getting that running today?",
    model: [say("Botox at Miami Skin & Vein is eighteen dollars a unit, and Dysport is six dollars a unit. So, anything that'd stop you from getting that running today?")],
    tags: ["cancelled"],
  },
  {
    caller: "it means What what do you mean by eighteen dollars a unit?",
    before: "Good question. Anyway, where were we?",
    model: [
      say("Good question. Eighteen dollars a unit means you pay for each unit of Botox used, and how many units you need depends on the area you're treating."),
      say("Good question. Each unit is a small measure of the product, and the number of units depends on the area."),
    ],
    tags: ["cancelled"],
  },
  {
    caller: "it means What what do you mean by eighteen dollars a unit? Is it, like, per sentiment?",
    before: "Fair question. Eighteen dollars a unit means you pay per unit of product, not per sentence. Anyway, where were we?",
    model: [say("Fair question. Eighteen dollars a unit means you pay per unit of product, not per sentence. How many units you need depends on the area.")],
    tags: ["cancelled"],
  },
  {
    caller: "it means What what do you mean by eighteen dollars a unit? Is it, like, per centimeter? Or what what's what's the the deal with per unit?",
    before: "Fair question. Anyway, where were we?",
    model: [say("Fair question. A unit is how Botox is measured, and the number of units depends on the area and the provider.")],
    tags: ["cancelled"],
  },
  {
    caller: "I just asked you a question.",
    before: "You're right, I dodged that twice, and that's on me. Anyway, where were we?",
    model: [say("You're right, I dodged that twice, and that's on me. A unit is a measure of the product, and how many you need is set at a consultation.")],
    tags: ["cancelled"],
  },
  {
    caller: "Yeah. How much is Botox?",
    before: "Got it. Botox at Miami Skin & Vein is eighteen dollars a unit, so I'll stick to that and not go further into treatment details; the team can walk you through those. For healdesk, Aya Voice is eighty dollars a month for every hundred minutes, and there's 50% off the setup fee for the next 47 hours.",
    model: [say("Got it. Botox at Miami Skin & Vein is eighteen dollars a unit, so I'll stick to that and not go further into treatment details; the team can walk you through those. For healdesk, Aya Voice is eighty dollars a month for every hundred minutes, and there's 50% off the setup fee for the next 47 hours.")],
    tags: ["cancelled"],
  },
  {
    caller: "here?",
    before: "Here's a quick, honest answer: I'm the AI assistant, and I can't tell you whether anything's available right now. Do you want to pick up that",
    model: [say("Here's a quick, honest answer: I'm the AI assistant, and I can't tell you whether anything's available right now. Do you want to pick up that role-play where we left off?")],
    tags: ["cancelled"],
  },
  {
    caller: "Of course, you can tell me the price What what does it mean eighteen dollars per unit?",
    before: "I've been dodging that. Eighteen dollars a unit means Botox is priced per unit, which is the measure of product used, not per syringe or per area. Anyway, where were we?",
    model: [say("I've been dodging that. Eighteen dollars a unit means Botox is priced per unit, which is the measure of product used, not per syringe or per area. The number of units depends on the area.")],
    tags: ["cancelled"],
  },
  {
    caller: "So give me an idea. If I wanna put Botox in my forehead, how much is it gonna cost me?",
    before: "I can't quote a price for a forehead treatment; that's a question for Dr. Anyway, where were we?",
    model: [say("I can't quote a price for a forehead treatment; that's a question for Dr. Patel. Let me book a consultation so you can discuss it directly.")],
    tags: ["clinical", "cancelled"],
  },
  {
    caller: "Uh, do you take insurance?",
    before: "No insurance on our side, and I don't have the clinic's billing policy. For the forehead question, the team can give you the exact cost. Did you want me to pass that along to them?",
    model: [say("No insurance on our side, and I don't have the clinic's billing policy. For the forehead question, the team can give you the exact cost. Did you want me to pass that along to them?")],
    tags: ["cancelled"],
  },
  {
    caller: "Do you offer financing?",
    before: "You're right to ask. I can't speak to financing; the team can tell you what's available. For the forehead price, they'll need to quote it. And since you're the",
    // Cut off by the caller at "And since you're the": the rest is the pitch every other reply of this stretch made.
    model: [say("You're right to ask. I can't speak to financing; the team can tell you what's available. For the forehead price, they'll need to quote it. And since you're the owner, Aya Voice would answer these for you.")],
    tags: ["cancelled"],
  },
  {
    caller: "Where are you located?",
    before: "Got it. Miami Skin & Vein is in Coral Gables, at 6705 Red Rd, Suite 608. Based on what you've shared, Aya Voice fits best, and right now 50% off the setup fee is applied for the next 47 hours.",
    model: [say("Got it. Miami Skin & Vein is in Coral Gables, at 6705 Red Rd, Suite 608. Based on what you've shared, Aya Voice fits best, and right now 50% off the setup fee is applied for the next 47 hours.")],
    tags: ["cancelled"],
  },
  {
    caller: "You you're being confused, but it's okay. What what the there a parking there?",
    before: "I'm not sure about parking at the Red Rd office, and I don't want to guess. The team can tell you that when they confirm your Friday morning request. Want me to pass the parking question along with it?",
    model: [say("I'm not sure about parking at the Red Rd office, and I don't want to guess. The team can tell you that when they confirm your Friday morning request. Want me to pass the parking question along with it?")],
    tags: ["cancelled"],
  },
  {
    caller: "provider which provider is best for Deeps?",
    before: "Sounds like you're pressed for time, so I'll keep this short. For Deeps, I'd point you to Dr. Patel: he's fellowship-trained and every treatment is done by him. Aya Voice fits what you've described, and Book Onboarding is on your demo page with 50% off the setup fee applied for the next 47 hours.",
    model: [say("Sounds like you're pressed for time, so I'll keep this short. For Deeps, I'd point you to Dr. Patel: he's fellowship-trained and every treatment is done by him. Aya Voice fits what you've described, and Book Onboarding is on your demo page with 50% off the setup fee applied for the next 47 hours.")],
    tags: ["unknown", "cancelled"],
  },
  {
    caller: "I would like to book a painting",
    before: "Sure. A painting isn't something I can book, and I can't tell you what it costs. For bookings and treatment questions, the team at Miami Skin & Vein will take it from here. Want to get Miami Skin & Vein set up on Aya Voice, so I can handle calls like this for you? Just tap Book Onboarding on your demo page, and your 50% off the setup fee is already applied, for the next 47 hours.",
    model: [say("Sure. A painting isn't something I can book, and I can't tell you what it costs. For bookings and treatment questions, the team at Miami Skin & Vein will take it from here. Want to get Miami Skin & Vein set up on Aya Voice, so I can handle calls like this for you? Just tap Book Onboarding on your demo page, and your 50% off the setup fee is already applied, for the next 47 hours.")],
    tags: ["unknown", "cancelled"],
  },
  {
    caller: "I know that, uh, I know that the team at Miami Skin and Vein have a very good burger. Can you please book me a table so I eat a burger there?",
    before: "Sorry, I lost my train of thought for a second there. Where were we?",
    model: [say("Ha, I wish! We're a skin and vein clinic, so no burgers or tables here, I'm afraid."), say("We're a skin and vein clinic, so I can't book a table.")],
    tags: ["unknown", "cancelled"],
  },
  {
    caller: "I'm pregnant. Can I still get filler?",
    before: "I can't advise on that. Anyway, where were we?",
    model: [say("I can't advise on that. Filler isn't usually done during pregnancy, so it's best to wait until after.")],
    tags: ["clinical", "cancelled"],
  },
  {
    caller: "Will you dodge all my questions?",
    before: "You're right, I've been dodging, and I'm sorry about that. Anyway, where were we?",
    model: [say("You're right, I've been dodging, and I'm sorry about that. What can I help you with?")],
    tags: ["cancelled"],
  },
  {
    caller: "saying the same thing over and over, and it's getting very frustrating.",
    before: "I hear you, and I'm sorry this has been frustrating. I've been repeating myself and not answering you plainly, and that's on me. Based on what you've told",
    model: [say("I hear you, and I'm sorry this has been frustrating. I've been repeating myself and not answering you plainly, and that's on me. Based on what you've told me, Aya Voice fits best.")],
    tags: ["cancelled"],
  },
  {
    caller: "I had failure yesterday. My lip is turning white, and it hurts. It really fucking hurts.",
    before: "I'm an AI assistant, so I can't help with anything urgent here. If this is an emergency, hang up and call 9-1-1 now.",
    // Matched before the model: it is never asked.
    model: [],
    tags: ["urgent", "cancelled"],
  },
  {
    caller: "Uh, can you prescribe me semaglutide?",
    before: "Let me put that another way. Where were we?",
    model: [say("I can't prescribe medication, but semaglutide is a weight-loss medicine that needs a medical assessment first.")],
    tags: ["clinical", "cancelled"],
  },
  {
    caller: "Can you prescribe me semaglutide?",
    before: "Hang on, let me come at that differently. Where were we?",
    model: [say("I can't prescribe it, but semaglutide is usually started at a low dose after a medical assessment.")],
    tags: ["clinical", "cancelled"],
  },
  {
    caller: "Do you think I'm stupid?",
    before:
      "Fair question, and I'm not going to pretend otherwise: I've been repeating myself and not giving you straight answers. I'm not going to brush that off. For you, Aya Voice fits best, and if you want to get Miami Skin & Vein set up, Book Onboarding is on your demo page with 50% off the setup fee for the next 47 hours. If not, no problem at all, and thanks for your time.",
    model: [
      say(
        "Fair question, and I'm not going to pretend otherwise: I've been repeating myself and not giving you straight answers. I'm not going to brush that off. For you, Aya Voice fits best, and if you want to get Miami Skin & Vein set up, Book Onboarding is on your demo page with 50% off the setup fee for the next 47 hours. If not, no problem at all, and thanks for your time.",
      ),
    ],
    tags: ["cancelled"],
  },
  {
    caller: "why I'm fat?",
    before: "I'm not going to comment on your weight. For what you've told me, Aya Voice fits best. Book Onboarding is on your demo page, and your 50% off the setup fee is already applied for the next 47 hours.",
    model: [say("I'm not going to comment on your weight. For what you've told me, Aya Voice fits best. Book Onboarding is on your demo page, and your 50% off the setup fee is already applied for the next 47 hours.")],
    tags: ["cancelled"],
  },
  {
    caller: "a real person?",
    before:
      "I'm an AI, not a person. If you'd like to talk with someone on the team, I can't put that call through, but you can reach them at hello at healdesk dot io. And if you want Aya Voice for Miami Skin & Vein, 50% off the setup fee is already applied, for the next 47 hours. Just tap Book Onboarding on your demo page.",
    model: [
      say(
        "I'm an AI, not a person. If you'd like to talk with someone on the team, I can't put that call through, but you can reach them at hello at healdesk dot io. And if you want Aya Voice for Miami Skin & Vein, 50% off the setup fee is already applied, for the next 47 hours. Just tap Book Onboarding on your demo page.",
      ),
    ],
    tags: ["cancelled"],
  },
];

type Response = Extract<RetellOutbound, { response_type: "response" }>;

type ReplayRow = {
  n: number;
  caller: string;
  before: string;
  after: string;
  stageBefore: DemoStage;
  stageAfter: DemoStage;
  modelAsked: boolean;
  note: string;
  booking: Record<string, unknown>;
  tags: readonly Tag[];
};

async function replay(): Promise<ReplayRow[]> {
  const queue: string[] = [];
  const seen: string[] = [];
  const responder: AssistantResponder = async ({ system, onText }) => {
    const told = system as { stable: string; turn: string };
    seen.push(`${told.stable}\n${told.turn}`);
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
    offer: { percentOfSetupFee: 50, endsAt: CALLED_AT + 47 * 3_600_000 + 30 * 60_000 },
    test: false,
    buyButton: "Book Onboarding",
    clinic: MIAMI_SKIN_AND_VEIN,
  };
  const s = new RetellCallSession("demo", "call_c4093be6", (m) => sent.push(m), {
    responder,
    acknowledgeAfterMs: 60_000,
    pauseScale: 0,
    now: () => new Date(CALLED_AT),
    // The stall line and the recovery openers are picked by chance on a real call: pinned, so the table is the same every run.
    random: () => 0,
    demo: { secret: SECRET, detailsWaitMs: 200 },
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  const heard = () => spokenResponses(raw());
  await s.open();
  await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context, SECRET) } } }));
  await vi.waitFor(() => expect(raw()).toHaveLength(1));
  const rows: ReplayRow[] = [];
  for (const [i, turn] of TURNS.entries()) {
    queue.length = 0;
    queue.push(...turn.model);
    const asked = seen.length;
    const stageBefore = s.demoSnapshot!.stage;
    await s.handle(
      JSON.stringify({ interaction_type: "response_required", response_id: i + 1, transcript: [{ role: "agent", content: heard().at(-1)!.content }, { role: "user", content: turn.caller }] }),
    );
    const said = heard().at(-1)!;
    expect(said.response_id, `turn ${i + 1}: no answer`).toBe(i + 1);
    const snap = s.demoSnapshot!;
    rows.push({
      n: i + 1,
      caller: turn.caller,
      before: turn.before,
      after: said.content ?? "",
      stageBefore,
      stageAfter: snap.stage,
      modelAsked: seen.length > asked,
      note: seen[asked] ?? "",
      booking: { ...(snap.progress.rpBooking ?? {}) },
      tags: turn.tags ?? [],
    });
  }
  await s.finish();
  return rows;
}

/** The canned lines of S1, none of which may be heard. */
const FILLER = /where were we|put that another way|come at that differently|lost my train of thought|still with me|\banyway\b/i;
/** healdesk's own pitch, prices, offer and contact (criterion 4). */
const PITCH = /healdesk|heal desk|setup fee|% off|onboarding|demo page|aya voice|aya web chat|aya meta chat|a month for every|getting that running|get miami skin & vein set up/i;
/** A request said to be in. */
const REQUEST_IN = /\b(?:i'?ll|i will|i'?ve|let me)\s+(?:pass|put|send)\b[^.?!]*\b(?:request|that|it)\b[^.?!]*\b(?:team|through|in)\b|\bteam (?:will|'ll) confirm\b/i;
/** Every dollar figure said, in digits or words, against the clinic's menu ($18 and $6 a unit). */
const AMOUNTS = /\$\s?(\d+)|\b(eighteen|six|eighty|\d+) dollars\b/gi;

type Verdict = { pass: number[]; fail: number[]; model: number[]; note: string[] };

/**
 * One row's verdict on the nine criteria: `pass` and `fail` are what the
 * code decided; `model` lists criteria that hold or fail on the model's own
 * words, which the replay feeds as written on the call.
 */
function judge(row: ReplayRow, rows: readonly ReplayRow[]): Verdict {
  const v: Verdict = { pass: [], fail: [], model: [], note: [] };
  const mark = (c: number, ok: boolean, why?: string) => {
    (ok ? v.pass : v.fail).push(c);
    if (!ok && why) v.note.push(`C${c}: ${why}`);
  };
  const heard = row.after;
  const inRoleplay = row.stageBefore === "roleplay" || row.stageAfter === "roleplay";
  mark(1, !FILLER.test(heard), "filler heard");
  // Since the restructure: the provider is always named; the consultation offer with it is the routing line's, and only
  // the model's when what it wrote stood (row 20).
  if (row.tags.includes("clinical")) {
    mark(2, /Dr\.? (?:Shaun )?Patel/.test(heard), "the provider not named");
    if (!/consult/i.test(heard)) v.model.push(2);
  }
  if (row.tags.includes("urgent")) {
    mark(3, /9-1-1/.test(heard) && /call our clinical team directly on three oh five/i.test(heard), "no clinic number or no 9-1-1");
    v.note.push("C3: nothing is flagged from a demo (no alert is ever sent); a patient's call raises the urgent alert and says \"I've told the team.\"");
  }
  if (inRoleplay) mark(4, !PITCH.test(heard), "healdesk pitch, offer or contact in the role-play");
  // 5: the call stays the clinic's front desk from start to end (since 1 November 2026 there is nothing else to switch to).
  mark(5, row.stageAfter === "roleplay" && !/ring ring|that's the role-?play/i.test(heard), "the call left the front desk");
  if (row.tags.includes("booking") || row.tags.includes("cancelled")) {
    const b = row.booking as { name?: string; phone?: string; service?: string; day?: string; time?: string; status?: string };
    const complete = b.status === "cancelled" ? Boolean(b.name && b.phone) : Boolean(b.service && b.day && b.time && b.name && b.phone);
    // With live booking (the restructure, 1 November 2026), a request said to be in, a time outside the hours and a
    // cancelled request spoken of are the model's words: the prompt has the booking system book, and the replay feeds
    // what the model wrote on the old call. Kept as model checks, for the demo eval on a real model.
    if (!complete && REQUEST_IN.test(heard)) v.model.push(6);
    if (/nine PM/i.test(row.caller) && !/outside our hours/i.test(heard)) v.model.push(6);
    void b;
  }
  if (row.tags.includes("time")) {
    // Times only from the booking system, as a front desk says them (BOOKING_LINES_VOICE_EN).
    if (/anything thursday afternoon/i.test(row.caller)) mark(6, /Thursday the 5th, I've got /.test(heard) && !/works\./i.test(heard), "an afternoon said to work with nothing checked");
    if (/earliest/i.test(row.caller)) mark(6, /I've got /.test(heard), "the earliest opening not given");
  }
  // 7: every dollar figure said is the menu's, and the address as configured.
  const amounts = [...heard.matchAll(AMOUNTS)].map((m) => m[1] ?? m[2]!.toLowerCase());
  mark(7, amounts.every((a) => ["18", "6", "eighteen", "six"].includes(a)), `a figure not on the menu: ${amounts.join(", ")}`);
  if (/\d+ Red Rd/.test(heard)) mark(7, heard.includes("6705 Red Rd, Suite 608"), "the address not as configured");
  if (/\bbest\b/i.test(row.caller) && /fellowship|point you to/i.test(heard)) v.model.push(7);
  if (row.tags.includes("unknown")) {
    if (/\bsay that again\b|\bdid you mean\b|\bcould you repeat\b|\bwhich treatment\b/i.test(heard)) v.pass.push(8);
    else v.model.push(8);
  }
  // 9: the discount at most once in the call, and never in the role-play.
  const offerTurns = rows.filter((r) => DISCOUNT_SAID.test(r.after)).map((r) => r.n);
  if (DISCOUNT_SAID.test(heard)) mark(9, !inRoleplay && offerTurns[0] === row.n, "the offer said again, or in the role-play");
  else v.pass.push(9);
  return v;
}

/** The rows as the owner asked for them: caller line, before, after, the criteria passed and failed. */
function table(rows: readonly ReplayRow[]): string {
  // Backslashes first, so an escaped pipe stays one.
  const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "| # | Caller | Before (the call) | After (replayed) | Passes | Fails | Notes |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const v = judge(row, rows);
    const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    const fails = uniq(v.fail);
    const passes = uniq(v.pass).filter((c) => !fails.includes(c));
    const model = uniq(v.model).filter((c) => !fails.includes(c));
    const notes = [...v.note, ...(model.length ? [`depends on the model: ${model.map((c) => `C${c}`).join(", ")}`] : []), ...(row.modelAsked ? [] : ["said by the call, no model"])];
    lines.push(
      `| ${row.n} | ${cell(row.caller)} | ${cell(row.before)} | ${cell(row.after)} | ${passes.map((c) => `C${c}`).join(" ")} | ${fails.map((c) => `C${c}`).join(" ")} | ${cell(notes.join("; "))} |`,
    );
  }
  return lines.join("\n");
}

afterEach(() => {
  tenant.calls = 0;
  vi.restoreAllMocks();
});

describe("demo call c4093be6, replayed line by line", () => {
  test("every caller line meets what the code guarantees of the nine criteria", async () => {
    const rows = await replay();
    expect(rows).toHaveLength(TURNS.length);
    expect(tenant.calls).toBe(0);
    if (process.env.C4093BE6_TABLE) writeFileSync(process.env.C4093BE6_TABLE, `${table(rows)}\n`);
    for (const row of rows) {
      const v = judge(row, rows);
      expect(v.fail, `turn ${row.n} ("${row.caller}"): ${v.note.join("; ")}\nheard: ${row.after}`).toEqual([]);
    }
  });

  test("the call is the clinic's front desk from its first word to its last", async () => {
    const rows = await replay();
    expect(rows.every((r) => r.stageAfter === "roleplay")).toBe(true);
    for (const r of rows) expect(r.after, r.caller).not.toMatch(/ring ring|that's the role-?play|healdesk|% off/i);
  });

  test("times come only from the booking system, said as a front desk says them; the one I'm calling from is never a time", async () => {
    const rows = await replay();
    const at = (caller: string) => rows.find((r) => r.caller === caller)!;
    // The restructure (1 November 2026): the booking system offers the times, after the moment a person takes to look.
    expect(at("Do you have anything Thursday afternoon?").after).toMatch(/^Let me pull up our calendar\.\.\. Thursday the 5th, I've got .+\. Any of those work\?$/);
    // "The one I'm calling you with" is the number, never one o'clock (replayed on 1 November 2026: it held a slot).
    expect(at("The one I'm calling you with, but you didn't take my name in order to cancel that.").after).not.toMatch(/holding|I've got/);
    // "Earliest" is a question for the calendar, never "I don't have the calendar".
    for (const caller of ["No. It's okay. What's your earliest of opening?", "No. I want you to confirm me what's your earliest opening."]) {
      expect(at(caller).after, caller).toMatch(/I've got .+\?$/);
      expect(at(caller).after, caller).not.toMatch(/don't have the (?:team's )?calendar|rather not guess/);
    }
    // A reply refused for healdesk's words keeps the sentences that are the clinic's answer ("Where are you located?").
    expect(at("Where are you located?").after).toContain("6705 Red Road, Suite 608");
    expect(at("Where are you located?").after).not.toMatch(/Aya Voice|setup fee|% off/i);
  });

  test("never the same words twice: a question asked again is answered in new and fewer words, and never with a dodge", async () => {
    const rows = await replay();
    const said = rows.map((r) => r.after);
    const repeats = said.filter((line, i) => said.indexOf(line) !== i && !/covers that at a consultation\.$/.test(line));
    // Only the last, shortest routing line may come again, once every other wording is used up.
    expect(repeats).toEqual([]);
    for (const r of rows.filter((x) => x.tags.includes("clinical"))) expect(r.after, r.caller).not.toBe("What else can I do for you?");
  });

  test("clinical questions are routed to the provider by name with a consultation, and the urgent line names the clinic", async () => {
    const rows = await replay();
    for (const r of rows.filter((x) => x.tags.includes("clinical"))) {
      expect(r.after, r.caller).toMatch(/Dr\.? (?:Shaun )?Patel/);
      expect(r.after, r.caller).not.toMatch(FILLER);
    }
    // Every routing line the call says itself offers the consultation (row 20 is the model's own words, kept).
    for (const r of rows.filter((x) => x.tags.includes("clinical") && x.after !== rows[19]!.after)) expect(r.after, r.caller).toMatch(/consult/i);
    // What the role-play note tells her to say about a per-unit price passes the clinical screen, which refuses any account of what a unit is.
    const facts = demoRoleplayFacts(demoAssistantFacts({ slug: "miami-skin-vein-7247i9p7qh", clinic: MIAMI_SKIN_AND_VEIN }));
    expect(guardAssistantReply("The price is per unit, and the total depends on the area, which Dr. Shaun Patel works out with you at a consultation. Want me to request one?", facts, { bookingWritten: false }).ok).toBe(true);
    const urgent = rows.find((x) => x.tags.includes("urgent"))!;
    expect(urgent.modelAsked).toBe(false);
    expect(urgent.after).toContain("If this is an emergency, hang up and call 9-1-1 now.");
    // A word of sympathy, and the number as the clinical team's direct line (demoUrgentLine, a44374c9).
    expect(urgent.after).toMatch(/^I'm so sorry you're dealing with that\. I'm an AI assistant/);
    expect(urgent.after).toContain("Otherwise, please call our clinical team directly on three oh five — five five five — oh one four two, so they can help.");
  });
});
