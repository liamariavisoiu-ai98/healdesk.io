import type Anthropic from "@anthropic-ai/sdk";
import type { PatientModelId } from "@healdesk/catalog";

import type { SupportPrompt } from "./prompt";
import { SUPPORT_TOOLS } from "./tools";

/**
 * The support chat's model, configured as the shared brain's is
 * (lib/assistant/responder.ts): Anthropic's API under healdesk's own key,
 * ANTHROPIC_API_KEY, imported lazily so a build without the key never loads
 * the SDK, low effort, a hard timeout and one retry, the system prompt's
 * stable prefix behind a cache breakpoint and the turn's context after it.
 * Null when the key is not set, and the chat gives its fixed line instead.
 *
 * Two things differ from the patient channels, both because this channel
 * carries no patient's words by design and answers staff, not callers:
 *
 *   - it STREAMS, so a reply appears as it is written. The patient channels
 *     do not, because their guard must read a whole reply before anyone sees
 *     it; this one's screen holds back enough of the stream that no
 *     treatment name or number can be sent before it is seen whole
 *     (screen.ts, StreamScreen);
 *   - it has TOOLS: four read-only ones (tools.ts), tool_choice auto, strict.
 *
 * No server-side refusal fallback, as on the patient channels: a refusal
 * ends the turn with the fixed line that gives the support phone and
 * hello@healdesk.io (turn.ts).
 *
 * The model is one of PATIENT_MODEL_IDS (@healdesk/catalog
 * model-retention.ts), as every model on this key is: the terms and the
 * agreements describe Anthropic's retention for those models only, and a
 * Covered Model (Claude Fable or Mythos) keeps content at least 30 days.
 */

export const SUPPORT_MODEL: PatientModelId = "claude-opus-5-5";
export const SUPPORT_MAX_TOKENS = 2_000;
const TIMEOUT_MS = 30_000;

/** One streamed response: its events, then the whole message. */
export type SupportStream = AsyncIterable<Anthropic.MessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Message>;
};

/** The one call the chat makes. A fake in the tests; the SDK's messages.stream otherwise. */
export type SupportModelClient = {
  stream(params: Anthropic.MessageStreamParams): SupportStream;
};

/** The request for one round of a turn. Exported so the tests can hold its shape. */
export function supportRequest(input: {
  system: SupportPrompt;
  messages: Anthropic.MessageParam[];
}): Anthropic.MessageStreamParams {
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: input.system.stable, cache_control: { type: "ephemeral" } },
  ];
  if (input.system.turn.trim()) system.push({ type: "text", text: input.system.turn });
  return {
    model: SUPPORT_MODEL,
    max_tokens: SUPPORT_MAX_TOKENS,
    output_config: { effort: "low" },
    system,
    tools: SUPPORT_TOOLS,
    tool_choice: { type: "auto" },
    messages: input.messages,
  };
}

/** The SDK's client on healdesk's key, or null when the key is not set. */
export async function anthropicSupportClient(): Promise<SupportModelClient | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return { stream: (params) => client.messages.stream(params) };
}
