import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identifierRef } from "@/lib/identifier-ref";
import { startForwardingTest } from "@/lib/onboarding/forwarding-test";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";
import { ingestCall, voiceMeteringFor, type VoiceCallEvent } from "@/lib/voice/ingest";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedClinic,
  seedEntitled,
} from "./setup/factories";

/**
 * Voice minutes at the post-call ingest (BD25, R18): the call's duration
 * becomes its billable minutes, and every new call that is not a test or
 * the clinic's own number is counted once.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "agent", serviceName: "voice-ingest" } as const;
const NOW = new Date("2026-10-15T15:00:00Z");
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const PUBLISHED = "+14155550199";
const ASSISTANT = "+14155550100";
const DIRECT = "+14155550111";

describe("what a call bills (R18)", () => {
  const startedAt = new Date("2026-10-15T15:00:00Z");
  // AYA's opening line played: she answered the call.
  const call = (extra: Partial<VoiceCallEvent> = {}) => ({
    callerPhone: "+15550100123",
    startedAt,
    disclosurePlayedAt: startedAt,
    ...extra,
  });
  const facts = { isTestCall: false, ownNumbers: [PUBLISHED, DIRECT, ASSISTANT] };

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
    for (const own of [PUBLISHED, DIRECT, ASSISTANT]) {
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

  test("an urgent call AYA answered bills, though Retell dropped her opening line and only the urgent reply was said", () => {
    const urgentOnly = voiceMeteringFor(call({ durationSeconds: 75, disclosurePlayedAt: undefined, urgent: true }), facts);
    expect(urgentOnly).not.toEqual({ skipped: "not_answered" });
    expect(urgentOnly).toEqual(voiceMeteringFor(call({ durationSeconds: 75, urgent: true }), facts));
  });

  test("nothing for a call AYA never spoke on: put through to the clinic or closed, with no opening line", () => {
    // The fall-through's trouble transfer after a start that failed, or the
    // pass-through of a paused clinic: our outage or the clinic's switch.
    expect(voiceMeteringFor(call({ durationSeconds: 75, disclosurePlayedAt: undefined }), facts)).toEqual({
      skipped: "not_answered",
    });
    // A test call and the clinic's own number still say so, for the first answer.
    expect(
      voiceMeteringFor(call({ durationSeconds: 75, disclosurePlayedAt: undefined }), { ...facts, isTestCall: true }),
    ).toEqual({ skipped: "test_call" });
    expect(
      voiceMeteringFor(call({ callerPhone: DIRECT, durationSeconds: 75, disclosurePlayedAt: undefined }), facts),
    ).toEqual({ skipped: "own_number" });
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
      disclosurePlayedAt: NOW,
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

  test("the forwarding test and a call from the clinic's own lines are never counted", async () => {
    const c = await seedClinic("voice-not-metered");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED, assistantNumberE164: ASSISTANT }),
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
        disclosurePlayedAt: new Date(until.getTime() - 60_000),
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
        disclosurePlayedAt: NOW,
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
        disclosurePlayedAt: NOW,
      },
      ACTOR,
    );
    expect((await usageRows(c.clinicId)).map((r) => r.quantity)).toEqual([1]);
  });

  test("a call ingested for a clinic with no billing row is recorded and not metered", async () => {
    const c = await seedClinic("voice-no-billing");
    const result = await ingestCall(
      { externalCallId: "call_free", clinicId: c.clinicId, startedAt: NOW, durationSeconds: 300, disclosurePlayedAt: NOW },
      ACTOR,
    );
    expect(result.duplicate).toBe(false);
    expect(await usageRows(c.clinicId)).toEqual([]);
  });

  test("a call AYA never spoke on is recorded, and neither billed nor counted as a call that would have rung out", async () => {
    const c = await seedClinic("voice-not-answered");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    // The fall-through put the caller through to the direct line after a
    // start that failed: no opening line, on an overflow line in hours.
    const put = await ingestCall(
      { externalCallId: "call_put_through", clinicId: c.clinicId, callerPhone: "+15550100779", startedAt: NOW, durationSeconds: 75 },
      ACTOR,
    );
    expect(put.recoveryReason).toBeNull();
    expect(await usageRows(c.clinicId)).toEqual([]);
    expect(await voiceUsed(c.clinicId)).toBe(0);
    const stored = await inTenant(c.clinicId, (client) =>
      client.query<{ recovery_reason: string | null; disclosure_played_at: Date | null }>(
        `select recovery_reason, disclosure_played_at from conversations where external_call_id = 'call_put_through'`,
      ),
    );
    expect(stored.rows).toEqual([{ recovery_reason: null, disclosure_played_at: null }]);

    // The same call answered by AYA bills and is recovered.
    const answered = await ingestCall(
      { externalCallId: "call_answered", clinicId: c.clinicId, callerPhone: "+15550100779", startedAt: NOW, durationSeconds: 75, disclosurePlayedAt: NOW },
      ACTOR,
    );
    expect(answered.recoveryReason).not.toBeNull();
    expect((await usageRows(c.clinicId)).map((r) => r.quantity)).toEqual([2]);
  });
});
