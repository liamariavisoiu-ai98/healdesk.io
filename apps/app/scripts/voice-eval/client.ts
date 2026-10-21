import type Anthropic from "@anthropic-ai/sdk";

import {
  approxTokens,
  ASSUMED_OUTPUT_TOKENS,
  assertSpendApproved,
  ledgerCost,
  type CallRole,
  type Estimate,
  type LedgerEntry,
  type Usage,
} from "./cost";

/**
 * The one door every eval model call goes through: the agent under test (the
 * production request, built by responder.ts modelRequest), the caller
 * simulator, the judge and the hill-climb's proposer.
 *
 * Two implementations:
 *   - createMockClient: no network, no key, no spend. Each role answers from
 *     a scripted fake (MockBehaviour); usage is the request's measured size
 *     (cost.ts approxTokens) and the role's assumed output, so a dry run
 *     prices a plan. Every test uses it.
 *   - createLiveClient: the real SDK, behind assertSpendApproved (cost.ts).
 *     Constructed only after the gate passes; stops itself once measured
 *     spend passes the estimate's cap; refuses a response served by another
 *     model than the one asked for.
 */

/** What the mock may know about a call beyond the request (the live client ignores it). */
export type CallContext = {
  conversationId?: string;
  /** For the caller: which of their turns this is (1 = the line after their opening), and which call. */
  callerTurn?: number;
  call?: 1 | 2;
  scenario?: { id: string; scripted: string[]; callerName: string; archetype: string; intent: string };
  /** For the judge: the transcript it is grading, as structured turns. */
  transcript?: { speaker: "caller" | "assistant"; text: string; source?: string }[];
  round?: number;
  /** Dry run only: how many turns the mock caller talks for before hanging up. */
  assumedTurns?: number;
};

export type EvalClient = {
  readonly mode: "dry-run" | "live";
  readonly ledger: LedgerEntry[];
  create(role: CallRole, params: Anthropic.MessageCreateParamsNonStreaming, context?: CallContext): Promise<Anthropic.Message>;
};

// ----------------------------------------------------------------------------
// The mock
// ----------------------------------------------------------------------------

export type MockBehaviour = {
  [R in CallRole]: (params: Anthropic.MessageCreateParamsNonStreaming, context: CallContext) => string;
};

function systemText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const s = params.system;
  if (!s) return "";
  return typeof s === "string" ? s : s.map((b) => b.text).join("\n");
}

function messageText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return params.messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("\n")))
    .join("\n");
}

function lastUserText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.map((b) => ("text" in b ? b.text : "")).join(" ");
}

/** Phrases the mock agent opens with when the tone asks it to acknowledge feelings first. */
const ACKNOWLEDGE = "That sounds stressful, I'm glad you called.";

/**
 * The scripted fakes. Deliberately simple, but wired to what they are given
 * so a dry run exercises the loop end to end: the agent's replies change
 * with the tone sentence in its system prompt, and the judge scores what it
 * reads, so a better tone candidate really does score higher in a dry run.
 */
export const DEFAULT_MOCK: MockBehaviour = {
  agent(params) {
    const system = systemText(params);
    const said = lastUserText(params).toLowerCase();
    const feelingFirst = /acknowledge|how they feel|feelings?/i.test(system);
    const feeling = /nervous|annoyed|worried|sorry|frustrat|ages/.test(said);
    const bye = /\b(bye|that's all|thanks, bye)\b/.test(said);
    let reply: string;
    if (bye) reply = "Thanks for calling, take care. Bye for now.";
    else if (/\bguess\b/.test(said)) reply = "I don't know that one, and I'd rather not guess. I can have the team get back to you within a day.";
    else if (/\b(cost|how much|price|cheaper)\b/.test(said)) reply = "The consultation is listed on our menu, and the team can go through the rest with you. Would you like a consultation?";
    else if (/\bsay that again\b/.test(said)) reply = "Of course. How can I help you today?";
    else reply = "I can help with that. Which day suits you best?";
    if (feeling && feelingFirst && !bye) reply = `${ACKNOWLEDGE} ${reply}`;
    else if (feeling && !bye) reply = `Sorry about that. ${reply}`;
    return JSON.stringify({ reply, booking: { wants: false }, handoff: false, end: bye });
  },
  caller(_params, context) {
    const scripted = context.scenario?.scripted ?? [];
    const turn = context.callerTurn ?? 1;
    const assumed = context.assumedTurns ?? scripted.length + 1;
    if (turn <= scripted.length) return scripted[turn - 1]!;
    if (turn < assumed) return "Okay, and is there anything else I should know before I come in?";
    return "Okay, thanks, bye. [HANG UP]";
  },
  judge(_params, context) {
    const turns = context.transcript ?? [];
    const agent = turns.filter((t) => t.speaker === "assistant" && t.source === "model").map((t) => t.text);
    const caller = turns.filter((t) => t.speaker === "caller").map((t) => t.text);
    const score = (applicable: boolean, value: number, evidence: string) => ({ applicable, score: Math.max(0, Math.min(3, value)), evidence });
    const feelingIdx = turns.findIndex((t) => t.speaker === "caller" && /nervous|annoyed|worried|frustrat/i.test(t.text));
    const answer = feelingIdx >= 0 ? turns.slice(feelingIdx + 1).find((t) => t.speaker === "assistant") : undefined;
    const sorries = agent.filter((t) => /\bsorry\b/i.test(t)).length;
    const name = context.scenario?.callerName ?? "";
    const gaveName = caller.some((t) => name && t.includes(name));
    const unknown = context.scenario?.intent === "unknown";
    const last = turns.filter((t) => t.speaker === "assistant").at(-1)?.text ?? "";
    return JSON.stringify({
      skills: {
        feeling_first: score(feelingIdx >= 0, answer && answer.text.startsWith(ACKNOWLEDGE) ? 3 : 1, "mock: first reply after the feeling"),
        spoken_brevity: score(true, agent.every((t) => t.split(/[.!?]\s/).length <= 3) ? 3 : 1, "mock: sentences per reply"),
        one_question: score(true, agent.every((t) => (t.match(/\?/g) ?? []).length <= 1) ? 3 : 1, "mock: questions per reply"),
        confirms_details: score(gaveName, agent.some((t) => name && t.includes(name)) ? 3 : 1, "mock: name said back"),
        honest_unknown: score(unknown, agent.some((t) => /don't know/i.test(t)) ? 3 : 0, "mock: admits not knowing"),
        no_over_apology: score(true, 3 - sorries, "mock: count of sorry"),
        natural_close: score(true, /bye|take care/i.test(last) ? 3 : 1, "mock: last line"),
      },
      summary: "mock judge",
    });
  },
  proposer(_params, context) {
    const round = context.round ?? 1;
    // A different candidate every round, so a dry run (and so an estimate) runs every round in full.
    const candidates = [
      "Be warm, welcoming and unhurried, like the best person at the front desk. When someone sounds worried or annoyed, acknowledge how they feel in a few words first, then help. Keep it brief and useful.",
      "Be calm and kind, and keep every answer short.",
      "Be friendly and plain-spoken, and ask one thing at a time.",
      "Be patient and clear, and repeat back names and days you hear.",
    ];
    const tone = candidates[(round - 1) % candidates.length]! + " Stay relaxed.".repeat(Math.floor((round - 1) / candidates.length));
    return JSON.stringify({ tone, rationale: "mock proposer" });
  },
};

export function createMockClient(options: { behaviour?: Partial<MockBehaviour>; assumedTurns?: number } = {}): EvalClient {
  const behaviour: MockBehaviour = { ...DEFAULT_MOCK, ...options.behaviour };
  const ledger: LedgerEntry[] = [];
  const cachedConversations = new Set<string>();
  return {
    mode: "dry-run",
    ledger,
    async create(role, params, context = {}) {
      const text = behaviour[role](params, { ...context, ...(options.assumedTurns ? { assumedTurns: options.assumedTurns } : {}) });
      // Measured request size: what the real request would carry.
      const system = params.system;
      let cachedPrefix = 0;
      let uncachedSystem = 0;
      if (Array.isArray(system)) {
        for (const block of system) {
          if (block.cache_control) cachedPrefix += approxTokens(block.text);
          else uncachedSystem += approxTokens(block.text);
        }
      } else if (system) {
        uncachedSystem += approxTokens(system);
      }
      const schema = params.output_config?.format ? approxTokens(JSON.stringify(params.output_config.format)) : 0;
      const conversation = context.conversationId ?? null;
      const firstForConversation = conversation === null || !cachedConversations.has(`${role}:${conversation}`);
      if (conversation) cachedConversations.add(`${role}:${conversation}`);
      const usage: Usage = {
        input_tokens: uncachedSystem + approxTokens(messageText(params)) + schema,
        output_tokens: ASSUMED_OUTPUT_TOKENS[role],
        cache_creation_input_tokens: firstForConversation ? cachedPrefix : 0,
        cache_read_input_tokens: firstForConversation ? 0 : cachedPrefix,
      };
      ledger.push({ role, model: params.model, usage, conversationId: conversation });
      return fakeMessage(params.model, text, usage);
    },
  };
}

function fakeMessage(model: string, text: string, usage: Usage): Anthropic.Message {
  return {
    id: "msg_dry_run",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { ...usage, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message;
}

// ----------------------------------------------------------------------------
// The live client
// ----------------------------------------------------------------------------

/** Per-role request limits. The agent keeps production's (responder.ts MODEL_CONFIG.voice): 8 seconds, no retry. */
const LIVE_LIMITS: Readonly<Record<CallRole, { timeout: number; maxRetries: number }>> = {
  agent: { timeout: 8_000, maxRetries: 0 },
  caller: { timeout: 30_000, maxRetries: 2 },
  judge: { timeout: 180_000, maxRetries: 2 },
  proposer: { timeout: 300_000, maxRetries: 2 },
};

export class SpendCapExceeded extends Error {}
export class ServedModelMismatch extends Error {}

/**
 * The real client. assertSpendApproved runs first and throws unless the
 * owner approved this estimate's id and the eval key is set; the SDK is not
 * even imported before it passes.
 */
export async function createLiveClient(estimate: Estimate): Promise<EvalClient> {
  const apiKey = assertSpendApproved(estimate);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const sdk = new Anthropic({ apiKey });
  const ledger: LedgerEntry[] = [];
  let stopped = false;
  return {
    mode: "live",
    ledger,
    async create(role, params, context = {}) {
      if (stopped || ledgerCost(ledger) > estimate.capUsd) {
        stopped = true;
        throw new SpendCapExceeded(`voice-eval: measured spend passed the cap of $${estimate.capUsd.toFixed(2)}; stopping.`);
      }
      const response = await sdk.messages.create(params, LIVE_LIMITS[role]);
      const u = response.usage;
      ledger.push({
        role,
        model: response.model,
        usage: {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        },
        conversationId: context.conversationId ?? null,
      });
      // A silently substituted model invalidates every comparison.
      if (response.model !== params.model && !response.model.startsWith(`${params.model}-`)) {
        throw new ServedModelMismatch(`asked for ${params.model}, served by ${response.model}`);
      }
      return response;
    },
  };
}
