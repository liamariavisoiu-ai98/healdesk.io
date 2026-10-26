import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { listDemoCallbacks, markDemoCallbackCalled, purgeStaleDemoCallbacks, recordDemoCallback, type NewDemoCallback } from "./callbacks";

/**
 * The call backs' queue (lib/demo/callbacks.ts): "Called" deletes the row, the
 * daily purge deletes what nobody marked after 30 days, and the order is the
 * order to ring them in. The number is kept nowhere else on this tab.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 9, 26, 12));

function input(overrides: Partial<NewDemoCallback> = {}): NewDemoCallback {
  return {
    slug: "lumen-aesthetics-ab2cd3ef4g",
    clinicName: "Lumen Aesthetics",
    firstName: "Josh",
    phoneE164: "+15125550147",
    topic: "Pricing",
    test: false,
    offerEndsAt: null,
    leadEmail: null,
    ...overrides,
  };
}

let sheets: FakeSheets;

beforeEach(() => {
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
});

afterEach(() => {
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("the demo call-back queue", () => {
  test("oldest first; a repeat within the hour is the same request, a later one a new one", async () => {
    const first = await recordDemoCallback(input(), new Date(NOW.getTime() - 2 * DAY));
    const other = await recordDemoCallback(input({ phoneE164: "+15125550148", firstName: "Ana" }), new Date(NOW.getTime() - DAY));
    const repeat = await recordDemoCallback(input(), new Date(NOW.getTime() - 2 * DAY + 30 * 60_000));
    const later = await recordDemoCallback(input(), NOW);
    expect(first.ok && other.ok && repeat.ok && later.ok).toBe(true);
    if (!first.ok || !repeat.ok || !later.ok) return;
    expect(repeat.repeat).toBe(true);
    expect(repeat.callback.id).toBe(first.callback.id);
    expect(later.repeat).toBe(false);
    expect((await listDemoCallbacks()).map((c) => c.firstName)).toEqual(["Josh", "Ana", "Josh"]);
  });

  test("Called deletes the row, number and all; a second press finds nothing", async () => {
    const kept = await recordDemoCallback(input(), NOW);
    if (!kept.ok) throw new Error("not kept");
    expect(await markDemoCallbackCalled(kept.callback.id)).toBe(true);
    expect(await listDemoCallbacks()).toEqual([]);
    expect(JSON.stringify(sheets.tabs.get("demo_callbacks"))).not.toContain("+15125550147");
    expect(await markDemoCallbackCalled(kept.callback.id)).toBe(false);
  });

  test("the purge deletes what nobody marked after 30 days, and only that", async () => {
    await recordDemoCallback(input({ phoneE164: "+15125550141" }), new Date(NOW.getTime() - 31 * DAY));
    await recordDemoCallback(input({ phoneE164: "+15125550142" }), new Date(NOW.getTime() - 30 * DAY));
    await recordDemoCallback(input({ phoneE164: "+15125550143" }), new Date(NOW.getTime() - 29 * DAY));
    expect(await purgeStaleDemoCallbacks(30, NOW)).toBe(2);
    expect((await listDemoCallbacks()).map((c) => c.phoneE164)).toEqual(["+15125550143"]);
  });
});
