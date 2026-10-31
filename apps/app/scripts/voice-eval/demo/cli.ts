import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLiveClient } from "../client";
import { formatEstimate } from "../cost";
import { outDirSetting } from "../env";

import { DEMO_SCENARIOS } from "./scenarios";
import { approveDemoSpend, compareDemoReports, createDemoMockClient, DemoSpendNotApproved, demoPromptHash, estimateDemoRun, reportMarkdown, runDemoEval, type DemoReport } from "./run";

/**
 * The demo eval's command line (README.md beside the voice eval):
 *
 *   npm run voice-eval:demo -w @healdesk/app -- estimate [--reps N] [--scenarios a,b]
 *   npm run voice-eval:demo -w @healdesk/app -- run --dry-run [flags]
 *   npm run voice-eval:demo -w @healdesk/app -- run [--reps N] [--baseline FILE] [--write-baseline FILE] [--fail-on-worse]
 *
 * A paid run needs VOICE_EVAL_ANTHROPIC_API_KEY (the eval's own key) and
 * either VOICE_EVAL_CONFIRM_SPEND set to the id `estimate` prints, or a
 * standing VOICE_EVAL_DEMO_BUDGET_USD the run's cap fits inside.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "../../..");

/** The code that decides what the demo model is told and what the call does with its answer. */
const PROMPT_FILES = [
  "src/lib/voice/demo-facts.ts",
  "src/lib/voice/retell.ts",
  "src/lib/assistant/turn.ts",
  "src/lib/assistant/prompt.ts",
  "src/lib/assistant/guard.ts",
  "src/lib/assistant/responder.ts",
  "scripts/voice-eval/demo/scenarios.ts",
];

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A report as kept for comparing: everything but the transcripts. */
function stripped(report: DemoReport): DemoReport {
  return { ...report, cases: report.cases.map((c) => ({ ...c, trace: { ...c.trace, turns: [], progress: [], modelAnswers: [] } })) };
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command !== "estimate" && command !== "run") {
    console.error("usage: voice-eval:demo <estimate|run> [--dry-run] [--reps N] [--scenarios a,b] [--concurrency N] [--baseline FILE] [--write-baseline FILE] [--fail-on-worse]");
    return 2;
  }
  const reps = Number(flag(args, "reps") ?? 2);
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer");
  const wanted = flag(args, "scenarios")?.split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = wanted ? DEMO_SCENARIOS.filter((s) => wanted.includes(s.id)) : DEMO_SCENARIOS;
  if (wanted && scenarios.length !== wanted.length) throw new Error(`unknown scenario in --scenarios; known: ${DEMO_SCENARIOS.map((s) => s.id).join(", ")}`);
  const promptHash = demoPromptHash(PROMPT_FILES.map((f) => readFileSync(join(app, f), "utf8")));
  const estimate = await estimateDemoRun(scenarios, reps, promptHash);
  if (command === "estimate") {
    console.log(formatEstimate(estimate).replace("To approve this exact plan:", "To approve this exact plan, or set VOICE_EVAL_DEMO_BUDGET_USD to at least the cap:"));
    return 0;
  }
  const dryRun = args.includes("--dry-run");
  let client;
  try {
    client = dryRun ? createDemoMockClient() : await createLiveClient(estimate, approveDemoSpend);
  } catch (error) {
    if (error instanceof DemoSpendNotApproved) {
      console.error(error.message);
      return 3;
    }
    throw error;
  }
  const report = await runDemoEval({ client, scenarios, reps, promptHash, concurrency: Number(flag(args, "concurrency") ?? 4), log: (l) => console.log(l) });
  const out = resolve(flag(args, "out") ?? join(outDirSetting() ?? join(app, ".voice-eval"), "demo", `${report.at.replace(/[:.]/g, "-")}${dryRun ? "-dry" : ""}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  let markdown = reportMarkdown(report);
  let worse = false;
  const baseline = flag(args, "baseline");
  if (baseline) {
    const before = JSON.parse(readFileSync(resolve(baseline), "utf8")) as DemoReport;
    const compared = compareDemoReports(before, report);
    worse = compared.verdict === "worse";
    markdown = [`## Before and after`, "", `Before: prompt ${before.promptHash} (${before.mode}, ${before.agentModel}, ${before.at}). After: prompt ${report.promptHash}.`, "", ...compared.lines, "", markdown].join("\n");
  }
  writeFileSync(join(out, "report.md"), markdown);
  const keep = flag(args, "write-baseline");
  if (keep) writeFileSync(resolve(keep), `${JSON.stringify(stripped(report), null, 2)}\n`);
  console.log(`\n${markdown}\n\nWritten to ${out}`);
  return worse && args.includes("--fail-on-worse") ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
