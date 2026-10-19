import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "./sheets/client";
import { __resetSheetSchemaForTests } from "./sheets/schema";
import {
  GLOBAL_CAP_KEYS,
  isGlobalCapKey,
  __resetRateLimiterForTests,
  clientKey,
  isOverLimit,
  rateLimit,
  releaseRateLimit,
} from "./rate-limit";

/**
 * Two kinds of key. Everything per-visitor lives in this process's memory
 * and never touches the Sheet; the two site-wide daily caps go through the
 * `counters` tab, on a cached read, and survive a fresh instance.
 */

const key = () => `test:${Math.random()}`;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  __resetRateLimiterForTests();
  __resetSheetSchemaForTests();
  __setSheetsClientForTests(null);
  delete process.env.MARKETING_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
});

afterEach(() => {
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("rateLimit (per-instance keys)", () => {
  it("allows up to the limit then refuses, and says when to retry", async () => {
    const k = key();
    for (let i = 0; i < 10; i += 1) {
      const r = await rateLimit(k, 10, 60_000);
      expect(r.ok, `call ${i + 1}`).toBe(true);
      expect(r.remaining).toBe(9 - i);
    }
    const eleventh = await rateLimit(k, 10, 60_000);
    expect(eleventh.ok).toBe(false);
    expect(eleventh.remaining).toBe(0);
    expect(eleventh.retryAfter).toBeGreaterThan(0);
    expect(eleventh.retryAfter).toBeLessThanOrEqual(60);
  });

  it("isOverLimit does not spend from the budget", async () => {
    const k = key();
    for (let i = 0; i < 100; i += 1) expect(await isOverLimit(k, 2)).toBe(false);
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    expect(await isOverLimit(k, 2)).toBe(true);
  });

  it("starts a fresh window once the old one has closed", async () => {
    // The clock is frozen, because a 1ms window on the real one closes again
    // whenever the reopening call and the check after it straddle a
    // millisecond, and under load they did: 12 failures in 178 full runs.
    const k = key();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      expect((await rateLimit(k, 1, 1)).ok).toBe(true);
      // The 1ms window has closed by the time the second call arrives.
      vi.setSystemTime(start + 15);
      expect((await rateLimit(k, 1, 1)).ok).toBe(true);
      expect(await isOverLimit(k, 1)).toBe(true);
      vi.setSystemTime(start + 30);
      expect(await isOverLimit(k, 1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clientKey takes the first x-forwarded-for entry, which is what Vercel sets", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientKey(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientKey(new Headers())).toBe("unknown");
  });

  it("never touches the Sheet, even when one is configured", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    for (const k of ["chat:203.0.113.9", "gate:203.0.113.9", "admin-session:203.0.113.9", "callback:num:+14155550100"]) {
      await rateLimit(k, 5, 60_000);
      await isOverLimit(k, 5);
    }
    expect(sheets.calls).toEqual([]);
  });
});

describe("rateLimit (the global daily caps)", () => {
  it("names exactly the eight daily caps the routes use", () => {
    expect([...GLOBAL_CAP_KEYS].sort()).toEqual([
      "callback:global:day",
      "chat:global:day",
      "own-demo:global:day",
      "site-read:global:day",
      "site-read:signed:day",
      "voice-demo-webcall:global:day",
      // The emails AYA's demo calls may send in a day (19 October 2026).
      "voice-followup:day",
      "webcall:global:day",
    ]);
  });

  it("also shares the contact form's per-address acknowledgement limit, and nothing else per visitor", () => {
    expect(isGlobalCapKey("contact-ack:0123456789abcdef")).toBe(true);
    // The signed re-reads' per-clinic limit: apps/app's, never a visitor's.
    expect(isGlobalCapKey("site-read:clinic:0c1d2e3f-0000-4000-8000-000000000000")).toBe(true);
    // The signer's copy of the agreement, once per unconfirmed address a day (P6).
    expect(isGlobalCapKey("agreement-copy:0123456789abcdef")).toBe(true);
    expect(isGlobalCapKey("agreement:10.0.0.1")).toBe(false);
    expect(isGlobalCapKey("site-read:10.0.0.1")).toBe(false);
    expect(isGlobalCapKey("contact:10.0.0.1")).toBe(false);
    expect(isGlobalCapKey("setup-request:10.0.0.1")).toBe(false);
    expect(isGlobalCapKey("admin-sign-in:10.0.0.1")).toBe(false);
  });

  it("serialises one key's calls, so two at once cannot both pass a limit of one, and gives a count back", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    const k = "agreement-copy:0123456789abcdef";
    const [a, b] = await Promise.all([rateLimit(k, 1, DAY), rateLimit(k, 1, DAY)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    // Both are given back: the one that passed and the one past the limit.
    await releaseRateLimit(k);
    await releaseRateLimit(k);
    __resetRateLimiterForTests();
    expect((await rateLimit(k, 1, DAY)).ok).toBe(true);
    expect(sheets.records("counters")[0]!.count).toBe(1);
    // Never below zero.
    await releaseRateLimit(k);
    await releaseRateLimit(k);
    __resetRateLimiterForTests();
    expect(sheets.records("counters")[0]!.count).toBe(0);
  });

  it("goes through the counters tab and survives a fresh instance", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);

    expect((await rateLimit("chat:global:day", 3, DAY)).remaining).toBe(2);
    expect((await rateLimit("chat:global:day", 3, DAY)).remaining).toBe(1);
    const rows = sheets.records("counters");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("chat:global:day");
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.window_ms).toBe(DAY);
    expect(rows[0]!.window_start).toMatch(/Z$/);

    // A cold start: memory gone, the Sheet still there.
    __resetRateLimiterForTests();
    const third = await rateLimit("chat:global:day", 3, DAY);
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = await rateLimit("chat:global:day", 3, DAY);
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfter).toBeGreaterThan(0);
    expect(fourth.retryAfter).toBeLessThanOrEqual(DAY / 1000);
    expect(sheets.records("counters")[0]!.count).toBe(4);
    // Still one row per key: updates in place, never a new row per request.
    expect(sheets.records("counters")).toHaveLength(1);
  });

  it("keeps the two caps on separate rows", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    await rateLimit("chat:global:day", 100, DAY);
    await rateLimit("callback:global:day", 100, DAY);
    await rateLimit("callback:global:day", 100, DAY);
    const byKey = Object.fromEntries(sheets.records("counters").map((r) => [r.key, r.count]));
    expect(byKey).toEqual({ "chat:global:day": 1, "callback:global:day": 2 });
  });

  it("reads the row at most once per refresh interval", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    for (let i = 0; i < 5; i += 1) await rateLimit("chat:global:day", 100, DAY);
    const reads = sheets.calls.filter((c) => c === "getValues counters!A2:D");
    expect(reads).toHaveLength(1);
    // The header row write from provisioning is not a counter write.
    const writes = sheets.calls.filter((c) => c === "updateRange counters!A2:D2" || c === "appendRows counters");
    expect(writes).toHaveLength(5);
  });

  it("peeks without spending", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    expect(await isOverLimit("callback:global:day", 2)).toBe(false);
    await rateLimit("callback:global:day", 2, DAY);
    await rateLimit("callback:global:day", 2, DAY);
    expect(await isOverLimit("callback:global:day", 2)).toBe(true);
    expect(sheets.records("counters")[0]!.count).toBe(2);
  });

  it("starts a fresh window once the shared one has closed", async () => {
    // On a frozen clock, like its per-instance twin above, and at both edges
    // of the window: refused a millisecond before it closes, fresh the moment
    // it does. Only Date is faked: the one timer on this path is the real
    // Sheets client's backoff, which FakeSheets never reaches.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const sheets = new FakeSheets();
      __setSheetsClientForTests(sheets);
      expect((await rateLimit("chat:global:day", 1, 200)).ok).toBe(true);
      vi.advanceTimersByTime(199);
      expect((await rateLimit("chat:global:day", 1, 200)).ok, "a millisecond before it closes").toBe(false);
      vi.advanceTimersByTime(1);
      expect((await rateLimit("chat:global:day", 1, 200)).ok, "the moment it closes").toBe(true);
      expect(sheets.records("counters")[0]!.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to per-instance memory when the Sheet is unconfigured, with one warning in production and no throw", async () => {
    const nodeEnv = process.env.NODE_ENV;
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
      expect((await rateLimit("chat:global:day", 2, DAY)).ok).toBe(true);
      expect((await rateLimit("chat:global:day", 2, DAY)).ok).toBe(true);
      expect((await rateLimit("chat:global:day", 2, DAY)).ok).toBe(false);
      expect(await isOverLimit("callback:global:day", 1)).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).toContain("MARKETING_SHEET_ID");
    } finally {
      console.warn = original;
      (process.env as { NODE_ENV?: string }).NODE_ENV = nodeEnv;
    }
  });

  it("falls back to memory for the request when the Sheet fails, and never throws", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    await rateLimit("chat:global:day", 3, DAY);
    sheets.updateRange = async () => {
      throw new Error("quota");
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect((await rateLimit("chat:global:day", 3, DAY)).remaining).toBe(1);
      sheets.getValues = async () => {
        throw new Error("down");
      };
      __resetRateLimiterForTests();
      // Fresh instance, Sheet down: memory from zero, request served.
      expect((await rateLimit("chat:global:day", 3, DAY)).ok).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
  });
});
