import { describe, expect, test, vi } from "vitest";

// No database, and none may be asked for: a demo call keeps nothing.
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    throw new Error("a demo call must never reach the database");
  },
}));
vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));

import { DEMO_ROLEPLAY_EXIT } from "@/lib/voice/demo-facts";

import type { DemoCallTrace } from "../scripts/voice-eval/demo/call";
import { approveDemoSpend, compareDemoReports, createDemoMockClient, DemoSpendNotApproved, estimateDemoRun, runDemoEval, type DemoReport } from "../scripts/voice-eval/demo/run";
import { DEMO_SCENARIOS } from "../scripts/voice-eval/demo/scenarios";
import { checkScore, demoChecks, parseDemoJudgement } from "../scripts/voice-eval/demo/score";

/**
 * The demo eval (scripts/voice-eval/demo; owner, 31 October 2026: "a small
 * set of real-model test calls scored on every change"). Its live runs need
 * the eval's own key and spend; these tests run its plumbing on the dry
 * run's fake model, through the real demo session, and pin the checks, the
 * comparison and the spend gate, so a change to the demo cannot quietly
 * break the thing that measures it.
 */

const scenario = (id: string) => DEMO_SCENARIOS.find((s) => s.id === id)!;

describe("the demo eval", () => {
  test("a dry run walks real demo calls end to end, the role-play and its exit included, and touches nothing", async () => {
    const client = createDemoMockClient();
    const report = await runDemoEval({ client, scenarios: [scenario("roleplay-first"), scenario("eager-buyer")], reps: 1, promptHash: "p-test", concurrency: 1 });
    expect(report.mode).toBe("dry-run");
    expect(report.errors).toBe(0);
    const rp = report.cases.find((c) => c.scenario === "roleplay-first")!;
    expect(rp.checks.roleplayRan).toBe(true);
    expect(rp.checks.roleplayExited).toBe(true);
    expect(rp.trace.turns.some((t) => t.text.includes(DEMO_ROLEPLAY_EXIT))).toBe(true);
    // The buyer's first words were a buying signal: the call moved on to the value points at once.
    const buyer = report.cases.find((c) => c.scenario === "eager-buyer")!;
    expect(buyer.trace.progress[0]).toMatchObject({ stage: "pitch", buying: true });
    expect(buyer.checks.repeated).toBe(0);
    // Every request the agent made is production's, on the call's model.
    expect(client.ledger.filter((e) => e.role === "agent").every((e) => e.model === report.agentModel)).toBe(true);
    expect(report.score).toBeGreaterThan(0);
  });

  test("the checks read what the call did: identity, re-asks, availability, buying signals and the close", () => {
    const trace: DemoCallTrace = {
      scenario: "eager-buyer",
      ending: "caller_hung_up",
      modelAnswers: [{ stage: "intro", text: "Hi\n###\n{}", hasState: false }],
      progress: [
        { stage: "pitch", asked: "volume", answers: ["identity"], buying: true },
        { stage: "pitch", asked: null, answers: ["identity", "volume"], buying: true },
        // Asked again after it was answered.
        { stage: "pitch", asked: "volume", answers: ["identity", "volume"], buying: true },
      ],
      turns: [
        { speaker: "assistant", text: "Hi! This is Aya.", source: "opening" },
        { speaker: "caller", text: "What does it cost?" },
        { speaker: "assistant", text: "I'm just the front desk here. How many calls do you get a day?", source: "model", stageBefore: "intro", stageAfter: "pitch" },
        { speaker: "caller", text: "Ten." },
        { speaker: "assistant", text: "Sorry, I lost my train of thought there.", source: "fixed", stageBefore: "pitch", stageAfter: "pitch" },
        { speaker: "caller", text: "Let's role-play." },
        { speaker: "assistant", text: "Friday at three is available!", source: "model", stageBefore: "roleplay", stageAfter: "roleplay" },
      ],
    };
    const checks = demoChecks(trace);
    expect(checks).toMatchObject({ identityLeaks: 1, reAsked: 1, replaced: 1, stateMissing: 1, availabilityClaims: 1, questionsAfterBuying: 1, closeReached: false, roleplayExited: false });
    const graded = checkScore(checks, scenario("eager-buyer"));
    expect(graded.score).toBeLessThan(40);
    expect(graded.misses).toContain("never reached the close x1");
  });

  test("before and after: a drop past the noise, or a new identity leak, is worse; a small move is the same", () => {
    const report = (scores: number[], leaks = 0): DemoReport =>
      ({
        version: "v",
        mode: "live",
        agentModel: "claude-haiku-5-5",
        promptHash: "p",
        at: "2026-10-31T00:00:00.000Z",
        reps: 2,
        score: scores.reduce((a, b) => a + b, 0) / scores.length,
        checkScore: 0,
        judgeScore: null,
        skills: {},
        byScenario: { a: { score: 0, checkScore: 0, judgeScore: null, misses: [], worst: [] } },
        totals: { identityLeaks: leaks, reAsked: 0, replaced: 0, questionsAfterBuying: 0, availabilityClaims: 0, closeRate: 100, wordsPerReply: 12 },
        errors: 0,
        usd: 0,
        cases: scores.map((score, i) => ({ scenario: "a", rep: i + 1, score }) as DemoReport["cases"][number]),
      }) as DemoReport;
    expect(compareDemoReports(report([80, 82, 81, 79]), report([81, 80, 82, 80])).verdict).toBe("same");
    expect(compareDemoReports(report([80, 82, 81, 79]), report([60, 62, 61, 63])).verdict).toBe("worse");
    expect(compareDemoReports(report([60, 62, 61, 63]), report([80, 82, 81, 79])).verdict).toBe("better");
    expect(compareDemoReports(report([80, 82]), report([81, 80], 1)).verdict).toBe("worse");
  });

  test("a paid run needs the eval's own key and an approval: the estimate's id, or a standing budget its cap fits", async () => {
    const estimate = await estimateDemoRun([scenario("eager-buyer")], 1, "p-test");
    expect((await estimateDemoRun([scenario("eager-buyer")], 1, "p-test")).id).toBe(estimate.id);
    expect(() => approveDemoSpend(estimate, {})).toThrow(DemoSpendNotApproved);
    // Never the patient-data organisation's key.
    expect(() => approveDemoSpend(estimate, { ANTHROPIC_API_KEY: "sk-org" })).toThrow(/VOICE_EVAL_ANTHROPIC_API_KEY/);
    expect(() => approveDemoSpend(estimate, { VOICE_EVAL_ANTHROPIC_API_KEY: "k" })).toThrow(/VOICE_EVAL_CONFIRM_SPEND/);
    expect(approveDemoSpend(estimate, { VOICE_EVAL_ANTHROPIC_API_KEY: "k", VOICE_EVAL_CONFIRM_SPEND: estimate.id })).toBe("k");
    expect(approveDemoSpend(estimate, { VOICE_EVAL_ANTHROPIC_API_KEY: "k", VOICE_EVAL_DEMO_BUDGET_USD: String(estimate.capUsd + 1) })).toBe("k");
    expect(() => approveDemoSpend(estimate, { VOICE_EVAL_ANTHROPIC_API_KEY: "k", VOICE_EVAL_DEMO_BUDGET_USD: String(estimate.capUsd / 2) })).toThrow(/over VOICE_EVAL_DEMO_BUDGET_USD/);
  });

  test("the judge's grades are read strictly: every skill, 0 to 3, nothing for a skill that does not apply", () => {
    const skill = (applicable: boolean, score: number) => ({ applicable, score, evidence: "x" });
    const parsed = parseDemoJudgement(
      JSON.stringify({ skills: { salesperson: skill(true, 5), receptionist: skill(false, 2), human: skill(true, 2), memory: skill(true, 3), recovery: skill(false, 0), honesty: skill(true, 3) }, worst_moment: "w", summary: "s" }),
    );
    expect(parsed.skills.salesperson.score).toBe(3);
    expect(parsed.skills.receptionist.score).toBe(0);
    expect(() => parseDemoJudgement(JSON.stringify({ skills: { salesperson: skill(true, 1) }, worst_moment: "", summary: "" }))).toThrow(/lacks/);
  });
});
