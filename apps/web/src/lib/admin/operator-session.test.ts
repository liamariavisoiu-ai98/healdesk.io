/**
 * Tests for the single-administrator session in `operator.ts`.
 *
 * A separate file from `operator.test.ts`, which covers the earlier three-field
 * Better Auth identity that this module replaced. That file cannot compile
 * against the module as it now stands; it is left alone rather than overwritten
 * because deleting somebody else's work is not this slice's to do.
 *
 * The properties worth having a test for are the ones a future edit could break
 * without anything looking wrong: that an enrolment token is not a session, that
 * the signature is checked before the clock, that a token stops verifying when
 * the configured address changes, and that a work factor read out of an
 * environment variable cannot ask for a gigabyte of memory.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENROLMENT_COOKIE,
  ENROLMENT_TTL_SECONDS,
  OPERATOR_COOKIE,
  OPERATOR_TTL_SECONDS,
  enrolmentCookieOptions,
  isAdminAccountConfigured,
  issueEnrolmentToken,
  issueOperatorToken,
  missingAdminConfig,
  operatorCookieOptions,
  verifyAdminPassword,
  verifyEnrolmentToken,
  verifyOperatorToken,
} from "./operator";

const EMAIL = "healdesk.io@gmail.com";
const PASSWORD = "correct horse battery staple 9f2a";

function hashFor(password: string, N = 16384, r = 8, p = 1): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

const saved = { ...process.env };

beforeEach(() => {
  process.env.HEALDESK_ADMIN_EMAIL = EMAIL;
  process.env.HEALDESK_ADMIN_SECRET = "test-secret-not-a-real-one";
  process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD);
});

afterEach(() => {
  process.env = { ...saved };
});

describe("configuration", () => {
  it("is configured when all three are present", () => {
    expect(isAdminAccountConfigured()).toBe(true);
    expect(missingAdminConfig()).toEqual([]);
  });

  it("names what is missing", () => {
    delete process.env.HEALDESK_ADMIN_SECRET;
    process.env.HEALDESK_ADMIN_PASSWORD_HASH = "not-a-hash";
    expect(isAdminAccountConfigured()).toBe(false);
    expect(missingAdminConfig()).toEqual([
      "HEALDESK_ADMIN_PASSWORD_HASH",
      "HEALDESK_ADMIN_SECRET",
    ]);
  });

  it("treats a blank secret as unset", () => {
    process.env.HEALDESK_ADMIN_SECRET = "";
    expect(isAdminAccountConfigured()).toBe(false);
  });
});

describe("password", () => {
  it("accepts the right pair", async () => {
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(true);
  });

  it("accepts a differently cased address", async () => {
    await expect(verifyAdminPassword(" HealDesk.IO@Gmail.com ", PASSWORD)).resolves.toBe(true);
  });

  it("refuses the wrong password", async () => {
    await expect(verifyAdminPassword(EMAIL, PASSWORD + "!")).resolves.toBe(false);
  });

  it("refuses the wrong address", async () => {
    await expect(verifyAdminPassword("someone@else.com", PASSWORD)).resolves.toBe(false);
  });

  it("refuses when the hash is absent or malformed", async () => {
    process.env.HEALDESK_ADMIN_PASSWORD_HASH = "scrypt$16384$8$1$short";
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(false);
    delete process.env.HEALDESK_ADMIN_PASSWORD_HASH;
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(false);
  });

  it("refuses a memory-bomb work factor rather than allocating it", async () => {
    process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD).replace(
      "scrypt$16384$",
      "scrypt$1073741824$",
    );
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(false);
  });

  it("refuses a non-power-of-two N", async () => {
    process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD).replace(
      "scrypt$16384$",
      "scrypt$16383$",
    );
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(false);
  });

  it("verifies against non-default work factors from the stored string", async () => {
    process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD, 8192, 4, 2);
    await expect(verifyAdminPassword(EMAIL, PASSWORD)).resolves.toBe(true);
    await expect(verifyAdminPassword(EMAIL, "wrong")).resolves.toBe(false);
  });

  it("refuses non-strings and over-long input", async () => {
    await expect(verifyAdminPassword(EMAIL, 1234 as unknown)).resolves.toBe(false);
    await expect(verifyAdminPassword(EMAIL, "x".repeat(2000))).resolves.toBe(false);
  });
});

describe("operator token", () => {
  it("round-trips the configured address", () => {
    expect(verifyOperatorToken(issueOperatorToken(EMAIL))).toBe(EMAIL);
  });

  it("normalises on the way in", () => {
    expect(verifyOperatorToken(issueOperatorToken(" HEALDESK.IO@GMAIL.COM "))).toBe(EMAIL);
  });

  it("refuses a tampered signature, payload or expiry", () => {
    const token = issueOperatorToken(EMAIL);
    const [payload, expiry, signature] = token.split(".") as [string, string, string];
    // The substituted character has to differ from the one it replaces. A flat
    // "A" is a no-op on the roughly one signature in sixty-four that already
    // ends in one, and this test went red at random until it stopped assuming.
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    expect(verifyOperatorToken(`${payload}.${expiry}.${flipped}`)).toBeNull();
    expect(verifyOperatorToken(`${payload}.${Number(expiry) + 1000}.${signature}`)).toBeNull();
    expect(verifyOperatorToken(`${payload}A.${expiry}.${signature}`)).toBeNull();
    expect(verifyOperatorToken(`${payload}.${expiry}`)).toBeNull();
    expect(verifyOperatorToken(`${payload}.${expiry}.${signature}.x`)).toBeNull();
  });

  it("refuses a token minted under a different secret", () => {
    const token = issueOperatorToken(EMAIL);
    process.env.HEALDESK_ADMIN_SECRET = "a-different-secret";
    expect(verifyOperatorToken(token)).toBeNull();
  });

  it("refuses a token naming an address the server no longer uses", () => {
    const token = issueOperatorToken(EMAIL);
    process.env.HEALDESK_ADMIN_EMAIL = "someone.else@example.com";
    expect(verifyOperatorToken(token)).toBeNull();
  });

  it("refuses when the secret or the address is gone", () => {
    const token = issueOperatorToken(EMAIL);
    delete process.env.HEALDESK_ADMIN_SECRET;
    expect(verifyOperatorToken(token)).toBeNull();
    process.env.HEALDESK_ADMIN_SECRET = "test-secret-not-a-real-one";
    delete process.env.HEALDESK_ADMIN_EMAIL;
    expect(verifyOperatorToken(token)).toBeNull();
  });

  it("refuses rubbish without throwing", () => {
    for (const value of ["", "...", "a.b.c", "x".repeat(5000), undefined]) {
      expect(verifyOperatorToken(value as string | undefined)).toBeNull();
    }
  });

  it("refuses an expired token", () => {
    const token = issueOperatorToken(EMAIL);
    const [payload, , signature] = token.split(".") as [string, string, string];
    // A past expiry cannot be re-signed without the key, so this proves the
    // signature is checked before the clock, not instead of it.
    expect(verifyOperatorToken(`${payload}.1.${signature}`)).toBeNull();
  });

  it("throws rather than minting an unsigned token", () => {
    delete process.env.HEALDESK_ADMIN_SECRET;
    expect(() => issueOperatorToken(EMAIL)).toThrow();
  });

  it("has an eight hour lifetime", () => {
    expect(OPERATOR_TTL_SECONDS).toBe(60 * 60 * 8);
    const token = issueOperatorToken(EMAIL);
    const expiry = Number(token.split(".")[1]);
    expect(expiry - Date.now()).toBeGreaterThan(OPERATOR_TTL_SECONDS * 1000 - 5000);
    expect(expiry - Date.now()).toBeLessThanOrEqual(OPERATOR_TTL_SECONDS * 1000);
  });
});

describe("enrolment token is not a session", () => {
  it("does not verify as an operator token", () => {
    expect(verifyOperatorToken(issueEnrolmentToken(EMAIL))).toBeNull();
  });

  it("and an operator token does not verify as an enrolment token", () => {
    expect(verifyEnrolmentToken(issueOperatorToken(EMAIL))).toBeNull();
  });

  it("round-trips on its own key and is short lived", () => {
    expect(ENROLMENT_TTL_SECONDS).toBe(600);
    const token = issueEnrolmentToken(EMAIL);
    expect(verifyEnrolmentToken(token)).toBe(EMAIL);
    const expiry = Number(token.split(".")[1]);
    expect(expiry - Date.now()).toBeLessThanOrEqual(ENROLMENT_TTL_SECONDS * 1000);
  });
});

describe("cookie flags", () => {
  it("are httpOnly, strict, and rooted so both /admin and /api/admin see them", () => {
    const options = operatorCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(OPERATOR_TTL_SECONDS);
  });

  it("scope the enrolment cookie to the one route that reads it", () => {
    const options = enrolmentCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/api/admin/enroll");
    expect(options.maxAge).toBe(ENROLMENT_TTL_SECONDS);
  });

  it("keep the two cookies under different names", () => {
    expect(OPERATOR_COOKIE).not.toBe(ENROLMENT_COOKIE);
    // And apart from the three cookies this app already sets.
    expect([OPERATOR_COOKIE, ENROLMENT_COOKIE]).not.toContain("hd_admin");
    expect([OPERATOR_COOKIE, ENROLMENT_COOKIE]).not.toContain("hd_demo");
    expect([OPERATOR_COOKIE, ENROLMENT_COOKIE]).not.toContain("hd_agreement");
  });

  it("are secure in production", () => {
    const saved = process.env.NODE_ENV;
    // `NODE_ENV` is read-only in the type, and this is the one thing worth
    // reaching around it for: without `secure` the cookie is a bearer token in
    // clear text on the wire.
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    expect(operatorCookieOptions().secure).toBe(true);
    expect(enrolmentCookieOptions().secure).toBe(true);
    Object.defineProperty(process.env, "NODE_ENV", {
      value: saved,
      configurable: true,
    });
  });
});
