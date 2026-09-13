import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * No AI voice dials a prospect except from the one route where the prospect
 * asked for it. This is the guard that outlives whoever builds the "voice
 * audit" touch later: the vendor client's placeCall() may be imported by
 * exactly one file, and that file must decide through canContactProspect().
 */

const SRC = join(process.cwd(), "src");
const ONLY_CALLER = "app/api/callback/route.ts";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) yield full;
  }
}

describe("no outbound AI voice to prospects", () => {
  test("placeCall() is reachable from the callback route and nowhere else", () => {
    const callers: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === "lib/synthflow.ts") continue;
      // Code only: a comment that names placeCall() is documentation, not a dial.
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      if (/\bplaceCall\s*\(/.test(code) || /from "@\/lib\/synthflow"/.test(code)) {
        callers.push(rel);
      }
    }
    expect(callers).toEqual([ONLY_CALLER]);
  });

  test("the callback route decides through canContactProspect()", () => {
    const text = readFileSync(join(SRC, ONLY_CALLER), "utf8");
    expect(text).toMatch(/canContactProspect\(/);
    // And the decision comes before the dial.
    expect(text.indexOf("canContactProspect(")).toBeLessThan(text.indexOf("placeCall("));
  });
});
