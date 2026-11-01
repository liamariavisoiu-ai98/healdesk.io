import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests, DEMO_SESSIONS, ensureSheetSchema } from "@/lib/sheets/schema";

import { __resetDemoCacheForTests, createDemoSession, DEMO_BUILD_STALL_MS, getDemoSession, listDemoSessions, updateDemoSession, type DemoSession } from "./sessions";
import { RETRY_BATCH, retryStalledDemo, retryStalledDemos, runRetriedBuilds, sweepStalledDemos } from "./sweep";

/**
 * Stalled demo builds (lib/demo/sweep.ts): the sweep starts a stalled build
 * again once and tells Slack; at the second stall it marks the row failed,
 * tells Slack it needs a person and emails hello@; a build still running is
 * never touched; and "Retry all stalled" touches stalled rows only, however
 * often it is pressed. The `retry_count` column arrives on an existing
 * register without disturbing its rows.
 */

const postInternalAlert = vi.fn();
vi.mock("./alert", () => ({ postInternalAlert: (...args: unknown[]) => postInternalAlert(...args) }));

const runDemoBuild = vi.fn();
vi.mock("./build", () => ({ runDemoBuild: (...args: unknown[]) => runDemoBuild(...args) }));

const mailed: { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }[] = [];
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSafely: async (message: (typeof mailed)[number]) => {
    mailed.push(message);
    return { status: "sent", providerId: "re_1" };
  },
}));

const NOW = new Date("2026-10-23T12:00:00Z");
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let sheets: FakeSheets;

async function demo(name: string, startedAgoMs: number, patch: Partial<DemoSession> = {}): Promise<DemoSession> {
  const created = await createDemoSession(
    { clinicName: name, websiteUrl: `https://${name.toLowerCase().replace(/\s+/g, "")}.test/`, leadEmail: `owner@${name.toLowerCase().replace(/\s+/g, "")}.test` },
    ago(startedAgoMs),
  );
  const updated = await updateDemoSession(created.slug, { buildStartedAt: ago(startedAgoMs), ...patch });
  __resetDemoCacheForTests();
  return updated!;
}

async function fresh(slug: string): Promise<DemoSession> {
  __resetDemoCacheForTests();
  return (await getDemoSession(slug, { fresh: true }))!;
}

function writes(): number {
  return sheets.calls.filter((c) => c.startsWith("updateRange") || c.startsWith("appendRows")).length;
}

beforeEach(() => {
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
  postInternalAlert.mockReset();
  runDemoBuild.mockReset();
  runDemoBuild.mockResolvedValue(null);
  mailed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __setSheetsClientForTests(null);
  vi.restoreAllMocks();
});

describe("the sweep", () => {
  it("starts a stalled build again once, with a fresh clock, and tells Slack", async () => {
    const stalled = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE);
    const running = await demo("Radiance", 2 * MINUTE, { status: "auditing" });
    const ready = await demo("Peachy", 30 * MINUTE, { status: "ready", readyAt: ago(20 * MINUTE) });
    const held = await demo("Lumen", 30 * MINUTE, { status: "held" });
    const failed = await demo("Verve", 30 * MINUTE, { status: "failed", buildNote: "no services" });

    const sweep = await sweepStalledDemos(NOW);

    expect(sweep.retried.map((s) => s.slug)).toEqual([stalled.slug]);
    expect(sweep.gaveUp).toEqual([]);
    const again = await fresh(stalled.slug);
    expect(again.status).toBe("building");
    expect(again.buildStartedAt?.toISOString()).toBe(NOW.toISOString());
    expect(again.retryCount).toBe(1);
    expect(again.buildNote).toBeNull();
    expect(postInternalAlert).toHaveBeenCalledTimes(1);
    expect(postInternalAlert.mock.calls[0]![0]).toMatch(/^Demo build stalled: Glow Spa, retried\. /);
    expect(mailed).toEqual([]);
    // The sweep marks rows; the builds are the caller's to run.
    expect(runDemoBuild).not.toHaveBeenCalled();

    // Everything that was not stalled is exactly as it was.
    for (const before of [running, ready, held, failed]) {
      expect(await fresh(before.slug)).toEqual(before);
    }
  });

  it("at the second stall marks the row failed, tells Slack it needs a person, and emails hello@", async () => {
    const twice = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE, { retryCount: 1 });

    const sweep = await sweepStalledDemos(NOW);

    expect(sweep.retried).toEqual([]);
    expect(sweep.gaveUp.map((s) => s.slug)).toEqual([twice.slug]);
    const given = await fresh(twice.slug);
    expect(given.status).toBe("failed");
    expect(given.retryCount).toBe(1);
    expect(given.buildNote).toContain("stalled twice");
    expect(given.buildNote).toContain("3 minutes");
    expect(postInternalAlert).toHaveBeenCalledTimes(1);
    expect(postInternalAlert.mock.calls[0]![0]).toMatch(/^Demo build needs you: Glow Spa stalled twice\. /);

    expect(mailed).toHaveLength(1);
    const [mail] = mailed;
    expect(mail!.to).toBe("hello@healdesk.io");
    expect(mail!.subject).toBe("Demo build failed: glowspa.test");
    expect(mail!.text).toContain("stalled twice");
    expect(mail!.text).toContain("/admin/demos");
    expect(mail!.replyTo).toBe("owner@glowspa.test");
    expect(mail!.idempotencyKey).toBe(`hd-demo-stalled-${twice.id}-1`);

    // A failed row is not a stalled one: the next sweep says nothing more about it.
    postInternalAlert.mockReset();
    const quiet = await sweepStalledDemos(new Date(NOW.getTime() + 60 * MINUTE));
    expect(quiet).toEqual({ retried: [], gaveUp: [], failures: [], waiting: 0 });
    expect(postInternalAlert).not.toHaveBeenCalled();
    expect(mailed).toHaveLength(1);
  });

  it("leaves a build that is still running alone, and finds nothing on a second run", async () => {
    const running = await demo("Radiance", MINUTE);
    const stalled = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE);

    await sweepStalledDemos(NOW);
    expect(await fresh(running.slug)).toEqual(running);

    // A minute later the retried build is running on its fresh clock, and the
    // other is still inside its three: nothing is stalled.
    const before = writes();
    const second = await sweepStalledDemos(new Date(NOW.getTime() + MINUTE));
    expect(second).toEqual({ retried: [], gaveUp: [], failures: [], waiting: 0 });
    expect(writes()).toBe(before);
    expect((await fresh(stalled.slug)).retryCount).toBe(1);
  });
});

describe("when the cron and the button meet on one row", () => {
  it("a writer whose read sees the other's retry does nothing", async () => {
    const listed = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE);
    // The other door got there first: building on a fresh clock, count 1.
    await retryStalledDemo(listed, NOW);
    const before = writes();

    expect(await retryStalledDemo(listed, new Date(NOW.getTime() + MINUTE))).toBeNull();
    expect(writes()).toBe(before);
    expect((await fresh(listed.slug)).retryCount).toBe(1);
  });

  it("a writer holding a stale count does nothing, even if the row stalled again since", async () => {
    const listed = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE);
    // Retried by the other door, then stalled again: still stalled, count moved.
    await updateDemoSession(listed.slug, { retryCount: 1, buildStartedAt: ago(DEMO_BUILD_STALL_MS + MINUTE) });
    const before = writes();

    expect(await retryStalledDemo(listed, NOW)).toBeNull();
    expect(writes()).toBe(before);
    // The sweep, listing afresh, sees count 1 and gives up rather than retrying twice.
    const sweep = await sweepStalledDemos(NOW);
    expect(sweep.retried).toEqual([]);
    expect(sweep.gaveUp.map((s) => s.slug)).toEqual([listed.slug]);
  });
});

describe("Retry all stalled", () => {
  it("touches stalled rows only, whatever their count, and a second press changes nothing", async () => {
    const first = await demo("Glow Spa", DEMO_BUILD_STALL_MS + MINUTE);
    const already = await demo("Lumen", DEMO_BUILD_STALL_MS + 2 * MINUTE, { retryCount: 1 });
    const running = await demo("Radiance", 2 * MINUTE);
    const ready = await demo("Peachy", 30 * MINUTE, { status: "ready", readyAt: ago(20 * MINUTE) });
    const failed = await demo("Verve", 30 * MINUTE, { status: "failed", buildNote: "no services" });

    const { retried, failures } = await retryStalledDemos(NOW);

    // Longest stalled first.
    expect(failures).toEqual([]);
    expect(retried.map((s) => s.slug)).toEqual([already.slug, first.slug]);
    expect((await fresh(first.slug)).retryCount).toBe(1);
    expect((await fresh(already.slug)).retryCount).toBe(2);
    for (const s of retried) {
      expect(s.status).toBe("building");
      expect(s.buildStartedAt?.toISOString()).toBe(NOW.toISOString());
    }
    for (const before of [running, ready, failed]) {
      expect(await fresh(before.slug)).toEqual(before);
    }
    // An operator's press is not an alert.
    expect(postInternalAlert).not.toHaveBeenCalled();
    expect(mailed).toEqual([]);

    const before = writes();
    expect(await retryStalledDemos(new Date(NOW.getTime() + MINUTE))).toEqual({ retried: [], failures: [], waiting: 0 });
    expect(writes()).toBe(before);
  });

  it("runs the builds it is given, each on its own", async () => {
    await runRetriedBuilds(["a-bcdefghij2", "b-cdefghij23"]);
    expect(runDemoBuild.mock.calls.map((c) => c[0])).toEqual(["a-bcdefghij2", "b-cdefghij23"]);
  });
});

describe("the batch", () => {
  it("starts at most three builds a run, longest stalled first, and still gives up on the rows past them", async () => {
    expect(RETRY_BATCH).toBe(3);
    // Five never-retried stalled rows, the oldest stall first, and one past its retry.
    const stalled = [];
    for (let i = 5; i >= 1; i -= 1) stalled.push(await demo(`Clinic ${i}`, DEMO_BUILD_STALL_MS + i * MINUTE));
    const twice = await demo("Lumen", DEMO_BUILD_STALL_MS + 30 * 1000, { retryCount: 1 });

    const sweep = await sweepStalledDemos(NOW);

    expect(sweep.retried.map((s) => s.clinicName)).toEqual(["Clinic 5", "Clinic 4", "Clinic 3"]);
    expect(sweep.waiting).toBe(2);
    expect(sweep.failures).toEqual([]);
    for (const left of stalled.slice(3)) expect(await fresh(left.slug)).toEqual(left);
    // Giving up starts no build, so the batch does not hold it back.
    expect(sweep.gaveUp.map((s) => s.slug)).toEqual([twice.slug]);
    expect((await fresh(twice.slug)).status).toBe("failed");

    // The next run, with the three still building on their fresh clocks, takes the two that waited.
    const next = await sweepStalledDemos(new Date(NOW.getTime() + MINUTE));
    expect(next.retried.map((s) => s.clinicName)).toEqual(["Clinic 2", "Clinic 1"]);
    expect(next.waiting).toBe(0);
  });

  it("holds Retry all stalled to the same batch", async () => {
    for (let i = 4; i >= 1; i -= 1) await demo(`Clinic ${i}`, DEMO_BUILD_STALL_MS + i * MINUTE);

    const first = await retryStalledDemos(NOW);
    expect(first.retried.map((s) => s.clinicName)).toEqual(["Clinic 4", "Clinic 3", "Clinic 2"]);
    expect(first.waiting).toBe(1);

    const second = await retryStalledDemos(new Date(NOW.getTime() + MINUTE));
    expect(second.retried.map((s) => s.clinicName)).toEqual(["Clinic 1"]);
    expect(second.waiting).toBe(0);
  });
});

describe("a row that cannot be handled", () => {
  /** The Sheet refuses every write to one row (its quota, say); reads and the other rows are fine. */
  function refuseWritesTo(row: number): void {
    const real = sheets.updateRange.bind(sheets);
    sheets.updateRange = async (range, rows) => {
      if (new RegExp(`!A${row}:[A-Z]+${row}$`).test(range)) throw new Error("quota exceeded");
      return real(range, rows);
    };
  }

  it("is stepped over by the sweep, which keeps the earlier row's retry and reports the failure", async () => {
    // Rows 2 and 3 of the tab; the longer-stalled one is handled first.
    const first = await demo("Glow Spa", DEMO_BUILD_STALL_MS + 10 * MINUTE);
    const second = await demo("Lumen", DEMO_BUILD_STALL_MS + MINUTE);
    refuseWritesTo(3);

    const sweep = await sweepStalledDemos(NOW);

    expect(sweep.retried.map((s) => s.slug)).toEqual([first.slug]);
    expect(sweep.gaveUp).toEqual([]);
    expect(sweep.failures).toEqual([{ slug: second.slug, error: "quota exceeded" }]);
    expect((await fresh(first.slug)).retryCount).toBe(1);
    expect(await fresh(second.slug)).toEqual(second);
    expect(postInternalAlert).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[healdesk] demo stall sweep: a row could not be handled", {
      slug: second.slug,
      error: "quota exceeded",
    });
  });

  it("with its id blanked by hand still goes failed, is reported, and costs no other row its retry", async () => {
    const first = await demo("Glow Spa", DEMO_BUILD_STALL_MS + 10 * MINUTE);
    const twice = await demo("Lumen", DEMO_BUILD_STALL_MS + MINUTE, { retryCount: 1 });
    // The email's key refuses an empty row id.
    sheets.tabs.get(DEMO_SESSIONS.title)![2]![0] = "";
    __resetDemoCacheForTests();

    const sweep = await sweepStalledDemos(NOW);

    expect(sweep.retried.map((s) => s.slug)).toEqual([first.slug]);
    expect(sweep.gaveUp.map((s) => s.slug)).toEqual([twice.slug]);
    expect(sweep.failures).toHaveLength(1);
    expect(sweep.failures[0]!.slug).toBe(twice.slug);
    expect(sweep.failures[0]!.error).toMatch(/row id/);
    expect((await fresh(first.slug)).retryCount).toBe(1);
    expect((await fresh(twice.slug)).status).toBe("failed");
    expect(postInternalAlert).toHaveBeenCalledTimes(2);
    expect(mailed).toEqual([]);
  });

  it("is stepped over by Retry all stalled too", async () => {
    const first = await demo("Glow Spa", DEMO_BUILD_STALL_MS + 10 * MINUTE);
    const second = await demo("Lumen", DEMO_BUILD_STALL_MS + MINUTE);
    refuseWritesTo(3);

    const { retried, failures } = await retryStalledDemos(NOW);

    expect(retried.map((s) => s.slug)).toEqual([first.slug]);
    expect(failures).toEqual([{ slug: second.slug, error: "quota exceeded" }]);
    expect(await fresh(second.slug)).toEqual(second);
  });
});

describe("the retry_count column", () => {
  it("is added to an existing register, whose older rows read as never retried", async () => {
    // A register provisioned before the column: the header stopping short of it, and a row to match.
    const older = DEMO_SESSIONS.columns.slice(0, DEMO_SESSIONS.columns.findIndex((c) => c.header === "retry_count"));
    expect(older[older.length - 1]!.header).toBe("audit_hash");
    const tab = DEMO_SESSIONS.title;
    sheets.tabs.set(tab, [older.map((c) => c.header)]);
    const cells = older.map((c) => {
      if (c.header === "id") return "row-1";
      if (c.header === "slug") return "old-clinic-abcdefghij";
      if (c.header === "status") return "ready";
      if (c.header === "clinic_name") return "Old Clinic";
      if (c.header === "website_url") return "https://old.test/";
      if (c.header === "created_at" || c.header === "ready_at") return "2026-10-20T10:00:00.000Z";
      if (c.header === "expires_at") return "2026-10-27T10:00:00.000Z";
      if (c.type === "bool") return false;
      return "";
    });
    sheets.tabs.get(tab)!.push(cells);

    await ensureSheetSchema(sheets);
    expect(sheets.tabs.get(tab)![0]).toEqual(DEMO_SESSIONS.columns.map((c) => c.header));

    const [row] = await listDemoSessions();
    expect(row?.slug).toBe("old-clinic-abcdefghij");
    expect(row?.retryCount).toBe(0);
    expect(row?.auditHash).toBeNull();

    // A write keeps the row aligned under the longer header.
    await updateDemoSession(row!.slug, { retryCount: 2 });
    const stored = sheets.tabs.get(tab)![1]!;
    expect(stored.length).toBe(DEMO_SESSIONS.columns.length);
    expect(stored[DEMO_SESSIONS.columns.findIndex((c) => c.header === "retry_count")]).toBe(2);
    __resetDemoCacheForTests();
    expect((await getDemoSession(row!.slug, { fresh: true }))?.retryCount).toBe(2);
  });
});
