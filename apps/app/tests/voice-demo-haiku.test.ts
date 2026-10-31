import { describe, expect, test, vi } from "vitest";

// No database, and none may be asked for: a demo call keeps nothing.
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    throw new Error("a demo call must never reach the database");
  },
}));
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));
vi.mock("@/lib/email/outbox", () => ({ deliverCriticalAfterCommit: async () => {} }));

import { sealDemoCallContext, type DemoCallContext } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";
import { jsonRequest, type AssistantResponder } from "@/lib/assistant/responder";
import { DEMO_CASE_CLINIC, DEMO_CASE_FIRST_NAME } from "@/lib/voice/demo-cases";
import {
  afterDemoReply,
  DEMO_START_PROGRESS,
  demoExamples,
  demoRecovery,
  demoIntroRecovery,
  demoSalesPrompt,
  demoSlots,
  demoStageNote,
  hoursDays,
  hoursSpan,
  SKIPPED_ANSWER,
  type DemoProgress,
} from "@/lib/voice/demo-facts";
import { heardFrom, LISTENER_SCHEMA, withHeard, type DemoHeard } from "@/lib/voice/demo-listener";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { spokenResponses } from "./setup/retell-responses";

/**
 * The six steps of docs/design/demo-haiku-2026-10-31.md (owner, 31 October
 * 2026: "Let's implement these all"): the listener, examples instead of
 * rules, one interleaved sales conversation, a role-play that ends when it
 * is done and can offer times, rotating recovery lines; the eval's own
 * steps are in voice-eval-demo.test.ts.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
const ISSUED = Date.parse("2026-10-30T15:00:00Z");

function context(overrides: Partial<DemoCallContext> = {}): DemoCallContext {
  return { v: 1, slug: "lumen-aesthetics-austin", mode: "phone", firstName: DEMO_CASE_FIRST_NAME, issuedAt: ISSUED, offer: null, test: false, buyButton: "Book Onboarding", clinic: DEMO_CASE_CLINIC, ...overrides };
}

const heard = (over: Partial<DemoHeard> = {}): DemoHeard => ({
  name: null,
  role: null,
  goal: null,
  callsPerDay: null,
  missed: null,
  coverage: null,
  buying: false,
  impatient: false,
  wantsRoleplay: false,
  speakingAsThemselves: false,
  leaving: false,
  ...over,
});

const at = (over: Partial<DemoProgress>): DemoProgress => ({ ...DEMO_START_PROGRESS, ...over });

describe("step 1: the listener", () => {
  test("its answer is read strictly, and fills what the call did not have, wherever it was said, never over an answer", () => {
    expect(heardFrom({ name: "Josh" })).toBeNull();
    expect(heardFrom("nope")).toBeNull();
    const ok = heardFrom({ ...heard({ role: "owner", callsPerDay: "10" }), extra: "ignored" });
    expect(ok).toMatchObject({ role: "owner", callsPerDay: "10", buying: false });
    // "Ten clothes a day" heard as ten calls: the volume answered, so never asked again.
    const p = withHeard(at({ answers: { role: "the owner" } }), "pitch", heard({ role: "manager", goal: "missed calls after hours", callsPerDay: "10" }));
    expect(p.answers).toMatchObject({ role: "the owner", goal: "missed calls after hours", volume: "10" });
    // A count in words already kept becomes the digits the volume check can use.
    expect(withHeard(at({ answers: { volume: "a fair few, ten-ish" } }), "pitch", heard({ callsPerDay: "10" })).answers.volume).toBe("10");
  });

  test("its signals: buying and impatience kept for the call outside the role-play; stepping out ends a role-play; asking starts one", () => {
    expect(withHeard(at({}), "pitch", heard({ buying: true })).buying).toBe(true);
    expect(withHeard(at({}), "roleplay", heard({ buying: true })).buying).toBeUndefined();
    const impatient = withHeard(at({ answers: { goal: "x" } }), "pitch", heard({ impatient: true }));
    expect(impatient.impatient).toBe(true);
    expect(impatient.answers).toMatchObject({ goal: "x", volume: SKIPPED_ANSWER, missed: SKIPPED_ANSWER, coverage: SKIPPED_ANSWER });
    expect(withHeard(at({}), "roleplay", heard({ speakingAsThemselves: true })).rpOut).toBe(true);
    expect(withHeard(at({}), "intro", heard({ wantsRoleplay: true })).rpWanted).toBe(true);
    // The notes act on them.
    expect(demoStageNote(context(), "roleplay", ISSUED, at({ rpOut: true, roleplayTurns: 2 }))).toContain("They are talking to you as themselves now, not as the patient: end the role-play in this reply");
    expect(demoStageNote(context(), "intro", ISSUED, at({ answers: { role: "owner" }, rpWanted: true }))).toContain("Next: they asked for the role-play: start it in this reply");
    // Both reset once the role-play they were about starts or ends.
    expect(afterDemoReply(at({ rpWanted: true }), "intro", "roleplay", { asked: null, beats: [], callback: null, roleplay: "start" })).toMatchObject({ rpWanted: false, rpOut: false });
  });

  test("its request is a strict schema on the call's model, with thinking off", () => {
    const r = jsonRequest({ system: "s", user: "u", schema: LISTENER_SCHEMA as unknown as Record<string, unknown>, maxTokens: 300 });
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.thinking).toEqual({ type: "disabled" });
    expect(r.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
  });

  test("in a real session it runs beside the turn, adds no wait, and what it heard reaches the next turn's note", async () => {
    const notes: string[] = [];
    const listened: string[] = [];
    const replies = ["Great to meet you! What's your role at Lumen?", "Nice. Would you like to hear what I can do for Lumen, or jump straight into a quick role-play where you call in as a patient?"];
    const responder: AssistantResponder = Object.assign(
      async ({ system }: { system: { stable: string; turn: string } }) => {
        notes.push(system.turn);
        return `${replies[notes.length - 1]}\n${SPOKEN_END}\n${JSON.stringify({ end: false, state: { asked: notes.length === 1 ? "role" : "choice", beats: [] } })}`;
      },
      {
        json: async ({ user }: { user: string }) => {
          listened.push(user);
          // An answer the phrase lists could not read: the role, said in passing.
          return heard({ role: "runs the place", name: "Josh" });
        },
      },
    ) as AssistantResponder;
    const sent: RetellOutbound[] = [];
    const s = new RetellCallSession("demo", "call_listener", (m) => sent.push(m), { responder, acknowledgeAfterMs: 60_000, demo: { secret: SECRET, detailsWaitMs: 200 } });
    const raw = () => sent.filter((m): m is Extract<RetellOutbound, { response_type: "response" }> => m.response_type === "response");
    await s.open();
    await s.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(context({ issuedAt: Date.now() }), SECRET) } } }));
    await vi.waitFor(() => expect(raw()).toHaveLength(1));
    const opening = spokenResponses(raw())[0]!.content;
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "agent", content: opening }, { role: "user", content: "Yep, I basically keep the lights on there." }] }));
    await vi.waitFor(() => expect(s.demoSnapshot!.progress.answers.role).toBe("runs the place"));
    expect(listened[0]).toContain("Owner (latest): Yep, I basically keep the lights on there.");
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "agent", content: opening }, { role: "user", content: "Yep, I basically keep the lights on there." }, { role: "agent", content: replies[0]! }, { role: "user", content: "Sure." }] }));
    // Never asked again: the note knows the role the listener heard.
    expect(notes[1]).toContain('- their role: "runs the place"');
    expect(notes[1]).not.toContain("ask their role");
    await s.finish();
  });
});

describe("step 2: examples instead of rules", () => {
  test("the prompt shows short exchanges from the calls that went wrong, true, naming no company and quoting no figure", () => {
    const examples = demoExamples("Lumen");
    expect(examples.length).toBeGreaterThanOrEqual(6);
    expect(examples.length).toBeLessThanOrEqual(10);
    const prompt = demoSalesPrompt(context());
    for (const e of examples) expect(prompt).toContain(e);
    for (const e of examples) {
      expect(e).not.toMatch(/\$\d/);
      expect(e).not.toMatch(/\bthe only\b|\bnumber one\b/i);
      // One short reaction then one sentence: no reply in an example runs long.
      const reply = e.split('You: "')[1]!;
      expect(reply.split(/\s+/).length).toBeLessThanOrEqual(30);
    }
    expect(examples.join("\n")).toContain("ten clothes a day");
  });
});

describe("step 3: one interleaved sales conversation", () => {
  test("after two questions, a value point before the next question; a value point said starts the count again", () => {
    const lastRoleplay = { caller: "bye", aya: "Take care!" };
    const two = demoStageNote(context(), "pitch", ISSUED, at({ answers: { goal: "missed calls", volume: "5" }, asksSinceValue: 2, lastRoleplay }));
    expect(two).toContain('Next: no question this time: one value point from your instructions, tied to what they just said; if none fits better, "reveal"');
    expect(two).not.toContain("Want to get Lumen set up?");
    const one = demoStageNote(context(), "pitch", ISSUED, at({ answers: { goal: "missed calls" }, asksSinceValue: 1, lastRoleplay }));
    expect(one).toContain('then ask: "Generally, how many calls do you get a day?"');
    // Counted from her state: questions add up, a value point resets.
    const asked = afterDemoReply(at({ asksSinceValue: 1 }), "pitch", "pitch", { asked: "volume", beats: [], callback: null });
    expect(asked.asksSinceValue).toBe(2);
    expect(afterDemoReply(asked, "pitch", "pitch", { asked: null, beats: ["reveal"], callback: null }).asksSinceValue).toBe(0);
    // Pain needs their missed calls first.
    const missed = demoStageNote(context(), "pitch", ISSUED, at({ answers: { goal: "x", volume: "5", volumeCheck: "y", missed: "voicemail" }, asksSinceValue: 2, lastRoleplay }));
    expect(missed).toContain('if none fits better, "pain"');
  });
});

describe("step 4: a role-play that ends when it is done and can offer times", () => {
  test("the calendar is three plausible times from the clinic's hours, the same for the whole call", () => {
    const slots = demoSlots(context());
    expect(slots).toEqual(["Monday, November 2 at 11 AM", "Monday, November 2 at 4 PM", "Tuesday, November 3 at 10 AM"]);
    expect(demoSlots(context())).toEqual(slots);
    const note = demoStageNote(context(), "roleplay", ISSUED + 3 * 3_600_000, at({ roleplayTurns: 1 }));
    expect(note).toContain(`This role-play's calendar has these free times: ${slots.join("; ")}.`);
    expect(note).toContain("never say a time is booked, held or confirmed");
    // Hours it cannot read: no times, a preferred time taken as before.
    const unread = demoStageNote(context({ clinic: { ...DEMO_CASE_CLINIC, hours: [{ days: "By appointment", hours: "varies" }] } }), "roleplay", ISSUED, at({ roleplayTurns: 1 }));
    expect(unread).toContain("never say a time is available, free or open");
    expect(hoursDays("Daily")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(hoursDays("Tue - Sat")).toEqual([2, 3, 4, 5, 6]);
    expect(hoursSpan("10:00 AM - 7:00 PM")).toEqual({ open: 600, close: 1140 });
    expect(hoursSpan("Closed")).toBeNull();
  });
});

describe("step 5: fewer stock lines", () => {
  test("a recovery line is never the same twice in a call: each opener once, in order", () => {
    const progress = at({ answers: { goal: "x" } });
    const first = demoRecovery(context(), progress, []);
    expect(first.line).toBe("Sorry, I lost my train of thought for a second there. Generally, how many calls do you get a day?");
    expect(first.alternate).toBe("Let me put that another way. Generally, how many calls do you get a day?");
    const second = demoRecovery(context(), progress, [first.line, first.alternate]);
    expect(second.line.startsWith("Hang on, let me come at that differently.")).toBe(true);
    expect(second.alternate.startsWith("Actually, let me back up a step.")).toBe(true);
    const intro = demoIntroRecovery(context(), ["Sorry, I lost my train of thought there. What would you like to know?"]);
    expect(intro.line.startsWith("Sorry, let me come at that another way:")).toBe(true);
    expect(intro.alternate).toBe("Hang on, let me back up. Want to hear what I do, or try a quick role-play?");
  });
});
