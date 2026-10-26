import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  CALENDAR_WRITE_REASON_WORDS,
  countWords,
  hoursWaited,
  MAX_WRITE_TRIES,
  nextTryWords,
  slotWords,
  stuckSummaryWords,
  transcriptCountWords,
  triesWords,
  waited,
  writeProblemWords,
  SWEEP_OFF_WORDS,
} from "./queue-words";

/**
 * The words the System page and the Setup tab put on apps/app's codes. The
 * reason table is read out of apps/app's source rather than imported
 * (apps/web must not import from apps/app): a code added there with no words
 * here would reach the operator as a code, and this fails first. The tries
 * "of 5" are apps/app's MAX_WRITE_ATTEMPTS, pinned the same way; an
 * operator's retries go past them, so a count above five drops the "of".
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

  test("`other` says no reason of ours was recorded, and names both ways that happens", () => {
    expect(CALENDAR_WRITE_REASON_WORDS.other).toContain("no reason of ours was recorded");
    expect(CALENDAR_WRITE_REASON_WORDS.other).toContain("the attempt was cut off");
    expect(CALENDAR_WRITE_REASON_WORDS.other).toContain("Google answered with a word of its own");
  });

  test("the tries are counted of apps/app's maximum while within it, and plainly past it", () => {
    expect(MAX_WRITE_TRIES).toBe(appsAppMaxAttempts());
    expect(triesWords(2)).toBe("Tries 2 of 5");
    expect(triesWords(5)).toBe("Tries 5 of 5");
    expect(triesWords(6)).toBe("Tries 6");
    expect(triesWords(9)).toBe("Tries 9");
    // The sweep never makes a sixth attempt; an operator's Retry can, and the comment says so.
    expect(readFileSync(join(__dirname, "queue-words.ts"), "utf8")).toContain("An operator's Retry does go past it");
  });
});

describe("the ages and counts", () => {
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

  test("a count some clinic is missing from reads 'at least'", () => {
    expect(countWords(3, false)).toBe("3");
    expect(countWords(3, true)).toBe("at least 3");
    expect(countWords(0, true)).toBe("at least 0");
  });

  test("a write's state, its next try and its slot, never a time", () => {
    const now = "2026-10-24T09:00:00.000Z";
    expect(writeProblemWords({ status: "failed", attempts: 1, retryable: false })).toBe("failed, not retried by itself");
    expect(writeProblemWords({ status: "unknown", attempts: 5, retryable: false })).toBe("gave up after 5 tries");
    expect(writeProblemWords({ status: "unknown", attempts: 7, retryable: false })).toBe("gave up after 7 tries");
    // Settled with tries to spare: not "gave up".
    expect(writeProblemWords({ status: "unknown", attempts: 1, retryable: false })).toBe("will not be retried by itself");
    expect(writeProblemWords({ status: "unknown", attempts: 2, retryable: true })).toBe("waiting for its next try");
    // With the sweep switched off nothing retries: never "waiting", whatever the row says.
    expect(writeProblemWords({ status: "unknown", attempts: 2, retryable: true }, false)).toBe("will not be retried by itself");
    expect(SWEEP_OFF_WORDS).toBe(
      "These writes will not be retried by themselves while the calendar-watch switch on the Jobs page is off. With it off, an alert for a write Google never answered waits until it has sat untouched for 24 hours or its slot has started, whichever comes first, so this list is the early warning.",
    );
    expect(nextTryWords({ nextAttemptAt: null }, now)).toBe("due now");
    expect(nextTryWords({ nextAttemptAt: "2026-10-24T09:30:00.000Z" }, now)).toBe("in about 30 minutes");
    expect(nextTryWords({ nextAttemptAt: "2026-10-24T09:01:00.000Z" }, now)).toBe("in about 1 minute");
    expect(nextTryWords({ nextAttemptAt: "2026-10-24T15:00:00.000Z" }, now)).toBe("in about 6 hours");
    expect(nextTryWords({ nextAttemptAt: "2026-10-24T08:00:00.000Z" }, now)).toBe("due now");
    expect(slotWords(0)).toBe("within 24 hours");
    expect(slotWords(1)).toBe("in 1 day");
    expect(slotWords(4)).toBe("in 4 days");
    // Once the slot has started the days mean nothing: say so, and what to do.
    expect(slotWords(0, true)).toBe("has passed: phone the clinic to check it was added by hand");
  });

  test("a clinic's stuck writes in a phrase: the count, and how many the sweep will not retry", () => {
    expect(stuckSummaryWords([{ retryable: true }])).toBe("1 stuck");
    expect(stuckSummaryWords([{ retryable: true }, { retryable: false }])).toBe("2 stuck, 1 will not be retried by itself");
    expect(stuckSummaryWords([{ retryable: false }, { retryable: false }])).toBe("2 stuck, 2 will not be retried by itself");
  });

  test("a clinic's undelivered transcript copies in Home's words, zeros left out", () => {
    expect(transcriptCountWords({ overdue: 1, bounced: 0, expired: 2, unconfirmed: 0 })).toBe("1 waiting more than 72 hours, 2 deleted unsent after 30 days");
    expect(transcriptCountWords({ overdue: 0, bounced: 1, expired: 0, unconfirmed: 1 })).toBe("1 bounced, 1 deleted after 72 hours with no answer from the mail service");
    expect(transcriptCountWords({ overdue: 0, bounced: 0, expired: 0, unconfirmed: 0 })).toBe("");
    for (const old of ["overdue", "expired", "unconfirmed"]) expect(transcriptCountWords({ overdue: 1, bounced: 1, expired: 1, unconfirmed: 1 })).not.toContain(old);
  });
});
