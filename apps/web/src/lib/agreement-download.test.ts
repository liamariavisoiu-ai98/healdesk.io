import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GATE_COOKIE } from "@/lib/gate";

import {
  DOWNLOAD_COOKIE,
  DOWNLOAD_COOKIE_PATH,
  DOWNLOAD_TTL_SECONDS,
  downloadCookieOptions,
  issueDownloadToken,
  verifyDownloadToken,
} from "./agreement-download";

/**
 * The download cookie, tested for the ways a bearer credential goes wrong.
 *
 * A token that works for the person who earned it is proved by using it once.
 * The failures are what nobody reports, so that is where the length goes: a
 * token presented against an agreement it was not minted for, a cookie someone
 * edited, a cookie signed with a key we have since rotated away from, a cookie
 * whose half-hour has passed, and the unconfigured production environment,
 * which must hand out nothing at all.
 *
 * The first of those is the design. Everything else in this feature, keeping
 * the acceptance id out of the email, the server-to-server HMAC in front of the
 * renderer, is wasted if a token for agreement A opens agreement B.
 */

/** Long random strings, which is what this env var is meant to hold. */
const SECRET = "wY2kP9sLd4Rn7Vc0Xt6Hb3Mq8Ja1Zg5f";
const OTHER_SECRET = "Lb8fQ3wT6mXz1Rk9Vd2Hs5Nc7Ja4Yg0p";

/** Two real-shaped acceptance ids. Same length, so nothing passes by accident. */
const AGREEMENT_A = "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f";
const AGREEMENT_B = "0a9c8b7d-6e5f-4321-8abc-9f8e7d6c5b4a";

const ENV_KEYS = ["HEALDESK_GATE_SECRET", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/**
 * Both vars are read from `process.env` on every call, so a test that sets one
 * and forgets leaks a configured signer into the next test, which would make a
 * fail-closed assertion pass for the wrong reason. Snapshot, clear, restore.
 */
const saved = new Map<EnvKey, string | undefined>();

/** `NODE_ENV` is narrowly typed; go through the index signature, not `any`. */
const env = process.env as Record<string, string | undefined>;

function setEnv(key: EnvKey, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

beforeEach(() => {
  saved.clear();
  for (const key of ENV_KEYS) saved.set(key, env[key]);
  setEnv("HEALDESK_GATE_SECRET", SECRET);
});

afterEach(() => {
  for (const key of ENV_KEYS) setEnv(key, saved.get(key));
  vi.useRealTimers();
});

/** `1741772460000.AbC...`, the expiry and the HMAC over it. */
function parts(token: string): { expiry: string; signature: string } {
  const split = token.split(".");
  expect(split.length, `token is not expiry.signature: ${token}`).toBe(2);
  return { expiry: split[0] ?? "", signature: split[1] ?? "" };
}

/** One character changed, same length, the edit a broken compare would miss. */
function flip(signature: string): string {
  const head = signature.startsWith("A") ? "B" : "A";
  return `${head}${signature.slice(1)}`;
}

describe("the token is for one agreement and no other", () => {
  test("a token minted for A does not open B, and still opens A", () => {
    // The property the entire design rests on. If this ever goes green for B,
    // the acceptance uuid is a bearer credential again and the review that
    // kept it out of the confirmation email was for nothing.
    const forA = issueDownloadToken(AGREEMENT_A);

    expect(verifyDownloadToken(forA, AGREEMENT_B)).toBe(false);
    // Asserted after the refusal so the refusal cannot have been for some
    // other reason, the same token, same moment, same secret, opens A.
    expect(verifyDownloadToken(forA, AGREEMENT_A)).toBe(true);
  });

  test("two live tokens do not cross over", () => {
    const forA = issueDownloadToken(AGREEMENT_A);
    const forB = issueDownloadToken(AGREEMENT_B);

    expect(verifyDownloadToken(forA, AGREEMENT_A)).toBe(true);
    expect(verifyDownloadToken(forB, AGREEMENT_B)).toBe(true);
    expect(verifyDownloadToken(forA, AGREEMENT_B)).toBe(false);
    expect(verifyDownloadToken(forB, AGREEMENT_A)).toBe(false);
  });

  test("near-miss ids are refused, including a one-character change", () => {
    const token = issueDownloadToken(AGREEMENT_A);

    for (const wrong of [
      `${AGREEMENT_A.slice(0, -1)}0`, // last character changed
      `0${AGREEMENT_A.slice(1)}`, // first character changed
      AGREEMENT_A.slice(0, -1), // a prefix
      `${AGREEMENT_A} `, // trailing whitespace
      `${AGREEMENT_A}x`, // an extra character
      AGREEMENT_A.toUpperCase(), // uuid case is not ours to normalise
    ]) {
      expect(verifyDownloadToken(token, wrong), wrong).toBe(false);
    }
  });

  test("an id split differently cannot borrow another id's signature", () => {
    // The MAC input is base64url(id) + "." + expiry precisely so that no pair
    // of (id, expiry) is another pair's bytes. Ids that would collide under a
    // naive concatenation must not verify against each other's tokens.
    const token = issueDownloadToken("agreement-12");
    expect(verifyDownloadToken(token, "agreement-12")).toBe(true);
    expect(verifyDownloadToken(token, "agreement-1")).toBe(false);
    expect(verifyDownloadToken(token, "agreement-123")).toBe(false);
  });

  test("a blank id verifies nothing, and cannot be minted", () => {
    // A token bound to the empty string would be a token bound to nothing, and
    // an id that arrives empty is a bug at the call site, not a permission.
    expect(() => issueDownloadToken("")).toThrow(/non-empty/);

    const token = issueDownloadToken(AGREEMENT_A);
    expect(verifyDownloadToken(token, "")).toBe(false);
    expect(verifyDownloadToken(token, undefined as unknown as string)).toBe(
      false,
    );
  });
});

describe("the signature", () => {
  test("a freshly issued token round-trips", () => {
    expect(verifyDownloadToken(issueDownloadToken(AGREEMENT_A), AGREEMENT_A)).toBe(
      true,
    );
  });

  test("an edited cookie fails", () => {
    const token = issueDownloadToken(AGREEMENT_A);
    const { expiry, signature } = parts(token);

    // Pushing the expiry out by a day is the edit worth having: it is what
    // someone who read this file would try, and it is the reason the expiry is
    // inside the signature rather than left to the cookie's Max-Age.
    const extended = `${Number(expiry) + 86_400_000}.${signature}`;
    expect(extended).not.toBe(token);
    expect(verifyDownloadToken(extended, AGREEMENT_A)).toBe(false);

    // One character of the signature changed, same length. A comparison
    // rewritten to "same length and same prefix" would still pass this; a
    // constant-time digest compare does not.
    const flipped = `${expiry}.${flip(signature)}`;
    expect(flipped).not.toBe(token);
    expect(verifyDownloadToken(flipped, AGREEMENT_A)).toBe(false);

    // Truncated, extended, and re-encoded signatures.
    for (const bad of [
      `${expiry}.${signature.slice(0, -1)}`,
      `${expiry}.${signature}x`,
      `${expiry}.`,
      `${expiry}.${Buffer.from(signature).toString("hex")}`,
    ]) {
      expect(verifyDownloadToken(bad, AGREEMENT_A), bad).toBe(false);
    }
  });

  test("shapes that are not expiry.signature are refused, never thrown", () => {
    const token = issueDownloadToken(AGREEMENT_A);
    const { expiry, signature } = parts(token);

    for (const malformed of [
      undefined,
      "",
      ".",
      "..",
      "true",
      "1",
      expiry,
      signature,
      `${token}.extra`,
      `.${signature}`,
      `${expiry} .${signature}`,
      `+${expiry}.${signature}`,
      `0${expiry}.${signature}`,
      `1e30.${signature}`,
      `0x${expiry}.${signature}`,
      `99999999999999999999.${signature}`,
      `${expiry}.${signature}.${signature}`,
    ]) {
      expect(
        verifyDownloadToken(malformed, AGREEMENT_A),
        String(malformed),
      ).toBe(false);
    }
  });

  test("a token signed with a different secret fails", () => {
    const token = issueDownloadToken(AGREEMENT_A);

    // Which is what rotating HEALDESK_GATE_SECRET looks like from the browser's
    // side, and the only revocation this module has.
    setEnv("HEALDESK_GATE_SECRET", OTHER_SECRET);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);

    // And the original key brings it back, so the refusal above was the key
    // and not a malformed token.
    setEnv("HEALDESK_GATE_SECRET", SECRET);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);
  });

  test("knowing HEALDESK_GATE_SECRET is not enough, the key is purpose-bound", () => {
    // gate.ts signs `base64url(value).timestamp` with the raw secret, which is
    // the same payload shape this module uses. If the raw secret signed here
    // too, a token minted by the demo gate would be replayable as a download
    // token the moment either file's validation changed. So: forge a signature
    // exactly as gate.ts would, over this module's own payload, and it must
    // still be refused.
    const expiry = String(Date.now() + 60_000);
    const encodedId = Buffer.from(AGREEMENT_A, "utf8").toString("base64url");
    const naive = createHmac("sha256", SECRET)
      .update(`${encodedId}.${expiry}`)
      .digest("base64url");

    expect(verifyDownloadToken(`${expiry}.${naive}`, AGREEMENT_A)).toBe(false);
  });
});

describe("the thirty-minute window", () => {
  test("the token dies at the TTL, enforced here and not by the browser", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T09:00:00.000Z"));

    const token = issueDownloadToken(AGREEMENT_A);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);

    // One minute inside the window.
    vi.setSystemTime(new Date("2026-03-12T09:29:00.000Z"));
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);

    // One minute past it. The signature is still perfectly valid here. This
    // is our expiry being enforced, not the browser's Max-Age being trusted.
    vi.setSystemTime(new Date("2026-03-12T09:31:00.000Z"));
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);

    // And it does not come back later.
    vi.setSystemTime(new Date("2026-03-13T09:00:00.000Z"));
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);
  });

  test("the boundary is exactly thirty minutes and not a second more", () => {
    expect(DOWNLOAD_TTL_SECONDS).toBe(1800);

    vi.useFakeTimers();
    const start = new Date("2026-03-12T09:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const token = issueDownloadToken(AGREEMENT_A);

    vi.setSystemTime(start + DOWNLOAD_TTL_SECONDS * 1000 - 1);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);

    vi.setSystemTime(start + DOWNLOAD_TTL_SECONDS * 1000);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);
  });
});

describe("configuration", () => {
  test("production without a secret mints nothing and verifies nothing", () => {
    // gate.ts falls back to a known dev string when its secret is missing,
    // which is defensible for a lead-capture cookie and indefensible here.
    setEnv("NODE_ENV", "production");
    setEnv("HEALDESK_GATE_SECRET", undefined);

    expect(() => issueDownloadToken(AGREEMENT_A)).toThrow(
      /HEALDESK_GATE_SECRET/,
    );
    // Verifying must fail closed rather than throw: it runs on a request.
    expect(verifyDownloadToken("1.abc", AGREEMENT_A)).toBe(false);
  });

  test("a blank secret counts as unset", () => {
    // The shape a half-finished deploy actually takes.
    setEnv("NODE_ENV", "production");
    setEnv("HEALDESK_GATE_SECRET", "");
    expect(() => issueDownloadToken(AGREEMENT_A)).toThrow(
      /HEALDESK_GATE_SECRET/,
    );
  });

  test("a token minted in production is dead once the secret is gone", () => {
    setEnv("NODE_ENV", "production");
    const token = issueDownloadToken(AGREEMENT_A);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);

    setEnv("HEALDESK_GATE_SECRET", undefined);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);
  });

  test("a token minted against the dev fallback dies once a real secret exists", () => {
    setEnv("NODE_ENV", "development");
    setEnv("HEALDESK_GATE_SECRET", undefined);

    const token = issueDownloadToken(AGREEMENT_A);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(true);

    setEnv("HEALDESK_GATE_SECRET", SECRET);
    expect(verifyDownloadToken(token, AGREEMENT_A)).toBe(false);
  });
});

describe("the cookie itself", () => {
  test("the flags are the ones a bearer credential needs", () => {
    setEnv("NODE_ENV", "production");
    const options = downloadCookieOptions();

    expect(options.httpOnly).toBe(true); // script cannot read it
    expect(options.sameSite).toBe("strict"); // no other origin can send it
    expect(options.secure).toBe(true); // not readable on the wire
    expect(options.maxAge).toBe(DOWNLOAD_TTL_SECONDS);

    // Scoped, so it is not attached to /api/chat, /admin or any page.
    expect(options.path).toBe(DOWNLOAD_COOKIE_PATH);
    expect(options.path).not.toBe("/");
    expect(options.path.startsWith("/")).toBe(true);
  });

  test("secure is off only outside production, because localhost is not HTTPS", () => {
    setEnv("NODE_ENV", "development");
    expect(downloadCookieOptions().secure).toBe(false);

    setEnv("NODE_ENV", "production");
    expect(downloadCookieOptions().secure).toBe(true);
  });

  test("this cookie is not the demo gate's cookie", () => {
    // Both are HMACs over a payload on the same domain. Sharing a name would
    // let a demo cookie be presented where a download token is expected.
    expect(DOWNLOAD_COOKIE).not.toBe(GATE_COOKIE);
    expect(DOWNLOAD_COOKIE).not.toBe("hd_admin");
    expect(DOWNLOAD_COOKIE.length).toBeGreaterThan(0);
  });

  test("the token carries no agreement id to read back out", () => {
    // The id is an input to the MAC, never a field. Nothing in the cookie
    // names the agreement, so there is no id for a verifier to trust and no
    // way to learn from the cookie which record it belongs to.
    const token = issueDownloadToken(AGREEMENT_A);
    expect(token).not.toContain(AGREEMENT_A);
    expect(token).not.toContain(
      Buffer.from(AGREEMENT_A, "utf8").toString("base64url"),
    );
  });
});
