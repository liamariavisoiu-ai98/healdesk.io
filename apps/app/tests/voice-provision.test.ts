import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { runOperation, type Operator } from "@/lib/ops/api";
import { __setVoiceAgentDepsForTests } from "@/lib/ops/voice-agent-ops";
import {
  checkVoiceAgentDrift,
  configHash,
  deprovisionVoiceAgent,
  expectedConfig,
  languageOf,
  MAX_DRIFT_REPAIRS,
  provisionVoiceAgent,
  retellVoiceId,
  syncVoiceAgent,
  verifyVoiceAgent,
  voiceProvisionDailyCap,
  voiceProvisionEnabled,
  type ProvisionDeps,
} from "@/lib/voice/provision";
import { assertRetellVoiceId, createRetellAgent, RETELL_DEFAULT_VOICE_ID, RetellAgentConfigError, updateRetellAgent } from "@/lib/voice/retell-agent";
import { handleVoiceProvisionJob, runVoiceAgentsSweep } from "@/lib/voice/provision-job";
import { numberNickname } from "@/lib/voice/retell-numbers";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * Automated voice provisioning (owner, 21 October 2026): each clinic's Retell
 * agent and AYA number created, kept, checked and released by code
 * (lib/voice/provision.ts). Retell is never reached: every request goes to
 * an in-memory fake below, and every value is synthetic. The owner's switch
 * is only ever set in the `env` passed here, never in process.env.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const ORIGIN = "https://app.healdesk.test";
const SECRET = "llm_secret_for_tests_0123456789";
const KEY = "key_test_retell_engine_0123456789";
const VOICE = "retell-Cimo";
const PUBLISHED = "+14155550142";
const DIRECT = "+14155550177";
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

type FakeOptions = {
  failCreateNumberAfterStore?: boolean;
  down?: boolean;
  /** Runs once, inside create-agent: a second run acting while this one waits on Retell. */
  onCreateAgent?: () => Promise<void>;
};

/** Retell, in memory: the calls provisioning makes, answered as its reference shows them. */
class FakeRetell {
  agents = new Map<string, Record<string, unknown>>();
  numbers = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string }[] = [];
  bought = 0;
  opts: FakeOptions = {};
  private seq = 0;

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    this.calls.push({ method, path });
    if (init?.headers && new Headers(init.headers).get("authorization") !== `Bearer ${KEY}`) return json({}, 401);
    if (this.opts.down) throw new TypeError("fetch failed");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/create-agent") {
      const id = `agent_${++this.seq}`;
      const agent = { ...body, agent_id: id };
      this.agents.set(id, agent);
      const hook = this.opts.onCreateAgent;
      this.opts.onCreateAgent = undefined;
      if (hook) await hook();
      return json(agent, 201);
    }
    if ((m = /^\/(update|get|delete)-agent\/(.+)$/.exec(path))) {
      const agent = this.agents.get(decodeURIComponent(m[2]!));
      if (!agent) return json({ status: "error" }, 422);
      if (m[1] === "get") return json(agent);
      if (m[1] === "delete") {
        this.agents.delete(String(agent.agent_id));
        return new Response(null, { status: 204 });
      }
      Object.assign(agent, body);
      return json(agent);
    }
    if (method === "POST" && path === "/create-phone-number") {
      this.bought += 1;
      const n = `+1${String(body.area_code ?? 415)}555${String(1000 + this.bought).slice(-4)}`;
      const number = {
        phone_number: n,
        nickname: body.nickname,
        inbound_agents: body.inbound_agents ?? [],
        outbound_agents: body.outbound_agents ?? [],
        fallback_number: null,
      };
      this.numbers.set(n, number);
      if (this.opts.failCreateNumberAfterStore) {
        this.opts.failCreateNumberAfterStore = false;
        throw new TypeError("socket hang up");
      }
      return json(number, 201);
    }
    if (method === "GET" && path === "/v2/list-phone-numbers") {
      return json({ items: [...this.numbers.values()], has_more: false });
    }
    if ((m = /^\/(update|get|delete)-phone-number\/(.+)$/.exec(path))) {
      const number = this.numbers.get(decodeURIComponent(m[2]!));
      if (!number) return json({ status: "error" }, 404);
      if (m[1] === "get") return json(number);
      if (m[1] === "delete") {
        this.numbers.delete(String(number.phone_number));
        return new Response(null, { status: 204 });
      }
      Object.assign(number, body);
      return json(number);
    }
    return json({ status: "error" }, 400);
  }) as typeof fetch;

  writes(): { method: string; path: string }[] {
    return this.calls.filter((c) => c.method !== "GET");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let retell: FakeRetell;

function deps(env: Record<string, string> = {}, extra: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    fetch: retell.fetch,
    key: KEY,
    publicOrigin: ORIGIN,
    llmSecret: SECRET,
    env: { HEALDESK_VOICE_PROVISION_ENABLED: "1", HEALDESK_RETELL_VOICE_ID: VOICE, ...env },
    ...extra,
  };
}

async function paidVoiceClinic(label: string, options: { planId?: string; paid?: boolean; directLine?: string | null } = {}) {
  const c = await seedClinic(label);
  await getMigratorPool().query(`update clinics set published_phone_e164 = $2 where id = $1`, [c.clinicId, PUBLISHED]);
  await seedEntitled(c.clinicId, {
    planId: options.planId ?? "voice-webchat-500-300",
    ...(options.paid === false ? { firstInvoice: false as const, status: "provisioning" as const } : {}),
  });
  if (options.directLine !== null) {
    await inTenant(c.clinicId, (q) =>
      q.query(`insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)`, [c.clinicId, options.directLine ?? DIRECT]),
    );
  }
  return c;
}

/** The clinic's row, read in its tenant: the table forces its policy on the migrator too. */
async function row(clinicId: string) {
  const { rows } = await inTenant(clinicId, (q) => q.query(`select * from voice_agents where clinic_id = $1`, [clinicId]));
  return rows[0] as Record<string, unknown> | undefined;
}

/** The test's own write to the row, in its tenant. */
async function setRow(clinicId: string, set: string, values: unknown[] = []) {
  await inTenant(clinicId, (q) => q.query(`update voice_agents set ${set} where clinic_id = $1`, [clinicId, ...values]));
}

async function alerts(event: string): Promise<number> {
  const { rows } = await getMigratorPool().query<{ n: number }>(`select count(*)::int as n from ops_alerts where event = $1`, [event]);
  return rows[0]!.n;
}

describe("the switch and the cap, read from the environment", () => {
  test("only exactly 1 is on; the cap defaults to 20", () => {
    expect(voiceProvisionEnabled({})).toBe(false);
    expect(voiceProvisionEnabled({ HEALDESK_VOICE_PROVISION_ENABLED: "true" })).toBe(false);
    expect(voiceProvisionEnabled({ HEALDESK_VOICE_PROVISION_ENABLED: "__unset__" })).toBe(false);
    expect(voiceProvisionEnabled({ HEALDESK_VOICE_PROVISION_ENABLED: " 1 " })).toBe(true);
    expect(voiceProvisionDailyCap({})).toBe(20);
    expect(voiceProvisionDailyCap({ HEALDESK_VOICE_PROVISION_DAILY_CAP: "3" })).toBe(3);
    expect(voiceProvisionDailyCap({ HEALDESK_VOICE_PROVISION_DAILY_CAP: "-1" })).toBe(20);
  });

  test("the configuration hash never covers the line password, and moves with what Retell holds", () => {
    const env = { HEALDESK_RETELL_VOICE_ID: VOICE };
    const base = { engine: "custom" as const, languages: ["en" as const], directLine: DIRECT, assistantNumber: "+14155551001", publishedPhone: PUBLISHED };
    const a = configHash(expectedConfig(base, env), "app.healdesk.test");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(configHash(expectedConfig(base, env), "app.healdesk.test"));
    expect(configHash(expectedConfig({ ...base, languages: ["en", "es"] }, env), "app.healdesk.test")).not.toBe(a);
    expect(configHash(expectedConfig({ ...base, directLine: "+14155550188" }, env), "app.healdesk.test")).not.toBe(a);
    expect(configHash(expectedConfig(base, { HEALDESK_RETELL_VOICE_ID: "retell-Other" }), "app.healdesk.test")).not.toBe(a);
    // Unset (or the Parameter Store placeholder), the voice is Retell's
    // platform voice retell-Sloane, the demo agent's (22 October 2026).
    expect(RETELL_DEFAULT_VOICE_ID).toBe("retell-Sloane");
    expect(expectedConfig(base, {}).voiceId).toBe("retell-Sloane");
    expect(expectedConfig(base, { HEALDESK_RETELL_VOICE_ID: "__unset__" }).voiceId).toBe("retell-Sloane");
    expect(retellVoiceId({})).toBe("retell-Sloane");
    // A value that is set but not a voice id is refused, not replaced by the default.
    expect(() => expectedConfig(base, { HEALDESK_RETELL_VOICE_ID: "not a voice!" })).toThrow(/HEALDESK_RETELL_VOICE_ID/);
  });

  test("an xai- voice is refused at config time, as a config error, before Retell is asked", async () => {
    const base = { engine: "custom" as const, languages: ["en" as const], directLine: DIRECT, assistantNumber: "+14155551001", publishedPhone: PUBLISHED };
    expect(() => expectedConfig(base, { HEALDESK_RETELL_VOICE_ID: "xai-Iris" })).toThrow(RetellAgentConfigError);
    expect(() => expectedConfig(base, { HEALDESK_RETELL_VOICE_ID: "xai-Iris" })).toThrow(/xai speech-to-speech/);
    const fetch = vi.fn();
    const options = { key: "key_test", fetch: fetch as unknown as typeof globalThis.fetch } as never;
    await expect(createRetellAgent("0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60", { voiceId: "xai-Iris" }, options)).rejects.toThrow(/xai speech-to-speech/);
    await expect(updateRetellAgent("agent_abc123", "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60", options, { voiceId: "xai-Iris" })).rejects.toThrow(RetellAgentConfigError);
    expect(fetch).not.toHaveBeenCalled();
    // retell-Sloane and any other platform voice pass.
    expect(() => assertRetellVoiceId("retell-Sloane")).not.toThrow();
  });

  test("the speech language is English, and English with Latin American Spanish when the clinic answers in Spanish", () => {
    const env = { HEALDESK_RETELL_VOICE_ID: VOICE };
    const base = { engine: "custom" as const, languages: ["en" as const], directLine: DIRECT, assistantNumber: "+14155551001", publishedPhone: PUBLISHED };
    expect(languageOf(["en"])).toBe("en-US");
    expect(languageOf(["en", "es"])).toEqual(["en-US", "es-419"]);
    expect(languageOf(["es"])).toEqual(["en-US", "es-419"]);
    // A language no screen reads never reaches the agent.
    expect(languageOf(["en", "fr", "pt"])).toBe("en-US");
    expect(expectedConfig({ ...base, languages: ["en", "es"] }, env).language).toEqual(["en-US", "es-419"]);
    // An English clinic's hash is the one recorded before Spanish existed: the
    // same canonical object, so no agent is rewritten for this change.
    const english = expectedConfig(base, env);
    expect(english).not.toHaveProperty("boostedKeywords");
    expect(configHash(english, "app.healdesk.test")).toBe(configHash({ ...english, boostedKeywords: [] }, "app.healdesk.test"));
    // Keywords, once something gives them, move the hash so the agent syncs.
    expect(configHash(expectedConfig({ ...base, boostedKeywords: ["Radiance"] }, env), "app.healdesk.test")).not.toBe(configHash(english, "app.healdesk.test"));
  });
});

describeDb("automated voice provisioning", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 240_000);

  beforeEach(async () => {
    await truncateAll();
    // The ops log has no clinic, so truncateAll leaves it: each test counts its own alerts.
    await getMigratorPool().query(`truncate ops_alerts`);
    retell = new FakeRetell();
    __setVoiceAgentDepsForTests(undefined);
  });

  afterAll(async () => {
    __setVoiceAgentDepsForTests(undefined);
    await closePools();
  });

  test("happy path: agent created, number bought in the clinic's area code, bound inbound only, fallback on the direct line, ready", async () => {
    const c = await paidVoiceClinic("vp-happy");
    const result = await provisionVoiceAgent(c.clinicId, deps());
    expect(result).toMatchObject({ outcome: "ready", adopted: false });
    expect(retell.bought).toBe(1);

    const [agent] = [...retell.agents.values()];
    expect(agent).toMatchObject({
      voice_id: VOICE,
      language: "en-US",
      data_storage_setting: "everything",
      data_storage_retention_days: 1,
      webhook_url: `${ORIGIN}/api/webhooks/retell/${c.clinicId}`,
      response_engine: { type: "custom-llm", llm_websocket_url: `wss://app.healdesk.test/llm-websocket/${SECRET}/${c.clinicId}` },
    });
    const [number] = [...retell.numbers.values()];
    expect(number).toMatchObject({
      nickname: numberNickname(c.clinicId),
      inbound_agents: [{ agent_id: agent!.agent_id, weight: 1 }],
      outbound_agents: [],
      fallback_number: DIRECT,
    });
    expect(String(number!.phone_number)).toMatch(/^\+1415/);

    const r = await row(c.clinicId);
    expect(r).toMatchObject({ status: "ready", engine: "custom", retell_agent_id: agent!.agent_id, phone_number_e164: number!.phone_number, attempts: 1, last_error: null });
    expect(String(r!.config_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(r!.config_hash)).not.toContain(SECRET);
    // The clinic's AYA number is the one bought.
    const { rows } = await getMigratorPool().query(`select assistant_number_e164 from clinics where id = $1`, [c.clinicId]);
    expect(rows[0]!.assistant_number_e164).toBe(number!.phone_number);

    // A second run, and the job, change nothing and buy nothing.
    expect(await provisionVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "already", status: "ready" });
    await handleVoiceProvisionJob({ clinicId: c.clinicId }, deps());
    expect(retell.bought).toBe(1);

    // No call ever placed: nothing here names a call-creating endpoint.
    expect(retell.calls.some((x) => /call/.test(x.path))).toBe(false);

    const report = await verifyVoiceAgent(c.clinicId, deps());
    expect(report).toMatchObject({ ok: true, checked: true, agentExists: true, numberExists: true, problems: [] });
  });

  test("a crash between buying the number and recording it is retried, and the retry adopts that number", async () => {
    const c = await paidVoiceClinic("vp-crash");
    retell.opts.failCreateNumberAfterStore = true;
    const first = await provisionVoiceAgent(c.clinicId, deps());
    expect(first.outcome).toBe("retry");
    expect(retell.bought).toBe(1);
    const mid = await row(c.clinicId);
    expect(mid).toMatchObject({ status: "provisioning", phone_number_e164: null });
    expect(mid!.number_ordered_at).not.toBeNull();
    // The job throws on it, so pg-boss retries with its backoff.
    retell.opts.failCreateNumberAfterStore = true;
    // (Set again only to prove the retry never reaches create-phone-number.)
    await expect(handleVoiceProvisionJob({ clinicId: c.clinicId }, deps())).resolves.toBeUndefined();
    expect(retell.bought).toBe(1);
    expect(await row(c.clinicId)).toMatchObject({ status: "ready", phone_number_e164: [...retell.numbers.keys()][0] });
    expect(retell.agents.size).toBe(1);
  });

  test("two runs for one clinic at once: only the one that took the order marker buys, the other retries and adopts", async () => {
    const c = await paidVoiceClinic("vp-race");
    // While this run waits on Retell for its agent, another run (an
    // operator's retry beside the job) marks the order first.
    retell.opts.onCreateAgent = () => setRow(c.clinicId, `number_ordered_at = now()`);
    const first = await provisionVoiceAgent(c.clinicId, deps());
    expect(first).toEqual({ outcome: "retry", reason: "another run is ordering this clinic's number" });
    expect(retell.bought).toBe(0);
    // Nothing was bought, so the retry finds no number by its nickname and
    // orders one, against the marker it read; exactly one in all.
    expect((await provisionVoiceAgent(c.clinicId, deps())).outcome).toBe("ready");
    expect(retell.bought).toBe(1);
    expect(retell.agents.size).toBe(1);
  });

  test("the hourly sweep queues an owed clinic only with the switch on and the key set, and never a failed one", async () => {
    const owed = await paidVoiceClinic("vp-sweep-owed");
    const failed = await paidVoiceClinic("vp-sweep-failed");
    const unpaid = await paidVoiceClinic("vp-sweep-unpaid", { paid: false });
    await inTenant(failed.clinicId, (q) =>
      q.query(`insert into voice_agents (clinic_id, status, last_error) values ($1, 'failed', 'stopped')`, [failed.clinicId]),
    );
    const queued: string[] = [];
    const schedule = async (id: string) => void queued.push(id);
    expect((await runVoiceAgentsSweep({ deps: deps({}, { key: null }), schedule })).status).toBe("skipped");
    expect(queued).toEqual([]);
    const sweep = await runVoiceAgentsSweep({ deps: deps(), schedule });
    // Queued, not run: provisioning itself re-checks the paid invoice, so an
    // unpaid clinic queued here is refused there with no Retell call.
    expect(queued).toContain(owed.clinicId);
    expect(queued).not.toContain(failed.clinicId);
    expect(sweep.queued).toBe(queued.length);
    expect(await provisionVoiceAgent(unpaid.clinicId, deps())).toMatchObject({ outcome: "not_eligible" });
    expect(retell.calls).toEqual([]);
  });

  test("with the owner's switch off, provisioning makes no Retell call at all", async () => {
    const c = await paidVoiceClinic("vp-off");
    for (const env of [{ HEALDESK_VOICE_PROVISION_ENABLED: "" }, { HEALDESK_VOICE_PROVISION_ENABLED: "true" }]) {
      expect(await provisionVoiceAgent(c.clinicId, deps(env))).toEqual({ outcome: "switched_off" });
    }
    // Nor does the hourly sweep queue anything.
    const queued: string[] = [];
    const sweep = await runVoiceAgentsSweep({ deps: deps({ HEALDESK_VOICE_PROVISION_ENABLED: "0" }), schedule: async (id) => void queued.push(id) });
    expect(sweep.queued).toBe(0);
    expect(queued).toEqual([]);
    expect(retell.calls).toEqual([]);
    expect(await row(c.clinicId)).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("over the daily cap the clinic waits as pending and ops is told once", async () => {
    const a = await paidVoiceClinic("vp-cap-a");
    const b = await paidVoiceClinic("vp-cap-b");
    const d = await paidVoiceClinic("vp-cap-c");
    const env = { HEALDESK_VOICE_PROVISION_DAILY_CAP: "1" };
    expect((await provisionVoiceAgent(a.clinicId, deps(env))).outcome).toBe("ready");
    expect(await provisionVoiceAgent(b.clinicId, deps(env))).toEqual({ outcome: "deferred", reason: "daily_cap" });
    expect(await provisionVoiceAgent(d.clinicId, deps(env))).toEqual({ outcome: "deferred", reason: "daily_cap" });
    expect(retell.bought).toBe(1);
    expect(await row(b.clinicId)).toMatchObject({ status: "pending", phone_number_e164: null, number_ordered_at: null });
    expect(await alerts("voice_provision_cap_reached")).toBe(1);
    // The next UTC day, it goes.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect((await provisionVoiceAgent(b.clinicId, deps(env, { now: () => tomorrow }))).outcome).toBe("ready");
    expect(retell.bought).toBe(2);
  });

  test("an unpaid clinic, or one whose package has no voice, gets nothing and no row", async () => {
    const unpaid = await paidVoiceClinic("vp-unpaid", { paid: false });
    const chatOnly = await paidVoiceClinic("vp-chat", { planId: "webchat-300" });
    expect(await provisionVoiceAgent(unpaid.clinicId, deps())).toEqual({ outcome: "not_eligible", reason: "the first invoice is not paid" });
    expect(await provisionVoiceAgent(chatOnly.clinicId, deps())).toEqual({ outcome: "not_eligible", reason: "the package bought has no voice" });
    expect(retell.calls).toEqual([]);
    expect(await row(unpaid.clinicId)).toBeUndefined();
    expect(await row(chatOnly.clinicId)).toBeUndefined();
  });

  test("a clinic set to the native engine fails with a typed not_implemented and an honest reason", async () => {
    const c = await paidVoiceClinic("vp-native");
    await inTenant(c.clinicId, (q) => q.query(`insert into voice_agents (clinic_id, engine) values ($1, 'native')`, [c.clinicId]));
    const result = await provisionVoiceAgent(c.clinicId, deps());
    expect(result).toMatchObject({ outcome: "failed", code: "not_implemented" });
    expect(await row(c.clinicId)).toMatchObject({ status: "failed", last_error: expect.stringMatching(/native engine is not built/) });
    expect(retell.calls).toEqual([]);
    expect(await alerts("voice_provision_failed")).toBe(1);
  });

  test("settings Retell holds are written only when their hash changes; knowledge and the greeting make no Retell call", async () => {
    const c = await paidVoiceClinic("vp-sync");
    await provisionVoiceAgent(c.clinicId, deps());
    const before = retell.calls.length;
    const hash = (await row(c.clinicId))!.config_hash;

    expect(await syncVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "unchanged" });

    // Knowledge, prices, the greeting, coverage mode: our database only.
    await inTenant(c.clinicId, (q) =>
      q.query(
        `update clinic_settings set phone_greeting = 'Thanks for calling, this is the AI assistant', coverage_mode = 'all_calls', tone = 'clinical' where clinic_id = $1`,
        [c.clinicId],
      ),
    );
    expect(await syncVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "unchanged" });
    expect(retell.calls.length).toBe(before);

    // A language Retell transcribes: one write, then unchanged again.
    await inTenant(c.clinicId, (q) => q.query(`update clinic_settings set languages = array['en','es'] where clinic_id = $1`, [c.clinicId]));
    expect(await syncVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "synced" });
    const agent = [...retell.agents.values()][0]!;
    expect(agent.language).toEqual(["en-US", "es-419"]);
    expect((await row(c.clinicId))!.config_hash).not.toBe(hash);
    const afterSync = retell.calls.length;
    expect(await syncVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "unchanged" });
    expect(retell.calls.length).toBe(afterSync);

    // A new direct line moves the number's fallback.
    await inTenant(c.clinicId, (q) => q.query(`update clinic_settings set direct_line_e164 = '+14155550188' where clinic_id = $1`, [c.clinicId]));
    expect(await syncVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "synced" });
    expect([...retell.numbers.values()][0]!.fallback_number).toBe("+14155550188");
  });

  test("drift is repaired once with one alert, and after the repair limit it is flagged for a person", async () => {
    const c = await paidVoiceClinic("vp-drift");
    await provisionVoiceAgent(c.clinicId, deps());
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "clean" });

    const agent = [...retell.agents.values()][0]!;
    agent.data_storage_setting = "basic_attributes_only";
    const repaired = await checkVoiceAgentDrift(c.clinicId, deps());
    expect(repaired).toEqual({ outcome: "repaired", problems: ["storage"] });
    expect(agent.data_storage_setting).toBe("everything");
    expect(await alerts("voice_agent_drift")).toBe(1);
    // Clean again: no further alert, the count back to nought.
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "clean" });
    expect(await alerts("voice_agent_drift")).toBe(1);
    expect(await row(c.clinicId)).toMatchObject({ drift_repairs: 0 });

    // Someone keeps changing the fallback by hand.
    const number = [...retell.numbers.values()][0]!;
    for (let i = 0; i < MAX_DRIFT_REPAIRS; i += 1) {
      number.fallback_number = "+14155550000";
      await setRow(c.clinicId, `drift_repairs = $2`, [i]);
      expect((await checkVoiceAgentDrift(c.clinicId, deps())).outcome).toBe("repaired");
    }
    number.fallback_number = "+14155550000";
    await setRow(c.clinicId, `drift_repairs = $2`, [MAX_DRIFT_REPAIRS]);
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "flagged", problems: ["fallback"] });
    expect((await row(c.clinicId))!.drift_flagged_at).not.toBeNull();
    // Flagged: left alone from then on, no repair, no Retell call.
    const calls = retell.calls.length;
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "skipped", reason: "flagged for a person" });
    expect(retell.calls.length).toBe(calls);
  });

  test("a Spanish clinic's agent whose speech language was narrowed by hand is drift, and is written back as the locale array", async () => {
    const c = await paidVoiceClinic("vp-drift-es");
    await inTenant(c.clinicId, (q) => q.query(`update clinic_settings set languages = array['en','es'] where clinic_id = $1`, [c.clinicId]));
    await provisionVoiceAgent(c.clinicId, deps());
    const agent = [...retell.agents.values()][0]!;
    expect(agent.language).toEqual(["en-US", "es-419"]);
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "clean" });
    agent.language = "en-US";
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "repaired", problems: ["language"] });
    expect(agent.language).toEqual(["en-US", "es-419"]);
  });

  test("deprovision waits for the pass-through, then releases the number and deletes the agent, once", async () => {
    const c = await paidVoiceClinic("vp-leave");
    await provisionVoiceAgent(c.clinicId, deps());
    const number = [...retell.numbers.keys()][0]!;

    // Live: never released.
    expect(await deprovisionVoiceAgent(c.clinicId, deps())).toMatchObject({ outcome: "not_due" });
    // Service ended today: still passing calls through.
    await getMigratorPool().query(`update clinics set offboarding_started_at = now() where id = $1`, [c.clinicId]);
    expect(await deprovisionVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "not_due", reason: "forwarded calls still pass through" });
    expect(retell.numbers.size).toBe(1);

    await getMigratorPool().query(`update clinics set offboarding_started_at = now() - interval '45 days' where id = $1`, [c.clinicId]);
    expect(await deprovisionVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "released", numberDeleted: true, agentDeleted: true });
    expect(retell.numbers.has(number)).toBe(false);
    expect(retell.agents.size).toBe(0);
    expect(await row(c.clinicId)).toMatchObject({ status: "released" });
    const { rows } = await getMigratorPool().query(`select assistant_number_e164 from clinics where id = $1`, [c.clinicId]);
    expect(rows[0]!.assistant_number_e164).toBeNull();

    const writes = retell.writes().length;
    expect(await deprovisionVoiceAgent(c.clinicId, deps())).toEqual({ outcome: "already" });
    expect(retell.writes().length).toBe(writes);

    // A release that crashed after Retell deleted both finishes without error.
    const again = await paidVoiceClinic("vp-leave-2");
    await provisionVoiceAgent(again.clinicId, deps());
    await getMigratorPool().query(`update clinics set offboarding_started_at = now() - interval '45 days' where id = $1`, [again.clinicId]);
    retell.numbers.clear();
    retell.agents.clear();
    expect(await deprovisionVoiceAgent(again.clinicId, deps())).toEqual({ outcome: "released", numberDeleted: false, agentDeleted: false });
  });

  test("the ops projection carries ids, status and times only, never a number, a secret or a patient", async () => {
    const c = await paidVoiceClinic("vp-ops");
    __setVoiceAgentDepsForTests(deps());
    await provisionVoiceAgent(c.clinicId, deps());
    const listed = await runOperation("voiceAgentStatus", {}, OPERATOR);
    expect(listed.status).toBe(200);
    const data = (listed.body as { data: { agents: Record<string, unknown>[]; report: unknown } }).data;
    expect(data.agents).toHaveLength(1);
    expect(Object.keys(data.agents[0]!).sort()).toEqual(
      [
        "attempts",
        "clinicId",
        "clinicSlug",
        "driftFlaggedAt",
        "driftRepairs",
        "engine",
        "hasNumber",
        "lastError",
        "lastSyncedAt",
        "numberOrderedAt",
        "releasedAt",
        "retellAgentId",
        "status",
        "updatedAt",
      ].sort(),
    );
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(DIRECT);
    expect(text).not.toContain([...retell.numbers.keys()][0]!);

    const verified = await runOperation("voiceAgentStatus", { clinicId: c.clinicId, verify: true }, OPERATOR);
    const report = (verified.body as { data: { report: Record<string, unknown> } }).data.report;
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(JSON.stringify(verified.body)).not.toContain(SECRET);
    // Read-only: verifying wrote nothing at Retell.
    expect(retell.calls.slice(-4).every((x) => x.method === "GET")).toBe(true);
    expect((await runOperation("voiceAgentStatus", { clinicId: "nope" }, OPERATOR)).status).toBe(400);
  });

  test("the row is the clinic's alone: another tenant cannot read or write it", async () => {
    const a = await paidVoiceClinic("vp-rls-a");
    const b = await paidVoiceClinic("vp-rls-b");
    await provisionVoiceAgent(a.clinicId, deps());
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [b.clinicId]);
      const seen = await client.query(`select clinic_id from voice_agents`);
      expect(seen.rows).toEqual([]);
      const updated = await client.query(`update voice_agents set last_error = 'x' where clinic_id = $1`, [a.clinicId]);
      expect(updated.rowCount).toBe(0);
      await expect(client.query(`insert into voice_agents (clinic_id) values ($1)`, [a.clinicId])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
      // And the runtime role may not delete a row, nor move it to another clinic.
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [a.clinicId]);
      await expect(client.query(`delete from voice_agents where clinic_id = $1`, [a.clinicId])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [a.clinicId]);
      await expect(client.query(`update voice_agents set clinic_id = $2 where clinic_id = $1`, [a.clinicId, b.clinicId])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  /* ------------------------------------------------ clearing a drift flag */

  async function securityEvents(clinicId: string) {
    const { rows } = await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown> }>(
      `select actor_label, metadata from security_events where event = 'voice_drift_flag_cleared' and metadata->>'clinicId' = $1`,
      [clinicId],
    );
    return rows;
  }

  test("a flagged clinic, cleared, is checked again: repaired, the counter reset, and the nightly check no longer skips it", async () => {
    const c = await paidVoiceClinic("vp-clear");
    __setVoiceAgentDepsForTests(deps());
    await provisionVoiceAgent(c.clinicId, deps());
    const number = [...retell.numbers.values()][0]!;
    number.fallback_number = "+14155550000";
    await setRow(c.clinicId, `drift_repairs = $2`, [MAX_DRIFT_REPAIRS]);
    expect((await checkVoiceAgentDrift(c.clinicId, deps())).outcome).toBe("flagged");
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "skipped", reason: "flagged for a person" });

    const bought = retell.bought;
    const cleared = await runOperation("clearVoiceDriftFlag", { clinicId: c.clinicId }, OPERATOR);
    expect(cleared.status).toBe(200);
    expect((cleared.body as { data: unknown }).data).toEqual({ outcome: "cleared", check: "repaired", problems: ["fallback"] });
    expect(number.fallback_number).toBe(DIRECT);
    const after = (await row(c.clinicId))!;
    expect(after.drift_flagged_at).toBeNull();
    expect(after.drift_repairs).toBe(1);
    expect(after.last_error).toBeNull();
    // Checked again from now on, and nothing was bought.
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toEqual({ outcome: "clean" });
    expect(retell.bought).toBe(bought);
    const events = await securityEvents(c.clinicId);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_label).toBe(OPERATOR.email);
    expect(events[0]!.metadata).toMatchObject({ outcome: "cleared", check: "repaired" });
  });

  test("an agent gone from Retell is never re-created by a clear: the check flags it again, still_drifted", async () => {
    const c = await paidVoiceClinic("vp-clear-gone");
    __setVoiceAgentDepsForTests(deps());
    await provisionVoiceAgent(c.clinicId, deps());
    retell.agents.clear();
    expect(await checkVoiceAgentDrift(c.clinicId, deps())).toMatchObject({ outcome: "flagged" });
    const writes = retell.writes().length;
    const bought = retell.bought;

    const cleared = await runOperation("clearVoiceDriftFlag", { clinicId: c.clinicId }, OPERATOR);
    expect((cleared.body as { data: unknown }).data).toEqual({ outcome: "still_drifted", problems: ["agent_missing"] });
    expect(retell.writes().length).toBe(writes);
    expect(retell.agents.size).toBe(0);
    expect(retell.bought).toBe(bought);
    expect((await row(c.clinicId))!.drift_flagged_at).not.toBeNull();
    expect((await securityEvents(c.clinicId))[0]!.metadata).toMatchObject({
      outcome: "still_drifted",
      problems: ["agent_missing"],
    });
  });

  test("a clinic not flagged is not_flagged and nothing changes; an unknown clinic or one with no agent is not_found", async () => {
    const c = await paidVoiceClinic("vp-clear-none");
    __setVoiceAgentDepsForTests(deps());
    expect((await runOperation("clearVoiceDriftFlag", { clinicId: c.clinicId }, OPERATOR)).body).toMatchObject({
      data: { outcome: "not_found" },
    });
    await provisionVoiceAgent(c.clinicId, deps());
    const before = await row(c.clinicId);
    const calls = retell.calls.length;
    expect((await runOperation("clearVoiceDriftFlag", { clinicId: c.clinicId }, OPERATOR)).body).toMatchObject({
      data: { outcome: "not_flagged" },
    });
    expect(await row(c.clinicId)).toEqual(before);
    expect(retell.calls.length).toBe(calls);
    expect((await runOperation("clearVoiceDriftFlag", { clinicId: "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60" }, OPERATOR)).body).toMatchObject({
      data: { outcome: "not_found" },
    });
    expect((await runOperation("clearVoiceDriftFlag", {}, OPERATOR)).status).toBe(400);
  });
});
