import { describe, expect, test, vi } from "vitest";

// No database, and none may be asked for: a demo call keeps nothing.
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    throw new Error("a demo call must never reach the database");
  },
}));
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import { RETELL_CALL_SETTINGS, sealDemoCallContext, type DemoCallClinic, type DemoCallContext } from "@healdesk/catalog";

import { SpokenStream, withoutMood, type AssistantResponder } from "@/lib/assistant/turn";
import { voiceExamples } from "@/lib/assistant/prompt";
import { BOOKING_LINES_VOICE_EN } from "@/lib/booking/lines";
import { afterFiller, fillerFor } from "@/lib/voice/fillers";
import { RetellCallSession, SPANISH_OFFER_LINE, type RetellOutbound } from "@/lib/voice/retell";

import { modelSays } from "./setup/demo-clinic";

/**
 * The owner's demo call on the evening of 1 November 2026 (Miami Skin & Vein): what it found, pinned. Fillers
 * doubled her own opener ("Sure thing, Sure thing"), tool notes were read out ("(find_times: service ...)"), the
 * calendar said "That one's full. Another day work?" four times, "Hello?" heard her introduction again, the call
 * ended on "No." with no goodbye, and the office murmur behind her made her words sound cut off.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
const AT = Date.parse("2026-11-01T15:45:00Z");
const OPENING = "Thanks for calling Miami Skin & Vein, this is Aya, the AI assistant, and this call's transcribed. How can I help you today?";

const CLINIC: DemoCallClinic = {
  clinicName: "Miami Skin & Vein",
  summary: "A physician-led cosmetic practice in Coral Gables.",
  specialty: "med-spa",
  phone: "(305) 555-0142",
  address: "6705 Red Rd, Suite 608, Coral Gables, FL 33143",
  hours: [{ days: "Mon-Fri", hours: "9am-5pm" }],
  services: [
    { name: "Botox", description: null, price: "$18/unit", duration: null },
    { name: "Hydrafacial", description: null, price: "$300", duration: "45 min" },
  ],
  providers: [{ name: "Dr. Shaun Patel", title: "Medical Director" }],
  faqs: [],
  policies: [],
  booking: null,
  highlights: [],
};

type Response = Extract<RetellOutbound, { response_type: "response" }>;

async function call(lines: readonly { caller: string; model: string }[]) {
  // Each turn's scripted answer, by the turn: a line the call says itself asks the model nothing.
  let current = 0;
  const responder: AssistantResponder = async ({ onText }) => {
    const text = lines[current]?.model ?? modelSays("Okay.");
    if (onText) for (const piece of text.split(/(?<=[.!?] )/)) onText(piece);
    return text;
  };
  const sent: RetellOutbound[] = [];
  const context: DemoCallContext = {
    v: 1,
    slug: "miami-skin-vein-evening",
    mode: "browser",
    firstName: null,
    issuedAt: AT,
    offer: { percentOfSetupFee: 50, endsAt: AT + 47 * 3_600_000 },
    test: false,
    buyButton: "Book Onboarding",
    clinic: CLINIC,
  };
  const s = new RetellCallSession("demo", "call_evening", (m) => sent.push(m), {
    responder,
    pauseScale: 0,
    now: () => new Date(AT),
    random: () => 0,
    demo: { secret: SECRET, detailsWaitMs: 200 },
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  await s.open();
  await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context, SECRET) } } }));
  await vi.waitFor(() => expect(raw()).toHaveLength(1));
  const heard: { said: string; ended: boolean }[] = [];
  let last = OPENING;
  for (const [i, line] of lines.entries()) {
    current = i;
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: i + 1, transcript: [{ role: "agent", content: last }, { role: "user", content: line.caller }] }));
    await vi.waitFor(() => expect(raw().some((m) => m.response_id === i + 1 && m.content_complete)).toBe(true));
    const mine = raw().filter((m) => m.response_id === i + 1);
    const said = mine.map((m) => m.content ?? "").join("").replace(/\s+/g, " ").trim();
    heard.push({ said, ended: mine.some((m) => m.end_call === true) });
    last = said;
  }
  await s.finish();
  return heard;
}

describe("the evening call of 1 November 2026", () => {
  test("a filler never doubles her own opener, and a greeting gets none", () => {
    expect(afterFiller("Sure,", "Sure thing, I can help with that.")).toBe("I can help with that.");
    expect(afterFiller("Right,", "No problem at all, we can point you in the right direction.")).toBe("we can point you in the right direction.");
    expect(afterFiller("Okay, so,", "Okay, so, Let me check Wednesday for you.")).toBe("let me check Wednesday for you.");
    expect(afterFiller("So,", "Hey, I'm doing well!")).toBe("I'm doing well!");
    expect(fillerFor("Hey. How are you?", "en", [])).toBeNull();
    expect(fillerFor("Hi, how are you doing today?", "en", [])).toBeNull();
  });

  test("a note on her tools is never said, whole or streamed; a phone number's brackets stay", () => {
    expect(withoutMood('Let me check Wednesday for you. (find_times: service "Botox Cosmetic", day "", after "21:00") Okay.')).toBe("Let me check Wednesday for you. Okay.");
    expect(withoutMood("Would you like that added? (Friday's times aren't checked yet, so no booking action this turn.)")).toBe("Would you like that added?");
    expect(withoutMood("Call us on (305) 555-0142.")).toBe("Call us on (305) 555-0142.");
    const out: string[] = [];
    const stream = new SpokenStream((sentence) => out.push(sentence));
    stream.push("Since you're coming in, want a Hydrafacial too? (Friday's times aren't checked yet, so no booking action this turn.) ");
    stream.push("It takes about forty-five minutes. ");
    expect(out.join(" ")).not.toMatch(/\(|booking action/);
    // The examples teach the details apart from the words: no tool name in parentheses after "You:".
    expect(voiceExamples({ services: [], providerNames: ["Dr. Shaun Patel"], specialty: "med-spa" })).not.toMatch(/You:[^\n]*\(/);
  });

  test("nothing at the time asked: the nearest times, with why, never the same words", () => {
    const late = BOOKING_LINES_VOICE_EN.nearest!("late", ["Thursday the 5th at 3", "4"]);
    expect(late).toBe("Nothing that late, I'm afraid. Thursday the 5th, I've got 3 or 4. Would any of those work?");
    expect(BOOKING_LINES_VOICE_EN.nearest!("dayFull", ["Friday the 6th at 10"])).toBe("That day's all booked up. Friday the 6th, I've got 10. Would that work?");
  });

  test("no background sound behind her", () => {
    expect(RETELL_CALL_SETTINGS.ambient_sound).toBeNull();
    expect("ambient_sound_volume" in RETELL_CALL_SETTINGS).toBe(false);
  });

  test("'Hello?' mid-call: she is there, never her introduction again", async () => {
    const heard = await call([
      { caller: "I'd like to know about Botox please.", model: modelSays("Botox is from $18 a unit, and Dr. Shaun Patel works out the total with you. Want a time?") },
      { caller: "Hello?", model: modelSays("Hi there, it's Aya. Are you still there?") },
      { caller: "Are you there?", model: modelSays("Hi there, it's Aya. Are you still there?") },
    ]);
    expect(heard[1]!.said).toBe("Yes, I'm here! Go ahead.");
    expect(heard[2]!.said).toBe("Still here, go ahead.");
    expect(heard.map((h) => h.said).join(" ")).not.toMatch(/it's Aya/);
  });

  test("the caller turns to Spanish: asked once, and Spanish only after their yes", async () => {
    const heard = await call([
      { caller: "Hola, quisiera reservar una cita para Botox, por favor.", model: modelSays("Claro, ¿qué día le viene bien?") },
      { caller: "Sí, por favor.", model: modelSays("Perfecto. ¿En qué le puedo ayudar?") },
    ]);
    expect(heard[0]!.said).toBe(SPANISH_OFFER_LINE);
    expect(heard[1]!.said).toMatch(/^Le atiende el asistente de inteligencia artificial de Miami Skin & Vein, y esta llamada se transcribe\./);
    expect(heard[1]!.said).toMatch(/¿En qué le puedo ayudar\?$/);
  });

  test("a no to 'anything else' that ends the call ends it on her goodbye", async () => {
    const heard = await call([
      { caller: "Where is your team located?", model: modelSays("We're at 6705 Red Road, Suite 608, Coral Gables. Anything else I can help with?") },
      { caller: "No.", model: modelSays("Okay.", { end: true }) },
    ]);
    expect(heard[1], JSON.stringify(heard)).toMatchObject({ ended: true });
    // Her "Okay." was already on its way as she wrote it; the goodbye follows it.
    expect(heard[1]!.said).toMatch(/Alright, thanks so much for calling\. Have a lovely day!$/);
  });
});
