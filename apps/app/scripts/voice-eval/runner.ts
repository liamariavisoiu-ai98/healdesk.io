import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assistantModel } from "../../src/lib/assistant/responder";

import { CALLER_MODEL } from "./caller";
import { SpendCapExceeded, type EvalClient } from "./client";
import { evalFacts } from "./clinics";
import { runConversation } from "./conversation";
import { addUsage, ZERO_USAGE, type Usage } from "./cost";
import { judgeConversation } from "./judge";
import { readRows, type ResultRow } from "./report";
import { overallScore, SKILL_IDS } from "./rubric";
import type { Scenario } from "./scenarios";
import { toneHash } from "./tone";

/**
 * Runs one variant (one tone) over a set of scenarios: each (scenario, rep)
 * is a synthetic call through the real pipeline, then the judge. Rows are
 * appended to results.jsonl as each case finishes, and a rerun skips the
 * (scenario, rep) pairs already written, so a crash costs only the cases in
 * flight. A case that fails before it can be scored (an API error, the
 * per-case wall-clock ceiling, a judge that does not parse) goes to
 * errors.jsonl with its class, never into results as a zero.
 *
 * Layout under the variant directory (gitignored output, see README):
 *   results.jsonl, errors.jsonl, traces/<id>_rep<k>.json, report.{json,md}
 */

export type RunOptions = {
  variant: string;
  dir: string;
  scenarios: readonly Scenario[];
  reps: number;
  client: EvalClient;
  tone: string;
  split?: (id: string) => "train" | "validation" | undefined;
  concurrency?: number;
  /** Hard ceiling on one case, conversation and judge together. */
  caseTimeoutMs?: number;
  modelDeadlineMs?: number;
  log?: (line: string) => void;
};

class CaseTimeout extends Error {}

async function withCeiling<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new CaseTimeout()), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function usageFor(client: EvalClient, conversationId: string, role: "agent" | "caller"): { usage: Usage; model: string | null } {
  let usage = ZERO_USAGE;
  let model: string | null = null;
  for (const e of client.ledger) {
    if (e.conversationId !== conversationId || e.role !== role) continue;
    usage = addUsage(usage, e.usage);
    model = e.model;
  }
  return { usage, model };
}

export async function runVariant(options: RunOptions): Promise<ResultRow[]> {
  const { dir, client } = options;
  const log = options.log ?? (() => {});
  mkdirSync(join(dir, "traces"), { recursive: true });
  const resultsFile = join(dir, "results.jsonl");
  const done = new Set(readRows(resultsFile).map((r) => `${r.prompt_id}#${r.rep}`));
  const hash = toneHash(options.tone);
  const jobs: { scenario: Scenario; rep: number }[] = [];
  for (const scenario of options.scenarios) {
    for (let rep = 0; rep < options.reps; rep += 1) if (!done.has(`${scenario.id}#${rep}`)) jobs.push({ scenario, rep });
  }
  log(`${options.variant}: ${jobs.length} case(s) to run, ${done.size} already done`);

  let next = 0;
  let finished = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (next < jobs.length && !fatal) {
      const { scenario, rep } = jobs[next++]!;
      const conversationId = `${options.variant}:${scenario.id}:${rep}`;
      const started = Date.now();
      try {
        const facts = evalFacts(scenario.specialty);
        const work = (async () => {
          const conversation = await runConversation({ scenario, facts, client, tone: options.tone, conversationId, modelDeadlineMs: options.modelDeadlineMs });
          const judged = await judgeConversation({ client, scenario, facts, turns: conversation.turns, conversationId });
          return { conversation, judged };
        })();
        const { conversation, judged } = await withCeiling(work, options.caseTimeoutMs ?? 300_000);
        const agent = usageFor(client, conversationId, "agent");
        const caller = usageFor(client, conversationId, "caller");
        const grade: Record<string, number> = {};
        const overall = overallScore(judged.skills);
        if (overall !== null) grade.overall = overall;
        for (const id of SKILL_IDS) if (judged.skills[id].applicable) grade[id] = judged.skills[id].score / 3;
        const explanation: ResultRow["explanation"] = { summary: judged.summary };
        for (const id of SKILL_IDS) explanation[id] = judged.skills[id].evidence;
        const row: ResultRow = {
          prompt_id: scenario.id,
          rep,
          prompt: scenario.opening,
          tags: [scenario.specialty, scenario.archetype, scenario.intent],
          ...(options.split?.(scenario.id) ? { split: options.split(scenario.id)! } : {}),
          status: "ok",
          grade,
          explanation,
          // The agent's model as served (a run where every turn was a fixed line has none: production's configured one).
          model: agent.model ?? assistantModel("voice"),
          usage: agent.usage,
          caller_model: caller.model ?? CALLER_MODEL,
          caller_usage: caller.usage,
          judge_model: judged.model,
          judge_usage: {
            input_tokens: judged.usage.input_tokens,
            output_tokens: judged.usage.output_tokens,
            cache_creation_input_tokens: judged.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: judged.usage.cache_read_input_tokens ?? 0,
          },
          latency_s: (Date.now() - started) / 1000,
          assistant_turns: conversation.turns.filter((t) => t.speaker === "assistant" && t.source !== "opening").length,
          sources: conversation.sources,
          endings: conversation.endings,
          tone_hash: hash,
        };
        writeFileSync(
          join(dir, "traces", `${scenario.id}_rep${rep}.json`),
          `${JSON.stringify(
            [
              { role: "system", content: `Synthetic call. Scenario ${scenario.id}; tone ${hash}. The agent's system prompt is the production prompt for this practice with that tone sentence.` },
              ...conversation.turns.map((t) => ({ role: t.speaker === "caller" ? "user" : "assistant", content: t.text, ...(t.source ? { name: `call ${t.call}, ${t.source}` } : { name: `call ${t.call}` }) })),
            ],
            null,
            2,
          )}\n`,
        );
        appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      } catch (error) {
        if (error instanceof SpendCapExceeded) {
          fatal = error;
          break;
        }
        const failure = error instanceof CaseTimeout ? "timeout" : "harness_or_serving_error";
        appendFileSync(
          join(dir, "errors.jsonl"),
          `${JSON.stringify({ prompt_id: scenario.id, rep, failure, message: error instanceof Error ? error.message.slice(0, 300) : String(error) })}\n`,
        );
      }
      finished += 1;
      if (finished % 10 === 0 || finished === jobs.length) log(`${options.variant}: ${finished}/${jobs.length} done`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  if (fatal) throw fatal;
  return readRows(resultsFile);
}
