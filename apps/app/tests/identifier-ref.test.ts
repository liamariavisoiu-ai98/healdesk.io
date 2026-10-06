import { createHash, createHmac, hkdfSync } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  IDENTIFIER_REF_HKDF_INFO,
  IDENTIFIER_REF_KINDS,
  identifierRef,
} from "@/lib/identifier-ref";

/**
 * identifierRef (build spec R26). The reference stands in for a vendor's
 * identifier in three ledgers, and a WhatsApp sender id is a phone number, so
 * what matters is that the reference is stable (the ledgers must recognise a
 * repeat), separated by kind and by clinic, keyed (a plain hash of a phone
 * number is reversible by enumeration), and built exactly as documented, so a
 * refactor cannot silently change every stored reference.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const OTHER_CLINIC = "9a8b7c6d-1111-4222-8333-444455556666";
const SENDER = "15550100000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("identifierRef", () => {
  test("is a v1-prefixed hex HMAC, and the same input always gives the same reference", () => {
    const ref = identifierRef("chat_party", CLINIC, SENDER);
    expect(ref).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(identifierRef("chat_party", CLINIC, SENDER)).toBe(ref);
    // A uuid is case-insensitive, and so is the reference to it.
    expect(identifierRef("chat_party", CLINIC.toUpperCase(), SENDER)).toBe(ref);
  });

  test("the same identifier as another kind, or at another clinic, is another reference", () => {
    const refs = IDENTIFIER_REF_KINDS.map((kind) => identifierRef(kind, CLINIC, SENDER));
    expect(new Set(refs).size).toBe(IDENTIFIER_REF_KINDS.length);
    expect(identifierRef("chat_party", OTHER_CLINIC, SENDER)).not.toBe(
      identifierRef("chat_party", CLINIC, SENDER),
    );
    expect(identifierRef("call", CLINIC, "call-1")).not.toBe(
      identifierRef("call", CLINIC, "call-2"),
    );
  });

  test("is not a plain sha256 of the identifier, so a phone number cannot be read back by hashing numbers", () => {
    const hex = identifierRef("chat_party", CLINIC, SENDER).slice(3);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(hex).not.toBe(sha(SENDER));
    expect(hex).not.toBe(sha(`chat_party:${SENDER}`));
    expect(hex).not.toBe(sha(`chat_party\u0000${CLINIC}\u0000${SENDER}`));
  });

  test("is built exactly as documented: HKDF-SHA256 over the key, then HMAC-SHA256 over kind, clinic and value", () => {
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "a-test-key-that-is-long-enough-to-pass-0000");
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        "a-test-key-that-is-long-enough-to-pass-0000",
        Buffer.alloc(0),
        IDENTIFIER_REF_HKDF_INFO,
        32,
      ),
    );
    const expected = createHmac("sha256", key)
      .update(`meta_message\u0000${CLINIC}\u0000m_abc`)
      .digest("hex");
    expect(IDENTIFIER_REF_HKDF_INFO).toBe("healdesk.identifier-ref.v1");
    expect(identifierRef("meta_message", CLINIC, "m_abc")).toBe(`v1:${expected}`);
  });

  test("depends on the key, so a copy of the database alone reveals nothing", () => {
    const underDevelopmentKey = identifierRef("chat_party", CLINIC, SENDER);
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "another-key-entirely-for-this-test-000000");
    expect(identifierRef("chat_party", CLINIC, SENDER)).not.toBe(underDevelopmentKey);
  });

  test("production refuses to run without a real key, or with one too short to be one", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "");
    expect(() => identifierRef("call", CLINIC, "call-1")).toThrow(
      /HEALDESK_IDENTIFIER_REF_KEY is not set/,
    );
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "short");
    expect(() => identifierRef("call", CLINIC, "call-1")).toThrow(/shorter than 32/);
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "k".repeat(44));
    expect(identifierRef("call", CLINIC, "call-1")).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("refuses a clinic id that is not a uuid and an empty identifier, and never echoes the value", () => {
    expect(() => identifierRef("chat_party", "not-a-clinic", SENDER)).toThrow(/not a uuid/);
    expect(() => identifierRef("chat_party", CLINIC, "")).toThrow(/no identifier/);
    expect(() => identifierRef("sms" as never, CLINIC, SENDER)).toThrow(/unknown kind/);
    try {
      identifierRef("chat_party", "not-a-clinic", SENDER);
    } catch (error) {
      expect(String(error)).not.toContain(SENDER);
    }
  });
});
