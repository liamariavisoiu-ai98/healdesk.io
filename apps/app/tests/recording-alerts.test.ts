import { createHmac } from "node:crypto";

import { sign as signOps, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scheduled: [] as Array<{ clinicId: string; callId: string }> }));
vi.mock("@/lib/voice/backstop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice/backstop")>();
  return {
    ...actual,
    scheduleCallBackstop: async (payload: { clinicId: string; callId: string }) => {
      mocks.scheduled.push(payload);
    },
  };
});

import { POST as opsRoute } from "@/app/api/ops/route";
import { POST as retellWebhook } from "@/app/api/webhooks/retell/[clinicId]/route";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { __setRecordingDeleteDepsForTests } from "@/lib/ops/recording-alerts-ops";
import { BACKSTOP_DELAY_SECONDS, runCallBackstop, type RetellCall } from "@/lib/voice/backstop";
import {
  DELETE_NOT_BEFORE_MS,
  RECORDING_URL_FIELDS,
  recordRecordingAlert,
  retellCallHasRecording,
} from "@/lib/voice/recording-alerts";
import {
  checkRetellAgent,
  createRetellAgent,
  RETELL_DATA_STORAGE_SETTING,
  RetellAgentConfigError,
  retellAgentSettings,
  updateRetellAgent,
  verifyRetellAgent,
} from "@/lib/voice/retell-agent";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * NOAUDIO-01: every clinic's Retell agent is written with call storage
 * restricted (lib/voice/retell-agent.ts), and a recording Retell keeps anyway
 * becomes one opaque alert per call (lib/voice/recording-alerts.ts) that
 * /admin/recordings deletes at Retell through the ops API. Retell is never
 * called: every request goes to a mocked fetch, and every value here is
 * synthetic.
 */

const CLINIC = "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60";
const SECRET = "llm_secret_for_tests_0123456789";
const ORIGIN = "https://app.healdesk.test";
const KEY = "key_test_retell_engine_0123456789";
const OPTIONS = { llmSecret: SECRET, publicOrigin: ORIGIN, key: KEY } as const;
/** A recording URL's shape only; nothing fetches it. */
const RECORDING = "https://recordings.example.test/rec/recording.wav";

type Seen = { url: string; method: string; body: unknown; authorization: string | null };

function fakeFetch(answer: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: headers.get("authorization"),
    };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// -----------------------------------------------------------------------------
// The agent, written by code
// -----------------------------------------------------------------------------

describe("a clinic's Retell agent", () => {
  const settings = retellAgentSettings(CLINIC, OPTIONS);

  test("carries storage restricted, our custom-LLM endpoint for the clinic and its webhook", () => {
    expect(RETELL_DATA_STORAGE_SETTING).toBe("basic_attributes_only");
    expect(settings).toEqual({
      response_engine: { type: "custom-llm", llm_websocket_url: `wss://app.healdesk.test/llm-websocket/${SECRET}/${CLINIC}` },
      webhook_url: `https://app.healdesk.test/api/webhooks/retell/${CLINIC}`,
      data_storage_setting: "basic_attributes_only",
    });
  });

  test("refuses to build without a usable secret, an https origin or a clinic id, naming no value", () => {
    expect(() => retellAgentSettings(CLINIC, { ...OPTIONS, llmSecret: null })).toThrow(RetellAgentConfigError);
    expect(() => retellAgentSettings(CLINIC, { ...OPTIONS, llmSecret: "__unset__" })).toThrow(RetellAgentConfigError);
    expect(() => retellAgentSettings(CLINIC, { ...OPTIONS, llmSecret: "short" })).toThrow(RetellAgentConfigError);
    expect(() => retellAgentSettings(CLINIC, { ...OPTIONS, publicOrigin: "http://app.healdesk.test" })).toThrow(/https/);
    expect(() => retellAgentSettings(CLINIC, { ...OPTIONS, publicOrigin: null })).toThrow(RetellAgentConfigError);
    expect(() => retellAgentSettings("not-a-clinic", OPTIONS)).toThrow(RetellAgentConfigError);
    try {
      retellAgentSettings(CLINIC, { ...OPTIONS, llmSecret: "has/slash/in-it-0123456789" });
    } catch (error) {
      expect((error as Error).message).not.toContain("has/slash");
    }
  });

  test("create posts the settings and a voice, and checks Retell kept them", async () => {
    const { fetch, seen } = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object) }, 201));
    const created = await createRetellAgent(CLINIC, { voiceId: "retell-Voice" }, { ...OPTIONS, fetch });
    expect(created).toEqual({
      agentId: "agent_abc123",
      check: { storageRestricted: true, storageSetting: "basic_attributes_only", engineIsOurs: true, webhookIsOurs: true },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://api.retellai.com/create-agent", method: "POST", authorization: `Bearer ${KEY}` });
    expect(seen[0]!.body).toMatchObject({ ...settings, voice_id: "retell-Voice", agent_name: `healdesk ${CLINIC}` });
  });

  test("update patches the agent to the settings; an answer that dropped storage is an error, never success", async () => {
    const good = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object) }));
    expect((await updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: good.fetch })).storageRestricted).toBe(true);
    expect(good.seen[0]).toMatchObject({ url: "https://api.retellai.com/update-agent/agent_abc123", method: "PATCH" });
    expect(good.seen[0]!.body).toEqual(settings);

    const ignored = fakeFetch((s) => json({ ...(s.body as object), data_storage_setting: "everything" }));
    await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: ignored.fetch })).rejects.toThrow(/storage restricted/);
    const refused = fakeFetch(() => json({ status: "error" }, 422));
    await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: refused.fetch })).rejects.toThrow(/422/);
    await expect(updateRetellAgent("../etc", CLINIC, { ...OPTIONS, fetch: good.fetch })).rejects.toThrow(RetellAgentConfigError);
  });

  test("verify reads the agent back and reports, as yes or no, never a URL", async () => {
    const { fetch, seen } = fakeFetch(() => json({ agent_id: "agent_abc123", ...settings }));
    const check = await verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch });
    expect(check).toEqual({ storageRestricted: true, storageSetting: "basic_attributes_only", engineIsOurs: true, webhookIsOurs: true });
    expect(seen[0]).toMatchObject({ url: "https://api.retellai.com/get-agent/agent_abc123", method: "GET" });
    expect(JSON.stringify(check)).not.toContain(SECRET);

    // Retell's default, a console change, an engine that is not ours, an old secret.
    expect(checkRetellAgent({ ...settings, data_storage_setting: undefined }, CLINIC, OPTIONS)).toMatchObject({ storageRestricted: false, storageSetting: null });
    expect(checkRetellAgent({ ...settings, data_storage_setting: "everything_except_pii" }, CLINIC, OPTIONS).storageRestricted).toBe(false);
    expect(checkRetellAgent({ ...settings, response_engine: { type: "retell-llm", llm_id: "llm_x" } }, CLINIC, OPTIONS).engineIsOurs).toBe(false);
    expect(
      checkRetellAgent(
        { ...settings, response_engine: { type: "custom-llm", llm_websocket_url: `wss://app.healdesk.test/llm-websocket/old_secret_0123456789/${CLINIC}` } },
        CLINIC,
        OPTIONS,
      ).engineIsOurs,
    ).toBe(false);
    expect(checkRetellAgent(null, CLINIC, OPTIONS)).toMatchObject({ storageRestricted: false, engineIsOurs: false, webhookIsOurs: false });

    const down = fakeFetch(() => json({}, 500));
    await expect(verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: down.fetch })).rejects.toThrow(/500/);
    await expect(verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, key: null, fetch: down.fetch })).rejects.toThrow(/HEALDESK_RETELL_API_KEY/);
    expect(down.seen).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

describe("a recording Retell kept", () => {
  test("is any of the four recording URLs, present and not empty", () => {
    expect(RECORDING_URL_FIELDS).toEqual(["recording_url", "recording_multi_channel_url", "scrubbed_recording_url", "scrubbed_recording_multi_channel_url"]);
    for (const field of RECORDING_URL_FIELDS) expect(retellCallHasRecording({ call_id: "c", [field]: RECORDING }), field).toBe(true);
    expect(retellCallHasRecording({ call_id: "c" })).toBe(false);
    expect(retellCallHasRecording({ call_id: "c", recording_url: "" })).toBe(false);
    expect(retellCallHasRecording({ call_id: "c", recording_url: null })).toBe(false);
    expect(retellCallHasRecording(null)).toBe(false);
    expect(retellCallHasRecording("recording_url")).toBe(false);
  });

  test("is not deleted at Retell before the backstop has read the call or given up", () => {
    // The first read, plus five retries doubling from a minute (about an hour).
    expect(DELETE_NOT_BEFORE_MS).toBeGreaterThanOrEqual(BACKSTOP_DELAY_SECONDS * 1000 + 63 * 60_000);
  });
});

// -----------------------------------------------------------------------------
// Against the real tables
// -----------------------------------------------------------------------------

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

function retellSign(body: string, at = Date.now()): string {
  return `v=${at},d=${createHmac("sha256", KEY).update(body + String(at)).digest("hex")}`;
}

function webhook(clinicId: string, body: unknown) {
  const raw = JSON.stringify(body);
  return retellWebhook(
    new Request(`http://localhost/api/webhooks/retell/${clinicId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-retell-signature": retellSign(raw) },
      body: raw,
    }),
    { params: Promise.resolve({ clinicId }) },
  );
}

async function alertRows(clinicId: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ id: string; retell_call_id: string; attempts: number; last_error: string | null; resolved_at: Date | null }>(
      `select id, retell_call_id, attempts, last_error, resolved_at from retell_recording_alerts order by detected_at`,
    ),
  );
  return rows;
}

describeDb("recording alerts, against the real tables", () => {
  const saved: Record<string, string | undefined> = {};
  let c: SeededClinic;

  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.scheduled = [];
    for (const key of ["HEALDESK_RETELL_API_KEY", "HEALDESK_PROVISION_SECRET"]) saved[key] = process.env[key];
    process.env.HEALDESK_RETELL_API_KEY = KEY;
    c = await seedClinic("rec-alerts");
  });

  afterEach(() => {
    __setRecordingDeleteDepsForTests(undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await closePools();
  });

  test("a webhook carrying a recording URL raises one alert per call, however often it comes; one without raises none", async () => {
    const call = { call_id: "call_rec_1", recording_url: RECORDING, transcript: "synthetic words", from_number: "+14155550192" };
    expect((await webhook(c.clinicId, { event: "call_ended", call })).status).toBe(204);
    expect((await webhook(c.clinicId, { event: "call_analyzed", call })).status).toBe(204);
    expect((await webhook(c.clinicId, { event: "call_ended", call })).status).toBe(204);
    expect((await webhook(c.clinicId, { event: "call_ended", call: { call_id: "call_clean" } })).status).toBe(204);
    // A call_started is not a call Retell has finished with: ignored, as before.
    expect((await webhook(c.clinicId, { event: "call_started", call: { call_id: "call_rec_2", recording_url: RECORDING } })).status).toBe(204);

    const rows = await alertRows(c.clinicId);
    expect(rows.map((r) => [r.retell_call_id, r.attempts, r.last_error, r.resolved_at])).toEqual([["call_rec_1", 0, null, null]]);
    // Opaque: no column could hold the URL, the words or the number.
    const { rows: columns } = await getMigratorPool().query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'retell_recording_alerts' order by ordinal_position`,
    );
    expect(columns.map((r) => r.column_name)).toEqual([
      "id",
      "clinic_id",
      "retell_call_id",
      "detected_at",
      "attempts",
      "last_attempt_at",
      "last_error",
      "resolved_at",
    ]);
    // The backstop is still queued for every finished call.
    expect(mocks.scheduled.map((s) => s.callId)).toEqual(["call_rec_1", "call_rec_1", "call_rec_1", "call_clean"]);
  });

  test("a clinic id that names no clinic records nothing", async () => {
    expect(await recordRecordingAlert(CLINIC, "call_rec_1")).toBe(false);
    expect((await webhook(CLINIC, { event: "call_ended", call: { call_id: "call_rec_1", recording_url: RECORDING } })).status).toBe(204);
  });

  test("the backstop's read of the call raises the alert too", async () => {
    const recorded: string[] = [];
    const call: RetellCall & Record<string, unknown> = { call_id: "call_rec_3", call_status: "ended", scrubbed_recording_url: RECORDING };
    await runCallBackstop(
      { clinicId: c.clinicId, callId: "call_rec_3" },
      { apiKey: KEY, realCalls: true, fetchCall: async () => call, recordAlert: async (_clinic, callId) => (recorded.push(callId), true) },
    );
    expect(recorded).toEqual(["call_rec_3"]);
  });

  test("the operations: a read of ids and times, and a delete that resolves the alert at Retell, idempotently", async () => {
    expect(isOpName("listRecordingAlerts")).toBe(true);
    expect(isMutating("listRecordingAlerts")).toBe(false);
    expect(isMutating("deleteRecordedCall")).toBe(true);
    await recordRecordingAlert(c.clinicId, "call_rec_1");
    const [row] = await alertRows(c.clinicId);

    const listed = await runOperation("listRecordingAlerts", {}, OPERATOR);
    expect(listed.status).toBe(200);
    const data = (listed.body as { data: { alerts: Record<string, unknown>[]; unreadClinics: number } }).data;
    expect(data.unreadClinics).toBe(0);
    expect(data.alerts).toHaveLength(1);
    // The projection, key by key: ids, a slug, counts, times and our own reason.
    expect(Object.keys(data.alerts[0]!).sort()).toEqual(
      ["alertId", "attempts", "callId", "clinicId", "clinicSlug", "detectedAt", "lastAttemptAt", "lastError", "resolvedAt"].sort(),
    );
    expect(data.alerts[0]).toMatchObject({ alertId: row!.id, clinicId: c.clinicId, clinicSlug: c.slug, callId: "call_rec_1", resolvedAt: null });
    expect(JSON.stringify(data)).not.toMatch(/https?:|\+1\d{6,}|wav/);

    // Too soon: the backstop may still need Retell's copy. Retell is not asked.
    const early = fakeFetch(() => new Response(null, { status: 204 }));
    __setRecordingDeleteDepsForTests({ fetch: early.fetch, apiKey: KEY });
    const tooSoon = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: row!.id }, OPERATOR);
    expect((tooSoon.body as { data: { status: string } }).data.status).toBe("too_soon");
    expect(early.seen).toEqual([]);

    // Later: a Retell failure leaves it open, with our reason and the attempt counted.
    const later = new Date(Date.now() + DELETE_NOT_BEFORE_MS + 60_000);
    const failing = fakeFetch(() => json({ status: "error", message: "synthetic upstream text" }, 500));
    __setRecordingDeleteDepsForTests({ fetch: failing.fetch, apiKey: KEY, now: later });
    const failed = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: row!.id }, OPERATOR);
    expect((failed.body as { data: unknown }).data).toEqual({ status: "failed", reason: "Retell answered 500" });
    expect(failing.seen).toEqual([
      { url: "https://api.retellai.com/v2/delete-call/call_rec_1", method: "DELETE", body: null, authorization: `Bearer ${KEY}` },
    ]);
    expect((await alertRows(c.clinicId)).map((r) => [r.attempts, r.last_error, r.resolved_at])).toEqual([[1, "Retell answered 500", null]]);

    // Unreachable: still open, in our words.
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    __setRecordingDeleteDepsForTests({ fetch: unreachable, apiKey: KEY, now: later });
    expect(((await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: row!.id }, OPERATOR)).body as { data: unknown }).data).toEqual({
      status: "failed",
      reason: "Retell could not be reached",
    });

    // Retell deletes it: resolved, the reason cleared.
    const deleting = fakeFetch(() => new Response(null, { status: 204 }));
    __setRecordingDeleteDepsForTests({ fetch: deleting.fetch, apiKey: KEY, now: later });
    const deleted = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: row!.id }, OPERATOR);
    expect((deleted.body as { data: { status: string } }).data.status).toBe("deleted");
    const [resolved] = await alertRows(c.clinicId);
    expect(resolved).toMatchObject({ attempts: 3, last_error: null });
    expect(resolved!.resolved_at).not.toBeNull();

    // A second press: already resolved, and Retell is not asked again.
    const again = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: row!.id }, OPERATOR);
    expect((again.body as { data: { status: string } }).data.status).toBe("already");
    expect(deleting.seen).toHaveLength(1);

    // Each press that reached Retell is a security event naming the operator.
    const { rows: events } = await getMigratorPool().query<{ event: string; actor_label: string }>(
      `select event, actor_label from security_events where event = 'retell_recorded_call_delete' order by occurred_at`,
    );
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.actor_label))).toEqual(new Set([OPERATOR.email]));
  });

  test("a call Retell no longer has (404) resolves; a recorded call may be deleted at once; a missing key stays open", async () => {
    await recordRecordingAlert(c.clinicId, "call_rec_4");
    await recordRecordingAlert(c.clinicId, "call_rec_5");
    const rows = await alertRows(c.clinicId);
    const byCall = Object.fromEntries(rows.map((r) => [r.retell_call_id, r.id]));

    // A conversation for the call: our copy exists, so no need to wait.
    await inTenant(c.clinicId, (client) =>
      client.query(`insert into conversations (clinic_id, channel, started_at, external_call_id) values ($1, 'voice', now(), 'call_rec_4')`, [c.clinicId]),
    );
    const missing = fakeFetch(() => json({ status: "error" }, 404));
    __setRecordingDeleteDepsForTests({ fetch: missing.fetch, apiKey: KEY });
    const gone = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: byCall.call_rec_4 }, OPERATOR);
    expect((gone.body as { data: { status: string } }).data.status).toBe("deleted");

    const later = new Date(Date.now() + DELETE_NOT_BEFORE_MS + 60_000);
    __setRecordingDeleteDepsForTests({ fetch: missing.fetch, apiKey: null, now: later });
    const noKey = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: byCall.call_rec_5 }, OPERATOR);
    expect((noKey.body as { data: unknown }).data).toEqual({ status: "failed", reason: "HEALDESK_RETELL_API_KEY is not set on apps/app" });
    expect(missing.seen).toHaveLength(1);

    // Another clinic's alert, or none at all: not found, nothing asked.
    const other = await seedClinic("rec-alerts-other");
    const crossed = await runOperation("deleteRecordedCall", { clinicId: other.clinicId, alertId: byCall.call_rec_5 }, OPERATOR);
    expect((crossed.body as { data: { status: string } }).data.status).toBe("not_found");
    const bad = await runOperation("deleteRecordedCall", { clinicId: c.clinicId, alertId: "not-an-id" }, OPERATOR);
    expect(bad.status).toBe(400);
    expect(missing.seen).toHaveLength(1);
  });

  test("the envelope refuses an unsigned or wrongly signed request before any work", async () => {
    process.env.HEALDESK_PROVISION_SECRET = "provision_secret_for_tests_0123456789";
    const body = JSON.stringify({ op: "deleteRecordedCall", args: { clinicId: c.clinicId, alertId: "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" } });
    const unsigned = await opsRoute(new Request("http://localhost/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(unsigned.status).toBe(401);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const forged = await opsRoute(
      new Request("http://localhost/api/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signOps(body, timestamp, "another_secret_0123456789abcdef"),
        },
        body,
      }),
    );
    expect(forged.status).toBe(401);
    const listBody = JSON.stringify({ op: "listRecordingAlerts", args: {} });
    expect((await opsRoute(new Request("http://localhost/api/ops", { method: "POST", body: listBody }))).status).toBe(401);
  });
});
