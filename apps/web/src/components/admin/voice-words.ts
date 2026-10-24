import type { VoiceAgentProblem, VoiceAgentStatusView } from "@/lib/admin/ops-client";

/**
 * The plain words the Setup tab's "Voice agent" card puts on apps/app's
 * voice codes (ops automation Phase 5, lane P5b): the set-up's status, the
 * engine, and each thing the read-back against Retell can find different
 * (lib/voice/provision.ts, VoiceAgentProblem, mirrored in ops-client's
 * VOICE_AGENT_PROBLEMS). Types only from ops-client, so the client card may
 * import this (lib/admin/client-imports.test.ts); `voice-words.test.ts`
 * fails when a problem code has no words.
 *
 * Nothing here ever prints a phone number: apps/app sends only whether one
 * is held, and the one free-text field it does send, the last reason, is
 * scrubbed of anything shaped like a number before it is drawn.
 */

export const VOICE_STATUS_WORDS: Record<VoiceAgentStatusView["status"], string> = {
  pending: "Not set up yet: waiting for its first run",
  provisioning: "Being set up now",
  ready: "Ready",
  failed: "Set-up failed",
  deprovisioning: "Being released",
  released: "Released: the agent and number were given back",
};

export const VOICE_ENGINE_WORDS: Record<VoiceAgentStatusView["engine"], string> = {
  custom: "healdesk's own (the custom LLM endpoint)",
  native: "Retell's native",
};

/** What the read-back found different, each as one clause an operator can act on. */
export const VOICE_PROBLEM_WORDS: Record<VoiceAgentProblem, string> = {
  agent_missing: "the agent is missing at Retell",
  storage: "the agent's storage setting is not as we wrote it",
  engine: "the agent is not on our engine",
  webhook: "the agent's webhook is not ours",
  voice: "the agent's voice is not the one configured",
  language: "the agent's language is not the one configured",
  keywords: "the agent's boosted keywords differ from ours",
  number_missing: "the phone number is missing at Retell",
  number_agent: "the number does not route to this agent alone",
  number_outbound: "the number has an outbound agent, which it must not",
  fallback: "the number's fallback is not the clinic's direct line",
};

/** The problems as one sentence fragment: "the agent is missing at Retell; the number's fallback is not the clinic's direct line". */
export function problemsWords(problems: readonly VoiceAgentProblem[]): string {
  return problems.map((p) => VOICE_PROBLEM_WORDS[p]).join("; ");
}

/**
 * Anything shaped like a phone number (seven or more digits, with the usual
 * separators) becomes "[number]" and anything shaped like an email address
 * "[address]". apps/app's own reasons carry neither; this is the belt for
 * the one free-text field the card prints.
 */
export function scrubContact(text: string): string {
  return text.replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, "[address]").replace(/(?:\+|\()?\d[\d\s().-]{5,}\d/g, "[number]");
}
