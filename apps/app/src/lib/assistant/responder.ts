import type { AssistantChannel } from "./facts";
import type { AssistantResponder } from "./turn";

/**
 * The model behind calls and web chats: Anthropic's API under healdesk's own
 * key (ANTHROPIC_API_KEY, the patient-data organisation's), no tools, no
 * search, nothing stored by healdesk. Null when the key is not set, and the
 * assistant then gives the fixed failure line (turn.ts).
 *
 * The model is set per channel, because a call cannot wait: the web chat
 * uses HEALDESK_CHAT_MODEL (default claude-opus-5-5), the call
 * HEALDESK_VOICE_MODEL (default claude-sonnet-5-5), each with low effort and
 * a hard timeout, after which the caller hears the failure line instead of
 * silence.
 */

const DEFAULT_MODEL: Record<AssistantChannel, string> = {
  web_chat: "claude-opus-5-5",
  voice: "claude-sonnet-5-5",
};

const TIMEOUT_MS: Record<AssistantChannel, number> = { web_chat: 30_000, voice: 8_000 };

export function assistantModel(channel: AssistantChannel): string {
  const configured = channel === "voice" ? process.env.HEALDESK_VOICE_MODEL : process.env.HEALDESK_CHAT_MODEL;
  return configured?.trim() || DEFAULT_MODEL[channel];
}

export function anthropicAssistantResponder(): AssistantResponder | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return async ({ system, messages, channel }) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS[channel], maxRetries: channel === "voice" ? 0 : 1 });
    const response = await client.messages.create({
      model: assistantModel(channel),
      max_tokens: channel === "voice" ? 400 : 800,
      output_config: { effort: "low" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content.slice(0, 4_000) })),
    });
    if (response.stop_reason === "refusal") return "";
    return response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
  };
}
