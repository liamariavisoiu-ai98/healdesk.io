import { beforeEach, describe, expect, test, vi } from "vitest";

import { __resetDemoCacheForTests, createDemoSession, readDemoSession } from "@/lib/demo/sessions";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * A demo link must never say "not found" for a demo that exists (owner,
 * 31 October 2026: Miami Skin & Vein's live link showed the 404 page). The
 * waiting page reads the register every few seconds, so a refused read is
 * expected: it is `unavailable`, and the page waits and tries again.
 */

let sheets: FakeSheets;

beforeEach(() => {
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
  vi.restoreAllMocks();
});

describe("readDemoSession", () => {
  test("a demo that exists is found; one that does not is null, and neither is unavailable", async () => {
    const made = await createDemoSession({ clinicName: "Miami Skin & Vein", websiteUrl: "https://miamiskinandvein.com/" });
    __resetDemoCacheForTests();
    const found = await readDemoSession(made.slug);
    expect(found.unavailable).toBe(false);
    expect(found.session?.slug).toBe(made.slug);
    expect(await readDemoSession("no-such-clinic-k7q2mz9xwa")).toEqual({ session: null, unavailable: false });
  });

  test("a refused read with nothing cached is unavailable, never null; with an earlier read, that read stands", async () => {
    const made = await createDemoSession({ clinicName: "Miami Skin & Vein", websiteUrl: "https://miamiskinandvein.com/" });
    __resetDemoCacheForTests();
    const refuse = vi.spyOn(sheets, "getValues").mockRejectedValue(new Error("Quota exceeded for quota metric 'Read requests'"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readDemoSession(made.slug)).toEqual({ session: null, unavailable: true });
    refuse.mockRestore();
    // Read once, then refused past the cache's few seconds: the last good read is served.
    const first = await readDemoSession(made.slug);
    expect(first.session?.slug).toBe(made.slug);
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 });
    try {
      vi.spyOn(sheets, "getValues").mockRejectedValue(new Error("429"));
      const again = await readDemoSession(made.slug);
      expect(again).toMatchObject({ unavailable: false, session: { slug: made.slug } });
    } finally {
      vi.useRealTimers();
    }
  });
});
