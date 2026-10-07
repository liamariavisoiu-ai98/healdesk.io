import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

/**
 * CI's "Assert the security tests actually ran" step (.github/workflows/
 * ci.yml), run as CI runs it, against reports shaped like vitest's JSON
 * reporter's.
 *
 * Every database-backed suite skips itself when the test database is not
 * configured (`describeDb`), and a skipped suite reports green, so this step
 * is all that stands between a job that lost its database and a green build
 * that ran none of the tenancy, RLS and billing suites. Counting passes no
 * longer catches that: the suites that need no database clear any sensible
 * floor on their own (1,297 passed beside 779 skipped in the review of
 * 7 October 2026). So the step fails on any skipped or todo test, and this
 * file holds it to that by running the step's own script.
 */

const WORKFLOW = join(process.cwd(), "..", "..", ".github", "workflows", "ci.yml");
const STEP = "- name: Assert the security tests actually ran";

/** The step's `node -e '…'` script, exactly as the workflow holds it. */
function guardScript(): string {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const at = workflow.indexOf(STEP);
  const script = at < 0 ? null : /node -e '([^']*)'/.exec(workflow.slice(at));
  if (!script) throw new Error("ci.yml has no guard step with a node -e script");
  return script[1]!;
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the guard in a directory holding `report` as test-results.json, as CI's checkout does. */
function runGuard(report: Record<string, unknown>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "healdesk-ci-guard-"));
  dirs.push(dir);
  writeFileSync(join(dir, "test-results.json"), JSON.stringify({ testResults: [], ...report }));
  const run = spawnSync(process.execPath, ["-e", guardScript()], { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("CI's guard that the database-backed suites ran", () => {
  test("a full run with nothing skipped passes", () => {
    const run = runGuard({
      numTotalTests: 2_076,
      numPassedTests: 2_076,
      numPendingTests: 0,
      numTodoTests: 0,
    });
    expect(run.status, run.output).toBe(0);
  });

  test("a run whose database suites skipped fails, however many other tests passed", () => {
    // The shape of apps/app without TEST_APP_URL (review-nodb.json, 7 October 2026).
    const run = runGuard({
      numTotalTests: 2_076,
      numPassedTests: 1_297,
      numPendingTests: 779,
      numTodoTests: 0,
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain("pending: 779");
  });

  test("a todo test fails it too: it ran nothing", () => {
    const run = runGuard({
      numTotalTests: 2_080,
      numPassedTests: 2_076,
      numPendingTests: 0,
      numTodoTests: 4,
    });
    expect(run.status).toBe(1);
  });

  test("a run with too few tests at all still fails it", () => {
    const run = runGuard({
      numTotalTests: 150,
      numPassedTests: 150,
      numPendingTests: 0,
      numTodoTests: 0,
    });
    expect(run.status).toBe(1);
  });
});
