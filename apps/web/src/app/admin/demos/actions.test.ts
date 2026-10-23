import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetDemoCacheForTests, createDemoSession, DEMO_BUILD_STALL_MS, getDemoSession, updateDemoSession, type DemoSession } from "@/lib/demo/sessions";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * The console's retry actions on the register: "Retry all stalled" starts
 * every stalled build again and no other, runs those builds after it
 * returns, and refuses a caller who is not signed in; the per-row Retry on
 * a stalled row counts as a retry, and on a finished demo does not.
 */

const operator = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@/lib/admin/operator", () => ({
  requireOperator: async () => (operator.signedIn ? "ops@healdesk.test" : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const afterFns: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void afterFns.push(fn),
}));

const runDemoBuild = vi.fn();
vi.mock("@/lib/demo/build", () => ({
  runDemoBuild: (...args: unknown[]) => runDemoBuild(...args),
  releaseHeldDemo: vi.fn(),
  requestDemo: vi.fn(),
  sendDemoEmail: vi.fn(),
}));

/** The real retry, except where a test stands in for the other door getting there first. */
const retryStalledDemo = vi.fn();
vi.mock("@/lib/demo/sweep", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/demo/sweep")>();
  retryStalledDemo.mockImplementation(original.retryStalledDemo);
  return { ...original, retryStalledDemo: (...args: Parameters<typeof original.retryStalledDemo>) => retryStalledDemo(...args) };
});

const { retryDemoAction, retryStalledDemosAction } = await import("./actions");

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function demo(name: string, startedAgoMs: number, patch: Partial<DemoSession> = {}): Promise<DemoSession> {
  const created = await createDemoSession({ clinicName: name, websiteUrl: `https://${name.toLowerCase()}.test/` }, ago(startedAgoMs));
  const updated = await updateDemoSession(created.slug, { buildStartedAt: ago(startedAgoMs), ...patch });
  __resetDemoCacheForTests();
  return updated!;
}

async function fresh(slug: string): Promise<DemoSession> {
  __resetDemoCacheForTests();
  return (await getDemoSession(slug, { fresh: true }))!;
}

async function runAfter(): Promise<void> {
  for (const fn of afterFns.splice(0)) await fn();
}

function form(slug: string): FormData {
  const data = new FormData();
  data.set("slug", slug);
  return data;
}

let sheets: FakeSheets;

beforeEach(() => {
  operator.signedIn = true;
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
  runDemoBuild.mockReset();
  runDemoBuild.mockResolvedValue(null);
  retryStalledDemo.mockClear();
  afterFns.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __setSheetsClientForTests(null);
  vi.restoreAllMocks();
});

describe("Retry all stalled", () => {
  test("starts every stalled build again, runs them after returning, and touches nothing else", async () => {
    const stalled = await demo("Glow", DEMO_BUILD_STALL_MS + MINUTE);
    const running = await demo("Radiance", 2 * MINUTE, { status: "auditing" });
    const ready = await demo("Peachy", 30 * MINUTE, { status: "ready", readyAt: ago(20 * MINUTE) });
    const failed = await demo("Verve", 30 * MINUTE, { status: "failed", buildNote: "no services" });

    await retryStalledDemosAction();

    const again = await fresh(stalled.slug);
    expect(again.status).toBe("building");
    expect(again.retryCount).toBe(1);
    for (const before of [running, ready, failed]) expect(await fresh(before.slug)).toEqual(before);

    expect(runDemoBuild).not.toHaveBeenCalled();
    await runAfter();
    expect(runDemoBuild.mock.calls.map((c) => c[0])).toEqual([stalled.slug]);

    // Pressed again straight away: nothing is stalled, nothing is scheduled.
    await retryStalledDemosAction();
    expect(afterFns).toEqual([]);
    expect((await fresh(stalled.slug)).retryCount).toBe(1);
  });

  test("a row the Sheet refuses to write costs no earlier row its build", async () => {
    // Rows 2 and 3 of the tab; the longer-stalled one is handled first.
    const first = await demo("Glow", DEMO_BUILD_STALL_MS + 10 * MINUTE);
    const second = await demo("Lumen", DEMO_BUILD_STALL_MS + MINUTE);
    const real = sheets.updateRange.bind(sheets);
    sheets.updateRange = async (range, rows) => {
      if (/!A3:[A-Z]+3$/.test(range)) throw new Error("quota exceeded");
      return real(range, rows);
    };

    await retryStalledDemosAction();
    await runAfter();

    expect(runDemoBuild.mock.calls.map((c) => c[0])).toEqual([first.slug]);
    expect((await fresh(first.slug)).retryCount).toBe(1);
    expect(await fresh(second.slug)).toEqual(second);
  });

  test("does nothing for a caller who is not signed in", async () => {
    const stalled = await demo("Glow", DEMO_BUILD_STALL_MS + MINUTE);
    operator.signedIn = false;
    await retryStalledDemosAction();
    expect(await fresh(stalled.slug)).toEqual(stalled);
    expect(afterFns).toEqual([]);
  });
});

describe("the per-row Retry", () => {
  test("counts a stalled build started again, and not a rebuild of a finished one", async () => {
    const stalled = await demo("Glow", DEMO_BUILD_STALL_MS + MINUTE);
    const ready = await demo("Peachy", 30 * MINUTE, { status: "ready", readyAt: ago(20 * MINUTE) });
    const running = await demo("Radiance", 2 * MINUTE);

    await retryDemoAction(form(stalled.slug));
    expect((await fresh(stalled.slug)).retryCount).toBe(1);

    await retryDemoAction(form(ready.slug));
    const rebuilt = await fresh(ready.slug);
    expect(rebuilt.status).toBe("building");
    expect(rebuilt.retryCount).toBe(0);

    await retryDemoAction(form(running.slug));
    expect(await fresh(running.slug)).toEqual(running);

    await runAfter();
    expect(runDemoBuild.mock.calls.map((c) => c[0])).toEqual([stalled.slug, ready.slug]);
  });

  test("starts no build when the retry finds someone else already did", async () => {
    const stalled = await demo("Glow", DEMO_BUILD_STALL_MS + MINUTE);
    // Between this action's read and its write, the sweep got there: the row
    // is building on a fresh clock and its build is running.
    retryStalledDemo.mockResolvedValueOnce(null);

    await retryDemoAction(form(stalled.slug));

    expect(retryStalledDemo).toHaveBeenCalledTimes(1);
    expect(afterFns).toEqual([]);
    await runAfter();
    expect(runDemoBuild).not.toHaveBeenCalled();
  });
});
