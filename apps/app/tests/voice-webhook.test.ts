import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/webhooks/voice/[clinicId]/route";
import { readSynthflowPayload, VoicePayloadError } from "@/lib/voice/synthflow-payload";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The voice webhook: the one route that turns a phone call into a row.
 *
 * The payload fixture below is the contract with the vendor
 * (docs/synthflow-voice-agent-context.md, question 7). When Synthflow
 * confirms the field names, change the fixture and the reader together.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SECRET = "voice-webhook-secret-for-tests";
const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A post-call payload in the documented shape (https://docs.synthflow.ai/
 * post-call-webhook, read 23 September 2026): top-level `call_id`, `status`,
 * `lead { name, phone_number }` and the extractors' `collected_variables`.
 */
const FIXTURE = {
  call_id: "call_abc123",
  model_id: "agent_inbound_1",
  start_time: "2026-09-02T18:00:00Z",
  end_time: "2026-09-02T18:04:30Z",
  duration: 270,
  status: "completed",
  lead: { name: "Test Caller", phone_number: "(555) 010-0123" },
  recording_url: "https://recordings.example.test/call_abc123.mp3",
  transcript_url: "https://transcripts.example.test/call_abc123.txt",
  executed_actions: [],
  collected_variables: {
    outcome: "booked",
    treatment_interest: "Botox",
    caller_name: "Test Caller",
    booked_for: "2026-09-10T15:00:00Z",
    preferred_window: "next Thursday afternoon",
    preferred_alt_1: "Friday morning",
    preferred_alt_2: "",
    booked_treatment: "Botox",
    rang_at_clinic_first: "true",
  },
};

describe("reading the vendor payload", () => {
  test("maps the confirmed fields and the extracted variables", () => {
    const event = readSynthflowPayload(FIXTURE, CLINIC_ID);
    expect(event.externalCallId).toBe("call_abc123");
    expect(event.callerPhone).toBe("+15550100123");
    expect(event.callerName).toBe("Test Caller");
    expect(event.startedAt.toISOString()).toBe("2026-09-02T18:00:00.000Z");
    expect(event.endedAt?.toISOString()).toBe("2026-09-02T18:04:30.000Z");
    expect(event.outcome).toBe("booked");
    expect(event.rangAtClinicFirst).toBe(true);
    expect(event.booking?.scheduledFor.toISOString()).toBe("2026-09-10T15:00:00.000Z");
    expect(event.booking?.treatment).toBe("Botox");
    expect(event.booking?.alternativeWindows).toEqual(["Friday morning"]);
    // No audio reference, even when the vendor sends one (21 September 2026).
    expect("recordingUri" in event).toBe(false);
  });

  test("the earlier aliases still land a payload from an agent configured under the previous draft", () => {
    const event = readSynthflowPayload(
      { call_id: "old_1", phone_number: "(555) 010-0123", start_time: "2026-09-02T18:00:00Z", custom_variables: { outcome: "booked", booked_for: "2026-09-10T15:00:00Z", preferred_time: "Tuesday" } },
      CLINIC_ID,
    );
    expect(event.callerPhone).toBe("+15550100123");
    expect(event.booking).toMatchObject({ preferredWindow: "Tuesday" });
  });

  test("accepts the nested and aliased shapes, and unix timestamps", () => {
    const event = readSynthflowPayload(
      { call: { id: "c2", customer_phone: "+15550100124", started_at: 1_756_836_000, variables: { call_outcome: "SPAM" } } },
      CLINIC_ID,
    );
    expect(event.externalCallId).toBe("c2");
    expect(event.callerPhone).toBe("+15550100124");
    expect(event.startedAt.getTime()).toBe(1_756_836_000 * 1000);
    expect(event.outcome).toBe("spam");
  });

  test("an unknown outcome is unknown, not guessed; a bad number is dropped", () => {
    const event = readSynthflowPayload(
      { call_id: "c3", start_time: "2026-09-02T18:00:00Z", phone_number: "anonymous", custom_variables: { outcome: "great call" } },
      CLINIC_ID,
    );
    expect(event.outcome).toBeUndefined();
    expect(event.callerPhone).toBeUndefined();
    expect(event.booking).toBeUndefined();
  });

  test("refuses a payload with no call id or no start time", () => {
    expect(() => readSynthflowPayload({ start_time: "2026-09-02T18:00:00Z" }, CLINIC_ID)).toThrow(VoicePayloadError);
    expect(() => readSynthflowPayload({ call_id: "c4" }, CLINIC_ID)).toThrow(VoicePayloadError);
  });
});

function post(clinicId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`http://app.test/api/webhooks/voice/${clinicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ clinicId }) });
}

describeDb("POST /api/webhooks/voice/[clinicId]", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    process.env.HEALDESK_VOICE_WEBHOOK_SECRET = SECRET;
  });

  afterAll(async () => {
    await closePools();
  });

  test("refuses everything when the secret is unset, and stores nothing", async () => {
    delete process.env.HEALDESK_VOICE_WEBHOOK_SECRET;
    const c = await seedClinic("voice-unset");
    const res = await post(c.clinicId, FIXTURE);
    expect(res.status).toBe(503);
    const stored = await inTenant(c.clinicId, (client) => client.query(`select id from webhook_events`));
    expect(stored.rows).toHaveLength(0);
  });

  test("a wrong or missing bearer is 401", async () => {
    const c = await seedClinic("voice-auth");
    expect((await post(c.clinicId, FIXTURE, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(c.clinicId, FIXTURE, { authorization: "" })).status).toBe(401);
  });

  test("bad input is refused with the reason, never stored", async () => {
    const c = await seedClinic("voice-bad");
    expect((await post(c.clinicId, "{not json")).status).toBe(400);
    const noId = await post(c.clinicId, { start_time: "2026-09-02T18:00:00Z" });
    expect(noId.status).toBe(400);
    expect(((await noId.json()) as { error: string }).error).toMatch(/call id/);
    expect((await post("not-a-uuid", FIXTURE)).status).toBe(404);
    const stored = await inTenant(c.clinicId, (client) => client.query(`select id from webhook_events`));
    expect(stored.rows).toHaveLength(0);
  });

  test("a clinic that has left stores nothing from a late call, and the vendor is answered 200 so it stops retrying", async () => {
    const { startOffboarding } = await import("@/lib/offboarding/offboarding");
    const { withTenant } = await import("@/lib/tenant");
    const leaving = await seedClinic("voice-leaving");
    await withTenant(
      { clinicId: leaving.clinicId, actor: { type: "service", serviceName: "voice-webhook-test" } },
      (tx) => startOffboarding(tx, "operator"),
    );
    const destroyed = await seedClinic("voice-destroyed");
    // Destroyed long ago, as the migrator, which owns the stamps.
    await getMigratorPool().query(
      `update clinics set offboarding_started_at = now() - interval '40 days',
              destroy_after = now() - interval '10 days', destroyed_at = now() - interval '9 days'
        where id = $1`,
      [destroyed.clinicId],
    );
    for (const c of [leaving, destroyed]) {
      const res = await post(c.clinicId, FIXTURE);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, stored: false });
      const kept = await inTenant(c.clinicId, async (client) => ({
        events: (await client.query(`select id from webhook_events`)).rows.length,
        conversations: (await client.query(`select id from conversations`)).rows.length,
        contacts: (await client.query(`select id from contacts`)).rows.length,
        requests: (await client.query(`select id from booking_requests`)).rows.length,
      }));
      expect(kept).toEqual({ events: 0, conversations: 0, contacts: 0, requests: 0 });
    }
  });

  test("a good call is stored raw, ingested, and replayed as a duplicate", async () => {
    const c = await seedClinic("voice-good");
    await getMigratorPool().query(`update clinics set call_routing = 'conditional' where id = $1`, [c.clinicId]);

    const first = await post(c.clinicId, FIXTURE);
    expect(first.status).toBe(202);
    const body = (await first.json()) as { received: boolean; conversationId: string };
    expect(body.received).toBe(true);

    const rows = await inTenant(c.clinicId, async (client) => {
      const events = await client.query<{ delivery_id: string; processed_at: Date | null; processing_error: string | null; raw_payload: string }>(
        `select delivery_id, processed_at, processing_error, raw_payload from webhook_events`,
      );
      const convos = await client.query<{ id: string; recovery_reason: string | null; outcome: string | null; contact_id: string | null }>(
        `select id, recovery_reason, outcome, contact_id from conversations`,
      );
      const contacts = await client.query<{ phone: string; timezone: string | null }>(`select phone, timezone from contacts`);
      const appts = await client.query<{ scheduled_for: Date }>(`select scheduled_for from appointments`);
      const requests = await client.query<{ channel: string; status: string }>(`select channel, status from booking_requests`);
      return { events: events.rows, convos: convos.rows, contacts: contacts.rows, appts: appts.rows, requests: requests.rows };
    });
    expect(rows.events).toHaveLength(1);
    expect(rows.events[0]!.delivery_id).toBe("call_abc123");
    expect(rows.events[0]!.processed_at).not.toBeNull();
    expect(rows.events[0]!.processing_error).toBeNull();
    expect(JSON.parse(rows.events[0]!.raw_payload)).toEqual(FIXTURE);

    expect(rows.convos).toHaveLength(1);
    expect(rows.convos[0]!.id).toBe(body.conversationId);
    // Conditional forwarding, in hours: the desk let it ring out.
    expect(rows.convos[0]!.recovery_reason).toBe("rang_unanswered");
    expect(rows.convos[0]!.outcome).toBe("booked");
    expect(rows.contacts).toEqual([{ phone: "+15550100123", timezone: "America/New_York" }]);
    // No direct booking on this clinic: a request for the desk, no
    // appointment row until the desk confirms a slot.
    expect(rows.appts).toHaveLength(0);
    expect(rows.requests).toEqual([{ channel: "voice", status: "requested" }]);
    // §D.1: the alternative is kept; no consent row of any kind is written
    // (v1 is inbound only, so nothing is asked about calling them back).
    const detail = await inTenant(c.clinicId, async (client) => ({
      request: (await client.query<{ preferred_window: string; alternative_windows: string[]; collected_fields: Record<string, string> }>(`select preferred_window, alternative_windows, collected_fields from booking_requests`)).rows[0],
      consent: (await client.query(`select id from consent_records`)).rows,
    }));
    expect(detail.request).toEqual({ preferred_window: "next Thursday afternoon", alternative_windows: ["Friday morning"], collected_fields: {} });
    expect(detail.consent).toEqual([]);

    const again = await post(c.clinicId, FIXTURE);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    const after = await inTenant(c.clinicId, (client) => client.query(`select id from conversations`));
    expect(after.rows).toHaveLength(1);
  });

  test("one clinic's secret-less path cannot write into another clinic", async () => {
    const a = await seedClinic("voice-a");
    const b = await seedClinic("voice-b");
    await post(a.clinicId, { ...FIXTURE, call_id: "call_only_a" });
    const inB = await inTenant(b.clinicId, (client) => client.query(`select id from conversations`));
    expect(inB.rows).toHaveLength(0);
    const inA = await inTenant(a.clinicId, (client) => client.query(`select id from conversations`));
    expect(inA.rows).toHaveLength(1);
  });
});
