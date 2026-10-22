import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The second step, "Assert the named security suites ran": the same script
 * extraction, from that step's own heading. It names the files whose absence
 * the count above cannot see.
 */
const NAMED_STEP = "- name: Assert the named security suites ran";

function namedScript(): string {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const at = workflow.indexOf(NAMED_STEP);
  const script = at < 0 ? null : /node -e '([^']*)'/.exec(workflow.slice(at));
  if (!script) throw new Error("ci.yml has no named-suites step with a node -e script");
  return script[1]!;
}

/** The names the step lists, read out of its SECURITY_SUITES array. */
function namedSuites(): string[] {
  const list = /const SECURITY_SUITES = \[([^\]]*)\]/.exec(namedScript());
  if (!list) throw new Error("the named-suites step has no SECURITY_SUITES array");
  return [...list[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** A vitest JSON report in which each of `ran` has `passed` passing tests (and one skipped). */
function reportOf(ran: string[], passed = 3): Record<string, unknown> {
  return {
    testResults: ran.map((name) => ({
      name: `/home/runner/work/healdesk.io/healdesk.io/apps/app/tests/${name}`,
      assertionResults: [
        ...Array.from({ length: passed }, () => ({ status: "passed" })),
        { status: "pending" },
      ],
    })),
  };
}

function runNamed(report: Record<string, unknown>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "healdesk-ci-named-"));
  dirs.push(dir);
  writeFileSync(join(dir, "test-results.json"), JSON.stringify(report));
  const run = spawnSync(process.execPath, ["-e", namedScript()], { cwd: dir, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("CI's guard that the named security suites ran", () => {
  test("every name the step lists is a test file that exists", () => {
    const names = namedSuites();
    // The core of the list: dropping one of these from the workflow would be
    // the same silent loss as deleting its file.
    for (const required of ["tenant-isolation.test.ts", "rls-drift.test.ts"]) {
      expect(names, `${required} must stay named in the CI step`).toContain(required);
    }
    for (const name of names) {
      const file = join(process.cwd(), "tests", name);
      expect(existsSync(file), `${name} is named in ci.yml but not in apps/app/tests`).toBe(true);
    }
  });

  test("a report holding every named suite with a passing test passes", () => {
    const run = runNamed(reportOf(namedSuites()));
    expect(run.status, run.output).toBe(0);
  });

  test("a report missing one named suite fails and names it", () => {
    for (const missing of namedSuites()) {
      const run = runNamed(reportOf(namedSuites().filter((n) => n !== missing)));
      expect(run.status, `${missing} absent`).toBe(1);
      expect(run.output).toContain(`apps/app/tests/${missing} did not run`);
    }
  });

  test("a suite that ran only skipped tests fails, however many others passed", () => {
    const names = namedSuites();
    const report = reportOf(names);
    (report.testResults as { name: string; assertionResults: { status: string }[] }[]).find((t) =>
      t.name.endsWith("/tests/rls-drift.test.ts"),
    )!.assertionResults = [{ status: "pending" }, { status: "failed" }];
    const run = runNamed(report);
    expect(run.status).toBe(1);
    expect(run.output).toContain("apps/app/tests/rls-drift.test.ts ran no passing test");
  });

  test("a report with no results at all fails", () => {
    expect(runNamed({}).status).toBe(1);
  });
});

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
