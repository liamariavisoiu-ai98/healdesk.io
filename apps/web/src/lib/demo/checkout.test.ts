import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createGateToken } from "@/lib/gate";
import { recordDemoUnlock } from "@/lib/leads";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { gatePrefill } from "./checkout";

/**
 * The homepage chat demo's gate, as /get-started's pre-fill (plan Part A3:
 * "Email and specialty are pre-filled from the demo gate when present"): the
 * address from our own signed cookie, the specialty from the lead row the
 * gate wrote, and nothing from a cookie that does not verify.
 */

beforeEach(() => {
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("the demo gate's pre-fill", () => {
  test("the address the demo was unlocked with, and the specialty demoed", async () => {
    await recordDemoUnlock({ email: "laura@glowmedspa.com", isBusinessEmail: true, specialty: "dental" });
    expect(await gatePrefill(createGateToken("laura@glowmedspa.com"))).toEqual({
      contactEmail: "laura@glowmedspa.com",
      specialty: "dental",
    });
  });

  test("the address alone when the lead row has no specialty", async () => {
    await recordDemoUnlock({ email: "laura@glowmedspa.com", isBusinessEmail: true });
    expect(await gatePrefill(createGateToken("laura@glowmedspa.com"))).toEqual({
      contactEmail: "laura@glowmedspa.com",
    });
  });

  test("nothing without a cookie, or from one that does not verify", async () => {
    expect(await gatePrefill(undefined)).toBeUndefined();
    const token = createGateToken("laura@glowmedspa.com");
    const forged = `${Buffer.from("mallory@evil.test").toString("base64url")}.${token.split(".")[1]}.${token.split(".")[2]}`;
    expect(await gatePrefill(forged)).toBeUndefined();
    expect(await gatePrefill("not-a-token")).toBeUndefined();
  });

  test("nothing in production without the signing secret, rather than a throw", async () => {
    const token = createGateToken("laura@glowmedspa.com");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEALDESK_GATE_SECRET", "");
    expect(await gatePrefill(token)).toBeUndefined();
  });
});
