import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import type { AssistantChannel, AssistantFacts } from "@/lib/assistant/facts";
import { openingLine } from "@/lib/assistant/opening";
import { buildAssistantPrompt, TONE } from "@/lib/assistant/prompt";
import { answerTurn, type AssistantResponder, type AssistantTurnResult } from "@/lib/assistant/turn";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";

import { evalFacts } from "../scripts/voice-eval/clinics";
import { EVAL_SPECIALTIES } from "../scripts/voice-eval/rubric";
import { applyTone, productionTone, validateToneCandidate } from "../scripts/voice-eval/tone";
import {
  FORBIDDEN_OUTPUT_CASES,
  INJECTION_CASES,
  modelJson,
  SAFETY_FACTS,
  stubModel,
  URGENT_CASES,
  type ModelCall,
} from "./setup/safety-cases";

/**
 * THE TONE GATE: the voice eval's hill-climb (scripts/voice-eval) runs this
 * file, beside the safety suites, on every tone candidate it considers, with
 * the candidate in VOICE_EVAL_TONE_FILE ({"tone": "..."}). Without it, it
 * checks the production tone, so it runs in CI like any other test.
 *
 * What it holds for the candidate, with a stub model and no network:
 *   1. it passes the eval's off-limits screen (tone.ts);
 *   2. in the prompt production builds, for every eval practice and the
 *      safety suite's own, on both channels, it replaces the tone sentence
 *      and nothing else: every rule, the booking and style sections, the
 *      never-say list and the output format are there byte for byte;
 *   3. the urgent screen, the guard and the injection cases answer exactly
 *      as under the production tone (same source, same words), the urgent
 *      ones without the model ever being asked.
 */

function candidate(): string {
  const file = process.env.VOICE_EVAL_TONE_FILE;
  if (!file) return productionTone();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tone?: unknown };
  if (typeof parsed.tone !== "string") throw new Error(`${file} has no "tone" string`);
  return parsed.tone;
}

const TONE_UNDER_TEST = candidate();
const CHANNELS: readonly AssistantChannel[] = ["voice", "web_chat"];
const NOW = new Date("2026-10-21T15:00:00Z");

/** The stub, with the tone swapped into the prompt it is shown, as the eval's responder does. */
function toned(responder: AssistantResponder, tone: string): AssistantResponder {
  return (request) => responder({ ...request, system: { ...request.system, stable: applyTone(request.system.stable, tone) } });
}

async function run(said: readonly string[], responder: AssistantResponder, channel: AssistantChannel, facts: AssistantFacts = SAFETY_FACTS) {
  const history: TranscriptTurn[] = [{ speaker: "assistant", text: openingLine(facts, channel) }];
  const results: AssistantTurnResult[] = [];
  let capture: AssistantTurnResult["capture"] | undefined;
  for (const text of said) {
    const result = await answerTurn({ facts, channel, history, text, capture, responder, now: NOW });
    history.push({ speaker: "person", text: result.personText }, { speaker: "assistant", text: result.reply });
    capture = result.capture;
    results.push(result);
  }
  return results;
}

const outcome = (r: AssistantTurnResult) => ({ source: r.source, reply: r.reply, urgent: r.urgent, handoff: r.handoff, guard: r.guard });

describe("the voice eval's tone gate", () => {
  test("the candidate passes the off-limits screen", () => {
    expect(validateToneCandidate(TONE_UNDER_TEST)).toEqual({ ok: true });
  });

  test("the exported tone sentences are the ones the prompt uses, each once", () => {
    for (const tone of ["warm", "clinical"] as const) {
      const prompt = buildAssistantPrompt({ ...SAFETY_FACTS, tone }, "voice");
      expect(prompt.split(TONE[tone]).length - 1).toBe(1);
      expect(validateToneCandidate(TONE[tone])).toEqual({ ok: true });
    }
  });

  for (const channel of CHANNELS) {
    test(`${channel}: the candidate replaces the tone sentence and nothing else`, () => {
      for (const facts of [SAFETY_FACTS, ...EVAL_SPECIALTIES.map(evalFacts)]) {
        const production = buildAssistantPrompt(facts, channel);
        const swapped = applyTone(production, TONE_UNDER_TEST);
        expect(swapped.replace(TONE_UNDER_TEST, productionTone())).toBe(production);
        // Every guardrail section, as production wrote it.
        const lines = production.split("\n").filter((line) => !line.includes(productionTone()));
        for (const line of lines) expect(swapped).toContain(line);
        expect(swapped).toContain("Rules you never break:");
        for (const phrase of facts.neverSay) expect(swapped).toContain(`- ${phrase}`);
      }
    });

    describe(`${channel}: the screens and the guard answer as under the production tone`, () => {
      for (const c of URGENT_CASES.filter((c) => !c.defect)) {
        test(`urgent: ${c.label}`, async () => {
          const model = stubModel(() => modelJson("model answered"));
          const results = await run([c.text], toned(model.responder, TONE_UNDER_TEST), channel);
          expect(model.calls).toHaveLength(0);
          expect(results[0]!.source).toBe("urgent");
          expect(results[0]!.reply).toMatch(/911/);
        });
      }

      for (const c of FORBIDDEN_OUTPUT_CASES.filter((c) => !c.defect)) {
        test(`guard: ${c.label}`, async () => {
          const answer = () => modelJson(c.reply, c.extra);
          const production = await run([c.asked], stubModel(answer).responder, channel);
          const candidateRun = await run([c.asked], toned(stubModel(answer).responder, TONE_UNDER_TEST), channel);
          expect(candidateRun[0]!.source).toBe("guard");
          expect(candidateRun.map(outcome)).toEqual(production.map(outcome));
        });
      }

      for (const c of INJECTION_CASES.filter((c) => !c.defect)) {
        test(`injection: ${c.label}`, async () => {
          const answer = (call: ModelCall) => c.compliant(call, SAFETY_FACTS);
          const production = await run(c.said, stubModel(answer).responder, channel);
          const model = stubModel(answer);
          const candidateRun = await run(c.said, toned(model.responder, TONE_UNDER_TEST), channel);
          expect(candidateRun.map(outcome)).toEqual(production.map(outcome));
          // The visitor's words never reach the system prompt, whatever the tone.
          for (const call of model.calls) for (const line of c.said) expect(call.system.stable + call.system.turn).not.toContain(line);
        });
      }
    });
  }
});
