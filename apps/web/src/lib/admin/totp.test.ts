/**
 * The operator's TOTP, checked against the RFCs' own numbers.
 *
 * The verifier moved here from apps/app on 14 October 2026, copied from
 * apps/app's portal TOTP because this app cannot import that one. Copies
 * drift; the vectors below are what keeps this one honest without sharing
 * code: RFC 4226 Appendix D (HOTP) and RFC 6238 Appendix B (TOTP, SHA-1), both
 * with the RFCs' secret, the ASCII string "12345678901234567890".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TOTP_SECRET_VARIABLE,
  __resetStepLedgerForTests,
  adminTotpSecret,
  adminTotpUri,
  base32Decode,
  base32Encode,
  claimStep,
  generateAdminTotpSecret,
  hotp,
  matchTotpStep,
  totpStep,
} from "./totp";

const RFC_KEY = Buffer.from("12345678901234567890", "ascii");

describe("the algorithm, against the RFC vectors", () => {
  it("matches RFC 4226 Appendix D, counters 0 to 9", () => {
    const expected = [
      "755224", "287082", "359152", "969429", "338314",
      "254676", "287922", "162583", "399871", "520489",
    ];
    expected.forEach((code, counter) => expect(hotp(RFC_KEY, counter)).toBe(code));
  });

  // RFC 6238 Appendix B, the SHA-1 column: eight digits, T0 = 0, X = 30.
  const VECTORS: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(VECTORS)("at %i seconds the eight-digit code is %s", (seconds, code) => {
    expect(hotp(RFC_KEY, totpStep(seconds * 1000), 8)).toBe(code);
  });

  it.each(VECTORS)("at %i seconds an authenticator shows the last six digits of %s", (seconds, code) => {
    expect(hotp(RFC_KEY, totpStep(seconds * 1000))).toBe(code.slice(-6));
  });

  it("counts thirty-second steps from the epoch", () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(59_000)).toBe(1);
  });
});

describe("matching a code to a step", () => {
  const step = totpStep(1234567890 * 1000);

  it("accepts the current step and names it", () => {
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, step), step)).toBe(step);
  });

  it("accepts one step of drift either side, and says which", () => {
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, step - 1), step)).toBe(step - 1);
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, step + 1), step)).toBe(step + 1);
  });

  it("refuses two steps either side", () => {
    // A neighbour sharing digits (one in a million) would make this pass for
    // the wrong reason, so for this fixed step that is checked, not assumed.
    const early = hotp(RFC_KEY, step - 2);
    const late = hotp(RFC_KEY, step + 2);
    for (const offset of [-1, 0, 1]) {
      expect(hotp(RFC_KEY, step + offset)).not.toBe(early);
      expect(hotp(RFC_KEY, step + offset)).not.toBe(late);
    }
    expect(matchTotpStep(RFC_KEY, early, step)).toBeNull();
    expect(matchTotpStep(RFC_KEY, late, step)).toBeNull();
  });

  it("refuses anything that is not exactly six digits, without throwing", () => {
    const code = hotp(RFC_KEY, step);
    for (const value of ["", "12345", "1234567", `${code} `, ` ${code}`, "12a456", "１２３４５６", `${code}0`]) {
      expect(matchTotpStep(RFC_KEY, value, step)).toBeNull();
    }
  });

  it("refuses the right digits under another secret", () => {
    const other = Buffer.from("abcdefghijabcdefghij", "ascii");
    const code = hotp(RFC_KEY, step);
    for (const offset of [-1, 0, 1]) expect(hotp(other, step + offset)).not.toBe(code);
    expect(matchTotpStep(other, code, step)).toBeNull();
  });

  it("does not look before step zero", () => {
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, 0), 0)).toBe(0);
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, 1), 0)).toBe(1);
  });
});

describe("base32", () => {
  it("encodes the RFC secret as authenticator apps expect it", () => {
    expect(base32Encode(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")).toEqual(RFC_KEY);
  });

  it("refuses characters outside the alphabet, and lower case", () => {
    for (const value of ["", "GEZDGNBVGY3TQOJ0", "GEZDGNBVGY3TQOJ1", "GEZDGNBVGY3TQOJ8", "gezdgnbv", "GEZD=", "GEZD GNBV"]) {
      expect(base32Decode(value)).toBeNull();
    }
  });
});

describe("the secret in the environment", () => {
  const saved = process.env[TOTP_SECRET_VARIABLE];
  afterEach(() => {
    if (saved === undefined) delete process.env[TOTP_SECRET_VARIABLE];
    else process.env[TOTP_SECRET_VARIABLE] = saved;
  });

  it("is unset when absent or blank", () => {
    delete process.env[TOTP_SECRET_VARIABLE];
    expect(adminTotpSecret()).toEqual({ ok: false, problem: "unset" });
    process.env[TOTP_SECRET_VARIABLE] = "  \n";
    expect(adminTotpSecret()).toEqual({ ok: false, problem: "unset" });
  });

  it("is 32 base32 characters, and a pasted newline or lower case is the same secret", () => {
    process.env[TOTP_SECRET_VARIABLE] = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(adminTotpSecret()).toEqual({ ok: true, key: RFC_KEY });
    process.env[TOTP_SECRET_VARIABLE] = " gezdgnbvgy3tqojqgezdgnbvgy3tqojq\n";
    expect(adminTotpSecret()).toEqual({ ok: true, key: RFC_KEY });
  });

  it("is malformed at any other length or with a character outside the alphabet", () => {
    for (const value of [
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJ", // 31: a character lost in a paste
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQA", // 33
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJ1", // 1 is not base32
      "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", // grouped for reading
      "12345678901234567890",
    ]) {
      process.env[TOTP_SECRET_VARIABLE] = value;
      expect(adminTotpSecret(), value).toEqual({ ok: false, problem: "malformed" });
    }
  });

  it("is generated as 20 random bytes the reader accepts", () => {
    const first = generateAdminTotpSecret();
    const second = generateAdminTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(first).not.toBe(second);
    expect(base32Decode(first)?.length).toBe(20);
    expect(base32Encode(base32Decode(first)!)).toBe(first);
    process.env[TOTP_SECRET_VARIABLE] = first;
    expect(adminTotpSecret().ok).toBe(true);
  });
});

describe("the otpauth URI", () => {
  it("is Google's Key URI format, labelled healdesk:<email>", () => {
    expect(adminTotpUri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", " Owner@Example.com ")).toBe(
      "otpauth://totp/healdesk:owner@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=healdesk&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("encodes anything in the address that could end the label", () => {
    expect(adminTotpUri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "a/b?c#d@example.com")).toMatch(
      /^otpauth:\/\/totp\/healdesk:a%2Fb%3Fc%23d@example\.com\?secret=/,
    );
  });
});

describe("the replay ledger in this process", () => {
  beforeEach(() => __resetStepLedgerForTests());

  it("accepts a step once, and never again", () => {
    expect(claimStep(RFC_KEY, 100)).toBe(true);
    expect(claimStep(RFC_KEY, 100)).toBe(false);
    expect(claimStep(RFC_KEY, 100)).toBe(false);
  });

  it("refuses a step below the last one accepted, so an older code cannot follow a newer one", () => {
    expect(claimStep(RFC_KEY, 101)).toBe(true);
    expect(claimStep(RFC_KEY, 100)).toBe(false);
    expect(claimStep(RFC_KEY, 102)).toBe(true);
    expect(claimStep(RFC_KEY, 101)).toBe(false);
  });

  it("keeps each secret's record apart", () => {
    const other = Buffer.from("abcdefghijabcdefghij", "ascii");
    expect(claimStep(RFC_KEY, 100)).toBe(true);
    expect(claimStep(other, 100)).toBe(true);
    expect(claimStep(other, 100)).toBe(false);
  });

  it("stays small however many secrets pass through it, keeping the latest", () => {
    for (let index = 0; index < 50; index += 1) {
      claimStep(Buffer.from(`secret-number-${String(index).padStart(6, "0")}`), 100);
    }
    expect(claimStep(RFC_KEY, 100)).toBe(true);
    expect(claimStep(RFC_KEY, 100)).toBe(false);
  });

  it("is empty in a fresh instance, which is the gap the step cookie and the limits cover", () => {
    expect(claimStep(RFC_KEY, 100)).toBe(true);
    __resetStepLedgerForTests();
    expect(claimStep(RFC_KEY, 100)).toBe(true);
  });
});
