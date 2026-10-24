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
import { purgeClinic } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";
import {
  BACKSTOP_DELAY_SECONDS,
  BACKSTOP_RETRY_DELAY_SECONDS,
  BACKSTOP_RETRY_LIMIT,
  runCallBackstop,
  type RetellCall,
} from "@/lib/voice/backstop";
import type { VoiceCallEvent } from "@/lib/voice/ingest";
import { getRetellPhoneNumber } from "@/lib/voice/retell-api";
import { deleteRetellNumber, getRetellNumber } from "@/lib/voice/retell-numbers";
import {
  DELETE_NOT_BEFORE_MS,
  deleteRetellCallAfterIngest,
  recordRecordingAlert,
  RETELL_DELETION_WINDOW_MS,
} from "@/lib/voice/recording-alerts";
import {
  checkRetellAgent,
  createRetellAgent,
  deleteRetellAgent,
  getRetellAgent,
  RETELL_DATA_RETENTION_DAYS,
  RETELL_DATA_STORAGE_SETTING,
  RetellAgentConfigError,
  RETELL_CONVERSATION_SETTINGS,
  retellAgentSettings,
  updateRetellAgent,
  verifyRetellAgent,
} from "@/lib/voice/retell-agent";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * Retell's copy of a call (the owner's decision of 21 October 2026): every
 * clinic's agent is written to keep the transcript, with a one-day retention
 * (lib/voice/retell-agent.ts); once the call and its sealed transcript are
 * committed here, the backstop job deletes the call at Retell, never before
 * and never when the ingest failed (lib/voice/recording-alerts.ts); a call
 * Retell still holds past the deletion window is one opaque alert, which
 * /admin/recordings deletes at Retell through the ops API. Retell is never
 * called: every request goes to a mocked fetch, and every value here is
 * synthetic.
 */

const CLINIC = "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60";
const SECRET = "llm_secret_for_tests_0123456789";
const ORIGIN = "https://app.healdesk.test";
const KEY = "key_test_retell_engine_0123456789";
const OPTIONS = { llmSecret: SECRET, publicOrigin: ORIGIN, key: KEY, engine: { type: "custom-llm" } } as const;
/** A recording URL's shape only; nothing fetches it. */
const RECORDING = "https://recordings.example.test/rec/recording.wav";
const ASSISTANT = "+14155550100";

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

  test("keeps the transcript, for one day at most, with our custom-LLM endpoint for the clinic and its webhook", () => {
    // everything_except_pii would scrub the transcript the clinic is emailed;
    // basic_attributes_only would leave the crash backstop nothing to read.
    expect(RETELL_DATA_STORAGE_SETTING).toBe("everything");
    // Retell's minimum: its own deletion of anything ours did not delete.
    expect(RETELL_DATA_RETENTION_DAYS).toBe(1);
    expect(settings).toEqual({
      response_engine: { type: "custom-llm", llm_websocket_url: `wss://app.healdesk.test/llm-websocket/${SECRET}/${CLINIC}` },
      webhook_url: `https://app.healdesk.test/api/webhooks/retell/${CLINIC}`,
      data_storage_setting: "everything",
      data_storage_retention_days: 1,
      // How a call feels (24 October 2026): backchannel, immediate yielding, some pitch variety.
      enable_backchannel: true,
      backchannel_frequency: 0.7,
      backchannel_words: ["mm-hmm", "right", "gotcha", "okay"],
      interruption_sensitivity: 1,
      responsiveness: 1,
      voice_temperature: 1.2,
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

  test("the engine is an input: a Retell LLM that exists, named by id and version, needs no socket secret", () => {
    const retellLlm = { ...OPTIONS, llmSecret: null, engine: { type: "retell-llm", llmId: "llm_synthetic_1", version: 3 } } as const;
    const native = retellAgentSettings(CLINIC, retellLlm);
    expect(native).toEqual({
      response_engine: { type: "retell-llm", llm_id: "llm_synthetic_1", version: 3 },
      webhook_url: `https://app.healdesk.test/api/webhooks/retell/${CLINIC}`,
      data_storage_setting: "everything",
      data_storage_retention_days: 1,
      ...RETELL_CONVERSATION_SETTINGS,
    });
    expect(JSON.stringify(native)).not.toContain("llm-websocket");
    expect(retellAgentSettings(CLINIC, { ...retellLlm, engine: { type: "retell-llm", llmId: "llm_synthetic_1" } }).response_engine).toEqual({
      type: "retell-llm",
      llm_id: "llm_synthetic_1",
    });
    expect(() => retellAgentSettings(CLINIC, { ...retellLlm, engine: { type: "retell-llm", llmId: "../x" } })).toThrow(RetellAgentConfigError);
    expect(() => retellAgentSettings(CLINIC, { ...retellLlm, engine: { type: "retell-llm", llmId: "llm_1", version: -1 } })).toThrow(RetellAgentConfigError);

    // Read back: the same LLM (and version, when named) is ours; another, or our socket, is not.
    expect(checkRetellAgent(native, CLINIC, retellLlm)).toMatchObject({ storageAsWritten: true, engineIsOurs: true, webhookIsOurs: true });
    expect(checkRetellAgent({ ...native, response_engine: { type: "retell-llm", llm_id: "llm_other" } }, CLINIC, retellLlm).engineIsOurs).toBe(false);
    expect(checkRetellAgent({ ...native, response_engine: { type: "retell-llm", llm_id: "llm_synthetic_1", version: 2 } }, CLINIC, retellLlm).engineIsOurs).toBe(false);
    expect(checkRetellAgent(settings, CLINIC, retellLlm).engineIsOurs).toBe(false);
    expect(checkRetellAgent(native, CLINIC, OPTIONS).engineIsOurs).toBe(false);
  });

  test("create posts the settings and a voice, and checks Retell kept them", async () => {
    const { fetch, seen } = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object) }, 201));
    const created = await createRetellAgent(CLINIC, { voiceId: "retell-Voice" }, { ...OPTIONS, fetch });
    expect(created).toEqual({
      agentId: "agent_abc123",
      check: { storageAsWritten: true, storageSetting: "everything", engineIsOurs: true, webhookIsOurs: true },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://api.retellai.com/create-agent", method: "POST", authorization: `Bearer ${KEY}` });
    expect(seen[0]!.body).toMatchObject({ ...settings, voice_id: "retell-Voice", agent_name: `healdesk ${CLINIC}` });
    expect(seen[0]!.body).toMatchObject({ data_storage_setting: "everything", data_storage_retention_days: 1 });

    // An answer without the retention is an agent that keeps calls forever.
    const forever = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object), data_storage_retention_days: null }, 201));
    await expect(createRetellAgent(CLINIC, { voiceId: "retell-Voice" }, { ...OPTIONS, fetch: forever.fetch })).rejects.toThrow(/retention/);
  });

  test("update patches the agent to the settings; an answer that dropped storage or retention is an error, never success", async () => {
    const good = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object) }));
    expect((await updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: good.fetch })).storageAsWritten).toBe(true);
    expect(good.seen[0]).toMatchObject({ url: "https://api.retellai.com/update-agent/agent_abc123", method: "PATCH" });
    expect(good.seen[0]!.body).toEqual(settings);

    const scrubbing = fakeFetch((s) => json({ ...(s.body as object), data_storage_setting: "everything_except_pii" }));
    await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: scrubbing.fetch })).rejects.toThrow(/storage setting/);
    const longer = fakeFetch((s) => json({ ...(s.body as object), data_storage_retention_days: 30 }));
    await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: longer.fetch })).rejects.toThrow(/retention/);
    const refused = fakeFetch(() => json({ status: "error" }, 422));
    await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: refused.fetch })).rejects.toThrow(/422/);
    await expect(updateRetellAgent("../etc", CLINIC, { ...OPTIONS, fetch: good.fetch })).rejects.toThrow(RetellAgentConfigError);
  });

  test("the speech language goes to create and update as Retell's locale array, keywords when given; a bad one is refused before any request", async () => {
    const { fetch, seen } = fakeFetch((s) => json({ agent_id: "agent_abc123", ...(s.body as object) }, 201));
    await createRetellAgent(CLINIC, { voiceId: "retell-Voice", language: ["en-US", "es-419"], boostedKeywords: ["Radiance", " Botox "] }, { ...OPTIONS, fetch });
    expect(seen[0]!.body).toMatchObject({ language: ["en-US", "es-419"], boosted_keywords: ["Radiance", "Botox"] });
    await updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch }, { voiceId: "retell-Voice", language: ["en-US", "es-419"] });
    expect(seen[1]!.body).toMatchObject({ voice_id: "retell-Voice", language: ["en-US", "es-419"] });
    expect(seen[1]!.body).not.toHaveProperty("boosted_keywords");
    // One locale is sent as Retell's scalar, as before.
    await updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch }, { language: ["en-US"] });
    expect(seen[2]!.body).toMatchObject({ language: "en-US" });
    for (const language of ["multi", "es", [], ["en-US", "multi"]] as const) {
      await expect(createRetellAgent(CLINIC, { voiceId: "retell-Voice", language }, { ...OPTIONS, fetch })).rejects.toThrow(RetellAgentConfigError);
    }
    for (const boostedKeywords of [["{{caller}}"], [""], ["a\nb"], Array.from({ length: 101 }, (_, i) => `w${i}`)]) {
      await expect(updateRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch }, { boostedKeywords })).rejects.toThrow(RetellAgentConfigError);
    }
    expect(seen).toHaveLength(3);
  });

  test("verify reads the agent back and reports, as yes or no, never a URL", async () => {
    const { fetch, seen } = fakeFetch(() => json({ agent_id: "agent_abc123", ...settings }));
    const check = await verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch });
    expect(check).toEqual({ storageAsWritten: true, storageSetting: "everything", engineIsOurs: true, webhookIsOurs: true });
    expect(seen[0]).toMatchObject({ url: "https://api.retellai.com/get-agent/agent_abc123", method: "GET" });
    expect(JSON.stringify(check)).not.toContain(SECRET);

    // Retell's default, a console change, an engine that is not ours, an old secret.
    expect(checkRetellAgent({ ...settings, data_storage_setting: undefined }, CLINIC, OPTIONS)).toMatchObject({ storageAsWritten: false, storageSetting: null });
    expect(checkRetellAgent({ ...settings, data_storage_setting: "everything_except_pii" }, CLINIC, OPTIONS).storageAsWritten).toBe(false);
    expect(checkRetellAgent({ ...settings, data_storage_setting: "basic_attributes_only" }, CLINIC, OPTIONS).storageAsWritten).toBe(false);
    expect(checkRetellAgent({ ...settings, data_storage_retention_days: undefined }, CLINIC, OPTIONS).storageAsWritten).toBe(false);
    expect(checkRetellAgent({ ...settings, response_engine: { type: "retell-llm", llm_id: "llm_x" } }, CLINIC, OPTIONS).engineIsOurs).toBe(false);
    expect(
      checkRetellAgent(
        { ...settings, response_engine: { type: "custom-llm", llm_websocket_url: `wss://app.healdesk.test/llm-websocket/old_secret_0123456789/${CLINIC}` } },
        CLINIC,
        OPTIONS,
      ).engineIsOurs,
    ).toBe(false);
    expect(checkRetellAgent(null, CLINIC, OPTIONS)).toMatchObject({ storageAsWritten: false, engineIsOurs: false, webhookIsOurs: false });

    const down = fakeFetch(() => json({}, 500));
    await expect(verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, fetch: down.fetch })).rejects.toThrow(/500/);
    await expect(verifyRetellAgent("agent_abc123", CLINIC, { ...OPTIONS, key: null, fetch: down.fetch })).rejects.toThrow(/HEALDESK_RETELL_API_KEY/);
    expect(down.seen).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// The window
// -----------------------------------------------------------------------------

describe("the deletion window", () => {
  test("is 30 minutes, and the backstop job's last try is always after it", () => {
    expect(RETELL_DELETION_WINDOW_MS).toBe(30 * 60_000);
    // pg-boss waits retryDelay * 2^n * (1 to 2) after the n-th failure: the
    // least the retries can take is retryDelay * (2^limit - 1).
    const leastRetrySeconds = BACKSTOP_RETRY_DELAY_SECONDS * (2 ** BACKSTOP_RETRY_LIMIT - 1);
    expect((BACKSTOP_DELAY_SECONDS + leastRetrySeconds) * 1000).toBeGreaterThan(RETELL_DELETION_WINDOW_MS);
  });

  test("a manual delete of a call not recorded here waits until the backstop has read it or given up", () => {
    // The first read, plus five retries doubling from a minute, at most (about an hour).
    const mostRetrySeconds = 2 * BACKSTOP_RETRY_DELAY_SECONDS * (2 ** BACKSTOP_RETRY_LIMIT - 1);
    expect(DELETE_NOT_BEFORE_MS).toBeGreaterThanOrEqual((BACKSTOP_DELAY_SECONDS + mostRetrySeconds) * 1000);
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

  test("a webhook carrying a recording URL raises no alert: Retell's copy is expected until the call is recorded", async () => {
    const call = { call_id: "call_rec_1", recording_url: RECORDING, transcript: "synthetic words", from_number: "+14155550192" };
    expect((await webhook(c.clinicId, { event: "call_ended", call })).status).toBe(204);
    expect((await webhook(c.clinicId, { event: "call_analyzed", call })).status).toBe(204);
    expect((await webhook(c.clinicId, { event: "call_ended", call: { call_id: "call_clean" } })).status).toBe(204);
    expect(await alertRows(c.clinicId)).toEqual([]);
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
    // The backstop, which records and then deletes, is queued for every finished call.
    expect(mocks.scheduled.map((s) => s.callId)).toEqual(["call_rec_1", "call_rec_1", "call_clean"]);
  });

  test("the nightly purge takes a resolved alert on the record clock and never an open one", async () => {
    // Review of 21 October 2026: an open alert is the only trace of a
    // recording Retell still holds, so only a resolved one goes.
    expect(await recordRecordingAlert(c.clinicId, "call_rec_open")).toBe(true);
    expect(await recordRecordingAlert(c.clinicId, "call_rec_done")).toBe(true);
    await inTenant(c.clinicId, (client) =>
      client.query(`update retell_recording_alerts set resolved_at = now() where retell_call_id = 'call_rec_done'`),
    );
    const purge = (now: Date) =>
      withTenant({ clinicId: c.clinicId, actor: { type: "agent", serviceName: "retention-purge" } }, (tx) => purgeClinic(tx, now));
    // Inside the record clock: both stay.
    expect((await purge(new Date())).recordingAlertsDeleted).toBe(0);
    // Long past it: the resolved one goes, the open one stays.
    expect((await purge(new Date(Date.now() + 800 * 24 * 60 * 60_000))).recordingAlertsDeleted).toBe(1);
    expect((await alertRows(c.clinicId)).map((r) => r.retell_call_id)).toEqual(["call_rec_open"]);
  });

  test("a clinic id that names no clinic records nothing", async () => {
    expect(await recordRecordingAlert(CLINIC, "call_rec_1")).toBe(false);
    expect(await recordRecordingAlert(CLINIC, "call_rec_1", { reason: "Retell answered 500", at: new Date() })).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The automatic delete
  // ---------------------------------------------------------------------------

  const ENDED = new Date("2026-10-21T12:00:00.000Z");
  const at = (minutes: number) => new Date(ENDED.getTime() + minutes * 60_000);

  async function recordConversation(clinicId: string, callId: string) {
    await inTenant(clinicId, (client) =>
      client.query(
        `insert into conversations (clinic_id, channel, started_at, ended_at, external_call_id) values ($1, 'voice', $2, $3, $4)`,
        [clinicId, new Date(ENDED.getTime() - 5 * 60_000), ENDED, callId],
      ),
    );
  }

  test("nothing is deleted at Retell for a call with no conversation here: our copy is not committed", async () => {
    const asked = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_unrecorded", { fetch: asked.fetch, apiKey: KEY, now: at(90) })).toEqual({
      status: "not_recorded",
    });
    expect(await deleteRetellCallAfterIngest(c.clinicId, "../bad", { fetch: asked.fetch, apiKey: KEY })).toEqual({ status: "not_recorded" });
    expect(asked.seen).toEqual([]);
    expect(await alertRows(c.clinicId)).toEqual([]);
  });

  test("a recorded call is deleted at Retell; 204 and Retell's JSON 404 are both done, and a retry is harmless", async () => {
    await recordConversation(c.clinicId, "call_done");
    const deleting = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_done", { fetch: deleting.fetch, apiKey: KEY, now: at(10) })).toEqual({ status: "deleted" });
    expect(deleting.seen).toEqual([
      { url: "https://api.retellai.com/v2/delete-call/call_done", method: "DELETE", body: null, authorization: `Bearer ${KEY}` },
    ]);
    const gone = fakeFetch(() => json({ status: "error", message: "Not Found" }, 404));
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_done", { fetch: gone.fetch, apiKey: KEY, now: at(11) })).toEqual({ status: "deleted" });
    expect(await alertRows(c.clinicId)).toEqual([]);
  });

  // What live Retell answered to DELETE /v2/delete-call (22 October 2026):
  // a missing call on the right route is 404 with {"status":"error","message":
  // "Not Found"}; a wrong route is 404 with an HTML page; a call still in
  // progress is 400 {"status":"error","message":"Cannot delete a live call.
  // Please wait until the call is completed."}. Mocked fetch only.
  const HTML_404 = () => new Response("<!DOCTYPE html><html><body><pre>Cannot DELETE /v2/delete-call/call_x</pre></body></html>", { status: 404, headers: { "content-type": "text/html" } });
  const LIVE_400 = () => json({ status: "error", message: "Cannot delete a live call. Please wait until the call is completed." }, 400);

  test("only Retell's own JSON 404 means already deleted: an HTML, empty or unparseable 404 is a failure, alerted after the window", async () => {
    await recordConversation(c.clinicId, "call_404s");
    for (const [name, answer] of [
      ["html", HTML_404],
      ["empty", () => new Response(null, { status: 404 })],
      ["unparseable", () => new Response("not json {", { status: 404 })],
      ["json without status error", () => json({ message: "Not Found" }, 404)],
    ] as const) {
      const wrong = fakeFetch(answer);
      expect(await deleteRetellCallAfterIngest(c.clinicId, "call_404s", { fetch: wrong.fetch, apiKey: KEY, now: at(10) }), name).toEqual({
        status: "failed",
        reason: "Retell answered 404 without its not-found body",
        alerted: false,
      });
    }
    expect(await alertRows(c.clinicId)).toEqual([]);
    const html = fakeFetch(HTML_404);
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_404s", { fetch: html.fetch, apiKey: KEY, now: at(31) })).toMatchObject({ status: "failed", alerted: true });
    expect((await alertRows(c.clinicId)).map((r) => [r.retell_call_id, r.last_error, r.resolved_at])).toEqual([
      ["call_404s", "Retell answered 404 without its not-found body", null],
    ]);
    // Retell's JSON 404 then resolves that alert.
    const gone = fakeFetch(() => json({ status: "error", message: "Not Found" }, 404));
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_404s", { fetch: gone.fetch, apiKey: KEY, now: at(40) })).toEqual({ status: "deleted" });
    expect((await alertRows(c.clinicId))[0]!.resolved_at).not.toBeNull();
  });

  test("a call still live (400) is retried later with no alert at once, and is alerted once the window passes; any other 400 is a plain failure", async () => {
    await recordConversation(c.clinicId, "call_live");
    const live = fakeFetch(LIVE_400);
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_live", { fetch: live.fetch, apiKey: KEY, now: at(10) })).toEqual({
      status: "failed",
      reason: "Retell says the call is still live",
      alerted: false,
      retryLater: true,
    });
    expect(await alertRows(c.clinicId)).toEqual([]);
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_live", { fetch: live.fetch, apiKey: KEY, now: at(31) })).toMatchObject({
      status: "failed",
      alerted: true,
      retryLater: true,
    });
    expect((await alertRows(c.clinicId)).map((r) => [r.retell_call_id, r.last_error, r.resolved_at])).toEqual([
      ["call_live", "Retell says the call is still live", null],
    ]);

    // Another 400 (a different message, or no JSON) is a failure, not a wait.
    for (const answer of [() => json({ status: "error", message: "Invalid call id" }, 400), () => new Response("bad", { status: 400 })]) {
      const other = fakeFetch(answer);
      const result = await deleteRetellCallAfterIngest(c.clinicId, "call_live", { fetch: other.fetch, apiKey: KEY, now: at(12) });
      expect(result).toMatchObject({ status: "failed", reason: "Retell answered 400" });
      expect(result).not.toHaveProperty("retryLater");
    }
  });

  test("the other Retell lookups agree: only the JSON 404 is 'absent', an HTML 404 throws", async () => {
    const jsonMissing = fakeFetch(() => json({ status: "error", message: "Not Found" }, 404));
    const html = fakeFetch(HTML_404);
    const opts = { key: KEY };
    expect(await deleteRetellAgent("agent_abc123", { ...opts, fetch: jsonMissing.fetch })).toBe("absent");
    await expect(deleteRetellAgent("agent_abc123", { ...opts, fetch: html.fetch })).rejects.toThrow(/404/);
    expect(await getRetellAgent("agent_abc123", { ...opts, fetch: jsonMissing.fetch })).toBeNull();
    await expect(getRetellAgent("agent_abc123", { ...opts, fetch: html.fetch })).rejects.toThrow(/404/);
    expect(await getRetellNumber("+14155550100", { ...opts, fetch: jsonMissing.fetch })).toBeNull();
    await expect(getRetellNumber("+14155550100", { ...opts, fetch: html.fetch })).rejects.toThrow(/404/);
    expect(await deleteRetellNumber("+14155550100", { ...opts, fetch: jsonMissing.fetch })).toBe("absent");
    await expect(deleteRetellNumber("+14155550100", { ...opts, fetch: html.fetch })).rejects.toThrow(/404/);
    expect(await getRetellPhoneNumber("+14155550100", { ...opts, fetch: jsonMissing.fetch })).toBeNull();
    await expect(getRetellPhoneNumber("+14155550100", { ...opts, fetch: html.fetch })).rejects.toThrow(/404/);
  });

  test("a failed delete is an alert only after the window, once per call, and a later delete resolves it", async () => {
    await recordConversation(c.clinicId, "call_stuck");
    const failing = fakeFetch(() => json({ status: "error", message: "synthetic upstream text" }, 500));

    // Inside the window: retried by the job, no alert yet.
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_stuck", { fetch: failing.fetch, apiKey: KEY, now: at(10) })).toEqual({
      status: "failed",
      reason: "Retell answered 500",
      alerted: false,
    });
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_stuck", { fetch: failing.fetch, apiKey: KEY, now: at(29) })).toMatchObject({ alerted: false });
    expect(await alertRows(c.clinicId)).toEqual([]);

    // Past it: one alert, in our words.
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_stuck", { fetch: failing.fetch, apiKey: KEY, now: at(31) })).toMatchObject({ alerted: true });
    expect((await alertRows(c.clinicId)).map((r) => [r.retell_call_id, r.attempts, r.last_error, r.resolved_at])).toEqual([
      ["call_stuck", 1, "Retell answered 500", null],
    ]);
    // Again: still one alert, one more attempt, the newest reason.
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_stuck", { fetch: failing.fetch, apiKey: null, now: at(45) })).toMatchObject({ alerted: true });
    expect((await alertRows(c.clinicId)).map((r) => [r.attempts, r.last_error, r.resolved_at])).toEqual([
      [2, "HEALDESK_RETELL_API_KEY is not set on apps/app", null],
    ]);
    expect(failing.seen).toHaveLength(3);

    // Retell back: deleted, and the alert resolves.
    const deleting = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await deleteRetellCallAfterIngest(c.clinicId, "call_stuck", { fetch: deleting.fetch, apiKey: KEY, now: at(50) })).toEqual({ status: "deleted" });
    const [resolved] = await alertRows(c.clinicId);
    expect(resolved).toMatchObject({ attempts: 3, last_error: null });
    expect(resolved!.resolved_at).not.toBeNull();
    // The resolved alert is never reopened by a later failure.
    await recordRecordingAlert(c.clinicId, "call_stuck", { reason: "Retell answered 502", at: at(60) });
    expect((await alertRows(c.clinicId)).map((r) => [r.attempts, r.last_error])).toEqual([[3, null]]);
  });

  function endedCall(callId: string): RetellCall {
    return {
      call_id: callId,
      call_type: "phone_call",
      call_status: "ended",
      direction: "inbound",
      to_number: ASSISTANT,
      from_number: "+14155550192",
      start_timestamp: ENDED.getTime() - 5 * 60_000,
      end_timestamp: ENDED.getTime(),
      duration_ms: 300_000,
      transcript_object: [
        { role: "agent", content: "Hello, synthetic opening." },
        { role: "user", content: "A synthetic question." },
      ],
    };
  }

  test("the backstop deletes only after the ingest has committed; a failed ingest deletes nothing", async () => {
    await getMigratorPool().query(`update clinics set assistant_number_e164 = $2 where id = $1`, [c.clinicId, ASSISTANT]);
    const order: string[] = [];
    const deleteCall = async (clinicId: string, callId: string) => {
      order.push(`delete ${callId}`);
      return deleteRetellCallAfterIngest(clinicId, callId, { fetch: fakeFetch(() => new Response(null, { status: 204 })).fetch, apiKey: KEY });
    };
    const ingest = async (event: VoiceCallEvent) => {
      order.push(`ingest ${event.externalCallId}`);
      await recordConversation(c.clinicId, event.externalCallId);
      return { conversationId: crypto.randomUUID(), recoveryReason: null, duplicate: false } as never;
    };
    const recorded = await runCallBackstop(
      { clinicId: c.clinicId, callId: "call_crash" },
      { apiKey: KEY, realCalls: true, fetchCall: async (id) => endedCall(id), ingest, deleteCall },
    );
    expect(recorded.status).toBe("recorded");
    expect(order).toEqual(["ingest call_crash", "delete call_crash"]);

    // The ingest throws (the database, say): retried, and Retell is not asked.
    order.length = 0;
    await expect(
      runCallBackstop(
        { clinicId: c.clinicId, callId: "call_ingest_fails" },
        {
          apiKey: KEY,
          realCalls: true,
          fetchCall: async (id) => endedCall(id),
          ingest: async () => {
            throw new Error("synthetic database failure");
          },
          deleteCall,
        },
      ),
    ).rejects.toThrow(/synthetic database failure/);
    expect(order).toEqual([]);

    // The ingest returned but nothing committed: the delete checks for itself and asks Retell nothing.
    const asked = fakeFetch(() => new Response(null, { status: 204 }));
    await runCallBackstop(
      { clinicId: c.clinicId, callId: "call_rolled_back" },
      {
        apiKey: KEY,
        realCalls: true,
        fetchCall: async (id) => endedCall(id),
        ingest: async () => ({ conversationId: crypto.randomUUID(), recoveryReason: null, duplicate: false }) as never,
        deleteCall: (clinicId, callId) => deleteRetellCallAfterIngest(clinicId, callId, { fetch: asked.fetch, apiKey: KEY }),
      },
    );
    expect(asked.seen).toEqual([]);
  });

  test("a delete that fails retries the job, which then finds the call recorded and deletes it without reading Retell again", async () => {
    await getMigratorPool().query(`update clinics set assistant_number_e164 = $2 where id = $1`, [c.clinicId, ASSISTANT]);
    const fetchCall = vi.fn(async (id: string) => endedCall(id));
    const ingest = async (event: VoiceCallEvent) => {
      await recordConversation(c.clinicId, event.externalCallId);
      return { conversationId: crypto.randomUUID(), recoveryReason: null, duplicate: false } as never;
    };
    const down = fakeFetch(() => json({}, 503));
    await expect(
      runCallBackstop(
        { clinicId: c.clinicId, callId: "call_retry" },
        { apiKey: KEY, realCalls: true, fetchCall, ingest, deleteCall: (cl, id) => deleteRetellCallAfterIngest(cl, id, { fetch: down.fetch, apiKey: KEY, now: at(10) }) },
      ),
    ).rejects.toThrow(/not deleted at Retell: Retell answered 503/);
    expect(await alertRows(c.clinicId)).toEqual([]);

    const up = fakeFetch(() => new Response(null, { status: 204 }));
    expect(
      await runCallBackstop(
        { clinicId: c.clinicId, callId: "call_retry" },
        { apiKey: KEY, realCalls: true, fetchCall, ingest, deleteCall: (cl, id) => deleteRetellCallAfterIngest(cl, id, { fetch: up.fetch, apiKey: KEY, now: at(12) }) },
      ),
    ).toEqual({ status: "already_recorded" });
    expect(fetchCall).toHaveBeenCalledTimes(1);
    expect(down.seen).toHaveLength(1);
    expect(up.seen.map((s) => s.url)).toEqual(["https://api.retellai.com/v2/delete-call/call_retry"]);
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

  test("a call Retell no longer has (its JSON 404) resolves; a recorded call may be deleted at once; a missing key stays open", async () => {
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
