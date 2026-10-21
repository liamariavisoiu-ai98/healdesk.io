import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deterministic safety gate the hill-climb runs on every tone candidate,
 * kept apart from the eval itself: the judge scores tone, and nothing it
 * says can keep a candidate that this gate rejects.
 *
 * It runs, with vitest and no model:
 *   - tests/safety-suite.test.ts, the shared pipeline's safety suite;
 *   - tests/safety-suite-voice.test.ts, the voice channel end to end (it
 *     skips without a test database, TEST_APP_URL; with one, it runs);
 *   - tests/voice-eval-tone-gate.test.ts, which reads the candidate
 *     (VOICE_EVAL_TONE_FILE) and holds that it leaves every guardrail line
 *     of the prompt byte for byte, passes the off-limits screen, and that the
 *     urgent screen, the guard and the injection cases answer exactly as they
 *     do under the production tone.
 *
 * A candidate passes only when nothing fails and at least as many tests pass
 * as passed for the production tone at the start of the loop (a test that
 * quietly stopped running is a weaker suite).
 */

export const SAFETY_GATE_FILES = ["tests/safety-suite.test.ts", "tests/safety-suite-voice.test.ts", "tests/voice-eval-tone-gate.test.ts"] as const;

export type SafetyGateResult = { ok: boolean; passed: number; failed: number; skipped: number; detail: string };

export type SafetyGate = (toneFile: string | null) => Promise<SafetyGateResult>;

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const vitestSafetyGate: SafetyGate = async (toneFile) => {
  const out = mkdtempSync(join(tmpdir(), "voice-eval-gate-"));
  const report = join(out, "report.json");
  try {
    const run = spawnSync(
      "npx",
      ["vitest", "run", ...SAFETY_GATE_FILES, "--reporter=json", `--outputFile=${report}`, "--testTimeout=120000", "--hookTimeout=240000"],
      { cwd: APP_DIR, env: { ...process.env, ...(toneFile ? { VOICE_EVAL_TONE_FILE: toneFile } : {}) }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    let parsed: { numPassedTests?: number; numFailedTests?: number; numPendingTests?: number; numTodoTests?: number; success?: boolean };
    try {
      parsed = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      return { ok: false, passed: 0, failed: 0, skipped: 0, detail: `vitest wrote no report (exit ${run.status}): ${(run.stderr ?? "").slice(-500)}` };
    }
    const passed = parsed.numPassedTests ?? 0;
    const failed = parsed.numFailedTests ?? 0;
    const skipped = (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0);
    return { ok: failed === 0 && run.status === 0, passed, failed, skipped, detail: `vitest exit ${run.status}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

/** Whether a candidate's gate result holds against the production tone's. */
export function gateHolds(candidate: SafetyGateResult, baseline: SafetyGateResult): { ok: boolean; reason: string } {
  if (!candidate.ok || candidate.failed > 0) return { ok: false, reason: `safety gate failed: ${candidate.failed} failing (${candidate.detail})` };
  if (candidate.passed < baseline.passed) return { ok: false, reason: `safety gate weaker: ${candidate.passed} passed, production tone ${baseline.passed}` };
  return { ok: true, reason: `safety gate held: ${candidate.passed} passed, ${candidate.skipped} skipped` };
}
