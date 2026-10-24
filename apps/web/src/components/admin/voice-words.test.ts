import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { problemsWords, scrubContact, VOICE_ENGINE_WORDS, VOICE_PROBLEM_WORDS, VOICE_STATUS_WORDS } from "./voice-words";

/**
 * The words the Voice agent card puts on apps/app's voice codes. The problem
 * list is read out of apps/app's source (lib/voice/provision.ts,
 * VoiceAgentProblem) rather than imported: a check added there with no words
 * here would reach the operator as a code. And the scrub that keeps a phone
 * number or an address out of the one free-text field the card prints.
 */

const PROVISION = join(__dirname, "..", "..", "..", "..", "app", "src", "lib", "voice", "provision.ts");

function appsAppProblems(): string[] {
  const source = readFileSync(PROVISION, "utf8");
  const block = /export type VoiceAgentProblem =([\s\S]*?);/.exec(source)?.[1];
  if (block === undefined) throw new Error("apps/app's VoiceAgentProblem union was not found");
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("the voice words", () => {
  test("every read-back problem apps/app can find has words, and nothing more", () => {
    const theirs = appsAppProblems();
    expect(theirs.length).toBeGreaterThan(8);
    expect(Object.keys(VOICE_PROBLEM_WORDS).sort()).toEqual([...theirs].sort());
    for (const words of Object.values(VOICE_PROBLEM_WORDS)) expect(words).not.toContain("_");
    expect(problemsWords(["agent_missing", "fallback"])).toBe("the agent is missing at Retell; the number's fallback is not the clinic's direct line");
  });

  test("every status and engine has words", () => {
    expect(Object.keys(VOICE_STATUS_WORDS).sort()).toEqual(["deprovisioning", "failed", "pending", "provisioning", "ready", "released"]);
    expect(Object.keys(VOICE_ENGINE_WORDS).sort()).toEqual(["custom", "native"]);
  });

  test("anything shaped like a phone number or an email address is scrubbed", () => {
    expect(scrubContact("Retell bound +14155550142 to the agent")).toBe("Retell bound [number] to the agent");
    expect(scrubContact("called (415) 555-0142 twice")).toBe("called [number] twice");
    expect(scrubContact("sent to ops@clinic.example today")).toBe("sent to [address] today");
    expect(scrubContact("Retell answered 502")).toBe("Retell answered 502");
    expect(scrubContact("the daily cap of 5 is reached")).toBe("the daily cap of 5 is reached");
  });
});
