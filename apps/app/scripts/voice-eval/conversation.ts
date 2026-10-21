import type { AssistantFacts } from "../../src/lib/assistant/facts";
import { openingLine } from "../../src/lib/assistant/opening";
import { modelRequest, readModelResponse, type AssistantResponder } from "../../src/lib/assistant/responder";
import { answerTurn, type AssistantTurnResult, type BookingCapture, type TurnSource } from "../../src/lib/assistant/turn";
import type { TranscriptTurn } from "../../src/lib/conversations/transcript-email";

import { heardReply, nextCallerLine } from "./caller";
import type { EvalClient } from "./client";
import type { Scenario } from "./scenarios";
import { applyTone } from "./tone";

/**
 * One synthetic call (two for a cut-off), driven through the REAL turn
 * pipeline: answerTurn (lib/assistant/turn.ts) with the real card cut,
 * urgent screen, language screen and guard, and the real production request
 * (responder.ts modelRequest: the voice model, its token limit, low effort,
 * the cache breakpoint) sent through the eval client. The only thing the
 * eval changes is the tone sentence in the stable prompt (tone.ts
 * applyTone), and only when a candidate is being tried.
 *
 * Voice only, in text: what the caller says arrives as the transcribed text
 * Retell would send, and what the assistant says is the text it would speak.
 * Inbound only: the caller always starts the call; nothing here calls anyone.
 */

/** A fixed weekday morning in the practices' zone (Wednesday 21 October 2026, 11am in New York): open. */
export const EVAL_NOW = new Date("2026-10-21T15:00:00Z");

export type EvalTurn = {
  call: 1 | 2;
  speaker: "caller" | "assistant";
  text: string;
  /** For the assistant: who wrote the line (turn.ts TurnSource), "opening" for the AI line, "model" when the model did. */
  source?: TurnSource | "opening";
  guard?: string;
};

export type ConversationResult = {
  turns: EvalTurn[];
  /** How each call ended. */
  endings: ("assistant_end" | "caller_hung_up" | "max_turns" | "cut_off")[];
  sources: Partial<Record<TurnSource, number>>;
};

/** The responder answerTurn calls: production's request and reading, through the eval client, with the tone swapped in. */
export function evalResponder(client: EvalClient, tone: string, conversationId: string): AssistantResponder {
  return async ({ system, messages, channel }) => {
    const request = modelRequest({ channel, system: { stable: applyTone(system.stable, tone), turn: system.turn }, messages });
    const response = await client.create("agent", request, { conversationId });
    return readModelResponse(channel, response);
  };
}

export async function runConversation(input: {
  scenario: Scenario;
  facts: AssistantFacts;
  client: EvalClient;
  tone: string;
  conversationId: string;
  /** Our own bound on one model answer; production's voice deadline when absent (turn.ts MODEL_DEADLINE_MS). */
  modelDeadlineMs?: number;
}): Promise<ConversationResult> {
  const { scenario, facts, client } = input;
  const responder = evalResponder(client, input.tone, input.conversationId);
  const turns: EvalTurn[] = [];
  const endings: ConversationResult["endings"] = [];
  const sources: ConversationResult["sources"] = {};
  const calls: (1 | 2)[] = scenario.cutAfterTurns ? [1, 2] : [1];
  let callerTurnCounter = 0;

  for (const call of calls) {
    const opening = openingLine(facts, "voice");
    const history: TranscriptTurn[] = [{ speaker: "assistant", text: opening }];
    turns.push({ call, speaker: "assistant", text: opening, source: "opening" });
    const heard: { speaker: "assistant" | "caller"; text: string }[] = [{ speaker: "assistant", text: opening }];
    let capture: BookingCapture | undefined;
    let line = { text: call === 1 ? scenario.opening : (scenario.redialOpening ?? scenario.opening), hangUp: false };
    let callerTurns = 0;
    let ending: ConversationResult["endings"][number] = "max_turns";

    while (true) {
      if (!line.text) {
        ending = "caller_hung_up";
        break;
      }
      callerTurns += 1;
      turns.push({ call, speaker: "caller", text: line.text });
      heard.push({ speaker: "caller", text: line.text });
      const result: AssistantTurnResult = await answerTurn({
        facts,
        channel: "voice",
        history,
        text: line.text,
        capture,
        responder,
        now: EVAL_NOW,
        callerPhone: scenario.callerNumber,
        ...(input.modelDeadlineMs ? { modelDeadlineMs: input.modelDeadlineMs } : {}),
      });
      history.push({ speaker: "person", text: result.personText }, { speaker: "assistant", text: result.reply });
      capture = result.capture;
      sources[result.source] = (sources[result.source] ?? 0) + 1;
      turns.push({ call, speaker: "assistant", text: result.reply, source: result.source, ...(result.guard ? { guard: result.guard } : {}) });
      heard.push({ speaker: "assistant", text: heardReply(scenario, result.reply) });

      if (line.hangUp) {
        ending = "caller_hung_up";
        break;
      }
      if (result.end) {
        ending = "assistant_end";
        break;
      }
      if (call === 1 && scenario.cutAfterTurns && callerTurns >= scenario.cutAfterTurns) {
        ending = "cut_off";
        break;
      }
      if (callerTurns >= scenario.maxTurns) break;
      callerTurnCounter += 1;
      line = await nextCallerLine({
        client,
        scenario,
        clinicName: facts.clinicName,
        heard,
        context: { conversationId: input.conversationId, callerTurn: callerTurnCounter, call, scenario },
      });
    }
    endings.push(ending);
  }
  return { turns, endings, sources };
}
