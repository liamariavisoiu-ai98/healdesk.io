import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { checkCallAgentStorage } from "@/lib/voice/agent-storage";
import { checkRetellAgent, retellStorageProblem } from "@/lib/voice/retell-agent";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations } from "./setup/db";

/**
 * The no-audio promise's per-call check (lib/voice/agent-storage.ts): the
 * agent a call ran on, read back from a fake Retell (GET only), raises
 * voice_agent_storage when its retention is not one day or its storage
 * setting is not everything, and nothing when it is ours. Agents made by
 * hand have no voice_agents row, so this is the only read-back they get.
 * Fixed ids and a fixed day; no real Retell.
 */

const KEY = "key_test_retell_engine_0123456789";
const CLINIC = "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5a01";
const AGENT = "agent_handmade_0001";
const NOW = new Date("2026-11-03T15:00:00.000Z");

type Seen = { url: string; method: string };

function fakeRetell(agent: Record<string, unknown> | null, seen: Seen[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    if (!url.startsWith(`https://api.retellai.com/get-agent/${AGENT}`))
      throw new Error(`unexpected fetch ${url}`);
    if (!agent)
      return new Response(JSON.stringify({ status: "error", message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ agent_id: AGENT, ...agent }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const OURS = { data_storage_setting: "everything", data_storage_retention_days: 1 };

describe("the storage problem, read from an agent", () => {
  test("ours is no problem; retention first, then the setting", () => {
    expect(retellStorageProblem(OURS)).toBeNull();
    expect(
      retellStorageProblem({ data_storage_setting: "everything", data_storage_retention_days: 30 }),
    ).toBe("retention");
    expect(
      retellStorageProblem({
        data_storage_setting: "everything",
        data_storage_retention_days: null,
      }),
    ).toBe("retention");
    expect(retellStorageProblem({ data_storage_setting: "everything" })).toBe("retention");
    expect(
      retellStorageProblem({
        data_storage_setting: "basic_attributes_only",
        data_storage_retention_days: 1,
      }),
    ).toBe("setting");
    expect(
      retellStorageProblem({
        data_storage_setting: "everything_except_pii",
        data_storage_retention_days: 1,
      }),
    ).toBe("setting");
    expect(retellStorageProblem({ data_storage_retention_days: 1 })).toBe("setting");
    expect(retellStorageProblem({ data_storage_setting: "basic_attributes_only" })).toBe(
      "retention",
    );
    expect(retellStorageProblem(null)).toBe("retention");
  });

  test("checkRetellAgent's storageAsWritten says the same", () => {
    const options = {
      publicOrigin: "https://app.healdesk.io",
      llmSecret: "s".repeat(32),
      engine: { type: "custom-llm" as const },
    };
    expect(checkRetellAgent(OURS, CLINIC, options).storageAsWritten).toBe(true);
    expect(
      checkRetellAgent({ data_storage_setting: "everything" }, CLINIC, options).storageAsWritten,
    ).toBe(false);
    expect(
      checkRetellAgent(
        { data_storage_setting: "everything", data_storage_retention_days: 2 },
        CLINIC,
        options,
      ).storageAsWritten,
    ).toBe(false);
  });
});

describe("checkCallAgentStorage, with a fake Retell", () => {
  test("a mis-set agent raises the alert with the clinic, the problem and the day", async () => {
    for (const [agent, problem] of [
      [{ data_storage_setting: "everything", data_storage_retention_days: 30 }, "retention"],
      [{ data_storage_setting: "everything" }, "retention"],
      [
        { data_storage_setting: "basic_attributes_only", data_storage_retention_days: 1 },
        "setting",
      ],
    ] as const) {
      const notify = vi.fn(async () => {});
      const seen: Seen[] = [];
      const outcome = await checkCallAgentStorage(
        CLINIC,
        { agent_id: AGENT, agent_version: 3 },
        { apiKey: KEY, fetch: fakeRetell(agent, seen), now: NOW, notify },
      );
      expect(outcome).toEqual({ status: "alerted", problem });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("voice_agent_storage", {
        clinicId: CLINIC,
        status: problem,
        windowStart: "2026-11-03",
      });
      // Read-only, and at the version the call ran on.
      expect(seen).toEqual([
        { url: `https://api.retellai.com/get-agent/${AGENT}?version=3`, method: "GET" },
      ]);
    }
  });

  test("an agent with our settings raises nothing", async () => {
    const notify = vi.fn(async () => {});
    const seen: Seen[] = [];
    expect(
      await checkCallAgentStorage(
        CLINIC,
        { agent_id: AGENT },
        { apiKey: KEY, fetch: fakeRetell(OURS, seen), now: NOW, notify },
      ),
    ).toEqual({ status: "ok" });
    expect(notify).not.toHaveBeenCalled();
    expect(seen).toEqual([{ url: `https://api.retellai.com/get-agent/${AGENT}`, method: "GET" }]);
  });

  test("what cannot be checked is said, never thrown, and raises nothing", async () => {
    const notify = vi.fn(async () => {});
    const deps = { apiKey: KEY, now: NOW, notify };
    expect(
      await checkCallAgentStorage(CLINIC, {}, { ...deps, fetch: fakeRetell(OURS) }),
    ).toMatchObject({ status: "unchecked" });
    expect(
      await checkCallAgentStorage(
        CLINIC,
        { agent_id: "../x" },
        { ...deps, fetch: fakeRetell(OURS) },
      ),
    ).toMatchObject({ status: "unchecked" });
    expect(
      await checkCallAgentStorage(
        CLINIC,
        { agent_id: AGENT },
        { ...deps, apiKey: null, fetch: fakeRetell(OURS) },
      ),
    ).toMatchObject({ status: "unchecked" });
    expect(
      await checkCallAgentStorage(
        CLINIC,
        { agent_id: AGENT },
        { ...deps, fetch: fakeRetell(null) },
      ),
    ).toEqual({ status: "unchecked", reason: "Retell has no such agent" });
    const down = (async () =>
      new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    expect(
      await checkCallAgentStorage(CLINIC, { agent_id: AGENT }, { ...deps, fetch: down }),
    ).toMatchObject({ status: "unchecked" });
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      await checkCallAgentStorage(CLINIC, { agent_id: AGENT }, { ...deps, fetch: unreachable }),
    ).toMatchObject({ status: "unchecked" });
    expect(notify).not.toHaveBeenCalled();
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("the alert in the ops log", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);
  beforeEach(async () => {
    await getMigratorPool().query(`delete from ops_alerts where event = 'voice_agent_storage'`);
  });
  afterAll(async () => {
    await closePools();
  });

  async function alerts() {
    return (
      await getMigratorPool().query<{ fields: Record<string, unknown>; repeats: number }>(
        `select fields, repeats from ops_alerts where event = 'voice_agent_storage' order by raised_at, id`,
      )
    ).rows;
  }

  test("many calls on a mis-set agent in one day are one alert; another problem or another day is another", async () => {
    const misRetention = fakeRetell({
      data_storage_setting: "everything",
      data_storage_retention_days: 730,
    });
    for (let call = 0; call < 3; call += 1) {
      expect(
        await checkCallAgentStorage(
          CLINIC,
          { agent_id: AGENT },
          { apiKey: KEY, fetch: misRetention, now: NOW },
        ),
      ).toEqual({ status: "alerted", problem: "retention" });
    }
    let rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toMatchObject({
      clinicId: CLINIC,
      status: "retention",
      windowStart: "2026-11-03",
    });

    const misSetting = fakeRetell({
      data_storage_setting: "basic_attributes_only",
      data_storage_retention_days: 1,
    });
    await checkCallAgentStorage(
      CLINIC,
      { agent_id: AGENT },
      { apiKey: KEY, fetch: misSetting, now: NOW },
    );
    await checkCallAgentStorage(
      CLINIC,
      { agent_id: AGENT },
      { apiKey: KEY, fetch: misRetention, now: new Date("2026-11-04T09:00:00.000Z") },
    );
    rows = await alerts();
    expect(rows.map((r) => [r.fields.status, r.fields.windowStart])).toEqual([
      ["retention", "2026-11-03"],
      ["setting", "2026-11-03"],
      ["retention", "2026-11-04"],
    ]);

    await checkCallAgentStorage(
      CLINIC,
      { agent_id: AGENT },
      { apiKey: KEY, fetch: fakeRetell(OURS), now: NOW },
    );
    expect(await alerts()).toHaveLength(3);
  });
});
