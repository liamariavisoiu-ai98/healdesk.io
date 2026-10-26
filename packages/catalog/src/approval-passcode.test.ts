import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createPasscodeLockout,
  PASSCODE_ATTEMPT_LIMIT,
  PASSCODE_LOCK_MS,
  parsePasscodeHash,
  passcodeMatches,
} from "./approval-passcode";

/** The shared verifier both apps check the approval passcode with (lane P7i). */

function hashOf(passcode: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passcode, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);

describe("the hash", () => {
  test("parses the owner script's format and refuses anything else", () => {
    expect(parsePasscodeHash(hashOf("123456"))).not.toBeNull();
    for (const bad of [undefined, null, "", "__unset__", "scrypt$1000$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA==", "bcrypt$x"]) {
      expect(parsePasscodeHash(bad)).toBeNull();
    }
    // Over 64 MiB of memory: refused rather than derived.
    expect(parsePasscodeHash(`scrypt$1048576$64$1$${"A".repeat(24)}$${"A".repeat(44)}`)).toBeNull();
  });

  test("matches the passcode it was made from, and nothing else", async () => {
    const hash = hashOf("482913");
    expect(await passcodeMatches("482913", hash)).toBe(true);
    expect(await passcodeMatches("482914", hash)).toBe(false);
    expect(await passcodeMatches("482913", undefined)).toBe(false);
    expect(await passcodeMatches("482913", "not a hash")).toBe(false);
  });
});

describe("the lockout", () => {
  test("five wrong tries lock the account and say so once, for fifteen minutes", () => {
    const locks: string[] = [];
    const lockout = createPasscodeLockout((account, reason) => locks.push(`${account}:${reason}`));
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT - 1; i += 1) lockout.recordFailure("a", NOW);
    expect(lockout.lockedFor("a", NOW)).toBe(0);
    lockout.recordFailure("a", NOW);
    expect(lockout.lockedFor("a", NOW)).toBe(PASSCODE_LOCK_MS);
    expect(locks).toEqual(["a:account"]);
    lockout.recordFailure("a", NOW);
    expect(locks).toEqual(["a:account"]);
    expect(lockout.lockedFor("a", NOW + PASSCODE_LOCK_MS)).toBe(0);
  });

  test("tries across accounts lock everyone", () => {
    const locks: string[] = [];
    const lockout = createPasscodeLockout((account, reason) => locks.push(`${account}:${reason}`));
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT; i += 1) lockout.recordFailure(`u${i}`, NOW);
    expect(lockout.lockedFor("someone-else", NOW)).toBeGreaterThan(0);
    expect(locks).toEqual([`u${PASSCODE_ATTEMPT_LIMIT - 1}:global`]);
  });

  test("one derivation at a time, and a reset is a fresh process", () => {
    const lockout = createPasscodeLockout();
    expect(lockout.claim()).toBe(true);
    expect(lockout.claim()).toBe(false);
    lockout.release();
    expect(lockout.claim()).toBe(true);
    lockout.reset();
    expect(lockout.claim()).toBe(true);
  });

  test("a report that throws never changes the count", () => {
    const lockout = createPasscodeLockout(() => {
      throw new Error("mail down");
    });
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT; i += 1) lockout.recordFailure("a", NOW);
    expect(lockout.lockedFor("a", NOW)).toBeGreaterThan(0);
  });
});
