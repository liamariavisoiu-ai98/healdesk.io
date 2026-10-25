import type Anthropic from "@anthropic-ai/sdk";
import { isPatientModelId, type PatientModelId } from "@healdesk/catalog";

import { log } from "@/lib/log";

import type { AssistantChannel } from "./facts";

/**
 * The one model client behind every patient conversation: calls, web chats
 * and the Meta front door (plan Part G, "one client on the patient-
 * organisation key"). Anthropic's API under healdesk's own key
 * (ANTHROPIC_API_KEY, the patient-data organisation's), no tools, no search,
 * nothing stored by healdesk. Null when the key is not set, and each caller
 * then gives its fixed failure line.
 *
 * Per channel (MODEL_CONFIG), because a call cannot wait:
 *   - the web chat: HEALDESK_CHAT_MODEL, default claude-opus-5-5, 800 output
 *     tokens, 30 seconds, one retry;
 *   - the call: HEALDESK_VOICE_MODEL, default claude-haiku-5-5 (Sonnet 5.5
 *     until 24 October 2026, when the owner chose speed: the marketing demo
 *     measured Haiku's share of a pause at 0.63s median against Sonnet 5.5's
 *     1.07s, apps/web/scripts/retell-demo-agent.ts), streamed, 400 tokens,
 *     thinking off (THINKING_OFF: Haiku 5.5 thinks by default, silently,
 *     before its first word), 8 seconds and no retry, after which the
 *     caller hears the failure line instead of silence;
 *   - the Meta front door: claude-opus-5-5, 800 tokens, adaptive thinking,
 *     the SDK's own timeout and retries, as it always had.
 *
 * An override names one of PATIENT_MODEL_IDS (@healdesk/catalog
 * model-retention.ts) or is ignored, with a warning and the channel's
 * default: the terms, BAA 1.6.0 and the DPA state Anthropic's retention for
 * those models only. Its Covered Models (Claude Fable and Mythos, 5 and 5.1)
 * keep content for at least 30 days, so an environment variable naming one
 * would quietly make "no more than 30 days" false in a signed agreement.
 * Moving a channel onto one needs the wording, the terms and a new BAA
 * version first (docs/counsel/agreement-changes.md §17).
 *
 * Every channel runs at low effort. Opus 5.5 and Sonnet 5.5 think adaptively
 * whether or not the request says so, and low effort keeps that short; the
 * Meta channel asks for it explicitly, as it did on its own client. Only a
 * call streams (owner, 24 October 2026), and only so its turn can speak each
 * sentence once the guard has read that sentence (turn.ts); the website chat
 * and the Meta front door are read whole before anyone sees a word.
 *
 * The system prompt arrives in two parts (prompt.ts): a stable prefix, sent
 * with a cache breakpoint so every turn after the first reads it from the
 * cache, and the turn's own context after it, uncached. A changing byte
 * ahead of the breakpoint would make every turn pay for the whole prefix.
 *
 * A refusal (stop_reason "refusal") is its own outcome, returned as a
 * ModelRefusal rather than as empty text, so no caller can mistake it for a
 * reply the guard refused: the call and the web chat answer it with a fixed
 * line and the clinic's number (turn.ts), the Meta channels with their
 * hand-off line. It is logged here, with its category and never the text.
 *
 * No server-side refusal fallback ("fallbacks", a beta): it would re-run a
 * patient's words on another model through a feature whose eligibility under
 * Anthropic's BAA nobody has confirmed (docs/blockers-runbook.md §3 lists
 * what is excluded, and asks Anthropic in writing which features are
 * eligible). A refusal ends the turn with the fixed line instead.
 */

export type AssistantMessage = { role: "user" | "assistant"; content: string };

/** The system prompt: the cached prefix, then the turn's own context (prompt.ts). */
export type AssistantPrompt = { stable: string; turn: string };

/** The model declined to answer. `category` is the API's refusal category, when it gives one. */
export type ModelRefusal = { refused: true; category: string | null };

export function isModelRefusal(value: unknown): value is ModelRefusal {
  return typeof value === "object" && value !== null && (value as { refused?: unknown }).refused === true;
}

/** The model behind a call or a web chat: a system prompt and the conversation so far, the last message the person's. */
export type AssistantResponder = (request: {
  system: AssistantPrompt;
  messages: AssistantMessage[];
  channel: AssistantChannel;
  /**
   * Each piece of text as the model writes it, for a turn that speaks it
   * sentence by sentence (turn.ts, a call). The answer still resolves to the
   * whole text, which is what the turn parses; a responder that does not
   * stream simply never calls it.
   */
  onText?: (delta: string) => void;
}) => Promise<string | ModelRefusal>;

/** Every channel the client serves: the assistant's two, and the Meta front door. */
export type ModelChannel = AssistantChannel | "meta";

type ChannelConfig = {
  /** The environment variable that may name another patient model; null when the model is fixed. */
  modelEnv: string | null;
  model: PatientModelId;
  maxTokens: number;
  /** Milliseconds; undefined keeps the SDK's default. */
  timeoutMs: number | undefined;
  /** Undefined keeps the SDK's default. */
  maxRetries: number | undefined;
  /**
   * "adaptive" asks for adaptive thinking; "off" turns thinking off where the
   * model in use accepts that (THINKING_OFF), and leaves its own default
   * elsewhere; null leaves the model's own default.
   */
  thinking: "adaptive" | "off" | null;
  /** The longest message passed on, in characters. */
  maxMessageChars: number;
};

export const MODEL_CONFIG: Readonly<Record<ModelChannel, ChannelConfig>> = {
  web_chat: {
    modelEnv: "HEALDESK_CHAT_MODEL",
    model: "claude-opus-5-5",
    maxTokens: 800,
    timeoutMs: 30_000,
    maxRetries: 1,
    thinking: null,
    maxMessageChars: 4_000,
  },
  voice: {
    modelEnv: "HEALDESK_VOICE_MODEL",
    model: "claude-haiku-5-5",
    maxTokens: 400,
    timeoutMs: 8_000,
    maxRetries: 0,
    thinking: "off",
    maxMessageChars: 4_000,
  },
  meta: {
    modelEnv: null,
    model: "claude-opus-5-5",
    maxTokens: 800,
    timeoutMs: undefined,
    maxRetries: undefined,
    thinking: "adaptive",
    maxMessageChars: 2_000,
  },
};

/**
 * Which patient models accept thinking turned off at low effort. Haiku 5.5
 * thinks by default, and its thinking text is omitted, so on a call it is
 * silence before the first word (owner, 25 October 2026: "an awkward 2 to 5
 * second pause"). Opus 5.5 and Sonnet 5.5 refuse `disabled` with a 400, so a
 * call moved onto one by HEALDESK_VOICE_MODEL keeps its default at low effort
 * rather than failing every turn. Safe to switch per request: no channel
 * replays a thinking block, only text.
 */
const THINKING_OFF: Readonly<Record<PatientModelId, boolean>> = {
  "claude-haiku-5-5": true,
  "claude-sonnet-5-5": false,
  "claude-opus-5-5": false,
};

/** Each refused override is warned about once per process, not on every turn. */
const warnedOverrides = new Set<string>();

/**
 * The model one channel runs on: the override its environment variable
 * names, if that is a patient model, and the channel's default otherwise.
 */
export function assistantModel(channel: ModelChannel): PatientModelId {
  const config = MODEL_CONFIG[channel];
  const configured = config.modelEnv ? process.env[config.modelEnv]?.trim() : undefined;
  if (!configured) return config.model;
  if (isPatientModelId(configured)) return configured;
  const key = `${channel}:${configured}`;
  if (!warnedOverrides.has(key)) {
    warnedOverrides.add(key);
    // The variable's name, never a conversation: the value is an operator's
    // setting, and the channel's default answers instead.
    log.warn(
      `${config.modelEnv} names a model outside PATIENT_MODEL_IDS (@healdesk/catalog); using ${config.model}`,
      { channel, source: config.modelEnv },
    );
  }
  return config.model;
}

/**
 * The request for one turn, as the API receives it. Exported so the tests can
 * hold the cache breakpoint on the stable prefix, and nothing after it.
 */
export function modelRequest(input: {
  channel: ModelChannel;
  system: AssistantPrompt;
  messages: AssistantMessage[];
}): Anthropic.MessageCreateParamsNonStreaming {
  const config = MODEL_CONFIG[input.channel];
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: input.system.stable, cache_control: { type: "ephemeral" } },
  ];
  if (input.system.turn.trim()) system.push({ type: "text", text: input.system.turn });
  const model = assistantModel(input.channel);
  const thinking: Anthropic.ThinkingConfigParam | null =
    config.thinking === "adaptive"
      ? { type: "adaptive" }
      : config.thinking === "off" && THINKING_OFF[model]
      ? { type: "disabled" }
      : null;
  return {
    model,
    max_tokens: config.maxTokens,
    ...(thinking ? { thinking } : {}),
    output_config: { effort: "low" },
    system,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content.slice(0, config.maxMessageChars) })),
  };
}

/** The reply's text, or the refusal. Throws what the SDK throws (a timeout, an API error). */
export function readModelResponse(channel: ModelChannel, response: Anthropic.Message): string | ModelRefusal {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? null;
    log.warn("model declined to answer", { channel, kind: category ?? "none" });
    return { refused: true, category };
  }
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

/** One turn on the shared client. */
export async function callModel(input: {
  apiKey: string;
  channel: ModelChannel;
  system: AssistantPrompt;
  messages: AssistantMessage[];
  onText?: (delta: string) => void;
}): Promise<string | ModelRefusal> {
  const client = await clientFor(input.apiKey, input.channel);
  if (!input.onText) {
    const response = await client.messages.create(modelRequest(input));
    return readModelResponse(input.channel, response);
  }
  // Streamed (a call, since 24 October 2026): each text delta goes to the
  // turn as it arrives, so it can speak a sentence as soon as the guard has
  // read it; the final message is read exactly as a non-streamed one is.
  const stream = client.messages.stream(modelRequest(input));
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") input.onText(event.delta.text);
  }
  return readModelResponse(input.channel, await stream.finalMessage());
}

/**
 * One client per key and channel, kept for the process: a client made per
 * turn opened a new TLS connection to the API on every turn of a call,
 * which the caller heard as dead air before each reply (test calls of 23
 * October 2026). The SDK keeps the connection alive between requests.
 */
const clients = new Map<string, Promise<Anthropic>>();

function clientFor(apiKey: string, channel: ModelChannel): Promise<Anthropic> {
  const key = `${channel}\u0000${apiKey}`;
  let client = clients.get(key);
  if (!client) {
    const config = MODEL_CONFIG[channel];
    client = import("@anthropic-ai/sdk").then(
      ({ default: AnthropicClient }) =>
        new AnthropicClient({
          apiKey,
          ...(config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : {}),
          ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
        }),
    );
    // A failed import is not kept: the next turn tries again.
    client.catch(() => clients.delete(key));
    clients.set(key, client);
  }
  return client;
}

/** The responder for calls and web chats. */
export function anthropicAssistantResponder(): AssistantResponder | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return ({ system, messages, channel, onText }) => callModel({ apiKey, channel, system, messages, ...(onText ? { onText } : {}) });
}
