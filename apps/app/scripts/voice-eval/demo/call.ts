import { randomBytes } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { sealDemoCallContext, type DemoCallContext } from "@healdesk/catalog";

import { jsonRequest, modelRequest, readJsonResponse, readModelResponse, type AssistantResponder } from "../../../src/lib/assistant/responder";
import { SPOKEN_END } from "../../../src/lib/assistant/prompt";
import { DEMO_CASE_CLINIC, DEMO_CASE_FIRST_NAME } from "../../../src/lib/voice/demo-cases";
import { demoSlots, type DemoProgress, type DemoQuestion, type DemoStage } from "../../../src/lib/voice/demo-facts";

import { CALLER_MODEL, parseCallerLine } from "../caller";
import type { EvalClient } from "../client";

import type { DemoScenario } from "./scenarios";

/**
 * One synthetic demo call on a real model (owner, 31 October 2026: "a small
 * set of real-model test calls scored on every change"), driven through the
 * REAL demo pipeline: a RetellCallSession in demo mode, opened from a sealed
 * context, each caller turn sent as Retell sends it, so the stage machine,
 * the notes, the prompt, the guard, the fail-soft lines and the shaping are
 * production's. Only two things are not: the model's answers come through
 * the eval client (production's request, modelRequest, on the voice model),
 * and the caller is a simulated owner (the eval's caller model). Nothing is
 * read or written anywhere: the session's database paths throw if touched,
 * and a call-back request goes nowhere.
 *
 * What the call kept is read from the session itself (demoSnapshot) after
 * every turn, so the checks see what the code believed, not a guess from the
 * words.
 */

/** The longest call, in the caller's turns: a good demo closes well before it. */
export const DEMO_MAX_CALLER_TURNS = 18;

export type DemoTurn = {
  speaker: "caller" | "assistant";
  text: string;
  /** For the assistant: whether the model's words were said ("model") or the call's own line ("fixed"). */
  source?: "model" | "fixed" | "opening";
  /** For her own lines: the words she wrote that the call took out before they were said (shapeVoiceReply, repeats). */
  cut?: number;
  /** The stage the call was in when the line was said, and after it. */
  stageBefore?: DemoStage;
  stageAfter?: DemoStage;
};

export type DemoCallTrace = {
  scenario: string;
  turns: DemoTurn[];
  /** The session's progress after each of the caller's turns. */
  progress: { stage: DemoStage; asked: DemoQuestion | null; answers: string[]; buying: boolean }[];
  /** The role-play's calendar on this call (demo-facts.ts demoSlots): free times she may offer. */
  slots: string[];
  /** The model's raw answers, in order, and whether each carried its state update. */
  modelAnswers: { stage: DemoStage; text: string; hasState: boolean }[];
  ending: "assistant_end" | "caller_hung_up" | "max_turns" | "error";
  error?: string;
};

type Outbound = { response_type?: string; response_id?: number; content?: string; content_complete?: boolean; end_call?: boolean };

/** What the caller hears, as Retell joins a response's parts (tests/setup/retell-responses.ts). */
function spoken(messages: readonly Outbound[]): Outbound[] {
  const out: Outbound[] = [];
  let open: Outbound | null = null;
  for (const m of messages) {
    if (m.response_type !== "response") continue;
    if (open && open.response_id === m.response_id) {
      const joined: Outbound = { ...m, content: `${open.content ?? ""}${m.content ?? ""}` };
      out[out.length - 1] = joined;
      open = m.content_complete === false ? joined : null;
      continue;
    }
    out.push(m);
    open = m.content_complete === false ? m : null;
  }
  return out;
}

/** The demo context every eval call opens with: the made-up clinic of the regression cases, a live 50% offer. */
export function evalDemoContext(now: number): DemoCallContext {
  return {
    v: 1,
    slug: "lumen-aesthetics-austin",
    mode: "phone",
    firstName: DEMO_CASE_FIRST_NAME,
    issuedAt: now,
    offer: { percentOfSetupFee: 50, endsAt: now + 40 * 3_600_000 },
    test: false,
    buyButton: "Book Onboarding",
    clinic: DEMO_CASE_CLINIC,
  };
}

/** The simulated owner's instructions. */
export function demoCallerSystem(scenario: DemoScenario): string {
  return [
    "You are role-playing a person on a phone call, for a test of an AI sales assistant. Stay in character the whole time.",
    `The assistant, Aya, is demoing an AI receptionist to you for your med spa, ${DEMO_CASE_CLINIC.clinicName}. You asked for this demo call. Your first name is ${DEMO_CASE_FIRST_NAME}.`,
    `How you behave: ${scenario.persona}`,
    `What you want: ${scenario.goal}`,
    "Speak as a person on the phone: one or two short spoken sentences per turn, no lists, no stage directions, no quotation marks.",
    "If you play a patient in a role-play, ask only about treatments, prices and booking: never describe a symptom, an injury, a complication or anything medical, and never give card or bank details. English only.",
    "When your goal is met, or you give up, say a short goodbye and end that line with [HANG UP]. Do not prolong the call.",
  ].join("\n");
}

async function callerLine(client: EvalClient, scenario: DemoScenario, heard: { speaker: "caller" | "assistant"; text: string }[], turn: number, conversationId: string) {
  const messages: Anthropic.MessageParam[] = [];
  for (const t of heard) {
    const role = t.speaker === "assistant" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${t.text}`;
    else messages.push({ role, content: t.text });
  }
  const response = await client.create(
    "caller",
    { model: CALLER_MODEL, max_tokens: 300, output_config: { effort: "low" }, system: demoCallerSystem(scenario), messages },
    {
      conversationId: `${conversationId}:caller`,
      callerTurn: turn,
      assumedTurns: scenario.scripted.length + 1,
      scenario: { id: scenario.id, scripted: scenario.scripted, callerName: DEMO_CASE_FIRST_NAME, archetype: "owner", intent: "demo" },
    },
  );
  if (response.stop_reason === "refusal") return { text: "", hangUp: true };
  return parseCallerLine(response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" "));
}

/** Retell's transcript, as it sends it: every line so far, the caller's last. */
function transcript(turns: readonly DemoTurn[]) {
  return turns.map((t) => ({ role: t.speaker === "assistant" ? "agent" : "user", content: t.text }));
}

export async function runDemoCall(input: { scenario: DemoScenario; client: EvalClient; conversationId: string }): Promise<DemoCallTrace> {
  const { scenario, client, conversationId } = input;
  // The session's module reads DATABASE_URL when it loads; nothing here ever connects.
  process.env.DATABASE_URL ??= "postgres://voice-eval@127.0.0.1:1/never";
  const { RetellCallSession } = await import("../../../src/lib/voice/retell");

  const modelAnswers: DemoCallTrace["modelAnswers"] = [];
  let stageNow: DemoStage = "intro";
  const responder: AssistantResponder = async ({ system, messages, channel, onText }) => {
    const request = modelRequest({ channel, system, messages });
    const response = await client.create("agent", request, { conversationId });
    const text = readModelResponse(channel, response);
    if (typeof text === "string") {
      modelAnswers.push({ stage: stageNow, text, hasState: /"state"\s*:/.test(text.split(SPOKEN_END)[1] ?? "") });
      onText?.(text);
    }
    return text;
  };
  // The listener, as production runs it (demo-listener.ts), through the eval client.
  responder.json = async (request) => readJsonResponse(await client.create("listener", jsonRequest(request), { conversationId: `${conversationId}:listener` }));
  const no = (name: string) => () => {
    throw new Error(`${name} must not run on a demo call`);
  };
  const secret = randomBytes(24).toString("hex");
  const sent: Outbound[] = [];
  const session = new RetellCallSession("demo", `eval_${conversationId}`, (m) => sent.push(m as Outbound), {
    responder,
    gate: no("gate"),
    ingest: no("ingest"),
    screen: no("screen"),
    fallbackLine: no("fallbackLine"),
    tools: no("tools"),
    redial: no("redial"),
    acknowledgeAfterMs: 60_000,
    keepWarmMs: 3_600_000,
    demo: { secret, detailsWaitMs: 200 },
    demoCallback: async () => true,
  });
  const heard = () => spoken(sent);
  const issuedAt = Date.now();
  const slots = demoSlots(evalDemoContext(issuedAt));
  const turns: DemoTurn[] = [];
  const progress: DemoCallTrace["progress"] = [];
  let ending: DemoCallTrace["ending"] = "max_turns";
  try {
    await session.open();
    await session.handle(JSON.stringify({ interaction_type: "call_details", call: { retell_llm_dynamic_variables: { demo_context: sealDemoCallContext(evalDemoContext(issuedAt), secret) } } }));
    for (let i = 0; i < 50 && heard().length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    const opening = heard()[0]?.content ?? "";
    turns.push({ speaker: "assistant", text: opening, source: "opening", stageBefore: "intro", stageAfter: "intro" });
    let line = { text: scenario.opening, hangUp: false };
    for (let callerTurn = 1; callerTurn <= DEMO_MAX_CALLER_TURNS; callerTurn += 1) {
      if (!line.text) {
        ending = "caller_hung_up";
        break;
      }
      turns.push({ speaker: "caller", text: line.text });
      const before = session.demoSnapshot?.stage ?? "intro";
      stageNow = before;
      const answersBefore = modelAnswers.length;
      const count = heard().length;
      await session.handle(JSON.stringify({ interaction_type: "response_required", response_id: callerTurn, transcript: transcript(turns) }));
      const reply = heard().length > count ? heard().at(-1)! : null;
      const snap = session.demoSnapshot;
      const after = snap?.stage ?? before;
      if (snap) progress.push({ stage: after, asked: snap.progress.asked, answers: Object.keys(snap.progress.answers), buying: snap.progress.buying === true });
      if (reply?.content) {
        const said = reply.content.trim();
        const wrote = modelAnswers.slice(answersBefore).map((a) => a.text.split(SPOKEN_END)[0]!.replace(/^\s*\[[a-z]+\]\s*/i, "").trim());
        const fromModel = wrote.some((w) => w.length > 0 && said.slice(0, 24).toLowerCase() === w.slice(0, 24).toLowerCase());
        const written = wrote.at(-1) ?? "";
        const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
        const cut = fromModel ? Math.max(0, words(written) - words(said)) : 0;
        turns.push({ speaker: "assistant", text: said, source: fromModel ? "model" : "fixed", stageBefore: before, stageAfter: after, ...(cut ? { cut } : {}) });
      }
      if (reply?.end_call) {
        ending = "assistant_end";
        break;
      }
      if (line.hangUp) {
        ending = "caller_hung_up";
        break;
      }
      line = await callerLine(
        client,
        scenario,
        turns.map((t) => ({ speaker: t.speaker, text: t.text })),
        callerTurn,
        conversationId,
      );
    }
  } catch (error) {
    ending = "error";
    await session.finish().catch(() => null);
    return { scenario: scenario.id, turns, progress, slots, modelAnswers, ending, error: error instanceof Error ? error.message : String(error) };
  }
  await session.finish().catch(() => null);
  return { scenario: scenario.id, turns, progress, slots, modelAnswers, ending };
}

export type { DemoProgress };
