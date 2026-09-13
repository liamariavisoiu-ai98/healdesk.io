import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * "Never log PHI" is only a rule if there is one door. This test is the
 * door: every log line in apps/app/src goes through lib/log.ts, which
 * allowlists field keys and scrubs free text. A bare console.* anywhere else
 * fails the suite, whatever it logs, because the reviewer cannot tell from
 * the call site what the value will hold six months from now.
 */

const SRC = join(process.cwd(), "src");
const ALLOWED = new Set(["lib/log.ts"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) yield full;
  }
}

describe("log hygiene", () => {
  test("no file in apps/app/src calls console.* except lib/log.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
        if (/\bconsole\.(log|info|warn|error|debug|trace)\b/.test(code)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(offenders, "route these through log.* in lib/log.ts").toEqual([]);
  });
});
