import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgreementResult } from "@/components/checkout/AgreementStep";

import {
  AGREEMENT_KEY,
  clearStoredAgreement,
  readStoredAgreement,
  storeAgreement,
} from "./agreement-recovery";

/** Minimal Storage stand-in, the test environment is `node`, with no DOM. */
function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage & { map: Map<string, string> };
}

function install(storage: Storage | undefined) {
  vi.stubGlobal("sessionStorage", storage);
}

afterEach(() => vi.unstubAllGlobals());

const SIGNED = {
  agreementId: "3f1a0e2c-0000-4000-8000-000000000001",
  version: "1.0.0",
  documentHash: "abc123",
  acceptedAt: "2026-09-09T12:00:00.000Z",
  text: "BUSINESS ASSOCIATE AGREEMENT …",
} as unknown as AgreementResult;

describe("agreement recovery", () => {
  test("round-trips a signature", () => {
    install(fakeStorage());
    storeAgreement(SIGNED);
    expect(readStoredAgreement()).toEqual(SIGNED);
  });

  test("clearing removes it", () => {
    install(fakeStorage());
    storeAgreement(SIGNED);
    clearStoredAgreement();
    expect(readStoredAgreement()).toBeNull();
  });

  test("returns null when nothing was stored", () => {
    install(fakeStorage());
    expect(readStoredAgreement()).toBeNull();
  });

  /**
   * The whole point of the module. A signature writes a row to an append-only
   * table and returns an id that otherwise lives in one React cell; losing it
   * means the buyer must sign again, producing a second row for one act of
   * assent. So a record without an id is not a usable recovery and must not be
   * treated as one.
   */
  test("refuses a stored record with no agreement id", () => {
    const storage = fakeStorage();
    install(storage);
    storage.setItem(AGREEMENT_KEY, JSON.stringify({ version: "1.0.0" }));
    expect(readStoredAgreement()).toBeNull();
  });

  test("survives corrupted JSON rather than throwing on mount", () => {
    const storage = fakeStorage();
    install(storage);
    storage.setItem(AGREEMENT_KEY, "{not json");
    expect(readStoredAgreement()).toBeNull();
  });

  /**
   * Private browsing and blocked site data both make these accessors throw on
   * ACCESS, not return null. A checkout that crashes on mount there would be
   * worse than one with no recovery net, so every path has to degrade quietly.
   */
  test("degrades quietly when storage is unavailable", () => {
    install(undefined);
    expect(() => storeAgreement(SIGNED)).not.toThrow();
    expect(readStoredAgreement()).toBeNull();
    expect(() => clearStoredAgreement()).not.toThrow();
  });

  test("degrades quietly when storage throws on write", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    install(hostile);
    expect(() => storeAgreement(SIGNED)).not.toThrow();
    expect(readStoredAgreement()).toBeNull();
    expect(() => clearStoredAgreement()).not.toThrow();
  });
});
