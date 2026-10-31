import { createHash } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { DEMO_CALLBACK_OFFER } from "@healdesk/catalog";

import { assistantModel } from "../../../src/lib/assistant/responder";
import { SPOKEN_END } from "../../../src/lib/assistant/prompt";

import { DEFAULT_MOCK, createMockClient, SpendCapExceeded, type EvalClient, type MockBehaviour } from "../client";
import { buildEstimate, ledgerCost, PRICE_TABLE_VERSION, spendCapFor, type Estimate } from "../cost";

import { runDemoCall, type DemoCallTrace } from "./call";
import { DEMO_EVAL_VERSION, DEMO_SCENARIOS, type DemoScenario } from "./scenarios";
import { checkScore, demoChecks, judgeDemoCall, judgeScore, DEMO_SKILL_IDS, type DemoChecks, type DemoJudgement, type DemoSkill } from "./score";

/**
 * The demo eval's run: every scenario, `reps` times, each a real demo call
 * then the judge, and the report the CI job prints and compares (owner,
 * 31 October 2026: "Nothing compares quality before and after a change").
 */

export type DemoCaseResult = {
  scenario: string;
  rep: number;
  checks: DemoChecks;
  misses: string[];
  checkScore: number;
  judge: DemoJudgement | null;
  judgeScore: number | null;
  /** The call's score: the mean of the check score and the judge's, or the check score alone without a judge. */
  score: number;
  ending: DemoCallTrace["ending"];
  error?: string;
  trace: DemoCallTrace;
};

export type DemoReport = {
  version: string;
  mode: "dry-run" | "live";
  agentModel: string;
  /** What the prompt and notes were when this ran: the sha of the demo's source, so two reports say whether they measured the same code. */
  promptHash: string;
  at: string;
  reps: number;
  score: number;
  checkScore: number;
  judgeScore: number | null;
  /** Per skill, the mean grade (0 to 3) over the calls it applied to. */
  skills: Partial<Record<DemoSkill, number>>;
  byScenario: Record<string, { score: number; checkScore: number; judgeScore: number | null; misses: string[]; worst: string[] }>;
  totals: { identityLeaks: number; reAsked: number; replaced: number; questionsAfterBuying: number; availabilityClaims: number; closeRate: number; wordsPerReply: number };
  errors: number;
  usd: number;
  cases: DemoCaseResult[];
};

const mean = (xs: readonly number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export async function runDemoEval(options: {
  client: EvalClient;
  scenarios?: readonly DemoScenario[];
  reps?: number;
  concurrency?: number;
  promptHash: string;
  log?: (line: string) => void;
}): Promise<DemoReport> {
  const scenarios = options.scenarios ?? DEMO_SCENARIOS;
  const reps = options.reps ?? 1;
  const jobs = scenarios.flatMap((scenario) => Array.from({ length: reps }, (_, i) => ({ scenario, rep: i + 1 })));
  const results: DemoCaseResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { scenario, rep } = jobs[next++]!;
      const id = `${scenario.id}_rep${rep}`;
      const trace = await runDemoCall({ scenario, client: options.client, conversationId: id });
      const checks = demoChecks(trace);
      const graded = checkScore(checks, scenario);
      let judge: DemoJudgement | null = null;
      let error = trace.error;
      if (!trace.error) {
        try {
          judge = await judgeDemoCall(options.client, scenario, trace, id);
        } catch (e) {
          if (e instanceof SpendCapExceeded) throw e;
          error = `judge: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const js = judge ? judgeScore(judge) : null;
      const score = js === null ? graded.score : Math.round(((graded.score + js) / 2) * 10) / 10;
      results.push({ scenario: scenario.id, rep, checks, misses: graded.misses, checkScore: graded.score, judge, judgeScore: js, score, ending: trace.ending, ...(error ? { error } : {}), trace });
      options.log?.(`${id}: ${score} (checks ${graded.score}${js === null ? "" : `, judge ${js}`})${graded.misses.length ? ` misses: ${graded.misses.join("; ")}` : ""}${error ? ` ERROR ${error}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, jobs.length)) }, worker));
  results.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.rep - b.rep);
  const scored = results.filter((r) => !r.error);
  const byScenario: DemoReport["byScenario"] = {};
  for (const s of scenarios) {
    const rs = scored.filter((r) => r.scenario === s.id);
    const js = rs.map((r) => r.judgeScore).filter((x): x is number => x !== null);
    byScenario[s.id] = {
      score: mean(rs.map((r) => r.score)),
      checkScore: mean(rs.map((r) => r.checkScore)),
      judgeScore: js.length ? mean(js) : null,
      misses: [...new Set(rs.flatMap((r) => r.misses))],
      worst: rs.map((r) => r.judge?.worst_moment ?? "").filter(Boolean),
    };
  }
  const skills: DemoReport["skills"] = {};
  for (const id of DEMO_SKILL_IDS) {
    const grades = scored.map((r) => r.judge?.skills[id]).filter((g) => g?.applicable).map((g) => g!.score);
    if (grades.length) skills[id] = Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 100) / 100;
  }
  const js = scored.map((r) => r.judgeScore).filter((x): x is number => x !== null);
  const closeExpected = scored.filter((r) => scenarios.find((s) => s.id === r.scenario)?.expect.close);
  return {
    version: DEMO_EVAL_VERSION,
    mode: options.client.mode,
    agentModel: assistantModel("voice"),
    promptHash: options.promptHash,
    at: new Date().toISOString(),
    reps,
    score: mean(scored.map((r) => r.score)),
    checkScore: mean(scored.map((r) => r.checkScore)),
    judgeScore: js.length ? mean(js) : null,
    skills,
    byScenario,
    totals: {
      identityLeaks: scored.reduce((n, r) => n + r.checks.identityLeaks, 0),
      reAsked: scored.reduce((n, r) => n + r.checks.reAsked, 0),
      replaced: scored.reduce((n, r) => n + r.checks.replaced, 0),
      questionsAfterBuying: scored.reduce((n, r) => n + r.checks.questionsAfterBuying, 0),
      availabilityClaims: scored.reduce((n, r) => n + r.checks.availabilityClaims, 0),
      closeRate: closeExpected.length ? Math.round((closeExpected.filter((r) => r.checks.closeReached).length / closeExpected.length) * 100) : 0,
      wordsPerReply: mean(scored.map((r) => r.checks.wordsPerReply)),
    },
    errors: results.length - scored.length,
    usd: Math.round(ledgerCost(options.client.ledger) * 100) / 100,
    cases: results,
  };
}

/**
 * Before against after. A real model is not deterministic, so a difference
 * counts only past the noise: three points, or twice the standard error of
 * the difference of the two means, whichever is larger. A drop past it, or
 * any new identity leak or availability claim, is a regression.
 */
export function compareDemoReports(before: DemoReport, after: DemoReport): { verdict: "better" | "same" | "worse"; delta: number; noise: number; lines: string[] } {
  const scores = (r: DemoReport) => r.cases.filter((c) => !c.error).map((c) => c.score);
  const se = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
  };
  const noise = Math.max(3, Math.round(2 * Math.sqrt(se(scores(before)) ** 2 + se(scores(after)) ** 2) * 10) / 10);
  const delta = Math.round((after.score - before.score) * 10) / 10;
  const hardWorse = after.totals.identityLeaks > before.totals.identityLeaks || after.totals.availabilityClaims > before.totals.availabilityClaims;
  const verdict = delta < -noise || hardWorse ? "worse" : delta > noise ? "better" : "same";
  const row = (name: string, b: number | null, a: number | null) => `| ${name} | ${b ?? "-"} | ${a ?? "-"} | ${a !== null && b !== null ? (Math.round((a - b) * 10) / 10 > 0 ? "+" : "") + Math.round((a - b) * 10) / 10 : "-"} |`;
  const lines = [
    `**${verdict.toUpperCase()}**: score ${before.score} to ${after.score} (${delta > 0 ? "+" : ""}${delta}; noise ${noise})${hardWorse ? "; a new identity leak or availability claim" : ""}.`,
    "",
    "| | before | after | change |",
    "|---|---|---|---|",
    row("Score", before.score, after.score),
    row("Checks", before.checkScore, after.checkScore),
    row("Judge", before.judgeScore, after.judgeScore),
    ...DEMO_SKILL_IDS.map((id) => row(`  ${id} (0-3)`, before.skills[id] ?? null, after.skills[id] ?? null)),
    row("Close reached (%)", before.totals.closeRate, after.totals.closeRate),
    row("Front-desk identity outside role-play", before.totals.identityLeaks, after.totals.identityLeaks),
    row("Asked again what was answered", before.totals.reAsked, after.totals.reAsked),
    row("Questions after a buying signal", before.totals.questionsAfterBuying, after.totals.questionsAfterBuying),
    row("Stock lines in place of hers", before.totals.replaced, after.totals.replaced),
    row("Time called available in role-play", before.totals.availabilityClaims, after.totals.availabilityClaims),
    row("Words per reply", before.totals.wordsPerReply, after.totals.wordsPerReply),
    "",
    "| scenario | before | after |",
    "|---|---|---|",
    ...Object.keys(after.byScenario).map((id) => `| ${id} | ${before.byScenario[id]?.score ?? "-"} | ${after.byScenario[id]!.score} |`),
  ];
  return { verdict, delta, noise, lines };
}

export function reportMarkdown(r: DemoReport): string {
  const lines = [
    `# Demo eval (${r.mode}${r.mode === "dry-run" ? ": scripted fake model, these scores test the plumbing, not Aya" : `, ${r.agentModel}`})`,
    "",
    `Score **${r.score}** (checks ${r.checkScore}, judge ${r.judgeScore ?? "-"}), ${r.cases.length} calls (${r.reps} per scenario), ${r.errors} errors, $${r.usd.toFixed(2)}. Prompt ${r.promptHash}, eval ${r.version}.`,
    "",
    "| scenario | score | checks | judge | misses |",
    "|---|---|---|---|---|",
    ...Object.entries(r.byScenario).map(([id, s]) => `| ${id} | ${s.score} | ${s.checkScore} | ${s.judgeScore ?? "-"} | ${s.misses.join("; ") || "-"} |`),
    "",
    "Worst moments (judge):",
    ...Object.entries(r.byScenario).flatMap(([id, s]) => s.worst.map((w) => `- ${id}: ${w}`)),
  ];
  return lines.join("\n");
}

/** A hash of the code that decides what the demo model is told and what the call does with it. */
export function demoPromptHash(files: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(f);
  return `p-${h.digest("hex").slice(0, 12)}`;
}

// ----------------------------------------------------------------------------
// The dry run's fakes
// ----------------------------------------------------------------------------

function lastText(params: Anthropic.MessageCreateParamsNonStreaming, role: "user" | "system"): string {
  const m = [...params.messages].reverse().find((x) => (x.role as string) === role);
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(" ");
}

function answer(words: string, state: Record<string, unknown> | null, end = false): string {
  return `[warm] ${words}\n${SPOKEN_END}\n${JSON.stringify({ end, ...(state ? { state } : {}) })}`;
}

const BEAT_WORDS: Record<string, string> = {
  pain: "So those after-hours calls are the ones I'd pick up.",
  reveal: "And it's not just the phone: the same me covers your website chat, Instagram, Messenger and WhatsApp.",
  number: "And you keep your own number: your calls just forward to me.",
  finish: "Finishing takes about fifteen minutes of your time.",
  anchor: "For context, a receptionist runs $3,900 to $4,800 a month.",
  value: "Every one of those calls that books is, say, a HydraFacial at $199.",
  recommend: "Based on what you've told me, Aya Voice looks like the fit.",
  noStrings: "You've already tried it, no strings attached.",
  refund: "If it's not a fit once you're live, cancel within your first 14 days and your first subscription period is refunded in full.",
};

/**
 * A fake demo model for the dry run: it reads the turn's note and answers
 * the step it names, in the demo's format, so a dry run walks the intro, a
 * role-play, discovery, the value points and the close through the real
 * session. It tests the plumbing, never Aya.
 */
export const DEMO_MOCK: Pick<MockBehaviour, "agent" | "judge"> = {
  agent(params) {
    const note = lastText(params, "system");
    const said = lastText(params, "user").toLowerCase();
    if (note.startsWith("Role-play:") || note.includes("\nRole-play:")) {
      if (/\bbye\b|thanks/.test(said) || note.includes("The role-play is over now")) return answer("Perfect, the team will confirm that time. Take care!", { roleplay: "end" });
      return answer("Lovely, what day and time suit you?", { booking: {} });
    }
    if (/\bbye\b/.test(said)) return answer("Thanks for your time, have a great day!", { asked: null, beats: [] }, true);
    if (/not (?:really )?interested/.test(said) && note.includes(DEMO_CALLBACK_OFFER.text)) return answer(DEMO_CALLBACK_OFFER.text, { asked: "callback", beats: [] });
    if (/role-?play/.test(said) && !note.includes("They showed a buying signal")) return answer("Let's do it, you be the patient.", { asked: null, beats: [], roleplay: "start" });
    if (note.includes("Next: greet them")) return answer("Great to meet you! What's your role at Lumen?", { asked: "role", beats: [] });
    if (note.includes("or jump straight into a quick role-play")) return answer("Would you like to hear what I can do for Lumen, or jump straight into a quick role-play where you call in as a patient?", { asked: "choice", beats: [] });
    const beat = /if none fits better, "([a-zA-Z]+)"/.exec(note)?.[1];
    if (beat) return answer(BEAT_WORDS[beat] ?? "Here's the thing.", { asked: null, beats: [beat], buying: /how much|price|cost|start|sign/.test(said) });
    if (note.includes("Next, the tie-down")) return answer("Anything that'd stop you from getting that running today?", { asked: "tiedown", beats: [] });
    if (note.includes("then ask for it plainly")) return answer("Want to get Lumen set up?", { asked: "ask", beats: [] });
    if (note.includes("Next: if they said yes")) return answer("Just tap Book Onboarding at the top of your demo page.", { asked: null, beats: [] });
    if (note.includes("Generally, how many calls do you get a day?")) return answer("Generally, how many calls do you get a day?", { asked: "volume", beats: [] });
    if (note.includes("Check the total with them")) return answer("So about fifty calls a week, roughly?", { asked: "volumeCheck", beats: [] });
    if (note.includes("What happens with those calls after hours")) return answer("What happens with those calls after hours, or when your team's busy with patients?", { asked: "missed", beats: [] });
    if (note.includes("How do you see me helping you best")) return answer("How do you see me helping you best: after-hours only, when the lines are busy, or everything?", { asked: "coverage", beats: [] });
    if (note.includes("say what you do in two short sentences") || note.includes("do what they chose")) return answer("One Aya answers your phone, website chat, Instagram, Messenger and WhatsApp. Want to try me as a patient?", { asked: null, beats: [] });
    return answer("Got it. What made you want to look at an AI assistant for Lumen?", { asked: "goal", beats: [] });
  },
  judge(_params, context) {
    const turns = context.transcript ?? [];
    const own = turns.filter((t) => t.speaker === "assistant" && t.source === "model");
    const short = own.every((t) => t.text.split(/\s+/).length <= 30);
    const grade = (applicable: boolean, score: number) => ({ applicable, score: applicable ? score : 0, evidence: "dry-run judge" });
    return JSON.stringify({
      skills: Object.fromEntries(DEMO_SKILL_IDS.map((id) => [id, grade(id !== "receptionist" || turns.some((t) => t.text.includes("Ring ring")), short ? 2 : 1)])),
      worst_moment: "dry-run judge: none",
      summary: "dry-run judge",
    });
  },
};

export function createDemoMockClient(): EvalClient {
  return createMockClient({ behaviour: { agent: DEMO_MOCK.agent, judge: DEMO_MOCK.judge, caller: DEFAULT_MOCK.caller } });
}

/**
 * The approval for a paid run, for the demo eval: the same estimate id as
 * the voice eval (VOICE_EVAL_CONFIRM_SPEND), or a standing budget
 * (VOICE_EVAL_DEMO_BUDGET_USD) the estimate's cap fits inside, which is what
 * lets CI run it on every change without a new id each time the prompt
 * moves the estimate by a cent. Either way the key is the eval's own,
 * never the patient-data organisation's.
 */
export class DemoSpendNotApproved extends Error {}

export function approveDemoSpend(estimate: Estimate, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = env.VOICE_EVAL_ANTHROPIC_API_KEY?.trim();
  if (!key) throw new DemoSpendNotApproved("Refusing to spend: VOICE_EVAL_ANTHROPIC_API_KEY is not set. No API call was made.");
  if (env.VOICE_EVAL_CONFIRM_SPEND?.trim() === estimate.id) return key;
  const budget = Number(env.VOICE_EVAL_DEMO_BUDGET_USD?.trim());
  if (Number.isFinite(budget) && budget > 0) {
    if (estimate.capUsd <= budget) return key;
    throw new DemoSpendNotApproved(`Refusing to spend: this run may cost up to $${estimate.capUsd.toFixed(2)}, over VOICE_EVAL_DEMO_BUDGET_USD ($${budget.toFixed(2)}). No API call was made.`);
  }
  throw new DemoSpendNotApproved(`Refusing to spend: set VOICE_EVAL_CONFIRM_SPEND=${estimate.id}, or VOICE_EVAL_DEMO_BUDGET_USD to at least ${estimate.capUsd.toFixed(2)}. No API call was made.`);
}

/** The estimate of a demo run, from a dry run of the same plan (cost.ts prices; the real run stops itself at the cap). */
export async function estimateDemoRun(scenarios: readonly DemoScenario[], reps: number, promptHash: string): Promise<Estimate> {
  const client = createDemoMockClient();
  await runDemoEval({ client, scenarios, reps, promptHash, concurrency: 1 });
  const turns = Math.round(scenarios.reduce((n, s) => n + s.scripted.length + 1, 0) / Math.max(1, scenarios.length));
  const e = buildEstimate({ command: "run", specialties: [`demo:${scenarios.map((s) => s.id).join(",")}`], limit: scenarios.length, reps, rounds: 0, assumedTurns: turns }, client.ledger);
  // Real calls run longer than the scripted ones and the judge writes more: half again, on top of the usual cap.
  const usd = e.usd * 1.5;
  return {
    ...e,
    usd,
    usdWithoutCache: e.usdWithoutCache * 1.5,
    capUsd: spendCapFor(usd),
    assumptions: [...e.assumptions, `the dry run's scripted calls (about ${turns} caller turns each), times 1.5 for real calls running longer (${PRICE_TABLE_VERSION})`],
  };
}
