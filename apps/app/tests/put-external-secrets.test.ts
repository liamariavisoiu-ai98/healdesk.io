import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

/**
 * infra/aws/scripts/put-external-secrets.sh, run as the owner runs it in
 * CloudShell, against a stand-in `aws` that answers as Parameter Store would
 * and writes down what was put.
 *
 * The runbook's backstop and fall-through checks (infra/aws/README.md,
 * "Turning it on", steps 6 and 7) come before the agreements are signed, on
 * the made-up demo clinic, and need HEALDESK_RETELL_API_KEY. The script used
 * to take that key only on a typed `yes`, the attestation that every
 * agreement in the chain is signed, so the owner could either skip the
 * checks or attest to something untrue. It now takes `test` for it, as it
 * does for the line password, and says what that allows; the keys with no
 * test exception still take only `yes`.
 */

const SCRIPT = join(process.cwd(), "..", "..", "infra", "aws", "scripts", "put-external-secrets.sh");

const FAKE_AWS = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"sts get-caller-identity"*) echo 865780386982 ;;
  *"ssm describe-parameters"*) printf 'SecureString\\tarn:aws:kms:us-east-1:865780386982:key/test\\n' ;;
  *"ssm get-parameter"*) echo True ;;
  *"ssm put-parameter"*)
    name="" value=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) name=$2; shift ;;
        --value) value=$(cat "\${2#file://}"); shift ;;
      esac
      shift
    done
    printf '%s=%s\\n' "$name" "$value" >>"$FAKE_AWS_PUTS"
    echo 2
    ;;
  *) echo "unexpected aws call: $args" >&2; exit 1 ;;
esac
`;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs the script for one key with the typed lines; returns what it said and what it put. */
function paste(key: string, lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "put-secrets-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), FAKE_AWS);
  chmodSync(join(bin, "aws"), 0o755);
  const puts = join(dir, "puts");
  const run = spawnSync("bash", [SCRIPT, key], {
    input: lines.map((l) => `${l}\n`).join(""),
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}`, HOME: dir, FAKE_AWS_PUTS: puts },
    timeout: 30_000,
  });
  return { status: run.status, stderr: run.stderr, puts: existsSync(puts) ? readFileSync(puts, "utf8") : "" };
}

const RETELL_KEY = "key_0123456789abcdefTEST";
const LINE_PASSWORD = "a".repeat(64);

describe("put-external-secrets.sh and the test exception", () => {
  test("takes the Retell API key on `test`, for the demo clinic's backstop and fall-through checks", () => {
    const run = paste("HEALDESK_RETELL_API_KEY", ["test", RETELL_KEY]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.puts).toBe(`/healdesk/production/app/HEALDESK_RETELL_API_KEY=${RETELL_KEY}\n`);
    expect(run.stderr).toMatch(/HEALDESK_RETELL_API_KEY: test\. This allows the backstop and the fall-through/);
    expect(run.stderr).toMatch(/must hold no real clinic's agent or number until Retell's agreement is signed/);
    expect(run.stderr).toMatch(/HEALDESK_RETELL_API_KEY\s+pasted, for a test on the demo clinic only/);
  });

  test("takes the Retell API key on `yes`, and keeps it on any other answer", () => {
    const yes = paste("HEALDESK_RETELL_API_KEY", ["yes", RETELL_KEY]);
    expect(yes.status, yes.stderr).toBe(0);
    expect(yes.puts).toBe(`/healdesk/production/app/HEALDESK_RETELL_API_KEY=${RETELL_KEY}\n`);
    expect(yes.stderr).toMatch(/HEALDESK_RETELL_API_KEY\s+pasted$/m);

    const no = paste("HEALDESK_RETELL_API_KEY", ["no", RETELL_KEY]);
    expect(no.status, no.stderr).toBe(0);
    expect(no.puts).toBe("");
    expect(no.stderr).toMatch(/HEALDESK_RETELL_API_KEY\s+kept \(__unset__\)/);
  });

  test("still takes the line password on `test`, with its own warning", () => {
    const run = paste("HEALDESK_RETELL_LLM_SECRET", ["test", LINE_PASSWORD]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.puts).toBe(`/healdesk/production/app/HEALDESK_RETELL_LLM_SECRET=${LINE_PASSWORD}\n`);
    expect(run.stderr).toMatch(/HEALDESK_RETELL_LLM_SECRET: test\. This allows a test call on the made-up demo clinic/);
    expect(run.stderr).toMatch(/Put this address only in the demo clinic's Retell agent/);
  });

  test("a key with no test exception takes only `yes`", () => {
    const run = paste("ANTHROPIC_API_KEY", ["test", "sk-ant-not-a-real-key"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.puts).toBe("");
    expect(run.stderr).toMatch(/ANTHROPIC_API_KEY\s+kept \(__unset__\)/);
  });
});
