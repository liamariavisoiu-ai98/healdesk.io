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

import { sealDemoCallContext, type DemoCallContext } from "@healdesk/catalog";

import { guardedLine, movingOnLine, type GuardRefusal } from "@/lib/assistant/guard";
import { SPOKEN_END } from "@/lib/assistant/prompt";
import { CALLBACK_FAILED_LINE } from "@/lib/voice/demo-callback";
import { demoStageNote } from "@/lib/voice/demo-facts";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { DEMO_CASE_CLINIC, DEMO_CASE_FIRST_NAME, DEMO_CASES, type DemoCase } from "@/lib/voice/demo-cases";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * The demo's regression cases (lib/voice/demo-cases.ts), each run through the
 * real demo pipeline: a call session in demo mode, opened from a sealed
 * context, with every caller turn sent as Retell sends it and the model's
 * words streamed sentence by sentence, as a real call's are. The guard, the
 * fail-soft layer, the notes and the progress are the production ones; only
 * the model is scripted.
 */

const SECRET = "test-provision-secret-0123456789abcdef";

/** Every fixed line the guard answers a refusal with, in English, as a call says it. */
const GUARD_LINES: readonly string[] = [
  ...(["never_say", "price", "payment_details", "hipaa_claim", "clinical", "language", "booking_confirmation", "human_claim", "outbound_promise", "alert_claim", "other_party", "empty"] as GuardRefusal[]).map(
    (reason) => guardedLine(reason, DEMO_CASE_CLINIC.clinicName, "en", true),
  ),
  movingOnLine(DEMO_CASE_CLINIC.clinicName, "en", true),
];

type Response = Extract<RetellOutbound, { response_type: "response" }>;

function contextFor(c: DemoCase): DemoCallContext {
  return {
    v: 1,
    slug: "lumen-aesthetics-austin",
    mode: "phone",
    firstName: DEMO_CASE_FIRST_NAME,
    issuedAt: Date.now(),
    offer: c.offer ? { percentOfSetupFee: c.offer.percentOfSetupFee, endsAt: Date.now() + c.offer.hoursLeft * 3_600_000 + 60_000 } : null,
    test: false,
    buyButton: "Book Onboarding",
    clinic: DEMO_CASE_CLINIC,
  };
}

/** A model that streams each scripted answer in pieces, as the API does, and records the turn context it was given. */
function scripted() {
  const queue: string[] = [];
  const seen: string[] = [];
  const responder: AssistantResponder = async ({ system, onText }) => {
    seen.push((system as { turn: string }).turn);
    const text = queue.shift();
    if (text === undefined) throw new Error("the case scripted no more model answers for this turn");
    if (onText) for (const piece of text.split(/(?<=[.!?] )/)) onText(piece);
    return text;
  };
  return { responder, queue, seen };
}

async function run(c: DemoCase) {
  const model = scripted();
  const sent: RetellOutbound[] = [];
  // apps/web, as the case has it answer: what the call sent it, and whether it took each.
  const requests: { phoneE164: string; note: string }[] = [];
  const s = new RetellCallSession("demo", `call_${c.id}`, (m) => sent.push(m), {
    responder: model.responder,
    acknowledgeAfterMs: 60_000,
    demo: { secret: SECRET, detailsWaitMs: 200 },
    demoCallback: async (request) => {
      expect(request.context.slug).toBe("lumen-aesthetics-austin");
      expect(request.context.firstName).toBe(DEMO_CASE_FIRST_NAME);
      requests.push({ phoneE164: request.phoneE164, note: request.note });
      return c.callbackTaken !== false;
    },
  });
  const raw = () => sent.filter((m): m is Response => m.response_type === "response");
  const heard = () => spokenResponses(raw());
  await s.open();
  await s.handle(
    JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(contextFor(c), SECRET) } } }),
  );
  await vi.waitFor(() => expect(raw()).toHaveLength(1));
  let id = 0;
  for (const [i, turn] of c.turns.entries()) {
    const at = `${c.id}, turn ${i + 1} ("${turn.caller}")`;
    model.queue.push(...turn.model);
    const notesBefore = model.seen.length;
    const lastHeard = heard().at(-1)!.content;
    id += 1;
    await s.handle(
      JSON.stringify({ interaction_type: "response_required", response_id: id, transcript: [{ role: "agent", content: lastHeard }, { role: "user", content: turn.caller }] }),
    );
    // Every scripted answer was asked for: the guard refused each but the last.
    expect(model.queue, `${at}: answers left unasked`).toEqual([]);
    const said = heard().at(-1)!;
    expect(said.response_id, `${at}: no answer`).toBe(id);
    const ck = turn.check;
    if (!ck) continue;
    const note = model.seen[notesBefore] ?? "";
    const snap = s.demoSnapshot!;
    if (ck.heard !== undefined) expect(said.content, at).toBe(ck.heard);
    for (const words of ck.heardIncludes ?? []) expect(said.content, at).toContain(words);
    for (const words of ck.heardExcludes ?? []) expect(said.content, at).not.toContain(words);
    if (ck.noGuardLine) for (const line of GUARD_LINES) expect(said.content, `${at}: a guard line reached the caller`).not.toContain(line);
    if (ck.stage) expect(snap.stage, at).toBe(ck.stage);
    if (ck.asked !== undefined) expect(snap.progress.asked, at).toBe(ck.asked);
    for (const [q, words] of Object.entries(ck.answers ?? {})) expect(snap.progress.answers[q as keyof typeof snap.progress.answers], `${at}: ${q}`).toBe(words);
    if (ck.callback !== undefined) expect(snap.progress.callback ?? null, `${at}: callback`).toBe(ck.callback);
    if (ck.pushback !== undefined) expect(snap.progress.pushback ?? null, `${at}: pushback`).toBe(ck.pushback);
    if (ck.ends !== undefined) expect(said.end_call, `${at}: ends`).toBe(ck.ends);
    if (ck.quirks !== undefined) expect(snap.progress.quirks ?? [], `${at}: quirks`).toEqual(ck.quirks);
    for (const words of ck.noteIncludes ?? []) expect(note, `${at}: note`).toContain(words);
    for (const words of ck.noteExcludes ?? []) expect(note, `${at}: note`).not.toContain(words);
  }
  await s.finish();
  expect(requests, `${c.id}: call-back requests`).toEqual(c.callbacks ?? []);
  return { heard: heard() };
}

afterEach(() => {
  tenant.calls = 0;
  vi.restoreAllMocks();
});

describe("the demo's regression cases, through the real demo pipeline", () => {
  test.each(DEMO_CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    await run(c);
    expect(tenant.calls).toBe(0);
  });

  /**
   * 6a, measured: what a demo reply may say is short. Each line a pitch note
   * scripts for her is at most two short sentences, and the cases' own
   * replies, which model the style a call should have, stay short on
   * average. The live length of a model's replies is the voice eval's
   * (scripts/voice-eval, "Words per turn"); these pin what the notes ask for.
   */
  test("6a: every scripted line in the pitch is at most two short sentences, and the cases' replies are short", () => {
    const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
    const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    const offer = { percentOfSetupFee: 50, endsAt: Date.now() + 40 * 3_600_000 };
    const note = demoStageNote(
      { firstName: "Josh", clinic: DEMO_CASE_CLINIC, offer, buyButton: "Book Onboarding", mode: "phone" },
      "pitch",
      Date.now(),
      { asked: null, answers: { goal: "x", volume: "5", volumeCheck: "yes", missed: "voicemail", coverage: "after hours" }, roleplayTurns: 0, said: [] },
    );
    const beats = note.split("\n").filter((line) => /^\d\. \(/.test(line));
    expect(beats).toHaveLength(9);
    for (const beat of beats) {
      // A placeholder ("[the step of 100 that covers their volume]") is said as one or two words.
      for (const [, quoted] of [...beat.matchAll(/"([^"]{12,})"/g)].map(([all, q]) => [all, q!.replace(/\[[^\]]*\]/g, "X")] as const)) {
        expect(sentences(quoted!), quoted).toBeLessThanOrEqual(2);
        expect(words(quoted!), quoted).toBeLessThanOrEqual(30);
      }
    }
    const fixed = new Set<string>([CALLBACK_FAILED_LINE]);
    const replies = DEMO_CASES.flatMap((c) => c.turns.flatMap((t) => t.model.map((m) => m.split(SPOKEN_END)[0]!.trim()))).filter((r) => !fixed.has(r));
    const mean = replies.reduce((sum, r) => sum + words(r), 0) / replies.length;
    // The longest is the owner's own volume check ("I see you're open 5 days a week, so would it be fair...").
    for (const r of replies) expect(words(r), r).toBeLessThanOrEqual(32);
    expect(mean).toBeLessThanOrEqual(20);
  });

  test("the cases cover what the owner asked for, and the Josh case says it is rebuilt until the transcript is in", () => {
    for (const id of ["reply-length", "no-reflection-opener", "repeat-the-caller", "pushback-rotation", "disinterest-then-contact-ask", "firm-no-goodbye", "roleplay-resume", "quirk-love-that-once"]) {
      expect(DEMO_CASES.map((c) => c.id)).toContain(id);
    }
    const ids = DEMO_CASES.map((c) => c.id);
    for (const n of ["five", "six", "12", "20"]) expect(ids).toContain(`bare-number-${n}`);
    expect(ids).toEqual(expect.arrayContaining(["price-objection-after-quote", "channels-three-ways", "not-convinced-before-coverage", "josh-lumen-d2d9a915"]));
    expect(DEMO_CASES.find((c) => c.id === "josh-lumen-d2d9a915")!.reconstructed).toMatch(/replace with transcript d2d9a915/);
  });
});
