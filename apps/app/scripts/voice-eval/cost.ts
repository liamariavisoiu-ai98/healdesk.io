import { createHash } from "node:crypto";

import { confirmedSpendId, evalApiKey } from "./env";

/**
 * What a run costs, and the gate in front of the first paid call.
 *
 * Prices are Anthropic's first-party list prices per million tokens, from the
 * claude-api skill's model table (cached 2026-10-06): cache writes at 1.25x
 * input, cache reads at 0.1x input. Haiku 5.5's price holds for prompts up to
 * 100K tokens; no prompt here comes near that. If a price changes, change
 * PRICES and PRICE_TABLE_VERSION together: the version is part of every
 * estimate id, so an approval given at the old price does not carry over.
 *
 * The estimate is measured, not guessed, as far as anything can be without a
 * paid call: `voice-eval estimate` runs the whole plan in dry-run mode, where
 * the mock client records each request's real size (the actual prompt the
 * production code builds, the actual transcript so far) and prices it. Two
 * things a dry run cannot see are assumptions, stated in the printout:
 *
 *   - tokens per character: input is counted as ceil(chars / CHARS_PER_TOKEN)
 *     (4 characters a token, typical for English; the real tokenizer may
 *     differ by about +-20%);
 *   - output length: each role's output (thinking included) is taken as
 *     ASSUMED_OUTPUT_TOKENS, since a mock reply's length says nothing about
 *     what the real model would write;
 *   - conversation length: the mock caller talks for `assumedTurns` turns.
 *
 * The owner's first approved run replaces all three with measured usage
 * (results rows carry each call's real `usage`).
 */

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type CallRole = "agent" | "caller" | "judge" | "proposer";

export type LedgerEntry = { role: CallRole; model: string; usage: Usage; conversationId: string | null };

export const PRICE_TABLE_VERSION = "claude-api-skill-2026-10-06";

/** Dollars per million tokens. */
export const PRICES: Readonly<Record<string, { in: number; out: number }>> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};

export const CHARS_PER_TOKEN = 4;

/** Output tokens per call, thinking included, by role (see the file header). */
export const ASSUMED_OUTPUT_TOKENS: Readonly<Record<CallRole, number>> = {
  agent: 150,
  caller: 60,
  judge: 1_500,
  proposer: 3_000,
};

export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export function addUsage(a: Usage, b: Partial<Usage> | null | undefined): Usage {
  return {
    input_tokens: a.input_tokens + (b?.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b?.output_tokens ?? 0),
    cache_creation_input_tokens: a.cache_creation_input_tokens + (b?.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: a.cache_read_input_tokens + (b?.cache_read_input_tokens ?? 0),
  };
}

/** Dollars for one call's usage on one model. Throws on a model with no price: a silent $0 would hide spend. */
export function costOf(model: string, usage: Usage): number {
  const price = PRICES[model];
  if (!price) throw new Error(`voice-eval: no price for model ${model}; add it to PRICES in cost.ts`);
  const perToken = (dollarsPerMillion: number) => dollarsPerMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(price.in) +
    usage.cache_creation_input_tokens * perToken(price.in) * 1.25 +
    usage.cache_read_input_tokens * perToken(price.in) * 0.1 +
    usage.output_tokens * perToken(price.out)
  );
}

export function ledgerCost(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + costOf(e.model, e.usage), 0);
}

/** The same calls with no prompt caching: every cached token billed as plain input. The upper bound. */
export function ledgerCostWithoutCache(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, e) => {
    const u = e.usage;
    const flat: Usage = { ...ZERO_USAGE, input_tokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, output_tokens: u.output_tokens };
    return sum + costOf(e.model, flat);
  }, 0);
}

export type Plan = {
  command: "run" | "hillclimb";
  specialties: string[];
  /** Scenarios per specialty; null for all. */
  limit: number | null;
  reps: number;
  /** Hill-climb rounds; 0 for a plain run. */
  rounds: number;
  /** Caller turns the dry run simulates per call. */
  assumedTurns: number;
};

export type RoleTotal = { calls: number; usage: Usage; usd: number; model: string };

export type Estimate = {
  id: string;
  plan: Plan;
  priceTable: string;
  byRole: Partial<Record<CallRole, RoleTotal>>;
  conversations: number;
  usd: number;
  usdWithoutCache: number;
  /** Real spend may run to this before the run stops itself (SpendCap). */
  capUsd: number;
  assumptions: string[];
};

/** The stop the live client enforces: half again the estimate, plus a dollar of slack for small runs. */
export function spendCapFor(usd: number): number {
  return Math.round((usd * 1.5 + 1) * 100) / 100;
}

export function buildEstimate(plan: Plan, ledger: readonly LedgerEntry[]): Estimate {
  const byRole: Partial<Record<CallRole, RoleTotal>> = {};
  for (const entry of ledger) {
    const total = byRole[entry.role] ?? { calls: 0, usage: ZERO_USAGE, usd: 0, model: entry.model };
    byRole[entry.role] = { calls: total.calls + 1, usage: addUsage(total.usage, entry.usage), usd: total.usd + costOf(entry.model, entry.usage), model: entry.model };
  }
  const usd = ledgerCost(ledger);
  const conversations = new Set(ledger.map((e) => e.conversationId).filter(Boolean)).size;
  const cents = Math.round(usd * 100);
  // The id binds the approval to this plan, these prices and this size: a
  // bigger plan, a changed prompt that moves the total by a cent, or a new
  // price table all print a new id, which needs a new approval.
  const id = `ve-${createHash("sha256").update(JSON.stringify({ plan, cents, priceTable: PRICE_TABLE_VERSION })).digest("hex").slice(0, 12)}`;
  return {
    id,
    plan,
    priceTable: PRICE_TABLE_VERSION,
    byRole,
    conversations,
    usd,
    usdWithoutCache: ledgerCostWithoutCache(ledger),
    capUsd: spendCapFor(usd),
    assumptions: [
      `input tokens = characters / ${CHARS_PER_TOKEN} (real tokenizer within about +-20%)`,
      `output tokens per call (thinking included): agent ${ASSUMED_OUTPUT_TOKENS.agent}, caller ${ASSUMED_OUTPUT_TOKENS.caller}, judge ${ASSUMED_OUTPUT_TOKENS.judge}, proposer ${ASSUMED_OUTPUT_TOKENS.proposer}`,
      `${plan.assumedTurns} caller turns per call; a cut-off scenario is two calls`,
      "the agent's stable prompt is written to the cache on each conversation's first turn and read on the rest (no-cache upper bound printed too)",
      `prices: ${PRICE_TABLE_VERSION} first-party list prices, cache write 1.25x and read 0.1x input`,
    ],
  };
}

export function formatEstimate(e: Estimate): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const lines = [
    `Estimate ${e.id}  (${e.plan.command}: ${e.plan.specialties.length} specialties, ${e.plan.limit ?? "all"} scenarios each, ${e.plan.reps} rep(s)${e.plan.command === "hillclimb" ? `, ${e.plan.rounds} round(s)` : ""})`,
    `  conversations: ${e.conversations}`,
  ];
  for (const [role, t] of Object.entries(e.byRole)) {
    lines.push(
      `  ${role.padEnd(8)} ${t!.model.padEnd(18)} ${String(t!.calls).padStart(6)} calls  in ${t!.usage.input_tokens + t!.usage.cache_creation_input_tokens + t!.usage.cache_read_input_tokens} tok  out ${t!.usage.output_tokens} tok  ${money(t!.usd)}`,
    );
  }
  lines.push(
    `  TOTAL ${money(e.usd)} with prompt caching; ${money(e.usdWithoutCache)} if nothing caches`,
    `  The run stops itself if measured spend passes ${money(e.capUsd)}.`,
    "  Assumptions:",
    ...e.assumptions.map((a) => `    - ${a}`),
    "",
    `To approve this exact plan: VOICE_EVAL_CONFIRM_SPEND=${e.id} (and VOICE_EVAL_ANTHROPIC_API_KEY set).`,
  );
  return lines.join("\n");
}

export class SpendNotApproved extends Error {}

/**
 * The gate in front of the first paid call. Returns the eval's key only when
 * VOICE_EVAL_CONFIRM_SPEND names this estimate's id and the key is set;
 * throws otherwise. Nothing that spends money is constructed before this
 * returns (client.ts, createLiveClient).
 */
export function assertSpendApproved(estimate: Estimate, read = { confirmed: confirmedSpendId, key: evalApiKey }): string {
  const confirmed = read.confirmed();
  if (confirmed !== estimate.id) {
    throw new SpendNotApproved(
      confirmed
        ? `VOICE_EVAL_CONFIRM_SPEND is ${confirmed}, but this plan's estimate is ${estimate.id}: run \`voice-eval estimate\` with the same flags and approve the id it prints. No API call was made.`
        : `Refusing to spend: set VOICE_EVAL_CONFIRM_SPEND=${estimate.id} to approve ${`$${estimate.usd.toFixed(2)}`} (cap $${estimate.capUsd.toFixed(2)}). No API call was made.`,
    );
  }
  const key = read.key();
  if (!key) throw new SpendNotApproved("Refusing to spend: VOICE_EVAL_ANTHROPIC_API_KEY is not set. No API call was made.");
  return key;
}
