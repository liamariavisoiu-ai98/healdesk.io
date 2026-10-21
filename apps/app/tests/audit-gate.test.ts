import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

/**
 * scripts/check-npm-audit.mjs, the gate on `npm audit --omit=dev` in
 * .github/workflows/security.yml, run as CI runs it, against reports shaped
 * like npm's audit JSON (auditReportVersion 2).
 *
 * The gate exists so a high or critical advisory in what we ship fails a
 * build, and so the only way to accept one is a line in audit-exceptions.json
 * that names the advisory, says why and expires. Each way that could quietly
 * stop being true is a test here: an exception for the package instead of the
 * advisory, one that has expired, one with no reason, a report the script
 * cannot read.
 */

const ROOT = join(process.cwd(), "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-npm-audit.mjs");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function advisory(id: string, name: string, severity: string) {
  return {
    source: 1_000_000,
    name,
    dependency: name,
    title: `${name} problem`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<9.9.9",
  };
}

/** An audit report whose `name` entry carries the given advisories. */
function report(entries: Record<string, ReturnType<typeof advisory>[]>) {
  const vulnerabilities: Record<string, unknown> = {};
  let high = 0;
  let critical = 0;
  for (const [name, list] of Object.entries(entries)) {
    vulnerabilities[name] = { name, severity: "high", isDirect: false, via: list, effects: [], range: "*", nodes: [], fixAvailable: true };
    for (const a of list) {
      if (a.severity === "high") high += 1;
      if (a.severity === "critical") critical += 1;
    }
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical, total: high + critical } },
  };
}

function run(audit: unknown, exceptions: unknown, today = "2026-10-21") {
  const dir = mkdtempSync(join(tmpdir(), "healdesk-audit-gate-"));
  dirs.push(dir);
  writeFileSync(join(dir, "audit.json"), typeof audit === "string" ? audit : JSON.stringify(audit));
  writeFileSync(join(dir, "exceptions.json"), JSON.stringify(exceptions));
  const out = spawnSync(process.execPath, [SCRIPT, join(dir, "audit.json"), join(dir, "exceptions.json")], {
    encoding: "utf8",
    env: { ...process.env, TODAY: today },
  });
  return { status: out.status, output: `${out.stdout}${out.stderr}` };
}

const A = "GHSA-aaaa-bbbb-cccc";
const B = "GHSA-dddd-eeee-ffff";
const REASON = "Only reachable by a Windows host, and the production image is Linux.";

describe("the production audit gate", () => {
  test("no high or critical advisory passes", () => {
    const run0 = run(report({}), { exceptions: [] });
    expect(run0.status, run0.output).toBe(0);
  });

  test("a moderate advisory is not gated", () => {
    const run0 = run(report({ left: [advisory(A, "left", "moderate")] }), { exceptions: [] });
    expect(run0.status, run0.output).toBe(0);
  });

  test("an unexcepted high advisory fails and is named", () => {
    const result = run(report({ axios: [advisory(A, "axios", "high")] }), { exceptions: [] });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`high ${A} in axios`);
  });

  test("a critical advisory fails", () => {
    const result = run(report({ next: [advisory(A, "next", "critical")] }), { exceptions: [] });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`critical ${A} in next`);
  });

  test("an exception with a reason and a near expiry passes it", () => {
    const result = run(report({ axios: [advisory(A, "axios", "high")] }), {
      exceptions: [{ id: A, reason: REASON, expires: "2026-12-01" }],
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`excepted  ${A}`);
  });

  test("an exception covers one advisory, not the package: a second one still fails", () => {
    const result = run(
      report({ axios: [advisory(A, "axios", "high"), advisory(B, "axios", "high")] }),
      { exceptions: [{ id: A, reason: REASON, expires: "2026-12-01" }] },
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(`high ${B} in axios`);
    expect(result.output).not.toContain(`high ${A} in axios`);
  });

  test("an expired exception fails, whatever the advisory", () => {
    const result = run(report({ axios: [advisory(A, "axios", "high")] }), {
      exceptions: [{ id: A, reason: REASON, expires: "2026-10-01" }],
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("expired on 2026-10-01");
  });

  test("an exception that runs more than 90 days is refused", () => {
    const result = run(report({ axios: [advisory(A, "axios", "high")] }), {
      exceptions: [{ id: A, reason: REASON, expires: "2027-06-01" }],
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("more than 90 days");
  });

  test("an exception with no reason, a bad id or a bad date is refused", () => {
    const audit = report({ axios: [advisory(A, "axios", "high")] });
    for (const entry of [
      { id: A, reason: "", expires: "2026-12-01" },
      { id: A, reason: "ok", expires: "2026-12-01" },
      { id: "axios", reason: REASON, expires: "2026-12-01" },
      { id: A, reason: REASON, expires: "soon" },
      { id: A, reason: REASON },
    ]) {
      const result = run(audit, { exceptions: [entry] });
      expect(result.status, JSON.stringify(entry)).toBe(1);
    }
  });

  test("an exception for an advisory no longer reported is a warning, not a pass for anything else", () => {
    const result = run(report({}), { exceptions: [{ id: A, reason: REASON, expires: "2026-12-01" }] });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`${A} is excepted but no longer reported`);
  });

  test("npm's own failure, an empty report and a count it cannot read all fail closed", () => {
    expect(run({ error: { code: "ENOAUDIT", summary: "registry down" } }, { exceptions: [] }).status).toBe(1);
    expect(run("", { exceptions: [] }).status).toBe(1);
    expect(run("{}", { exceptions: [] }).status).toBe(1);
    const unreadable = report({});
    unreadable.metadata.vulnerabilities.high = 3;
    expect(run(unreadable, { exceptions: [] }).status).toBe(1);
  });

  test("the exceptions file in the repository is valid JSON with an exceptions array", () => {
    const file = JSON.parse(readFileSync(join(ROOT, "audit-exceptions.json"), "utf8"));
    expect(Array.isArray(file.exceptions)).toBe(true);
  });
});
