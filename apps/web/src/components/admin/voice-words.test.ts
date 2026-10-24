import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { isPermanentRefusal, problemsWords, scrubContact, somethingGone, VOICE_PROBLEM_WORDS, VOICE_STATUS_WORDS, voiceStatusWords } from "./voice-words";

/**
 * The words the Voice agent card puts on apps/app's voice codes. The problem
 * list is read out of apps/app's source (lib/voice/provision.ts,
 * VoiceAgentProblem) rather than imported: a check added there with no words
 * here would reach the operator as a code. The permanent refusals are
 * apps/app's own `not_eligible` sentences, read from the same file. And the
 * scrub that keeps a phone number or an address out of the one free-text
 * field the card prints.
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
    expect(somethingGone(["agent_missing"])).toBe(true);
    expect(somethingGone(["number_missing", "voice"])).toBe(true);
    expect(somethingGone(["fallback", "voice"])).toBe(false);
  });

  test("every status has words; a provisioning row with a last reason is a run that stopped, with the reason scrubbed and the retry's condition said", () => {
    expect(Object.keys(VOICE_STATUS_WORDS).sort()).toEqual(["deprovisioning", "failed", "pending", "provisioning", "ready", "released"]);
    expect(voiceStatusWords({ status: "provisioning", lastError: null })).toBe("Being set up now");
    expect(voiceStatusWords({ status: "provisioning", lastError: "Retell answered 503 for +14155550142" })).toBe(
      "The last attempt failed: Retell answered 503 for [number]; the hourly retry runs only while the voice provisioning switch is on",
    );
    expect(voiceStatusWords({ status: "failed", lastError: "x" })).toBe("Set-up failed");
    expect(voiceStatusWords({ status: "ready", lastError: null })).toBe("Ready");
  });

  test("the refusals that do not lift with time are apps/app's own sentences; the two that do are not", () => {
    const source = readFileSync(PROVISION, "utf8");
    for (const reason of ["the clinic's service has ended", "the package bought has no voice", "no such clinic"]) {
      expect(source, reason).toContain(`"${reason}"`);
      expect(isPermanentRefusal(reason), reason).toBe(true);
    }
    expect(source).toContain("`billing is ${ent.status}`");
    for (const status of ["suspended", "canceled", "purged"]) expect(isPermanentRefusal(`billing is ${status}`), status).toBe(true);
    for (const reason of ["the first invoice is not paid", "no entitlement"]) {
      expect(source, reason).toContain(`"${reason}"`);
      expect(isPermanentRefusal(reason), reason).toBe(false);
    }
  });

  test("anything shaped like a phone number or an email address is scrubbed", () => {
    expect(scrubContact("Retell bound +14155550142 to the agent")).toBe("Retell bound [number] to the agent");
    expect(scrubContact("called (415) 555-0142 twice")).toBe("called [number] twice");
    expect(scrubContact("sent to ops@clinic.example today")).toBe("sent to [address] today");
    expect(scrubContact("Retell answered 502")).toBe("Retell answered 502");
    expect(scrubContact("the daily cap of 5 is reached")).toBe("the daily cap of 5 is reached");
  });
});
