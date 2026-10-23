import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The demo stall sweep's cron (lib/demo/sweep.ts): CRON_SECRET or nothing;
 * the sweep runs once, the builds it started again run after the response,
 * and the answer is counts.
 */

const state = vi.hoisted(() => ({
  sweep: { retried: [] as { slug: string }[], gaveUp: [] as { slug: string }[] },
  sweeps: 0,
  built: [] as string[][],
  afterFns: [] as (() => unknown)[],
}));

vi.mock("@/lib/demo/sweep", () => ({
  sweepStalledDemos: async () => {
    state.sweeps += 1;
    return state.sweep;
  },
  runRetriedBuilds: async (slugs: string[]) => {
    state.built.push(slugs);
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void state.afterFns.push(fn),
}));

const { GET } = await import("./route");

function call(secret: string | null = "cron-secret") {
  return GET(
    new Request("http://web.test/api/cron/demo-sweep", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  state.sweep = { retried: [{ slug: "glow-spa-abcdefghij" }, { slug: "lumen-abcdefghij" }], gaveUp: [{ slug: "verve-abcdefghij" }] };
  state.sweeps = 0;
  state.built = [];
  state.afterFns = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/demo-sweep", () => {
  test("refuses without the cron secret, and sweeps nothing", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("wrong-secret")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).status).toBe(503);
    expect(state.sweeps).toBe(0);
  });

  test("sweeps once, runs the retried builds after the response, and answers with counts", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, retried: 2, gaveUp: 1 });
    expect(state.sweeps).toBe(1);
    // Scheduled, not yet run.
    expect(state.built).toEqual([]);
    expect(state.afterFns).toHaveLength(1);
    await state.afterFns[0]!();
    expect(state.built).toEqual([["glow-spa-abcdefghij", "lumen-abcdefghij"]]);
  });

  test("nothing stalled schedules nothing", async () => {
    state.sweep = { retried: [], gaveUp: [] };
    expect(await (await call()).json()).toEqual({ ok: true, retried: 0, gaveUp: 0 });
    expect(state.afterFns).toEqual([]);
  });
});
