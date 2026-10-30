import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { __resetDemoCacheForTests, createDemoSession, findDemoSession, getDemoSession } from "./sessions";

/**
 * A demo whose row the Sheet could not read is "unavailable", never missing:
 * the demo page showed the site's 404 for a demo that exists when a read
 * failed on a fresh instance (owner, 30 October 2026).
 */

let sheets: FakeSheets;

beforeEach(() => {
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __setSheetsClientForTests(null);
  vi.restoreAllMocks();
});

describe("findDemoSession", () => {
  it("says unavailable, not missing, when the Sheet cannot be read and nothing is cached", async () => {
    const created = await createDemoSession({ clinicName: "Glow Spa", websiteUrl: "https://glowspa.test/", leadEmail: "owner@glowspa.test" });
    __resetDemoCacheForTests();
    vi.spyOn(sheets, "getValues").mockRejectedValue(new Error("Quota exceeded"));
    expect(await findDemoSession(created.slug)).toBe("unavailable");
    expect(await getDemoSession(created.slug)).toBeNull();
  });

  it("finds a demo that exists, and says missing for one that does not", async () => {
    const created = await createDemoSession({ clinicName: "Glow Spa", websiteUrl: "https://glowspa.test/", leadEmail: "owner@glowspa.test" });
    __resetDemoCacheForTests();
    const found = await findDemoSession(created.slug);
    expect(found !== "unavailable" && found?.slug).toBe(created.slug);
    expect(await findDemoSession("nobody-abcdefghjk")).toBeNull();
  });
});
