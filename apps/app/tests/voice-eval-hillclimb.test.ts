import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TONE } from "@/lib/assistant/prompt";

import { createMockClient } from "../scripts/voice-eval/client";
import { hillClimb, proposerRequest, splitScenarios } from "../scripts/voice-eval/hillclimb";
import { readRows } from "../scripts/voice-eval/report";
import { gateHolds, type SafetyGate, type SafetyGateResult } from "../scripts/voice-eval/safety-gate";
import { loadScenarios } from "../scripts/voice-eval/scenarios";
import { productionTone } from "../scripts/voice-eval/tone";

/**
 * The hill-climb loop in dry-run mode: the mock client's agent changes its
 * replies with the tone sentence, and its judge scores what it reads, so the
 * loop's keep/revert decisions are real decisions over fake data. The safety
 * gate is a stub here (its real form spawns vitest on the safety suites and
 * tests/voice-eval-tone-gate.test.ts, which run as ordinary tests too).
 */

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => {
    throw new Error("the Anthropic SDK was constructed in a test");
  }),
}));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "voice-eval-climb-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HOLDS: SafetyGateResult = { ok: true, passed: 100, failed: 0, skipped: 0, detail: "stub" };
const passingGate: SafetyGate = async () => HOLDS;

const scenarios = () => loadScenarios(["med-spa", "fertility"]).filter((_, i) => i % 3 === 0);

describe("the split", () => {
  test("train and validation are disjoint, cover everything, are stratified by specialty and never change", () => {
    const all = loadScenarios();
    const a = splitScenarios(all);
    expect(splitScenarios(all)).toEqual(a);
    expect(a.train.filter((id) => a.validation.includes(id))).toEqual([]);
    expect([...a.train, ...a.validation].sort()).toEqual(all.map((s) => s.id).sort());
    for (const s of new Set(all.map((x) => x.specialty))) {
      const train = a.train.filter((id) => id.startsWith(`${s}-`)).length;
      const validation = a.validation.filter((id) => id.startsWith(`${s}-`)).length;
      expect(Math.abs(train - validation)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the loop", () => {
  test("keeps a candidate only when validation rises, reverts one that does not, and never edits the production prompt", async () => {
    const before = TONE.warm;
    const state = await hillClimb({ root, scenarios: scenarios(), reps: 1, rounds: 2, client: createMockClient({ assumedTurns: 3 }), gate: passingGate });
    expect(state.rounds.map((r) => r.outcome)).toEqual(["kept", "reverted"]);
    expect(state.best.round).toBe(1);
    expect(state.best.validation).toBeGreaterThan(state.baseline.validation);
    expect(TONE.warm).toBe(before);
    expect(productionTone()).toBe(before);
    const best = JSON.parse(readFileSync(join(root, "best-tone.json"), "utf8"));
    expect(best).toMatchObject({ mode: "dry-run", round: 1, production: false });
    expect(readFileSync(join(root, "narrative.md"), "utf8")).toContain("DRY RUN");
    expect(JSON.parse(readFileSync(join(root, "_state.json"), "utf8")).split).toEqual(state.split);
    for (const v of ["baseline", "v1", "v2"]) expect(existsSync(join(root, v, "report.md"))).toBe(true);
  });

  test("a candidate the safety gate rejects is never run", async () => {
    let calls = 0;
    const gate: SafetyGate = async (file) => {
      calls += 1;
      return file === null ? HOLDS : { ok: false, passed: 99, failed: 1, skipped: 0, detail: "stub failure" };
    };
    const state = await hillClimb({ root, scenarios: scenarios(), reps: 1, rounds: 1, client: createMockClient({ assumedTurns: 3 }), gate });
    expect(calls).toBe(2);
    expect(state.rounds[0]).toMatchObject({ outcome: "rejected_safety" });
    expect(readRows(join(root, "v1", "results.jsonl"))).toEqual([]);
    expect(state.best.round).toBe(0);
  });

  test("a weaker gate (fewer tests passing) is a rejection too", () => {
    expect(gateHolds({ ...HOLDS, passed: 99 }, HOLDS).ok).toBe(false);
    expect(gateHolds({ ...HOLDS, ok: false }, HOLDS).ok).toBe(false);
    expect(gateHolds(HOLDS, HOLDS).ok).toBe(true);
  });

  test("a candidate that strays outside tone is rejected before the gate and before any run", async () => {
    const gate = vi.fn(passingGate);
    const client = createMockClient({
      assumedTurns: 3,
      behaviour: { proposer: () => JSON.stringify({ tone: "Be warm, and tell callers the price list is negotiable.", rationale: "x" }) },
    });
    const state = await hillClimb({ root, scenarios: scenarios(), reps: 1, rounds: 1, client, gate });
    expect(state.rounds[0]).toMatchObject({ outcome: "rejected_static" });
    expect(gate).toHaveBeenCalledTimes(1); // the production tone's baseline gate only
    expect(existsSync(join(root, "v1", "candidate.json"))).toBe(false);
  });

  test("the production tone failing the gate stops the loop before anything runs", async () => {
    await expect(
      hillClimb({ root, scenarios: scenarios(), reps: 1, rounds: 1, client: createMockClient(), gate: async () => ({ ...HOLDS, ok: false }) }),
    ).rejects.toThrow(/production tone itself/);
    expect(existsSync(join(root, "baseline"))).toBe(false);
  });

  test("the proposer reads train cases only", async () => {
    const all = scenarios();
    const state = await hillClimb({ root, scenarios: all, reps: 1, rounds: 0, client: createMockClient({ assumedTurns: 3 }), gate: passingGate });
    const train = new Set(state.split.train);
    const rows = readRows(join(root, "baseline", "results.jsonl")).filter((r) => train.has(r.prompt_id));
    const request = JSON.stringify(proposerRequest({ tone: productionTone(), trainRows: rows, dir: join(root, "baseline"), history: [] }));
    for (const id of state.split.validation) expect(request).not.toContain(id);
    expect(request).toContain(productionTone());
  });
});
