import type Anthropic from "@anthropic-ai/sdk";

import type { CallContext, EvalClient } from "./client";
import { saidNumber, type Scenario } from "./scenarios";

/**
 * The caller simulator: Claude Haiku 5.5 playing one synthetic caller from
 * the scenario library, one spoken line per turn. It hears the assistant's
 * replies (for an interrupting caller, only up to the first sentence: they
 * cut in) and says its next line; "[HANG UP]" at the end of a line ends the
 * call after the assistant answers it.
 *
 * Its system prompt keeps the run inside what the tone eval measures: no
 * emergencies or symptoms (those go to the urgent screen before the model,
 * and the safety suite covers them), no card numbers, English only, the
 * made-up name and number it is given and nothing real.
 */

export const CALLER_MODEL = "claude-haiku-5-5";
export const HANG_UP = "[HANG UP]";

export function callerSystem(scenario: Scenario, clinicName: string): string {
  const pet = scenario.petName ? ` Your pet's name is ${scenario.petName}.` : "";
  return [
    `You are role-playing a caller in a test of ${clinicName}'s phone assistant. Everything about you is made up for the test.`,
    `Your first name is ${scenario.callerName}; your phone number is ${saidNumber(scenario.callerNumber)}.${pet} You would like to come in ${scenario.preferredTime} if it comes up.`,
    `Your goal: ${scenario.goal}`,
    `How you behave: ${scenario.persona}`,
    "Speak as a person on the phone: one or two short spoken sentences per turn, no lists, no stage directions, no quotation marks.",
    "Never describe an emergency, an injury, a symptom, a medical complication or self-harm, never give card or bank details, and speak English only.",
    `When your goal is met, or you give up, say a short goodbye and end that line with ${HANG_UP}. Do not prolong the call.`,
  ].join("\n");
}

/** What the caller hears of a reply: an interrupting caller cuts in after the first sentence. */
export function heardReply(scenario: Scenario, reply: string): string {
  if (scenario.archetype !== "interrupting") return reply;
  const first = reply.match(/^.*?[.!?](\s|$)/)?.[0]?.trim();
  return first && first.length < reply.length ? `${first} ...` : reply;
}

export type CallerLine = { text: string; hangUp: boolean };

export function parseCallerLine(raw: string): CallerLine {
  const hangUp = raw.includes(HANG_UP);
  const text = raw.replace(HANG_UP, "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ").trim();
  return { text, hangUp };
}

/**
 * The caller's next line. `heard` is the call so far from the caller's side:
 * the assistant's lines as the user's turns, the caller's own as the model's,
 * starting with the assistant's opening line.
 */
export async function nextCallerLine(input: {
  client: EvalClient;
  scenario: Scenario;
  clinicName: string;
  heard: { speaker: "assistant" | "caller"; text: string }[];
  context: CallContext;
}): Promise<CallerLine> {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of input.heard) {
    const role = turn.speaker === "assistant" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${turn.text}`;
    else messages.push({ role, content: turn.text });
  }
  const response = await input.client.create(
    "caller",
    {
      model: CALLER_MODEL,
      max_tokens: 400,
      output_config: { effort: "low" },
      system: callerSystem(input.scenario, input.clinicName),
      messages,
    },
    input.context,
  );
  // A declined role-play ends the call; it is recorded as the caller hanging up.
  if (response.stop_reason === "refusal") return { text: "", hangUp: true };
  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  return parseCallerLine(raw);
}
