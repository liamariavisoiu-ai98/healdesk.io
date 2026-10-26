import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TurnSource } from "../../src/lib/assistant/turn";

import { costOf, type Usage } from "./cost";
import { SKILL_IDS, SKILLS, type SkillId } from "./rubric";

/**
 * Scores out of the per-case rows: overall, per skill, per specialty, per
 * caller archetype and per scenario, with a 95% interval on the overall
 * mean, plus the guard's rate (how often a reply was replaced by a fixed
 * line) as a guardrail metric beside the tone score. Written as JSON and
 * markdown into the variant's directory; each run also appends one line to
 * the output root's history.jsonl, from which trend.md is rebuilt.
 *
 * Every number here is recomputed from results.jsonl, never carried over
 * from a running total.
 */

export type ResultRow = {
  prompt_id: string;
  rep: number;
  prompt: string;
  /** [specialty, archetype, intent]. */
  tags: [string, string, string];
  split?: "train" | "validation";
  status: "ok";
  /** overall and each applicable skill, 0..1. */
  grade: Record<string, number>;
  explanation: Partial<Record<SkillId | "summary", string>>;
  model: string;
  usage: Usage;
  caller_model: string | null;
  caller_usage: Usage;
  judge_model: string;
  judge_usage: Usage;
  latency_s: number;
  assistant_turns: number;
  /** Words in the model's own replies, and how many replies (owner, 26 October 2026, 6a: replies run long). Absent on rows from before. */
  model_words?: number;
  model_turns?: number;
  sources: Partial<Record<TurnSource, number>>;
  endings: string[];
  tone_hash: string;
};

export type Interval = { mean: number; low: number; high: number; n: number };

export function interval(values: readonly number[]): Interval {
  const n = values.length;
  if (n === 0) return { mean: Number.NaN, low: Number.NaN, high: Number.NaN, n };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / n);
  return { mean, low: mean - half, high: mean + half, n };
}

function meanBy(rows: readonly ResultRow[], key: (r: ResultRow) => string): Record<string, Interval> {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (typeof r.grade.overall !== "number") continue;
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r.grade.overall]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, interval(v)]));
}

export type VariantReport = {
  variant: string;
  toneHash: string | null;
  cases: number;
  overall: Interval;
  perSkill: Record<SkillId, Interval>;
  perSpecialty: Record<string, Interval>;
  perArchetype: Record<string, Interval>;
  perScenario: Record<string, Interval>;
  perSplit: Record<string, Interval>;
  /** Share of the assistant's answers (the opening line not counted) that the guard replaced. */
  guardRate: number;
  /** Share of answers that were any fixed line rather than the model's own words. */
  fixedRate: number;
  /** Mean words per reply the model wrote itself (6a); NaN with no rows that counted them. */
  wordsPerTurn: number;
  usd: number;
};

/** Mean words per model-written reply across the rows that counted them. */
export function wordsPerTurn(rows: readonly ResultRow[]): number {
  let words = 0;
  let turns = 0;
  for (const r of rows) {
    if (typeof r.model_words !== "number" || typeof r.model_turns !== "number") continue;
    words += r.model_words;
    turns += r.model_turns;
  }
  return turns === 0 ? Number.NaN : words / turns;
}

export function rowCost(r: ResultRow): number {
  return costOf(r.model, r.usage) + (r.caller_model ? costOf(r.caller_model, r.caller_usage) : 0) + costOf(r.judge_model, r.judge_usage);
}

export function buildReport(variant: string, rows: readonly ResultRow[]): VariantReport {
  const perSkill = {} as Record<SkillId, Interval>;
  for (const id of SKILL_IDS) perSkill[id] = interval(rows.map((r) => r.grade[id]).filter((v): v is number => typeof v === "number"));
  let answers = 0;
  let guarded = 0;
  let fixed = 0;
  for (const r of rows) {
    for (const [source, count] of Object.entries(r.sources)) {
      answers += count ?? 0;
      if (source === "guard") guarded += count ?? 0;
      if (source !== "model") fixed += count ?? 0;
    }
  }
  const hashes = new Set(rows.map((r) => r.tone_hash));
  return {
    variant,
    toneHash: hashes.size === 1 ? [...hashes][0]! : null,
    cases: rows.length,
    overall: interval(rows.map((r) => r.grade.overall).filter((v): v is number => typeof v === "number")),
    perSkill,
    perSpecialty: meanBy(rows, (r) => r.tags[0]),
    perArchetype: meanBy(rows, (r) => r.tags[1]),
    perScenario: meanBy(rows, (r) => r.prompt_id),
    perSplit: meanBy(rows, (r) => r.split ?? "all"),
    guardRate: answers === 0 ? 0 : guarded / answers,
    fixedRate: answers === 0 ? 0 : fixed / answers,
    wordsPerTurn: wordsPerTurn(rows),
    usd: rows.reduce((sum, r) => sum + rowCost(r), 0),
  };
}

const pct = (v: number) => (Number.isFinite(v) ? (v * 100).toFixed(1) : "-");
const ci = (i: Interval) => (Number.isFinite(i.mean) ? `${pct(i.mean)} (${pct(i.low)}-${pct(i.high)}, n=${i.n})` : "-");

export function reportMarkdown(r: VariantReport, mode: "dry-run" | "live"): string {
  const label = (id: string) => SKILLS.find((s) => s.id === id)?.label ?? id;
  const table = (title: string, rows: Record<string, Interval>, name: (k: string) => string = (k) => k) =>
    [`## ${title}`, "", "| | score (95% CI) |", "|---|---|", ...Object.entries(rows).map(([k, v]) => `| ${name(k)} | ${ci(v)} |`), ""].join("\n");
  return [
    `# Voice eval: ${r.variant}${mode === "dry-run" ? " (DRY RUN: scripted fake replies, scores mean nothing)" : ""}`,
    "",
    `Cases: ${r.cases}. Tone: ${r.toneHash ?? "mixed"}. Overall: **${ci(r.overall)}** (0-100).`,
    `Guard replaced ${pct(r.guardRate)}% of answers; ${pct(r.fixedRate)}% of answers were fixed lines. Words per turn (the model's own replies): ${Number.isFinite(r.wordsPerTurn) ? r.wordsPerTurn.toFixed(1) : "-"}. Spend ${mode === "dry-run" ? "(estimated)" : "(measured)"}: $${r.usd.toFixed(2)}.`,
    "",
    table("Per skill", r.perSkill, label),
    table("Per specialty", r.perSpecialty),
    table("Per caller type", r.perArchetype),
    table("Per split", r.perSplit),
    table("Per scenario", r.perScenario),
  ].join("\n");
}

export function readRows(file: string): ResultRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ResultRow);
}

export function writeReport(dir: string, report: VariantReport, mode: "dry-run" | "live"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), `${JSON.stringify({ mode, ...report }, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), reportMarkdown(report, mode));
}

export type HistoryLine = {
  at: string;
  label: string;
  mode: "dry-run" | "live";
  variant: string;
  tone_hash: string | null;
  cases: number;
  overall: number;
  perSkill: Record<string, number>;
  perSpecialty: Record<string, number>;
  guardRate: number;
  usd: number;
};

/** Appends this run to history.jsonl and rewrites trend.md from the whole history. */
export function recordTrend(root: string, label: string, report: VariantReport, mode: "dry-run" | "live", at: Date = new Date()): void {
  const file = join(root, "history.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const line: HistoryLine = {
    at: at.toISOString(),
    label,
    mode,
    variant: report.variant,
    tone_hash: report.toneHash,
    cases: report.cases,
    overall: report.overall.mean,
    perSkill: Object.fromEntries(Object.entries(report.perSkill).map(([k, v]) => [k, v.mean])),
    perSpecialty: Object.fromEntries(Object.entries(report.perSpecialty).map(([k, v]) => [k, v.mean])),
    guardRate: report.guardRate,
    usd: report.usd,
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  const history = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryLine);
  const head = `| when | run | mode | variant | tone | cases | overall | ${SKILL_IDS.map((id) => SKILLS.find((s) => s.id === id)!.label).join(" | ")} | guard | $ |`;
  const rule = `|${"---|".repeat(9 + SKILL_IDS.length)}`;
  const body = history.map(
    (h) =>
      `| ${h.at.slice(0, 16)} | ${h.label} | ${h.mode} | ${h.variant} | ${h.tone_hash ?? "mixed"} | ${h.cases} | ${pct(h.overall)} | ${SKILL_IDS.map((id) => pct(h.perSkill[id] ?? Number.NaN)).join(" | ")} | ${pct(h.guardRate)} | ${h.usd.toFixed(2)} |`,
  );
  writeFileSync(join(root, "trend.md"), ["# Voice eval trend", "", "Dry-run lines use scripted replies: only live lines are scores.", "", head, rule, ...body, ""].join("\n"));
}
