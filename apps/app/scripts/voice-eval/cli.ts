import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLiveClient, createMockClient, type EvalClient } from "./client";
import { buildEstimate, formatEstimate, SpendNotApproved, type Estimate, type Plan } from "./cost";
import { outDirSetting } from "./env";
import { hillClimb } from "./hillclimb";
import { buildReport, readRows, recordTrend, writeReport } from "./report";
import { EVAL_SPECIALTIES, type EvalSpecialty } from "./rubric";
import { runVariant } from "./runner";
import { vitestSafetyGate, type SafetyGate } from "./safety-gate";
import { loadScenarios, type Scenario } from "./scenarios";
import { productionTone } from "./tone";

/**
 * The voice eval's command line (README.md beside this file):
 *
 *   npm run voice-eval -w @healdesk/app -- estimate  [--plan run|hillclimb] [flags]
 *   npm run voice-eval -w @healdesk/app -- run       --dry-run [flags]
 *   npm run voice-eval -w @healdesk/app -- hillclimb --dry-run [flags]
 *
 * Flags: --specialty a,b  --limit N (scenarios per specialty)  --reps N
 *        --rounds N (hillclimb)  --assumed-turns N (dry run and estimate)
 *        --concurrency N  --label NAME
 *
 * Without --dry-run, `run` and `hillclimb` make paid API calls, and refuse
 * unless VOICE_EVAL_CONFIRM_SPEND holds the id `estimate` printed for the
 * same flags and VOICE_EVAL_ANTHROPIC_API_KEY is set (cost.ts).
 */

export type Args = {
  command: "estimate" | "run" | "hillclimb";
  /** What is run, or estimated: `estimate --plan hillclimb` prices the hill-climb. */
  plan: "run" | "hillclimb";
  dryRun: boolean;
  specialties: EvalSpecialty[];
  limit: number | null;
  reps: number;
  rounds: number;
  assumedTurns: number;
  concurrency: number;
  label: string | null;
};

export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "estimate" && command !== "run" && command !== "hillclimb") {
    throw new Error("usage: voice-eval <estimate|run|hillclimb> [--plan run|hillclimb] [--dry-run] [--specialty a,b] [--limit N] [--reps N] [--rounds N] [--assumed-turns N] [--concurrency N] [--label NAME]");
  }
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const int = (name: string, fallback: number, min: number) => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer of at least ${min}`);
    return n;
  };
  const specialties = (flag("specialty")?.split(",").map((s) => s.trim()) ?? [...EVAL_SPECIALTIES]) as EvalSpecialty[];
  for (const s of specialties) if (!EVAL_SPECIALTIES.includes(s)) throw new Error(`unknown specialty ${s}`);
  const limitRaw = flag("limit");
  const planFlag = flag("plan");
  if (planFlag !== undefined && planFlag !== "run" && planFlag !== "hillclimb") throw new Error("--plan must be run or hillclimb");
  const plan = command === "estimate" ? (planFlag ?? "run") : command;
  return {
    command,
    plan,
    dryRun: rest.includes("--dry-run"),
    specialties,
    limit: limitRaw === undefined ? null : int("limit", 0, 1),
    reps: int("reps", 1, 1),
    rounds: plan === "hillclimb" ? int("rounds", 3, 1) : 0,
    assumedTurns: int("assumed-turns", 6, 2),
    concurrency: int("concurrency", 4, 1),
    label: flag("label") ?? null,
  };
}

export function planFor(args: Args): Plan {
  return {
    command: args.plan,
    specialties: [...args.specialties],
    limit: args.limit,
    reps: args.reps,
    rounds: args.plan === "hillclimb" ? args.rounds : 0,
    assumedTurns: args.assumedTurns,
  };
}

export function selectScenarios(specialties: readonly EvalSpecialty[], limit: number | null): Scenario[] {
  return specialties.flatMap((s) => {
    const all = loadScenarios([s]);
    return limit === null ? all : all.slice(0, limit);
  });
}

/** The gate an estimate's dry run uses: always holds, never spawns vitest (it changes nothing that costs). */
const estimateGate: SafetyGate = async () => ({ ok: true, passed: 1, failed: 0, skipped: 0, detail: "estimate" });

async function execute(plan: Plan, client: EvalClient, root: string, gate: SafetyGate, log: (line: string) => void, concurrency: number) {
  const scenarios = selectScenarios(plan.specialties as EvalSpecialty[], plan.limit);
  if (plan.command === "hillclimb") {
    return hillClimb({ root, scenarios, reps: plan.reps, rounds: plan.rounds, client, gate, concurrency, log });
  }
  const dir = join(root, "baseline");
  const rows = await runVariant({ variant: "baseline", dir, scenarios, reps: plan.reps, client, tone: productionTone(), concurrency, log });
  const report = buildReport("baseline", rows);
  writeReport(dir, report, client.mode);
  return report;
}

/** Runs the whole plan against the mock client in a scratch directory and prices what it sent. No network. */
export async function estimatePlan(plan: Plan): Promise<Estimate> {
  const scratch = mkdtempSync(join(tmpdir(), "voice-eval-estimate-"));
  try {
    const client = createMockClient({ assumedTurns: plan.assumedTurns });
    await execute(plan, client, scratch, estimateGate, () => {}, 1);
    return buildEstimate(plan, client.ledger);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".voice-eval");

export async function main(argv: readonly string[], options: { gate?: SafetyGate; out?: string; log?: (line: string) => void; now?: Date } = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const args = parseArgs(argv);
  const plan = planFor(args);
  const estimate = await estimatePlan(plan);
  log(formatEstimate(estimate));
  if (args.command === "estimate") return 0;

  let client: EvalClient;
  if (args.dryRun) {
    client = createMockClient({ assumedTurns: args.assumedTurns });
    log("DRY RUN: scripted fake model replies, no network, no spend. Scores below test the plumbing, not the assistant.");
  } else {
    try {
      client = await createLiveClient(estimate);
    } catch (error) {
      if (error instanceof SpendNotApproved) {
        log(error.message);
        return 2;
      }
      throw error;
    }
  }
  const now = options.now ?? new Date();
  const label = args.label ?? `${args.dryRun ? "dry" : "live"}-${now.toISOString().replace(/[:.]/g, "-")}`;
  const out = options.out ?? outDirSetting() ?? DEFAULT_OUT_DIR;
  const root = join(out, args.command === "hillclimb" ? "hillclimb" : "runs", label);
  const result = await execute(plan, client, root, options.gate ?? vitestSafetyGate, log, args.concurrency);
  // The trend line is the run's report, or for a hill-climb the best variant's.
  const bestVariant = (round: number) => (round === 0 ? "baseline" : `v${round}`);
  const trend =
    "variant" in result
      ? result
      : buildReport(bestVariant(result.best.round), readRows(join(root, bestVariant(result.best.round), "results.jsonl")));
  recordTrend(out, label, trend, client.mode, now);
  log(`Results in ${root}`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
