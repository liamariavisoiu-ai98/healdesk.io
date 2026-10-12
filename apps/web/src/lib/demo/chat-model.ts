import type Anthropic from "@anthropic-ai/sdk";

import { buildClinicChatPrompt } from "./clinic-prompts";
import type { ClinicProfile } from "./profile";

/**
 * The personalised demo's chat call, in one place, for its two callers: the
 * prospect's chat (app/api/demo/[slug]/chat streams it) and the handoff audit
 * (lib/demo/audit.ts asks it the test questions). The audit grades the demo
 * the prospect will get only while both build the request here; a second copy
 * of these settings would let the two drift and the audit pass a chat that
 * nobody runs.
 */

export const DEMO_CHAT_MODEL = "claude-opus-5-5";
export const DEMO_CHAT_MAX_TOKENS = 2_000;

export function demoChatParams(
  profile: ClinicProfile,
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: DEMO_CHAT_MODEL,
    max_tokens: DEMO_CHAT_MAX_TOKENS,
    // A refused turn retries on Anthropic's recommended fallback model
    // instead of leaving the prospect with an empty bubble.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Short front-desk answers: low effort is fast and holds quality here.
    output_config: { effort: "low" },
    system: [
      {
        type: "text",
        text: buildClinicChatPrompt(profile),
        // Stable for the life of the demo, so every turn after the first reads it from cache.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages,
  };
}

/**
 * The reply's text. After a fallback, the blocks before the last `fallback`
 * block are the declined model's unfinished answer, so only what follows it
 * counts (the same rule as lib/site-read/extract.ts).
 */
export function finalText(content: readonly Anthropic.Beta.Messages.BetaContentBlock[]): string {
  const lastSwitch = content.map((block) => block.type).lastIndexOf("fallback");
  return content
    .slice(lastSwitch + 1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}
