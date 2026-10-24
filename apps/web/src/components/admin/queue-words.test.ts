import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CALENDAR_WRITE_REASON_WORDS, hoursWaited, MAX_WRITE_TRIES, nextTryWords, slotWords, waited, writeProblemWords } from "./queue-words";

/**
 * The words the System page and the Setup tab put on apps/app's codes. The
 * reason table is read out of apps/app's source rather than imported
 * (apps/web must not import from apps/app): a code added there with no words
 * here would reach the operator as a code, and this fails first. The tries
 * "of 5" are apps/app's MAX_WRITE_ATTEMPTS, pinned the same way.
 */

const CALENDAR = join(__dirname, "..", "..", "..", "..", "app", "src", "lib", "booking", "calendar.ts");

function appsAppReasons(): string[] {
  const source = readFileSync(CALENDAR, "utf8");
  const table = /export const CALENDAR_WRITE_REASONS = \{([\s\S]*?)\} as const/.exec(source)?.[1];
  if (table === undefined) throw new Error("apps/app's CALENDAR_WRITE_REASONS table was not found");
  return [...table.matchAll(/^\s+([a-z_]+): "(?:transient|settled|refused)",$/gm)].map((m) => m[1]!);
}

function appsAppMaxAttempts(): number {
  const source = readFileSync(CALENDAR, "utf8");
  const match = /export const MAX_WRITE_ATTEMPTS = (\d+);/.exec(source);
  if (!match) throw new Error("apps/app's MAX_WRITE_ATTEMPTS was not found");
  return Number(match[1]);
}

describe("the calendar write reason words", () => {
  test("every code apps/app can record has words, plus `other`, and nothing more", () => {
    const theirs = appsAppReasons();
    expect(theirs.length).toBeGreaterThan(30);
    expect(Object.keys(CALENDAR_WRITE_REASON_WORDS).sort()).toEqual([...theirs, "other"].sort());
    for (const [code, words] of Object.entries(CALENDAR_WRITE_REASON_WORDS)) {
      expect(words, code).toMatch(/^[a-zA-Z]/);
      expect(words, code).not.toContain("_");
      expect(words, code).not.toMatch(/\.$/);
    }
  });

  test("the tries are counted of apps/app's maximum", () => {
    expect(MAX_WRITE_TRIES).toBe(appsAppMaxAttempts());
  });
});

describe("the ages", () => {
  test("a queue's wait is in the largest unit that reads well", () => {
    expect(waited(0)).toBe("under a minute");
    expect(waited(1)).toBe("1 minute");
    expect(waited(45)).toBe("45 minutes");
    expect(waited(60)).toBe("1 hour");
    expect(waited(125)).toBe("2 hours");
    expect(waited(47 * 60)).toBe("47 hours");
    expect(waited(48 * 60)).toBe("2 days");
    expect(hoursWaited(1)).toBe("1 hour");
    expect(hoursWaited(80)).toBe("3 days");
    expect(hoursWaited(47)).toBe("47 hours");
  });

  test("a write's state, its next try and its slot, never a time", () => {
    const now = "2026-10-24T09:00:00.000Z";
    expect(writeProblemWords({ status: "failed", attempts: 1, retryable: false })).toBe("failed");
    expect(writeProblemWords({ status: "unknown", attempts: 5, retryable: false })).toBe("gave up after 5 tries");
    expect(writeProblemWords({ status: "unknown", attempts: 1, retryable: false })).toBe("gave up after 1 try");
    expect(writeProblemWords({ status: "unknown", attempts: 2, retryable: true })).toBe("waiting for its next try");
    expect(nextTryWords({ retryable: false, nextAttemptAt: null }, now)).toBe("will not be tried again by itself");
    expect(nextTryWords({ retryable: true, nextAttemptAt: null }, now)).toBe("due now");
    expect(nextTryWords({ retryable: true, nextAttemptAt: "2026-10-24T09:30:00.000Z" }, now)).toBe("in about 30 minutes");
    expect(nextTryWords({ retryable: true, nextAttemptAt: "2026-10-24T09:01:00.000Z" }, now)).toBe("in about 1 minute");
    expect(nextTryWords({ retryable: true, nextAttemptAt: "2026-10-24T15:00:00.000Z" }, now)).toBe("in about 6 hours");
    expect(nextTryWords({ retryable: true, nextAttemptAt: "2026-10-24T08:00:00.000Z" }, now)).toBe("due now");
    expect(slotWords(0)).toBe("within 24 hours");
    expect(slotWords(1)).toBe("in 1 day");
    expect(slotWords(4)).toBe("in 4 days");
  });
});
