import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DemoPipelineRow, LiveDemoPipelineRow } from "@/components/admin/DemoPipelineRow";
import type { DemoPipeline } from "@/lib/demo/pipeline";
import { __resetDemoCacheForTests, createDemoSession, updateDemoSession } from "@/lib/demo/sessions";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * The demo pipeline strip states only what the register supports: a read
 * that failed prints an em-dash in every place a number would go and says
 * so, never a zero; a share with nothing built to convert from is an
 * em-dash, never 0%; and a capped read says the month is a floor. The live
 * variant, which reads the register itself for the admin home, keeps the
 * same rule when the read throws or the Sheet is not configured.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PIPELINE: DemoPipeline = {
  windows: [
    {
      days: 7,
      requested: 6,
      built: 2,
      live: 2,
      held: 1,
      failed: 1,
      stalled: 1,
      expired: 0,
      claimed: 1,
      bySource: [
        { source: "operator", built: 2, claimed: 1 },
        { source: "outreach", built: 0, claimed: 0 },
        { source: "homepage", built: 0, claimed: 0 },
      ],
    },
    {
      days: 30,
      requested: 8,
      built: 4,
      live: 2,
      held: 1,
      failed: 1,
      stalled: 1,
      expired: 1,
      claimed: 2,
      bySource: [
        { source: "operator", built: 2, claimed: 1 },
        { source: "outreach", built: 1, claimed: 0 },
        { source: "homepage", built: 1, claimed: 1 },
      ],
    },
  ],
  now: { live: 2, held: 1, failed: 1, stalled: 2 },
  rows: 9,
  truncated: false,
};

describe("the demo pipeline strip", () => {
  test("prints the month in plain words", () => {
    const strip = text(h(DemoPipelineRow, { pipeline: PIPELINE }));
    expect(strip).toContain("7 days: 6 requested → 2 built → 1 claimed (50%)");
    expect(strip).toContain("30 days: 8 requested → 4 built → 2 claimed (50%) · 1 expired unclaimed");
    expect(strip).toContain("now: 2 live · 1 held · 1 failed · 2 stalled");
    expect(strip).toContain("by source: operator 1/2 · outreach 0/1 · homepage 1/1");
    expect(strip).not.toContain("could not be read");
    expect(strip).not.toContain("floor");
  });

  test("a register that could not be read is em-dashes and a reason, never zeros", () => {
    const strip = text(h(DemoPipelineRow, { pipeline: null }));
    expect(strip).toContain("7 days: — requested → — built → — claimed (—)");
    expect(strip).toContain("now: — live · — held · — failed · — stalled");
    expect(strip).toContain("operator —/— · outreach —/— · homepage —/—");
    expect(strip).toContain("could not be read");
    expect(strip).not.toMatch(/\b0 requested|\b0 built|\b0 claimed|0%/);
  });

  test("nothing built gives no share, not 0%", () => {
    const empty: DemoPipeline = {
      ...PIPELINE,
      windows: PIPELINE.windows.map((w) => ({
        ...w,
        requested: 1,
        built: 0,
        claimed: 0,
        bySource: w.bySource.map((b) => ({ ...b, built: 0, claimed: 0 })),
      })),
    };
    const strip = text(h(DemoPipelineRow, { pipeline: empty }));
    expect(strip).toContain("7 days: 1 requested → 0 built → 0 claimed (—)");
    expect(strip).not.toContain("0%");
    expect(strip).not.toContain("could not be read");
  });

  test("a capped read says the month is a floor", () => {
    const strip = text(h(DemoPipelineRow, { pipeline: { ...PIPELINE, truncated: true } }));
    expect(strip).toContain("newest 500 rows only, so the 30-day numbers are a floor");
  });
});

describe("the live strip reads the register itself", () => {
  afterEach(() => {
    __setSheetsClientForTests(null);
    vi.restoreAllMocks();
  });

  async function live(): Promise<string> {
    return text(await LiveDemoPipelineRow());
  }

  test("counts the rows it finds", async () => {
    __setSheetsClientForTests(new FakeSheets());
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
    const now = new Date();
    const built = await createDemoSession({ clinicName: "Glow Spa", websiteUrl: "https://glowspa.test/", createdBy: "webhook" }, now);
    await updateDemoSession(built.slug, { status: "ready", readyAt: now, auditVerdict: "pass" });
    await createDemoSession({ clinicName: "Peachy", websiteUrl: "https://peachystudio.test/", createdBy: "homepage" }, now);

    const strip = await live();
    expect(strip).toContain("7 days: 2 requested → 1 built → 0 claimed (0%)");
    expect(strip).toContain("outreach 0/1 · homepage 0/0");
    expect(strip).not.toContain("could not be read");
  });

  test("a read that throws is em-dashes and a reason, and the page still renders", async () => {
    const broken = new FakeSheets();
    broken.getValues = async () => {
      throw new Error("quota exceeded");
    };
    __setSheetsClientForTests(broken);
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const strip = await live();
    expect(strip).toContain("7 days: — requested → — built → — claimed (—)");
    expect(strip).toContain("could not be read");
    expect(logged).toHaveBeenCalledWith("[healdesk] demo pipeline read failed", { error: "quota exceeded" });
  });

  test("an unconfigured Sheet is em-dashes too", async () => {
    vi.stubEnv("MARKETING_SHEET_ID", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
    try {
      const strip = await live();
      expect(strip).toContain("now: — live · — held · — failed · — stalled");
      expect(strip).toContain("could not be read");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
