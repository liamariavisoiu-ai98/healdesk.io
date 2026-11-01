import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { DEMO_SESSIONS, ensureSheetSchema, __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import type { AuditInput, AuditReport } from "./audit";
import { normalizeProfile } from "./profile";
import { __resetDemoCacheForTests, createDemoSession, getDemoSession, listDemoSessions, profileOf, updateDemoSession } from "./sessions";

/**
 * The fill step of the build (lib/demo/build.ts, lib/demo/samples.ts; owner,
 * 1 November 2026): what the demo makes up is worked out once, stored on the
 * row beside the profile and never in it, read back by every surface, and
 * checked as it is stored, a failed check holding the demo like any audit
 * blocker. The scrape, the extraction and the audit's model calls are
 * stubbed; the register is the fake Sheet.
 */

vi.mock("./alert", () => ({ postInternalAlert: async () => undefined }));
vi.mock("./google-listing", () => ({ fetchGoogleListing: async () => null }));
vi.mock("./scrape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scrape")>()),
  scrapeClinicSite: async () => ({
    pages: [{ url: "https://glow.test/", title: "Glow", text: "Botox. Microneedling. Mystery Glow facial ritual. Teeth whitening $399." }],
    brand: { name: "Glow", logoUrl: null, color: null },
    source: "fetch",
    apifyNote: null,
  }),
}));

const RAW = {
  clinic_name: "Glow Med Spa",
  services: [{ name: "Botox" }, { name: "Microneedling" }, { name: "Mystery Glow" }],
};
vi.mock("./structure", () => ({ structureProfile: async () => normalizeProfile(RAW, "Glow Med Spa") }));

const auditDemo = vi.fn<(input: AuditInput) => Promise<AuditReport>>();
vi.mock("./audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audit")>()),
  auditDemo: (input: AuditInput) => auditDemo(input),
}));

const checkDemoFill = vi.fn<(...args: unknown[]) => string[]>();
vi.mock("./samples", async (importOriginal) => {
  const real = await importOriginal<typeof import("./samples")>();
  return { ...real, checkDemoFill: (...args: Parameters<typeof real.checkDemoFill>) => checkDemoFill(...args) ?? real.checkDemoFill(...args) };
});

const { runDemoBuild } = await import("./build");
const { decide } = await import("./audit");
const { demoFillOf, liveDemo, fillDemo, sampledForCall } = await import("./samples");

function passing(input: AuditInput): AuditReport {
  const scores = { accuracy: 90, conversation: 90, personalisation: 90, voice: 90, presentation: 90 };
  return { version: 1, model: "claude-opus-5-5", round: input.round, scores, overall: 90, blockers: [], findings: [], summary: "Good.", probes: [], decision: decide({ overall: 90, scores, blockers: [] }, { canRepair: input.canRepair }), previous: null };
}

describe("the fill step", () => {
  beforeEach(() => {
    __setSheetsClientForTests(new FakeSheets());
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
    auditDemo.mockReset().mockImplementation(async (input) => passing(input));
    checkDemoFill.mockReset().mockReturnValue(undefined as never);
  });
  afterEach(() => __setSheetsClientForTests(null));

  it("stores the fill beside the profile, never in it, and every surface reads it back", async () => {
    const demo = await createDemoSession({ clinicName: "Glow Med Spa", websiteUrl: "https://glow.test/" });
    const done = await runDemoBuild(demo.slug);
    expect(done?.status).toBe("ready");

    __resetDemoCacheForTests();
    const row = (await getDemoSession(demo.slug, { fresh: true }))!;
    const profile = profileOf(row)!;
    // The profile is the website's: nothing made up in it, so the audit read the facts alone.
    expect(profile.services.map((s) => s.price)).toEqual([null, null, null]);
    expect(auditDemo.mock.calls[0]![0].profile.services.map((s) => s.price)).toEqual([null, null, null]);

    const fill = demoFillOf(row.demoFill)!;
    expect(fill.items.map((i) => [i.kind, i.basis])).toEqual([
      ["calendar", "sample"],
      ["price", "benchmark"],
      ["price", "benchmark"],
      ["price", "consultation"],
      ["hours", "sample"],
      ["deposit", "sample"],
    ]);
    // Read back from the Sheet, it is the one the surfaces use, not a fresh one.
    const live = liveDemo(profile, row.demoFill);
    expect(live.fill.filledAt).toBe(fill.filledAt);
    expect(live.fill.filledAt).not.toBe(fillDemo(profile, new Date(0)).filledAt);
    expect(live.profile.services.map((s) => s.price)).toEqual(["$14/unit", "$938", "Price at consultation"]);
    expect(live.invented).toEqual(["calendar", "prices", "hours", "deposit"]);
    expect(sampledForCall(live.fill)).toEqual({ prices: ["Botox", "Microneedling"], menu: false, hours: true, deposit: true });
  });

  it("holds the demo when the fill fails its check, as an audit blocker does", async () => {
    checkDemoFill.mockReturnValue(["The made-up price $90/unit for \"Botox\" is outside the benchmark range for neurotoxin."]);
    const demo = await createDemoSession({ clinicName: "Glow Med Spa", websiteUrl: "https://glow.test/" });
    const done = await runDemoBuild(demo.slug);
    expect(done?.status).toBe("held");
    expect(done?.auditVerdict).toBe("held");
    const report = done!.auditReport as unknown as AuditReport;
    expect(report.decision).toBe("held");
    expect(report.blockers[0]).toMatchObject({ code: "invented_fact", where: "demo: made-up values", source: "check" });
  });

  it("adds its column to a register made before it, whose rows read as having no fill", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    const older = DEMO_SESSIONS.columns.slice(0, -1);
    expect(older[older.length - 1]!.header).toBe("retry_count");
    sheets.tabs.set(DEMO_SESSIONS.title, [older.map((c) => c.header)]);
    sheets.tabs.get(DEMO_SESSIONS.title)!.push(
      older.map((c) => {
        if (c.header === "id") return "row-1";
        if (c.header === "slug") return "old-clinic-abcdefghij";
        if (c.header === "status") return "ready";
        if (c.header === "clinic_name") return "Old Clinic";
        if (c.header === "website_url") return "https://old.test/";
        if (c.header === "created_at") return "2026-10-20T10:00:00.000Z";
        if (c.header === "expires_at") return "2026-10-27T10:00:00.000Z";
        if (c.type === "bool") return false;
        return "";
      }),
    );
    await ensureSheetSchema(sheets);
    expect(sheets.tabs.get(DEMO_SESSIONS.title)![0]).toEqual(DEMO_SESSIONS.columns.map((c) => c.header));
    const [row] = await listDemoSessions();
    expect(row?.demoFill).toBeNull();
    await updateDemoSession(row!.slug, { demoFill: { v: 1 } });
    expect(sheets.tabs.get(DEMO_SESSIONS.title)![1]!.length).toBe(DEMO_SESSIONS.columns.length);
  });
});
