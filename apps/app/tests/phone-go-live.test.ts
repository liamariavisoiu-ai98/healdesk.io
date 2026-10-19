import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AnswerDecision } from "@/lib/billing/answering";
import { evaluateChannels } from "@/lib/channels/events";
import {
  evaluateForwardingCall,
  inForwardingTestWindow,
  startForwardingTest,
} from "@/lib/onboarding/forwarding-test";
import { readOnboarding } from "@/lib/onboarding/steps";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";
import { withTenant } from "@/lib/tenant";
import {
  forwardedFromCall,
  forwardedFromLine,
  parseDiversion,
  parseHistoryInfo,
} from "@/lib/voice/forwarded-from";
import { ingestCall, type VoiceCallEvent } from "@/lib/voice/ingest";
import { RetellCallSession } from "@/lib/voice/retell";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedClinic,
  seedEntitled,
  setWeekdayHours,
} from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { passPracticeQuestions } from "./setup/practice";

/**
 * Phone goes live without an operator (wave 2, R5): a call the carrier says
 * it forwarded from the clinic's own published line, with the caller's
 * number kept, meets phone's forwarding step by itself (spec, "Confirming it
 * worked": "Then it flips to live by itself"). Being forwarded is a
 * different fact from being a first answer: the call that proves forwarding
 * was answered while phone was not live, so it starts nothing, and the
 * observation opens no test window that would hide later calls from the
 * first answer or the bill.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "phone-go-live-test" } as const;
const AYA = "+15125550142";
const PUBLISHED = "+14155550199";
const DIRECT = "+14155550123";
const STRANGER = "+14155550777";

const DIVERSION = `<sip:${PUBLISHED}@carrier.example;user=phone>;reason=no-answer;counter=1;privacy=off`;

// -----------------------------------------------------------------------------
// Pure: reading the carrier's headers
// -----------------------------------------------------------------------------

describe("which line forwarded the call", () => {
  test("Diversion names the forwarding line and why, in each shape carriers send", () => {
    expect(parseDiversion(DIVERSION)).toEqual([{ numberE164: PUBLISHED, condition: "no_answer" }]);
    expect(parseDiversion("<tel:415-555-0199>;reason=user-busy")).toEqual([
      { numberE164: PUBLISHED, condition: "busy" },
    ]);
    expect(parseDiversion("sip:4155550199@10.0.0.1;reason=unconditional")).toEqual([
      { numberE164: PUBLISHED, condition: "all" },
    ]);
    // Two hops, the latest first; a name is not a number.
    expect(
      parseDiversion(
        `<sip:+15125550100@pbx.example>;reason=deflection, <sip:reception@pbx.example>;reason=no-answer, ${DIVERSION}`,
      ),
    ).toEqual([
      { numberE164: "+15125550100", condition: "unknown" },
      { numberE164: PUBLISHED, condition: "no_answer" },
    ]);
    expect(parseDiversion(`${"x".repeat(5000)}${DIVERSION}`)).toEqual([]);
  });

  test("History-Info: every target before the last forwarded the call; the last is AYA's own number", () => {
    const header = `<sip:${PUBLISHED}@a.example?Reason=SIP%3Bcause%3D486>;index=1,<sip:${AYA}@b.example>;index=1.1`;
    expect(parseHistoryInfo(header)).toEqual([{ numberE164: PUBLISHED, condition: "busy" }]);
    // One entry is the request itself: nothing was forwarded.
    expect(parseHistoryInfo(`<sip:${AYA}@b.example>;index=1`)).toEqual([]);
  });

  test("Retell's call object: its dynamic variables and its SIP headers, each hop once", () => {
    expect(
      forwardedFromCall({
        from_number: STRANGER,
        retell_llm_dynamic_variables: { diversion: DIVERSION },
      }),
    ).toEqual([{ numberE164: PUBLISHED, condition: "no_answer" }]);
    expect(
      forwardedFromCall({
        custom_sip_headers: {
          Diversion: DIVERSION,
          "History-Info": `<sip:${PUBLISHED}@a.example>;index=1,<sip:${AYA}@b.example>;index=1.1`,
        },
      }),
    ).toEqual([{ numberE164: PUBLISHED, condition: "no_answer" }]);
    expect(forwardedFromCall({ from_number: STRANGER })).toEqual([]);
    expect(forwardedFromCall(null)).toEqual([]);
    expect(forwardedFromLine([{ numberE164: PUBLISHED, condition: "all" }], PUBLISHED)).toEqual({
      numberE164: PUBLISHED,
      condition: "all",
    });
    expect(
      forwardedFromLine([{ numberE164: "+15125550100", condition: "all" }], PUBLISHED),
    ).toBeNull();
    expect(forwardedFromLine([{ numberE164: PUBLISHED, condition: "all" }], null)).toBeNull();
  });
});

describe("a forwarded call outside any test window", () => {
  const clinic = { forwardingTestUntil: null, publishedPhoneE164: PUBLISHED };
  const at = new Date("2026-10-19T22:00:00Z");
  const event = (over: Partial<VoiceCallEvent> = {}): VoiceCallEvent => ({
    externalCallId: "call_1",
    clinicId: "c",
    callerPhone: STRANGER,
    startedAt: at,
    forwardedFrom: [{ numberE164: PUBLISHED, condition: "no_answer" }],
    ...over,
  });

  test("forwarded from the clinic's own line, caller ID kept: observed, with no window", () => {
    const v = evaluateForwardingCall(clinic, event(), "conv");
    expect(v).toMatchObject({ isTest: false, observation: null });
    expect(v.forwarded).toEqual({
      arrivedAt: at.toISOString(),
      conversationId: "conv",
      callerIdPreserved: true,
      condition: "no_answer",
      via: "forwarded_call",
    });
    // No window: it makes no call a test call, now or a minute later.
    for (const t of [at, new Date(at.getTime() + 60_000), new Date(at.getTime() - 60_000)]) {
      expect(inForwardingTestWindow({ ...clinic, forwardingTestObserved: v.forwarded }, t)).toBe(
        false,
      );
    }
  });

  test("dialled straight to AYA, forwarded from another line, or the carrier's activation call: nothing", () => {
    expect(
      evaluateForwardingCall(clinic, event({ forwardedFrom: undefined }), "conv").forwarded,
    ).toBeNull();
    expect(
      evaluateForwardingCall(
        clinic,
        event({ forwardedFrom: [{ numberE164: "+15125550100", condition: "all" }] }),
        "conv",
      ).forwarded,
    ).toBeNull();
    const activation = event({ callerPhone: PUBLISHED, outcome: "abandoned" });
    expect(evaluateForwardingCall(clinic, activation, "conv")).toMatchObject({
      activationCall: true,
      forwarded: null,
    });
  });

  test("the caller's number replaced by the clinic's: observed as lost", () => {
    const v = evaluateForwardingCall(
      clinic,
      event({ callerPhone: PUBLISHED, outcome: "qualified_no_booking" }),
      "conv",
    );
    expect(v.forwarded?.callerIdPreserved).toBe(false);
  });

  test("inside a test window the test is what is recorded, with the carrier's condition", () => {
    const until = new Date(at.getTime() + 120_000);
    const v = evaluateForwardingCall({ ...clinic, forwardingTestUntil: until }, event(), "conv");
    expect(v).toMatchObject({ isTest: true, forwarded: null });
    expect(v.observation).toMatchObject({
      windowUntil: until.toISOString(),
      condition: "no_answer",
      callerIdPreserved: true,
    });
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

async function makeProduction(clinicId: string): Promise<void> {
  await bindAgreementInEffect(clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
    [clinicId],
  );
}

/** Phone with every input but the clinic's forwarding: ready, waiting on forwarding. */
async function waitingOnForwarding(label: string) {
  const c = await seedClinic(label);
  await seedEntitled(c.clinicId, { planId: "voice-500", channelRows: [{ channel: "voice" }] });
  await makeProduction(c.clinicId);
  await inTenant(c.clinicId, async (client) => {
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      await client.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, $3, now(), 'test')
         on conflict (clinic_id, screen) do update set outcome = excluded.outcome`,
        [c.clinicId, screen, screen === "services" ? "done" : "skipped"],
      );
    }
    await client.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [c.clinicId, DIRECT],
    );
  });
  await setWeekdayHours(c.clinicId);
  await getMigratorPool().query(
    `update clinics set assistant_number_e164 = $2, published_phone_e164 = $3,
            onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('hours_confirmed', now()::text)
      where id = $1`,
    [c.clinicId, AYA, PUBLISHED],
  );
  // The audit passes only on the practice questions (19 October 2026).
  await passPracticeQuestions(c.clinicId, ["voice"]);
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
    evaluateChannels(tx, { only: "voice" }),
  );
  expect(await voiceRow(c.clinicId)).toMatchObject({ waiting_on: "forwarding", live_at: null });
  return c;
}

async function voiceRow(clinicId: string, channel: Channel = "voice") {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{
      ready_at: Date | null;
      waiting_on: string | null;
      live_at: Date | null;
      first_answer_at: Date | null;
    }>(
      `select ready_at, waiting_on, live_at, first_answer_at from clinic_channels where channel = $1`,
      [channel],
    ),
  );
  return rows[0]!;
}

async function observed(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    forwarding_test_observed: Record<string, unknown> | null;
  }>(`select forwarding_test_observed from clinics where id = $1`, [clinicId]);
  return rows[0]!.forwarding_test_observed;
}

async function billingRequests(clinicId: string) {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ kind: string; reason: string }>(
      `select kind, reason from billing_requests order by requested_at`,
    ),
  );
  return rows;
}

/** A call as the Retell process hands it over before phone is live: the gate refused it. */
function call(clinicId: string, over: Partial<VoiceCallEvent> = {}): VoiceCallEvent {
  const startedAt = over.startedAt ?? new Date();
  return {
    externalCallId: `call-${randomUUID()}`,
    clinicId,
    callerPhone: STRANGER,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 60_000),
    durationSeconds: 60,
    answeredByAssistant: false,
    outcome: "qualified_no_booking",
    ...over,
  };
}

const FORWARDED = { forwardedFrom: [{ numberE164: PUBLISHED, condition: "no_answer" as const }] };

describeDb("phone flips to live on the first forwarded call", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("a call forwarded from the clinic's own line takes phone live with no window and no operator, and is no first answer", async () => {
    const c = await waitingOnForwarding("fwd-flip");

    // Dialled straight to AYA's number, or forwarded from some other line: still waiting.
    await ingestCall(call(c.clinicId));
    await ingestCall(
      call(c.clinicId, { forwardedFrom: [{ numberE164: "+15125550100", condition: "all" }] }),
    );
    expect(await voiceRow(c.clinicId)).toMatchObject({ waiting_on: "forwarding", live_at: null });
    expect(await observed(c.clinicId)).toBeNull();

    const proof = await ingestCall(call(c.clinicId, FORWARDED));
    const row = await voiceRow(c.clinicId);
    expect(row.live_at).not.toBeNull();
    expect(row.waiting_on).toBeNull();
    // Being forwarded is not being answered: it was answered before phone was live.
    expect(row.first_answer_at).toBeNull();
    expect(await billingRequests(c.clinicId)).toEqual([]);
    expect(await observed(c.clinicId)).toEqual({
      arrivedAt: expect.any(String),
      conversationId: proof.conversationId,
      callerIdPreserved: true,
      condition: "no_answer",
      via: "forwarded_call",
    });
    const onboarding = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readOnboarding(tx),
    );
    expect(onboarding.test_call_passed).not.toBeNull();
    // No window was opened, by the call or by anyone.
    const { rows } = await getMigratorPool().query(
      `select forwarding_test_until from clinics where id = $1`,
      [c.clinicId],
    );
    expect(rows[0]!.forwarding_test_until).toBeNull();

    // The next call AYA answers, a minute later, is a patient's: the first answer, which starts the plan.
    await ingestCall(
      call(c.clinicId, { startedAt: new Date(Date.now() + 60_000), answeredByAssistant: true }),
    );
    expect((await voiceRow(c.clinicId)).first_answer_at).not.toBeNull();
    expect(await billingRequests(c.clinicId)).toEqual([
      { kind: "plan_start", reason: "first_answer" },
    ]);
  });

  test("the clinic's own numbers and the test window still never count as a first answer once phone is live", async () => {
    const c = await waitingOnForwarding("fwd-own");
    await ingestCall(call(c.clinicId, FORWARDED));
    expect((await voiceRow(c.clinicId)).live_at).not.toBeNull();
    // The direct line, forwarded through the main line and answered: the clinic's own call.
    await ingestCall(
      call(c.clinicId, { ...FORWARDED, callerPhone: DIRECT, answeredByAssistant: true }),
    );
    // An operator's window, and a call in it.
    const t0 = new Date();
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => startForwardingTest(tx, t0));
    await ingestCall(
      call(c.clinicId, { startedAt: new Date(t0.getTime() + 30_000), answeredByAssistant: true }),
    );
    expect((await voiceRow(c.clinicId)).first_answer_at).toBeNull();
    expect(await billingRequests(c.clinicId)).toEqual([]);
  });

  test("a forwarded call that lost the caller's number says so and leaves phone waiting; one that kept it then passes", async () => {
    const c = await waitingOnForwarding("fwd-lost");
    // A caller who withheld their number shows nothing about the carrier.
    await ingestCall(call(c.clinicId, { ...FORWARDED, callerPhone: undefined }));
    expect(await observed(c.clinicId)).toBeNull();

    await ingestCall(call(c.clinicId, { ...FORWARDED, callerPhone: PUBLISHED }));
    expect(await observed(c.clinicId)).toMatchObject({
      callerIdPreserved: false,
      via: "forwarded_call",
    });
    expect(await voiceRow(c.clinicId)).toMatchObject({ waiting_on: "forwarding", live_at: null });

    await ingestCall(call(c.clinicId, FORWARDED));
    expect(await observed(c.clinicId)).toMatchObject({
      callerIdPreserved: true,
      via: "forwarded_call",
    });
    expect((await voiceRow(c.clinicId)).live_at).not.toBeNull();
  });

  test("a passed observation is never overwritten by a forwarded call that lost the caller's number", async () => {
    const c = await waitingOnForwarding("fwd-keep");
    // A passed test is recorded, then a forwarded call arrives as the clinic.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => startForwardingTest(tx));
    const test = await ingestCall(call(c.clinicId));
    expect(await observed(c.clinicId)).toMatchObject({
      conversationId: test.conversationId,
      callerIdPreserved: true,
    });
    await ingestCall(
      call(c.clinicId, {
        ...FORWARDED,
        callerPhone: PUBLISHED,
        startedAt: new Date(Date.now() + 600_000),
      }),
    );
    expect(await observed(c.clinicId)).toMatchObject({
      conversationId: test.conversationId,
      callerIdPreserved: true,
    });
  });

  test("the Retell process hands the carrier's Diversion header to the ingest", async () => {
    const clinic = await seedClinic("fwd-retell");
    const events: VoiceCallEvent[] = [];
    const session = new RetellCallSession(
      clinic.clinicId,
      `call_${randomUUID()}`,
      () => undefined,
      {
        responder: null,
        // Past the test-mode check (lib/voice/test-calls.ts): this is about the headers.
        realCalls: true,
        gate: async (): Promise<AnswerDecision> => ({ decision: "answer" }),
        ingest: async (event) => {
          events.push(event);
          return {
            conversationId: randomUUID(),
            recoveryReason: null,
            duplicate: false,
            bookingRequestId: null,
          };
        },
      },
    );
    await session.open();
    await session.handle(
      JSON.stringify({
        interaction_type: "call_details",
        call: {
          from_number: STRANGER,
          direction: "inbound",
          retell_llm_dynamic_variables: { diversion: DIVERSION },
        },
      }),
    );
    await session.finish();
    expect(events[0]!.forwardedFrom).toEqual([{ numberE164: PUBLISHED, condition: "no_answer" }]);

    // A call with neither header carries none.
    const plain: VoiceCallEvent[] = [];
    const direct = new RetellCallSession(clinic.clinicId, `call_${randomUUID()}`, () => undefined, {
      responder: null,
      realCalls: true,
      gate: async (): Promise<AnswerDecision> => ({ decision: "answer" }),
      ingest: async (event) => {
        plain.push(event);
        return {
          conversationId: randomUUID(),
          recoveryReason: null,
          duplicate: false,
          bookingRequestId: null,
        };
      },
    });
    await direct.open();
    await direct.handle(
      JSON.stringify({ interaction_type: "call_details", call: { from_number: STRANGER } }),
    );
    await direct.finish();
    expect(plain[0]!.forwardedFrom).toBeUndefined();
  });
});
