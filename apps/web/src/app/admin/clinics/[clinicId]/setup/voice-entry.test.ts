import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * The two voice acts that change what Retell holds, one more provisioning
 * run (which can buy a number) and the drift flag's clear, enter only
 * through lib/admin/voice-drift.ts, which asks for the operator's fresh
 * authenticator code before the signed request goes. No page or server
 * action under app/ may import the raw ops-client operations, by name or
 * through a namespace; the Setup page takes both from voice-drift. Read from
 * the source, so a page that reaches for the raw one fails here before a
 * number is bought on a session alone.
 */

const APP = join(__dirname, "..", "..", "..", "..");
const RAW = ["retryVoiceAgent", "clearVoiceDriftFlag"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function importsRaw(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*ops-client["']/g)) {
    for (const spec of m[1]!.split(",")) {
      const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (RAW.includes(name)) hits.push(name);
    }
  }
  for (const m of source.matchAll(/\*\s+as\s+(\w+)\s+from\s*["'][^"']*ops-client["']/g)) {
    for (const name of RAW) if (new RegExp(`\\b${m[1]}\\s*(?:\\.|\\[["'])\\s*${name}\\b`).test(source)) hits.push(name);
  }
  return hits;
}

describe("the voice acts' entry", () => {
  const files = sources(APP);

  test("no page or action under app/ imports the raw retryVoiceAgent or clearVoiceDriftFlag", () => {
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => importsRaw(readFileSync(file, "utf8")).map((name) => `${file.slice(APP.length + 1)} imports ${name}`));
    expect(offenders).toEqual([]);
  });

  test("the Setup page takes both acts from voice-drift", () => {
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toMatch(/import\s*\{[^}]*\bclearVoiceDriftFlag\b[^}]*\}\s*from\s*["']@\/lib\/admin\/voice-drift["']/);
    expect(page).toMatch(/import\s*\{[^}]*\bretryVoiceAgentWithCode\b[^}]*\}\s*from\s*["']@\/lib\/admin\/voice-drift["']/);
  });

  test("the guard reads a raw import, named or aliased or through a namespace", () => {
    expect(importsRaw('import { retryVoiceAgent as go } from "@/lib/admin/ops-client";')).toEqual(["retryVoiceAgent"]);
    expect(importsRaw('import * as ops from "@/lib/admin/ops-client";\nops.clearVoiceDriftFlag(id);')).toEqual(["clearVoiceDriftFlag"]);
    expect(importsRaw('import { fetchVoiceAgentStatus, type RetryVoiceAgentOutcome } from "@/lib/admin/ops-client";')).toEqual([]);
  });
});
