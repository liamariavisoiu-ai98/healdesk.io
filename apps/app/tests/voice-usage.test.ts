import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as voiceWebhook } from "@/app/api/webhooks/voice/[clinicId]/route";
import { identifierRef } from "@/lib/identifier-ref";
import { startForwardingTest } from "@/lib/onboarding/forwarding-test";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";
import { ingestCall, voiceMeteringFor, type VoiceCallEvent } from "@/lib/voice/ingest";
import { readSynthflowPayload } from "@/lib/voice/synthflow-payload";
import { __resetVoiceToolLimitsForTests, handleVoiceTool } from "@/lib/voice/tools";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";

/**
 * Voice before Retell (BD25, R18, R25): Synthflow's `duration` becomes the
 * call's billable minutes, every new call that is not a test or the
 * clinic's own number is counted once, and the answer gate decides what the
 * `context` and `slots` tools tell the agent, never leaving a dead line.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "agent", serviceName: "voice-ingest" } as const;
const CLINIC = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T15:00:00Z");
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const PUBLISHED = "+14155550199";
const SYNTHFLOW = "+14155550100";
const DIRECT = "+14155550111";
const TOOLS_SECRET = "voice-tools-secret-for-usage-tests";
const WEBHOOK_SECRET = "voice-webhook-secret-for-usage-tests";

describe("Synthflow's duration (BD25)", () => {
  const base = { call_id: "c1", start_time: "2026-10-15T15:00:00Z" };

  test("is read in seconds, as a number or a numeric string, top-level or nested", () => {
    expect(readSynthflowPayload({ ...base, duration: 270 }, CLINIC).durationSeconds).toBe(270);
    expect(readSynthflowPayload({ ...base, duration: "61" }, CLINIC).durationSeconds).toBe(61);
    expect(readSynthflowPayload({ ...base, duration: "61.5" }, CLINIC).durationSeconds).toBe(61.5);
    expect(readSynthflowPayload({ call: { ...base, duration: 30 } }, CLINIC).durationSeconds).toBe(
      30,
    );
    expect(readSynthflowPayload({ ...base, duration: 0 }, CLINIC).durationSeconds).toBe(0);
  });

  test("anything else is unknown, never zero", () => {
    for (const duration of [undefined, null, -5, "soon", "", "1e3", Number.NaN]) {
      expect(readSynthflowPayload({ ...base, duration }, CLINIC)).not.toHaveProperty(
        "durationSeconds",
      );
    }
  });
});

describe("what a call bills (R18)", () => {
  const startedAt = new Date("2026-10-15T15:00:00Z");
  const call = (extra: Partial<VoiceCallEvent> = {}) => ({
    callerPhone: "+15550100123",
    startedAt,
    ...extra,
  });
  const facts = { isTestCall: false, ownNumbers: [PUBLISHED, DIRECT, SYNTHFLOW] };

  test("its duration rounded up per call; the gap between start and end when there is no duration", () => {
    expect(voiceMeteringFor(call({ durationSeconds: 61 }), facts)).toEqual({ minutes: 2 });
    expect(voiceMeteringFor(call({ durationSeconds: 270 }), facts)).toEqual({ minutes: 5 });
    expect(
      voiceMeteringFor(call({ endedAt: new Date(startedAt.getTime() + 270_000) }), facts),
    ).toEqual({ minutes: 5 });
    // The vendor's duration wins over the timestamps.
    expect(
      voiceMeteringFor(
        call({ durationSeconds: 30, endedAt: new Date(startedAt.getTime() + 600_000) }),
        facts,
      ),
    ).toEqual({ minutes: 1 });
  });

  test("nothing for the forwarding test, the clinic's own numbers, an unknown or empty length", () => {
    expect(voiceMeteringFor(call({ durationSeconds: 61 }), { ...facts, isTestCall: true })).toEqual(
      { skipped: "test_call" },
    );
    for (const own of [PUBLISHED, DIRECT, SYNTHFLOW]) {
      expect(voiceMeteringFor(call({ callerPhone: own, durationSeconds: 61 }), facts)).toEqual({
        skipped: "own_number",
      });
    }
    expect(voiceMeteringFor(call(), facts)).toEqual({ skipped: "no_duration" });
    expect(
      voiceMeteringFor(call({ endedAt: new Date(startedAt.getTime() - 1_000) }), facts),
    ).toEqual({ skipped: "no_duration" });
    expect(voiceMeteringFor(call({ durationSeconds: 0 }), facts)).toEqual({ skipped: "too_short" });
    // A withheld number is a caller like any other.
    expect(voiceMeteringFor(call({ callerPhone: undefined, durationSeconds: 61 }), facts)).toEqual({
      minutes: 2,
    });
  });
});

async function usageRows(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      source: string;
      source_ref: string;
      quantity: number;
      location_clinic_id: string;
    }>(
      `select source, source_ref, quantity, location_clinic_id from usage_events order by created_at`,
    );
    return rows;
  });
}

async function voiceUsed(clinicId: string): Promise<number> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ used: string }>(
      `select used_voice_minutes as used from entitlements where clinic_id = $1`,
      [clinicId],
    );
    return Number(rows[0]!.used);
  });
}

describeDb("counting calls at ingest (R18)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    process.env.HEALDESK_VOICE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.HEALDESK_VOICE_WEBHOOK_SECRET;
  });

  afterAll(async () => {
    await closePools();
  });

  test("a new call counts its minutes once, by a reference to its id; a replay counts nothing", async () => {
    const c = await seedClinic("voice-meter");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    const event: VoiceCallEvent = {
      externalCallId: "call_meter_1",
      clinicId: c.clinicId,
      callerPhone: "+15550100123",
      startedAt: NOW,
      durationSeconds: 270,
    };
    const first = await ingestCall(event, ACTOR);
    expect(first.duplicate).toBe(false);
    const again = await ingestCall(event, ACTOR);
    expect(again.duplicate).toBe(true);
    expect(await usageRows(c.clinicId)).toEqual([
      {
        source: "voice_call",
        source_ref: identifierRef("call", c.clinicId, "call_meter_1"),
        quantity: 5,
        location_clinic_id: c.clinicId,
      },
    ]);
    expect(await voiceUsed(c.clinicId)).toBe(5);
  });

  test("the webhook route end to end: the documented payload's duration is what is billed", async () => {
    const c = await seedClinic("voice-route-meter");
    await seedEntitled(c.clinicId, { planStartedAt: new Date("2026-09-01T00:00:00Z") });
    const payload = {
      call_id: "call_route_1",
      start_time: "2026-09-02T18:00:00Z",
      end_time: "2026-09-02T18:04:30Z",
      duration: 270,
      lead: { phone_number: "(555) 010-0123" },
    };
    const post = () =>
      voiceWebhook(
        new Request(`http://app.test/api/webhooks/voice/${c.clinicId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${WEBHOOK_SECRET}`,
          },
          body: JSON.stringify(payload),
        }),
        { params: Promise.resolve({ clinicId: c.clinicId }) },
      );
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(200);
    expect((await usageRows(c.clinicId)).map((r) => r.quantity)).toEqual([5]);
    expect(await voiceUsed(c.clinicId)).toBe(5);
  });

  test("the forwarding test and a call from the clinic's own lines are never counted", async () => {
    const c = await seedClinic("voice-not-metered");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED, synthflowNumberE164: SYNTHFLOW }),
    );
    await inTenant(c.clinicId, (client) =>
      client.query(`insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)`, [
        c.clinicId,
        DIRECT,
      ]),
    );

    // The forwarding test: the first call inside the operator's window.
    const until = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startForwardingTest(tx),
    );
    await ingestCall(
      {
        externalCallId: "call_test",
        clinicId: c.clinicId,
        callerPhone: "+15550100777",
        startedAt: new Date(until.getTime() - 60_000),
        durationSeconds: 120,
      },
      ACTOR,
    );
    // The clinic ringing itself from its direct line.
    await ingestCall(
      {
        externalCallId: "call_own",
        clinicId: c.clinicId,
        callerPhone: DIRECT,
        startedAt: NOW,
        durationSeconds: 120,
      },
      ACTOR,
    );
    expect(await usageRows(c.clinicId)).toEqual([]);

    // A patient's call afterwards is counted.
    await ingestCall(
      {
        externalCallId: "call_patient",
        clinicId: c.clinicId,
        callerPhone: "+15550100778",
        startedAt: NOW,
        durationSeconds: 59,
      },
      ACTOR,
    );
    expect((await usageRows(c.clinicId)).map((r) => r.quantity)).toEqual([1]);
  });

  test("a call ingested for a clinic with no billing row is recorded and not metered", async () => {
    const c = await seedClinic("voice-no-billing");
    const result = await ingestCall(
      { externalCallId: "call_free", clinicId: c.clinicId, startedAt: NOW, durationSeconds: 300 },
      ACTOR,
    );
    expect(result.duplicate).toBe(false);
    expect(await usageRows(c.clinicId)).toEqual([]);
  });
});

describeDb("the answer gate in front of the voice tools (BD25, R25)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    process.env.HEALDESK_VOICE_TOOLS_SECRET = TOOLS_SECRET;
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    __resetVoiceToolLimitsForTests();
  });

  afterEach(() => {
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
  });

  afterAll(async () => {
    await closePools();
  });

  function tool(
    name: "context" | "slots",
    clinicId: string,
    callId = "call_gate_1",
  ): Promise<Response> {
    return handleVoiceTool(
      new Request(`http://app.test/api/voice/tools/${clinicId}/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOOLS_SECRET}` },
        body: JSON.stringify({ call_id: callId, user_phone_number: "+15550100123" }),
      }),
      clinicId,
      name,
      { now: NOW },
    );
  }

  /** A production clinic, billed and live on voice, then suspended. */
  async function suspendedClinic(label: string, directLine: string | null) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [c.clinicId],
    );
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await seedChannels(c.clinicId, [{ channel: "voice", liveAt: WINDOW_START }]);
    if (directLine) {
      await inTenant(c.clinicId, (client) =>
        client.query(`insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)`, [
          c.clinicId,
          directLine,
        ]),
      );
    }
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const { transition } = await import("@/lib/billing/state-machine");
      await transition(tx, "suspended", { actor: "system", reason: "grace_expired" });
    });
    return c;
  }

  test("an answered call: assistant mode, no transfer number", async () => {
    const c = await seedClinic("tools-answer");
    const res = await tool("context", c.clinicId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer_mode: "assistant", transfer_number: null });
  });

  test("a refused call with a direct line passes through to it, and slots refuse without saying why", async () => {
    const c = await suspendedClinic("tools-pass", DIRECT);
    const ctx = await tool("context", c.clinicId);
    expect(ctx.status).toBe(200);
    expect(await ctx.json()).toMatchObject({
      answer_mode: "pass_through",
      transfer_number: DIRECT,
      booking_mode: "desk_confirms",
    });

    const slots = await tool("slots", c.clinicId);
    expect(slots.status).toBe(403);
    expect(await slots.json()).toEqual({ error: "service_unavailable" });

    const audit = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{
        resource_type: string;
        metadata: Record<string, unknown>;
      }>(
        `select resource_type, metadata from audit_log where resource_type like 'voice_tool_%' order by occurred_at`,
      );
      return rows;
    });
    expect(audit.map((a) => [a.resource_type, a.metadata.reason])).toEqual([
      ["voice_tool_context", "suspended"],
      ["voice_tool_slots", "suspended"],
    ]);
    expect(audit[0]!.metadata.answerMode).toBe("pass_through");
  });

  test("a refused call with no direct line is answered with the safe script, and ops is told (never a dead line)", async () => {
    const c = await suspendedClinic("tools-noline", null);
    const ctx = await tool("context", c.clinicId);
    expect(ctx.status).toBe(200);
    expect(await ctx.json()).toMatchObject({
      answer_mode: "assistant",
      transfer_number: null,
      booking_mode: "desk_confirms",
    });
    const alerts = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'voice_fallback_no_direct_line' and fields->>'clinicId' = $1`,
      [c.clinicId],
    );
    expect(alerts.rows.map((r) => r.fields.code)).toEqual(["suspended"]);
  });

  test("an unknown clinic is still a 404, and raises nothing", async () => {
    const unknown = "44444444-4444-4444-8444-444444444444";
    expect((await tool("context", unknown)).status).toBe(404);
    const alerts = await getMigratorPool().query(
      `select 1 from ops_alerts where event = 'voice_fallback_no_direct_line' and fields->>'clinicId' = $1`,
      [unknown],
    );
    expect(alerts.rows).toHaveLength(0);
  });
});
