import { randomUUID } from "node:crypto";

import { CURRENT_BAA_VERSION, type Channel } from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { __setMetaRuntimeForTests, POST as metaPost } from "@/app/api/webhooks/meta/route";
import { POST as startPost } from "@/app/api/widget/v1/[slug]/start/route";
import { billingRequests, channelEvents, clinicChannels } from "@/db/schema";
import type { AssistantResponder } from "@/lib/assistant/turn";
import type { AnswerDecision } from "@/lib/billing/answering";
import { getEntitlements } from "@/lib/billing/entitlements";
import { decideReconcile } from "@/lib/billing/reconcile";
import { readBillingGroupChannels } from "@/lib/billing/requests";
import { attestChannelAudit } from "@/lib/channels/audit-seam";
import {
  CHANNEL_READY_EMAIL_DELAY_MS,
  channelInputs,
  decideChannel,
  evaluateChannels,
  firstAnswerExclusion,
  readReadinessFacts,
  recordFirstAnswer,
  sweepChannelStates,
  voiceFirstAnswerEvidence,
  type ChannelInputs,
  type FirstAnswerEvidence,
  type ReadinessFacts,
} from "@/lib/channels/events";
import { readPhoneStepsNumber } from "@/lib/channels/state";
import { sendWebChatMessage, startWebChat, webChatClinic } from "@/lib/chat/web-chat";
import { assertPayloadAllowed, copyProblems, subjectProblems } from "@/lib/email/lint";
import { CHANNEL_LIVE_ENTRY, renderChannelLive } from "@/lib/email/templates/channel_live";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import type { FrontDoorResponder } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { inForwardingTestWindow, startForwardingTest } from "@/lib/onboarding/forwarding-test";
import { goLive } from "@/lib/onboarding/go-live";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { runOperation, type Operator } from "@/lib/ops/api";
import { saveSetupScreen, skipSetupScreen } from "@/lib/setup/save";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { ingestCall, voiceMeteringFor, type VoiceCallEvent } from "@/lib/voice/ingest";
import { RetellCallSession } from "@/lib/voice/retell";
import { healdeskTestNumbers, isHealdeskTestNumber } from "@/lib/voice/test-numbers";

import {
  closePools,
  getAppPool,
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
import { provisionPortalClinic } from "./setup/portal-clinic";

/**
 * Channel events (lib/channels/events.ts, drizzle/0079): a channel's ready,
 * waiting_on, live and first answer, and the billing hooks the first answer
 * records (healdesk-io-58's startPlan and stepUpPackage).
 *
 *   - phone is ready before go-live, so O10 and the steps fire; live needs the
 *     operator's go-live, the audit, an observed forwarding test and setup as
 *     its skip lines promise, and the database's definers re-check it all;
 *   - the runtime role cannot write a channel's lifecycle, or `live`'s inputs;
 *   - website chat's line is confirmed by an operator, never by an Origin;
 *   - the first answer records startPlan for the clinic's first channel and
 *     stepUpPackage for each later one, once each, for a conversation that
 *     exists, never for Healdesk's own calls, and never at the cost of the
 *     caller's record;
 *   - the reviewer's four probes (P1 to P4), each now a test the attack fails.
 */

const flags = vi.hoisted(() => ({ failBilling: false }));

vi.mock("@/lib/billing/requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/requests")>();
  return {
    ...actual,
    startPlan: async (...args: Parameters<typeof actual.startPlan>) => {
      if (flags.failBilling) throw new Error("the billing definer refused");
      return actual.startPlan(...args);
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "channel-events-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const AYA = "+15125550142";
const PUBLISHED = "+14155550199";
const DIRECT = "+14155550123";
const LIVE = new Date("2026-10-02T00:00:00Z");

// -----------------------------------------------------------------------------
// Pure: the decisions
// -----------------------------------------------------------------------------

const ALL_IN: ChannelInputs = {
  channel: "voice",
  leaving: false,
  auditPassed: true,
  runtimeOurs: true,
  setupDone: true,
  hours: true,
  directLine: true,
  vetReferral: true,
  pricesChecked: true,
  coveredStatus: true,
  clinicStepDone: true,
  opsReady: true,
};

describe("decideChannel", () => {
  test("every input present is live, waiting on nothing", () => {
    for (const channel of ["web", "meta", "voice"] as const) {
      expect(decideChannel({ ...ALL_IN, channel })).toEqual({
        ready: true,
        waitingOn: null,
        live: true,
        missing: [],
      });
    }
  });

  test("ready on our side is the audit and our half of the runtime; the operator's go-live is not needed for it", () => {
    for (const [over, missing] of [
      [{ auditPassed: false }, "audit"],
      [{ runtimeOurs: false }, "runtime"],
    ] as [Partial<ChannelInputs>, string][]) {
      expect(decideChannel({ ...ALL_IN, ...over }), missing).toEqual({
        ready: false,
        waitingOn: null,
        live: false,
        missing: [missing],
      });
    }
    // Before go-live, with the clinic's part done: ready, waiting on us.
    expect(decideChannel({ ...ALL_IN, opsReady: false })).toEqual({
      ready: true,
      waitingOn: null,
      live: false,
      missing: ["go_live"],
    });
    // Before go-live, with the forwarding still to do: phone waits on it.
    expect(decideChannel({ ...ALL_IN, opsReady: false, clinicStepDone: false })).toMatchObject({
      ready: true,
      waitingOn: "forwarding",
      missing: ["clinic_step", "go_live"],
    });
  });

  test("ready waits on the clinic's one next action, in order, with the direct line its own state", () => {
    expect(decideChannel({ ...ALL_IN, setupDone: false, clinicStepDone: false })).toMatchObject({
      waitingOn: "setup",
      missing: ["setup", "clinic_step"],
    });
    expect(decideChannel({ ...ALL_IN, directLine: false })).toMatchObject({
      waitingOn: "direct_line",
      missing: ["direct_line"],
    });
    expect(decideChannel({ ...ALL_IN, hours: false, directLine: false })).toMatchObject({
      waitingOn: "setup",
      missing: ["hours", "direct_line"],
    });
    for (const [over, code] of [
      [{ vetReferral: false }, "vet_referral"],
      [{ pricesChecked: false }, "prices_checked"],
      [{ coveredStatus: false }, "covered_status"],
    ] as [Partial<ChannelInputs>, string][]) {
      expect(decideChannel({ ...ALL_IN, channel: "web", ...over }), code).toMatchObject({
        waitingOn: "setup",
        live: false,
        missing: [code],
      });
    }
    // Hours and the direct line are phone's alone.
    expect(decideChannel({ ...ALL_IN, channel: "web", hours: false, directLine: false }).live).toBe(
      true,
    );
    expect(decideChannel({ ...ALL_IN, clinicStepDone: false }).waitingOn).toBe("forwarding");
    expect(decideChannel({ ...ALL_IN, channel: "web", clinicStepDone: false }).waitingOn).toBe(
      "snippet",
    );
    expect(decideChannel({ ...ALL_IN, channel: "meta", clinicStepDone: false }).waitingOn).toBe(
      "meta_connect",
    );
  });

  test("a clinic that has left is never ready", () => {
    expect(decideChannel({ ...ALL_IN, leaving: true })).toEqual({
      ready: false,
      waitingOn: null,
      live: false,
      missing: ["leaving"],
    });
  });

  test("each channel reads its own runtime and its own evidence", () => {
    const facts: ReadinessFacts = {
      slug: "x",
      leaving: false,
      opsReady: true,
      setupDone: true,
      hours: true,
      directLine: true,
      vetReferral: true,
      pricesChecked: true,
      coveredStatus: true,
      assistantNumberE164: null,
      metaFrontDoor: false,
      metaConnected: true,
      forwardingObserved: true,
      auditPassed: new Set<Channel>(["web", "meta", "voice"]),
      runtimeSeen: new Set<Channel>(),
    };
    expect(decideChannel(channelInputs("voice", facts)).missing).toEqual(["runtime"]);
    expect(decideChannel(channelInputs("meta", facts)).missing).toEqual(["runtime"]);
    expect(decideChannel(channelInputs("web", facts))).toMatchObject({
      ready: true,
      waitingOn: "snippet",
    });
    const seen = {
      ...facts,
      assistantNumberE164: AYA,
      metaFrontDoor: true,
      runtimeSeen: new Set<Channel>(["web"]),
    };
    for (const channel of ["web", "meta", "voice"] as const) {
      expect(decideChannel(channelInputs(channel, seen)).live, channel).toBe(true);
    }
    // Phone's step is an observed forwarding-test call, never a stamp.
    expect(
      decideChannel(channelInputs("voice", { ...seen, forwardingObserved: false })).missing,
    ).toEqual(["clinic_step"]);
    // No audit, no live: the seam is never a default.
    expect(
      decideChannel(channelInputs("web", { ...seen, auditPassed: new Set() })).missing,
    ).toEqual(["audit"]);
  });
});

const PATIENT: FirstAnswerEvidence = {
  channel: "voice",
  source: "runtime",
  gateAnswered: true,
  personAnswered: true,
};

describe("firstAnswerExclusion and Healdesk's own calls", () => {
  test("a patient conversation the gate answered counts; every excluded kind does not", () => {
    expect(firstAnswerExclusion(PATIENT)).toBeNull();
    for (const [over, reason] of [
      [{ source: "preview" }, "preview"],
      [{ source: "practice" }, "practice"],
      [{ gateAnswered: false }, "not_answered"],
      [{ healdeskTest: true }, "healdesk_test"],
      [{ ownNumber: true }, "own_number"],
      [{ localTest: true }, "local_test"],
      [{ personAnswered: false }, "no_conversation"],
    ] as [Partial<FirstAnswerEvidence>, string][]) {
      expect(firstAnswerExclusion({ ...PATIENT, ...over }), reason).toBe(reason);
    }
  });

  test("a call's evidence reuses its metering, and the clinic's own numbers match in any shape the carrier sends", () => {
    const startedAt = new Date("2026-10-14T15:00:00Z");
    const own = [PUBLISHED, DIRECT, AYA, "+14155550144", "(415) 555-0155"];
    const evidence = (over: Partial<VoiceCallEvent>, isTestCall = false): FirstAnswerEvidence =>
      voiceFirstAnswerEvidence(
        { answeredByAssistant: true, outcome: "qualified_no_booking", ...over },
        voiceMeteringFor(
          { callerPhone: "+14155550777", startedAt, durationSeconds: 90, ...over },
          { isTestCall, ownNumbers: own },
        ),
        "conv-1",
      );
    expect(firstAnswerExclusion(evidence({}))).toBeNull();
    expect(firstAnswerExclusion(evidence({}, true))).toBe("healdesk_test");
    for (const number of [
      PUBLISHED,
      "(415) 555-0199",
      "4155550123",
      "+1 512 555 0142",
      "+14155550155",
    ]) {
      expect(firstAnswerExclusion(evidence({ callerPhone: number })), number).toBe("own_number");
    }
    expect(firstAnswerExclusion(evidence({ answeredByAssistant: false }))).toBe("not_answered");
    expect(firstAnswerExclusion(evidence({ answeredByAssistant: undefined }))).toBe("not_answered");
    expect(firstAnswerExclusion(evidence({ outcome: "abandoned" }))).toBe("no_conversation");
  });

  test("HEALDESK_TEST_NUMBERS is a list of E.164 numbers, empty by default, matched in any shape", () => {
    const saved = process.env.HEALDESK_TEST_NUMBERS;
    try {
      delete process.env.HEALDESK_TEST_NUMBERS;
      expect(healdeskTestNumbers()).toEqual([]);
      expect(isHealdeskTestNumber("+14155550888")).toBe(false);
      process.env.HEALDESK_TEST_NUMBERS = "+14155550888, (415) 555-0889, not-a-number";
      expect(healdeskTestNumbers()).toEqual(["+14155550888", "+14155550889"]);
      expect(isHealdeskTestNumber("415-555-0889")).toBe(true);
      expect(isHealdeskTestNumber("+14155550777")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.HEALDESK_TEST_NUMBERS;
      else process.env.HEALDESK_TEST_NUMBERS = saved;
    }
  });

  test("the forwarding test's window covers every call in it, not only the first", () => {
    const until = new Date("2026-10-14T15:05:00Z");
    const observed = {
      arrivedAt: "2026-10-14T15:01:00Z",
      windowUntil: until.toISOString(),
      conversationId: "c",
      callerIdPreserved: true,
      condition: "no_answer" as const,
    };
    const closed = { forwardingTestUntil: null, forwardingTestObserved: observed };
    expect(inForwardingTestWindow(closed, new Date("2026-10-14T15:03:00Z"))).toBe(true);
    expect(inForwardingTestWindow(closed, new Date("2026-10-14T15:06:00Z"))).toBe(false);
    expect(
      inForwardingTestWindow({ forwardingTestUntil: until }, new Date("2026-10-14T15:02:00Z")),
    ).toBe(true);
    expect(
      inForwardingTestWindow(
        { forwardingTestUntil: null, forwardingTestObserved: null },
        new Date(),
      ),
    ).toBe(false);
  });
});

describe("L1, AYA is answering on a channel", () => {
  const ctx = {
    clinicName: "Radiance Med Spa",
    audience: "patients" as const,
    reason: "You're receiving this because Radiance Med Spa uses healdesk.",
    raisedAt: new Date("2026-10-14T15:20:00Z"),
    timeZone: "America/New_York",
  };

  test("before any first answer it says the plan starts that day; after, that the channel's price joins from its own", () => {
    const fixture = CHANNEL_LIVE_ENTRY.fixture;
    assertPayloadAllowed(fixture, "channel_live");
    const before = renderChannelLive(fixture, ctx);
    expect(before.subject).toBe("AYA is answering your website chat");
    expect(before.text).toContain("Your monthly plan starts the day AYA first answers a patient.");
    const after = renderChannelLive({ ...fixture, channel: "voice", isPlanStarted: true }, ctx);
    expect(after.subject).toBe("AYA is answering your phone");
    expect(after.text).toContain(
      "Its price joins your monthly plan from the day AYA first answers a patient by phone.",
    );
    const vet = renderChannelLive({ ...fixture, channel: "meta" }, { ...ctx, audience: "clients" });
    expect(vet.text).toContain("first answers a client");
    for (const rendered of [before, after, vet]) {
      expect(subjectProblems(rendered.subject)).toEqual([]);
      expect(copyProblems(`${rendered.subject}\n${rendered.text}`)).toEqual([]);
      expect(rendered.text).not.toMatch(/\$\d/);
    }
  });
});

// -----------------------------------------------------------------------------
// Against the database: fixtures
// -----------------------------------------------------------------------------

async function makeProduction(clinicId: string): Promise<void> {
  await bindAgreementInEffect(clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
    [clinicId],
  );
}

/** A clinic bought on `plan` (its plan not started), with `channels` rows. */
async function boughtClinic(
  label: string,
  options: {
    plan?: string;
    channels?: { channel: Channel; liveAt?: Date }[];
    production?: boolean;
    planStartedAt?: Date;
  } = {},
) {
  const c = await seedClinic(label);
  await seedEntitled(c.clinicId, {
    planId: options.plan ?? "voice-webchat-1000-1000",
    ...(options.planStartedAt ? { planStartedAt: options.planStartedAt } : {}),
    channelRows: options.channels ?? [{ channel: "voice" }, { channel: "web" }],
  });
  if (options.production !== false) await makeProduction(c.clinicId);
  return c;
}

/** Every wizard screen left, the services screen answered (so no price stands unchecked). */
async function finishSetup(clinicId: string): Promise<void> {
  await inTenant(clinicId, async (client) => {
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      await client.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, $3, now(), 'test')
         on conflict (clinic_id, screen) do update set outcome = excluded.outcome`,
        [clinicId, screen, screen === "services" ? "done" : "skipped"],
      );
    }
  });
}

async function confirmHours(clinicId: string): Promise<void> {
  await setWeekdayHours(clinicId);
  await getMigratorPool().query(
    `update clinics set onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('hours_confirmed', now()::text) where id = $1`,
    [clinicId],
  );
}

async function setDirectLine(clinicId: string, line: string | null = DIRECT): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [clinicId, line],
    ),
  );
}

async function setPhoneRuntime(clinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics set assistant_number_e164 = $2, published_phone_e164 = $3 where id = $1`,
    [clinicId, AYA, PUBLISHED],
  );
}

/** A forwarding-test call observed with the caller's number intact, as observeForwardingCall records it. */
async function observeForwarding(clinicId: string): Promise<void> {
  const now = new Date();
  await getMigratorPool().query(
    `update clinics set forwarding_test_observed = $2::jsonb where id = $1`,
    [
      clinicId,
      JSON.stringify({
        arrivedAt: now.toISOString(),
        windowUntil: new Date(now.getTime() - 60_000).toISOString(),
        conversationId: randomUUID(),
        callerIdPreserved: true,
        condition: "no_answer",
      }),
    ],
  );
}

/** Phone with every input the clinic and the operator give it, but the operator's go-live. */
async function phoneClinic(
  label: string,
  options: { production?: boolean; forwarding?: boolean } = {},
) {
  const c = await boughtClinic(label, { production: options.production });
  await finishSetup(c.clinicId);
  await confirmHours(c.clinicId);
  await setDirectLine(c.clinicId);
  await setPhoneRuntime(c.clinicId);
  if (options.forwarding !== false) await observeForwarding(c.clinicId);
  await attest(c.clinicId, "voice");
  return c;
}

function attest(clinicId: string, channel: Channel) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => attestChannelAudit(tx, channel));
}

function evaluate(clinicId: string, only?: Channel, now?: Date) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => evaluateChannels(tx, { only, now }));
}

/** A conversation row on the channel, as a runtime leaves one: the first answer's evidence. */
async function conversation(
  clinicId: string,
  channel: "voice" | "web_chat" = "voice",
): Promise<string> {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ id: string }>(
      `insert into conversations (clinic_id, channel, started_at) values ($1, $2, now()) returning id`,
      [clinicId, channel],
    ),
  );
  return rows[0]!.id;
}

async function patient(clinicId: string, channel: Channel = "voice"): Promise<FirstAnswerEvidence> {
  return {
    ...PATIENT,
    channel,
    conversationId: await conversation(clinicId, channel === "web" ? "web_chat" : "voice"),
  };
}

function firstAnswer(clinicId: string, evidence: FirstAnswerEvidence) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => recordFirstAnswer(tx, evidence));
}

async function channelRow(clinicId: string, channel: Channel) {
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

async function eventsOf(clinicId: string, channel?: Channel) {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{
      channel: string | null;
      kind: string;
      waiting_on: string | null;
      actor: string | null;
    }>(
      `select channel, kind, waiting_on, actor from channel_events
        where ($1::text is null or channel = $1) order by occurred_at, kind`,
      [channel ?? null],
    ),
  );
  return rows;
}

async function noticesOf(clinicId: string, kind: string) {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ dedupe_key: string; payload: Record<string, unknown>; send_after: Date }>(
      `select dedupe_key, payload, send_after from billing_notices where kind = $1`,
      [kind],
    ),
  );
  return rows;
}

async function requestsOf(clinicId: string) {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ kind: string; channel_key: string; reason: string }>(
      `select kind, channel_key, reason from billing_requests order by requested_at, kind`,
    ),
  );
  return rows;
}

async function opsAlerts(event: string, clinicId: string) {
  const { rows } = await getMigratorPool().query<{ repeats: number }>(
    `select repeats from ops_alerts where event = $1 and fields->>'clinicId' = $2`,
    [event, clinicId],
  );
  return rows;
}

async function conversationsOf(clinicId: string): Promise<number> {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ n: number }>(`select count(*)::int as n from conversations`),
  );
  return rows[0]!.n;
}

async function agent(clinicId: string): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    await setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED });
    await updateAgentConfig(tx, {
      greeting: "Hi",
      services: [{ name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 }],
      escalationPhone: null,
      escalationHours: "Weekdays 9 to 5",
      notes: null,
    });
    await approveAgentConfig(tx, "Dr Chen");
  });
}

function call(clinicId: string, over: Partial<VoiceCallEvent> = {}): VoiceCallEvent {
  const startedAt = over.startedAt ?? new Date();
  return {
    externalCallId: `call-${randomUUID()}`,
    clinicId,
    callerPhone: "+14155550777",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 60_000),
    durationSeconds: 60,
    answeredByAssistant: true,
    outcome: "qualified_no_booking",
    ...over,
  };
}

const data = async (op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) =>
  ((await runOperation(op, args, OPERATOR)).body as { data: Record<string, unknown> }).data;

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

describeDb("channel events against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterEach(() => {
    flags.failBilling = false;
    delete process.env.HEALDESK_TEST_NUMBERS;
  });

  afterAll(async () => {
    __setMetaRuntimeForTests(undefined, undefined);
    await closePools();
  });

  test("R4: phone is ready before go-live, so it waits on forwarding, O10 is due an hour out and AYA's number is shown", async () => {
    const c = await phoneClinic("ev-ready", { production: false, forwarding: false });
    expect(await evaluate(c.clinicId, "voice")).toMatchObject([
      {
        readied: true,
        waitingOn: "forwarding",
        wentLive: false,
        missing: ["clinic_step", "go_live"],
      },
    ]);
    const row = await channelRow(c.clinicId, "voice");
    expect(row).toMatchObject({ waiting_on: "forwarding", live_at: null });
    const ready = await noticesOf(c.clinicId, "channel_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.dedupe_key).toBe(`channel_ready:voice:${row.ready_at!.toISOString()}`);
    expect(ready[0]!.send_after.getTime()).toBe(
      row.ready_at!.getTime() + CHANNEL_READY_EMAIL_DELAY_MS,
    );
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        readPhoneStepsNumber(tx.db, tx.clinicId),
      ),
    ).toBe(AYA);

    // Forwarding observed: ready, waiting on us, and still not live before go-live.
    await observeForwarding(c.clinicId);
    expect(await evaluate(c.clinicId, "voice")).toMatchObject([
      { wentLive: false, waitingOn: null, missing: ["go_live"] },
    ]);
    expect((await channelRow(c.clinicId, "voice")).live_at).toBeNull();
  });

  test("the audit seam fails closed: no attestation, no readiness; a second records nothing; an unbought channel is refused", async () => {
    const c = await boughtClinic("ev-seam");
    await finishSetup(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({ readied: false });
    expect((await channelRow(c.clinicId, "voice")).ready_at).toBeNull();
    expect(await attest(c.clinicId, "voice")).toEqual({ recorded: true });
    expect(await attest(c.clinicId, "voice")).toEqual({ recorded: false });
    expect((await eventsOf(c.clinicId, "voice")).filter((e) => e.kind === "audit_passed")).toEqual([
      { channel: "voice", kind: "audit_passed", waiting_on: null, actor: "ops" },
    ]);
    await expect(attest(c.clinicId, "meta")).rejects.toThrow(/didn't buy/);
  });

  test("P2 (R3): the runtime role cannot write a channel's lifecycle or live's inputs, and the definers check what they record", async () => {
    const c = await boughtClinic("ev-role", {
      channels: [{ channel: "voice" }, { channel: "web" }],
    });
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      expect((await client.query<{ u: string }>(`select current_user as u`)).rows[0]!.u).toBe(
        "healdesk_app",
      );
      const refused = async (statement: string, values: unknown[] = []) => {
        await client.query("savepoint s");
        await expect(client.query(statement, values), statement).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("rollback to savepoint s");
      };
      for (const kind of ["audit_passed", "runtime_seen", "ready", "live", "first_answer"]) {
        await refused(
          `insert into channel_events (clinic_id, channel, kind, actor, detail) values ($1, 'web', $2, 'ops', '{"via":"ops_attested"}')`,
          [c.clinicId, kind],
        );
      }
      for (const column of ["live_at", "ready_at", "first_answer_at"]) {
        await refused(`update clinic_channels set ${column} = now() where channel = 'voice'`);
      }
      await refused(
        `insert into clinic_channels (clinic_id, channel, live_at) values ($1, 'meta', now())`,
        [c.clinicId],
      );
      // What the runtime role still writes itself: the next step and the switch.
      await client.query(
        `update clinic_channels set waiting_on = 'setup', enabled = true where channel = 'voice'`,
      );
      await client.query(
        `insert into channel_events (clinic_id, channel, kind, waiting_on) values ($1, 'voice', 'waiting', 'setup')`,
        [c.clinicId],
      );

      // The definers record only what the evidence supports.
      const one = async (statement: string, values: unknown[] = []) =>
        Object.values(
          (await client.query(statement, values)).rows[0] as Record<string, unknown>,
        )[0];
      expect(await one(`select app_channel_mark_live('voice', now(), 'probe')`)).toBe(false);
      expect(await one(`select app_channel_mark_ready('voice', now(), 'probe')`)).toBe(false);
      await client.query("savepoint s");
      await expect(
        client.query(`select app_channel_record_input('voice', 'audit_passed', 'trust_me')`),
      ).rejects.toMatchObject({ code: "22023" });
      await client.query("rollback to savepoint s");
      await expect(
        client.query(`select app_channel_record_input('voice', 'runtime_seen', 'ops_confirmed')`),
      ).rejects.toMatchObject({ code: "22023" });
      await client.query("rollback to savepoint s");
      expect(
        await one(
          `select app_channel_record_first_answer('voice', $1::uuid, 'plan_start')`,
          [randomUUID()],
        ),
      ).toBe("not_live");
      await client.query("rollback");
    } finally {
      client.release();
    }
    // Outside a tenant, nothing.
    const bare = await getAppPool().connect();
    try {
      await expect(
        bare.query(`select app_channel_mark_live('voice', now(), 'probe')`),
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      bare.release();
    }
    expect(await channelRow(c.clinicId, "voice")).toMatchObject({ ready_at: null, live_at: null });

    // A first answer needs a conversation that exists on its channel.
    const live = await boughtClinic("ev-evidence", {
      channels: [{ channel: "voice", liveAt: LIVE }],
    });
    expect(await firstAnswer(live.clinicId, { ...PATIENT, conversationId: randomUUID() })).toEqual({
      recorded: false,
      reason: "no_evidence",
    });
    const web = await conversation(live.clinicId, "web_chat");
    expect(await firstAnswer(live.clinicId, { ...PATIENT, conversationId: web })).toEqual({
      recorded: false,
      reason: "no_evidence",
    });
    expect(await requestsOf(live.clinicId)).toEqual([]);
  });

  test("phone goes live once on the four inputs, through its definer, with L1 once", async () => {
    const c = await phoneClinic("ev-phone");
    const liveAt = new Date();
    expect((await evaluate(c.clinicId, "voice", liveAt))[0]).toMatchObject({
      wentLive: true,
      missing: [],
    });
    expect(await channelRow(c.clinicId, "voice")).toMatchObject({
      live_at: liveAt,
      waiting_on: null,
    });
    expect(await evaluate(c.clinicId, "voice")).toMatchObject([{ wentLive: false }]);
    expect((await eventsOf(c.clinicId, "voice")).map((e) => e.kind)).toEqual([
      "audit_passed",
      "live",
      "ready",
    ]);
    const live = await noticesOf(c.clinicId, "channel_live");
    expect(live).toHaveLength(1);
    expect(live[0]!.payload).toMatchObject({ channel: "voice", isPlanStarted: false });
    expect(() => assertPayloadAllowed(live[0]!.payload, "channel_live")).not.toThrow();
  });

  test("R9: what a skip line says a channel can't go live without, it can't; and the database agrees with decideChannel", async () => {
    const parity = async (clinicId: string) => {
      const ts = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
        const facts = await readReadinessFacts(tx, ["voice", "web"]);
        return (["voice", "web"] as const).map((ch) => decideChannel(channelInputs(ch, facts!)));
      });
      const db = await inTenant(clinicId, async (cl) =>
        Promise.all(
          (["voice", "web"] as const).map(
            async (ch) =>
              (
                await cl.query<{ ready: boolean; live: boolean }>(
                  `select app_channel_ours_ok($1, $2) as ready, app_channel_live_ok($1, $2) as live`,
                  [clinicId, ch],
                )
              ).rows[0]!,
          ),
        ),
      );
      expect(
        db.map((r) => r.ready),
        "ready",
      ).toEqual(ts.map((d) => d.ready));
      expect(
        db.map((r) => r.live),
        "live",
      ).toEqual(ts.map((d) => d.live));
      return ts[0]!;
    };

    // Each rule broken alone keeps phone from going live, in TS and in SQL.
    const cases: [string, (clinicId: string) => Promise<void>, string][] = [
      [
        "hours",
        (id) =>
          getMigratorPool()
            .query(`update clinics set onboarding = onboarding - 'hours_confirmed' where id = $1`, [
              id,
            ])
            .then(() => undefined),
        "hours",
      ],
      ["direct line", (id) => setDirectLine(id, null), "direct_line"],
      [
        "prices",
        (id) =>
          inTenant(id, (cl) =>
            cl.query(
              `update clinic_setup_screens set outcome = 'skipped' where screen = 'services'`,
            ),
          ).then(async () => {
            await agent(id);
          }),
        "prices_checked",
      ],
      [
        "covered status",
        (id) =>
          getMigratorPool()
            .query(
              `update clinics set regulatory_regime = 'hipaa-if-covered', is_covered_entity = null where id = $1`,
              [id],
            )
            .then(() => undefined),
        "covered_status",
      ],
      [
        "vet referral",
        (id) =>
          getMigratorPool()
            .query(
              `update clinics set regulatory_regime = 'non-hipaa', agreement_kind = 'dpa' where id = $1`,
              [id],
            )
            .then(() => undefined),
        "vet_referral",
      ],
      [
        "a screen",
        (id) =>
          inTenant(id, (cl) =>
            cl.query(`delete from clinic_setup_screens where screen = 'tone'`),
          ).then(() => undefined),
        "setup",
      ],
    ];
    for (const [label, breakIt, code] of cases) {
      const c = await phoneClinic(`ev-rule-${code}`);
      await breakIt(c.clinicId);
      const decision = await parity(c.clinicId);
      expect(decision.live, label).toBe(false);
      expect(decision.missing, label).toContain(code);
      expect((await evaluate(c.clinicId, "voice"))[0]!.wentLive, label).toBe(false);
      expect((await channelRow(c.clinicId, "voice")).live_at, label).toBeNull();
    }
    // And all of them met, both say live.
    const ok = await phoneClinic("ev-rule-ok");
    expect((await parity(ok.clinicId)).live).toBe(true);
  });

  test("the hourly sweep moves every clinic's channels on: phone ready before go-live, live after", async () => {
    const prod = await phoneClinic("ev-sweep");
    const synth = await phoneClinic("ev-sweep-synth", { production: false, forwarding: false });
    const summary = await sweepChannelStates();
    expect(summary.failures).toBe(0);
    expect((await channelRow(prod.clinicId, "voice")).live_at).not.toBeNull();
    expect(await channelRow(synth.clinicId, "voice")).toMatchObject({
      waiting_on: "forwarding",
      live_at: null,
    });
    expect((await channelRow(synth.clinicId, "voice")).ready_at).not.toBeNull();
  });

  test("the first answer is stamped from the database's clock, and no caller can pass a time (0085)", async () => {
    const c = await boughtClinic("ev-first-clock", { channels: [{ channel: "voice", liveAt: LIVE }] });
    const conversationId = await conversation(c.clinicId, "voice");
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const { rows: [clock] } = await client.query<{ now: Date }>(`select now() as now`);
      // The old signature, with the caller's time, is gone.
      await client.query("savepoint s");
      await expect(
        client.query(`select app_channel_record_first_answer('voice', $1::uuid, 'plan_start', now() - interval '3 days')`, [
          conversationId,
        ]),
      ).rejects.toMatchObject({ code: "42883" });
      await client.query("rollback to savepoint s");
      const { rows: [recorded] } = await client.query<{ outcome: string }>(
        `select app_channel_record_first_answer('voice', $1::uuid, 'plan_start') as outcome`,
        [conversationId],
      );
      expect(recorded!.outcome).toBe("recorded");
      const { rows: [row] } = await client.query<{ first_answer_at: Date }>(
        `select first_answer_at from clinic_channels where channel = 'voice'`,
      );
      const { rows: [event] } = await client.query<{ occurred_at: Date }>(
        `select occurred_at from channel_events where channel = 'voice' and kind = 'first_answer'`,
      );
      expect(row!.first_answer_at.getTime()).toBe(clock!.now.getTime());
      expect(event!.occurred_at.getTime()).toBe(clock!.now.getTime());
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("the first answer: startPlan for the clinic's first channel, stepUpPackage for the next, once each, and no second start from the reconcile", async () => {
    const c = await boughtClinic("ev-first", {
      channels: [
        { channel: "voice", liveAt: LIVE },
        { channel: "web", liveAt: LIVE },
      ],
    });
    const web = await patient(c.clinicId, "web");
    expect(await firstAnswer(c.clinicId, web)).toEqual({
      recorded: true,
      billing: "plan_start",
      billingRecorded: true,
    });
    expect(await firstAnswer(c.clinicId, web)).toEqual({ recorded: false, reason: "already" });
    expect(await firstAnswer(c.clinicId, await patient(c.clinicId))).toEqual({
      recorded: true,
      billing: "step_up",
      billingRecorded: true,
    });
    expect(await firstAnswer(c.clinicId, await patient(c.clinicId))).toEqual({
      recorded: false,
      reason: "already",
    });
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
      { kind: "step_up", channel_key: "voice", reason: "first_answer" },
    ]);
    expect((await eventsOf(c.clinicId)).filter((e) => e.kind === "first_answer")).toHaveLength(2);

    const now = new Date();
    const snapshot = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => ({
      row: (await getEntitlements(tx.db, c.clinicId))!,
      requests: await tx.db.select().from(billingRequests),
    }));
    const group = await readBillingGroupChannels(c.clinicId, now, ACTOR);
    expect([...group.inService].sort()).toEqual(["voice", "web"]);
    const actions = decideReconcile({
      now,
      row: snapshot.row,
      requests: snapshot.requests,
      promised: new Map(),
      group,
      setupClosureOn: false,
    });
    expect(actions.filter((a) => a.type === "record" || a.type === "rearm")).toEqual([]);
  });

  test("two channels answered at once still record one plan start and one step-up", async () => {
    const c = await boughtClinic("ev-race", {
      channels: [
        { channel: "voice", liveAt: LIVE },
        { channel: "web", liveAt: LIVE },
      ],
    });
    const [web, voice] = [await patient(c.clinicId, "web"), await patient(c.clinicId)];
    const results = await Promise.all([
      firstAnswer(c.clinicId, web),
      firstAnswer(c.clinicId, voice),
    ]);
    expect(results.map((r) => (r.recorded ? r.billing : r.reason)).sort()).toEqual([
      "plan_start",
      "step_up",
    ]);
    expect((await requestsOf(c.clinicId)).map((r) => r.kind).sort()).toEqual([
      "plan_start",
      "step_up",
    ]);
  });

  test("once the plan has started, even the first answered channel steps up", async () => {
    const c = await boughtClinic("ev-started", {
      planStartedAt: new Date("2026-10-01T00:00:00Z"),
      channels: [{ channel: "voice", liveAt: LIVE }],
    });
    expect(await firstAnswer(c.clinicId, await patient(c.clinicId))).toMatchObject({
      recorded: true,
      billing: "step_up",
    });
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "step_up", channel_key: "voice", reason: "first_answer" },
    ]);
  });

  test("excluded answers, a channel not live and a channel not bought record nothing", async () => {
    const c = await boughtClinic("ev-excluded", {
      channels: [{ channel: "voice", liveAt: LIVE }, { channel: "web" }],
    });
    for (const over of [
      { source: "preview" },
      { source: "practice" },
      { gateAnswered: false },
      { healdeskTest: true },
      { ownNumber: true },
      { localTest: true },
      { personAnswered: false },
    ] as Partial<FirstAnswerEvidence>[]) {
      expect(
        (await firstAnswer(c.clinicId, { ...(await patient(c.clinicId)), ...over })).recorded,
      ).toBe(false);
    }
    expect(await firstAnswer(c.clinicId, await patient(c.clinicId, "web"))).toEqual({
      recorded: false,
      reason: "not_live",
    });
    expect(await firstAnswer(c.clinicId, { ...PATIENT, channel: "meta" })).toEqual({
      recorded: false,
      reason: "not_bought",
    });
    expect(await requestsOf(c.clinicId)).toEqual([]);
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
  });

  test("a billing failure rolls back the first answer with its request, tells ops, and never the caller's own work", async () => {
    const c = await boughtClinic("ev-rollback", { channels: [{ channel: "voice", liveAt: LIVE }] });
    const evidence = await patient(c.clinicId);
    flags.failBilling = true;
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await tx.db
        .insert(channelEvents)
        .values({ clinicId: c.clinicId, channel: "voice", kind: "turned_on", actor: "caller" });
      return recordFirstAnswer(tx, evidence);
    });
    expect(result).toEqual({ recorded: false, reason: "failed" });
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
    expect((await eventsOf(c.clinicId)).map((e) => e.kind)).toEqual(["turned_on"]);
    expect(await requestsOf(c.clinicId)).toEqual([]);
    expect(await opsAlerts("first_answer_not_recorded", c.clinicId)).toHaveLength(1);
    flags.failBilling = false;
    expect(await firstAnswer(c.clinicId, evidence)).toMatchObject({
      recorded: true,
      billing: "plan_start",
    });
  });

  test("58's fix: an error on the first read aborts only the savepoint, so the caller's write survives", async () => {
    const c = await boughtClinic("ev-first-read", {
      channels: [{ channel: "voice", liveAt: LIVE }],
    });
    const evidence = await patient(c.clinicId);
    /** The transaction's first SELECT fails in Postgres itself, as a statement timeout would. */
    function failingFirstRead(tx: TenantTx): TenantTx {
      let failed = false;
      const wrap = <T extends object>(db: T): T =>
        new Proxy(db, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop === "select" && !failed) {
              failed = true;
              const execute = (
                target as unknown as { execute: (q: unknown) => Promise<unknown> }
              ).execute.bind(target);
              const chain: unknown = new Proxy(() => chain, {
                get: (_t, p) =>
                  p === "then"
                    ? (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
                        execute(sql.raw("select 1/0")).then(resolve, reject)
                    : () => chain,
              });
              return () => chain;
            }
            if (prop === "transaction") {
              return (fn: (sp: object) => Promise<unknown>) =>
                (
                  target as unknown as {
                    transaction: (f: (sp: object) => Promise<unknown>) => Promise<unknown>;
                  }
                ).transaction((sp) => fn(wrap(sp)));
            }
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      return { ...tx, db: wrap(tx.db) };
    }
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await tx.db
        .insert(channelEvents)
        .values({ clinicId: c.clinicId, channel: "voice", kind: "turned_on", actor: "caller" });
      const outcome = await recordFirstAnswer(failingFirstRead(tx), evidence);
      // The caller's transaction is still usable after the failure.
      await tx.db
        .insert(channelEvents)
        .values({ clinicId: c.clinicId, channel: "voice", kind: "turned_off", actor: "caller" });
      return outcome;
    });
    expect(result).toEqual({ recorded: false, reason: "failed" });
    expect((await eventsOf(c.clinicId)).map((e) => e.kind).sort()).toEqual([
      "turned_off",
      "turned_on",
    ]);
    expect(await opsAlerts("first_answer_not_recorded", c.clinicId)).toHaveLength(1);
  });

  test("P3 (R5) and R6: Healdesk's own test calls and the clinic's own numbers never start the plan; a patient's call does", async () => {
    const c = await boughtClinic("ev-ingest", { channels: [{ channel: "voice", liveAt: LIVE }] });
    await setPhoneRuntime(c.clinicId);
    await setDirectLine(c.clinicId);
    await inTenant(c.clinicId, (cl) =>
      cl.query(
        `update clinic_settings set urgent_help_e164 = '+14155550166', transfer_e164 = '+14155550177'`,
      ),
    );
    process.env.HEALDESK_TEST_NUMBERS = "+14155550900";

    // The operator's forwarding test: two calls from two phones in one window.
    const t0 = new Date();
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => startForwardingTest(tx, t0));
    await ingestCall(
      call(c.clinicId, { startedAt: new Date(t0.getTime() + 30_000), callerPhone: "+14155550888" }),
    );
    await ingestCall(
      call(c.clinicId, {
        startedAt: new Date(t0.getTime() + 120_000),
        callerPhone: "+14155550889",
      }),
    );
    // A check call from one of Healdesk's test phones, long after the window.
    await ingestCall(
      call(c.clinicId, {
        startedAt: new Date(t0.getTime() + 600_000),
        callerPhone: "(415) 555-0900",
      }),
    );
    // The clinic's own numbers, in the shapes carriers send them.
    for (const phone of ["415-555-0199", "+1 (415) 555-0123", "4155550166", "+14155550177"]) {
      await ingestCall(
        call(c.clinicId, { startedAt: new Date(t0.getTime() + 700_000), callerPhone: phone }),
      );
    }
    // A refused call, and one the caller hung up on.
    await ingestCall(
      call(c.clinicId, { startedAt: new Date(t0.getTime() + 800_000), answeredByAssistant: false }),
    );
    await ingestCall(
      call(c.clinicId, { startedAt: new Date(t0.getTime() + 800_000), outcome: "abandoned" }),
    );
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([]);

    await ingestCall(call(c.clinicId, { startedAt: new Date(t0.getTime() + 900_000) }));
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).not.toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
    ]);
  });

  test("P4 (R2): a writer that locks out of order cannot cost a call its record", async () => {
    const c = await boughtClinic("ev-dead", {
      channels: [{ channel: "voice", liveAt: LIVE }, { channel: "web" }],
    });
    await setPhoneRuntime(c.clinicId);
    const b = await getAppPool().connect();
    let bError: unknown = null;
    try {
      await b.query("begin");
      await b.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      // The old noteWidgetLoaded's order: website chat's row alone ...
      await b.query(
        `select channel from clinic_channels where clinic_id = $1 and channel = 'web' for update`,
        [c.clinicId],
      );
      const ingest = ingestCall(
        call(c.clinicId, {
          outcome: "booked",
          booking: { preferredWindow: "Tuesday morning" },
          callerName: "Pat",
        }),
      ).then(
        () => "recorded",
        (e: unknown) => `failed: ${(e as { code?: string }).code ?? ""}`,
      );
      await new Promise((r) => setTimeout(r, 300));
      // ... then every row in channel order.
      try {
        await b.query(
          `select channel from clinic_channels where clinic_id = $1 order by channel for update`,
          [c.clinicId],
        );
      } catch (error) {
        bError = error;
      }
      await b.query("rollback").catch(() => undefined);
      expect(await ingest).toBe("recorded");
    } finally {
      await b.query("rollback").catch(() => undefined);
      b.release();
    }
    void bError;
    expect(await conversationsOf(c.clinicId)).toBe(1);
  }, 60_000);

  test("a live channel takes no lock: evaluating it while another transaction holds its rows returns at once", async () => {
    const c = await boughtClinic("ev-nolock", { channels: [{ channel: "voice", liveAt: LIVE }] });
    const b = await getAppPool().connect();
    try {
      await b.query("begin");
      await b.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await b.query(`select channel from clinic_channels where clinic_id = $1 for update`, [
        c.clinicId,
      ]);
      const moved = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
        await tx.db.execute(sql`set local lock_timeout = '500ms'`);
        return evaluateChannels(tx, { only: "voice" });
      });
      expect(moved).toEqual([{ channel: "voice", readied: false, wentLive: false, missing: [] }]);
    } finally {
      await b.query("rollback").catch(() => undefined);
      b.release();
    }
  });

  test("R7: the Retell process passes answeredByAssistant only for a gate's answer with a real reply in it", async () => {
    const clinic = await seedClinic("ev-retell");
    const responder: AssistantResponder = async () =>
      JSON.stringify({ reply: "We're open weekdays." });
    const run = async (decision: AnswerDecision, reply: AssistantResponder | null) => {
      const events: VoiceCallEvent[] = [];
      const session = new RetellCallSession(
        clinic.clinicId,
        `call_${randomUUID()}`,
        () => undefined,
        {
          responder: reply,
          gate: async () => decision,
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
          interaction_type: "response_required",
          response_id: 1,
          transcript: [{ role: "user", content: "When are you open?" }],
        }),
      );
      await session.finish();
      return events[0]!;
    };
    expect((await run({ decision: "answer" }, responder)).answeredByAssistant).toBe(true);
    // Only the failure line: not an answer.
    expect((await run({ decision: "answer" }, null)).answeredByAssistant).toBe(false);
    // The safe script for a refused call with no direct line: not an answer.
    expect(
      (
        await run(
          {
            decision: "pass_through",
            reason: "channel_not_live",
            fallback: "direct_line",
            directLine: null,
          },
          responder,
        )
      ).answeredByAssistant,
    ).toBe(false);
  });

  test("P1 (R1): a forged Origin takes nothing live and starts nothing; an operator's confirmation does, and only a real answer counts", async () => {
    const c = await boughtClinic("ev-forge", {
      plan: "webchat-1000",
      channels: [{ channel: "web" }],
    });
    await getMigratorPool().query(
      `update clinics set website = 'forge-victim.test' where id = $1`,
      [c.clinicId],
    );
    await setWeekdayHours(c.clinicId);
    await agent(c.clinicId);
    await finishSetup(c.clinicId);
    expect(await data("attestChannelAudit", { clinicId: c.clinicId, channel: "web" })).toEqual({
      status: "updated",
    });
    expect(await channelRow(c.clinicId, "web")).toMatchObject({
      waiting_on: "snippet",
      live_at: null,
    });

    // curl -X POST /api/widget/v1/<slug>/start -H 'Origin: https://forge-victim.test'
    const forged = async () =>
      (await (
        await startPost(
          new Request(`http://app.test/api/widget/v1/${c.slug}/start`, {
            method: "POST",
            headers: { origin: "https://forge-victim.test", "x-forwarded-for": "203.0.113.9" },
            body: "{}",
          }),
          { params: Promise.resolve({ slug: c.slug }) },
        )
      ).json()) as { mode: string; token?: string };
    expect(await forged()).toMatchObject({ mode: "contact_form", reason: "channel_not_live" });
    expect(await forged()).toMatchObject({ mode: "contact_form" });
    expect(await channelRow(c.clinicId, "web")).toMatchObject({
      waiting_on: "snippet",
      live_at: null,
    });
    expect((await eventsOf(c.clinicId, "web")).map((e) => e.kind)).not.toContain("runtime_seen");
    // The load asks an operator to look, once.
    expect(await opsAlerts("web_widget_to_confirm", c.clinicId)).toHaveLength(1);
    expect(await requestsOf(c.clinicId)).toEqual([]);

    // The operator looked and saw the chat on the site.
    expect(await data("confirmWebWidget", { clinicId: c.clinicId })).toEqual({ status: "updated" });
    expect(await data("confirmWebWidget", { clinicId: c.clinicId })).toEqual({ status: "updated" });
    expect((await eventsOf(c.clinicId, "web")).filter((e) => e.kind === "runtime_seen")).toEqual([
      { channel: "web", kind: "runtime_seen", waiting_on: null, actor: "ops" },
    ]);
    expect((await channelRow(c.clinicId, "web")).live_at).not.toBeNull();

    const clinic = (await webChatClinic(c.slug))!;
    // A local page's chat, and a reply that is only the failure line: answered, never counted.
    const local = await startWebChat(clinic, new Date(), "http://localhost:3000");
    if (local.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, local.token, "When are you open?", {
      responder: async () => JSON.stringify({ reply: "We're open weekdays.", booking: {} }),
      origin: "http://localhost:3000",
    });
    const site = await startWebChat(clinic, new Date(), "https://forge-victim.test");
    if (site.mode !== "chat") throw new Error("no chat");
    const failed = await sendWebChatMessage(clinic, site.token, "When are you open?", {
      responder: null,
      origin: "https://forge-victim.test",
    });
    expect((await channelRow(c.clinicId, "web")).first_answer_at).toBeNull();
    // The same chat's next, real answer counts.
    if (failed.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, failed.token, "And on Saturday?", {
      responder: async () => JSON.stringify({ reply: "We're closed on Saturday.", booking: {} }),
      origin: "https://forge-victim.test",
    });
    expect((await channelRow(c.clinicId, "web")).first_answer_at).not.toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
    ]);
    // Refusals: a clinic without website chat.
    const phoneOnly = await boughtClinic("ev-forge-phone", { channels: [{ channel: "voice" }] });
    expect(await data("confirmWebWidget", { clinicId: phoneOnly.clinicId })).toMatchObject({
      status: "error",
      message: "The clinic didn't buy website chat.",
    });
  });

  test("the Meta webhook records the Meta channel's first answer when a reply reaches the person", async () => {
    const APP_SECRET = "meta-app-secret-for-channel-events";
    process.env.META_APP_SECRET = APP_SECRET;
    const pageId = `${Date.now()}`.slice(-9) + "1";
    const c = await boughtClinic("ev-meta", {
      plan: "metachat-1000",
      channels: [{ channel: "meta", liveAt: LIVE }],
    });
    await setWeekdayHours(c.clinicId);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-page-token-0123456789",
      });
      await setMetaFrontDoor(tx, true);
    });
    const sent: Parameters<MetaSender>[0][] = [];
    const sender: MetaSender = async (input) => {
      sent.push(input);
    };
    const responder: FrontDoorResponder = async () =>
      "We're open weekdays 9 to 5; call the practice to book.";
    const now = new Date();
    __setMetaRuntimeForTests(responder, sender, undefined, now);
    const raw = JSON.stringify({
      object: "page",
      entry: [
        {
          id: pageId,
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: pageId },
              timestamp: now.getTime() - 60_000,
              message: { mid: `m-${randomUUID()}`, text: "When are you open?" },
            },
          ],
        },
      ],
    });
    const response = await metaPost(
      new Request("http://app.test/api/webhooks/meta", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signMetaBody(raw, APP_SECRET),
        },
        body: raw,
      }),
    );
    expect(await response.json()).toMatchObject({ answered: 1 });
    expect(sent).toHaveLength(1);
    expect((await channelRow(c.clinicId, "meta")).first_answer_at).not.toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
    ]);
  });

  test("a setup screen saved or skipped moves the channels on: finishing setup can be the last input", async () => {
    const c = await boughtClinic("ev-setup", { channels: [{ channel: "voice" }] });
    await confirmHours(c.clinicId);
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await observeForwarding(c.clinicId);
    await attest(c.clinicId, "voice");
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({
      waitingOn: "setup",
      missing: ["setup"],
    });
    const ctx = {
      clinicId: c.clinicId,
      slug: c.slug,
      userId: c.staffUserId,
      actorLabel: "Front desk Mac",
    };
    for (const screen of SETUP_SCREENS) {
      if (screen !== "backup") await skipSetupScreen(ctx, screen);
    }
    expect((await channelRow(c.clinicId, "voice")).live_at).not.toBeNull();
    expect((await eventsOf(c.clinicId, "voice")).find((e) => e.kind === "live")?.actor).toBe(
      "Front desk Mac",
    );
  });

  test("R4, the real flow with no shortcut: provisioned, the operator's steps, the wizard, the forwarding test, go-live", async () => {
    const clinic = await provisionPortalClinic("ev-real", { plan: "voice-webchat-1000-1000" });
    const id = clinic.clinicId;
    const ctx = {
      clinicId: id,
      slug: clinic.clinicSlug,
      userId: clinic.userId,
      actorLabel: "Front desk Mac",
    };
    const stepUp = async () => await channelRow(id, "voice");

    // The operator: AYA's number once the Retell agent exists, and the audit.
    expect(
      await data("setPhoneSettings", {
        clinicId: id,
        assistantNumberE164: AYA,
        publishedPhoneE164: PUBLISHED,
        phoneSystemType: "landline",
        callRouting: "conditional",
        carrier: "verizon",
      }),
    ).toMatchObject({ status: "updated" });
    expect(await data("attestChannelAudit", { clinicId: id, channel: "voice" })).toEqual({
      status: "updated",
    });
    // Ready before go-live, waiting on the clinic's setup.
    expect(await stepUp()).toMatchObject({ waiting_on: "setup", live_at: null });
    expect((await stepUp()).ready_at).not.toBeNull();

    // The clinic: the wizard, with its hours, its prices checked and its direct line.
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      const input =
        screen === "hours"
          ? {
              hours: {
                mon: [["09:00", "17:00"]],
                tue: [["09:00", "17:00"]],
                wed: [["09:00", "17:00"]],
                thu: [["09:00", "17:00"]],
                fri: [["09:00", "17:00"]],
                sat: [],
                sun: [],
              },
              closures: [],
            }
          : screen === "services"
            ? { services: [{ name: "Consultation" }] }
            : screen === "direct_line"
              ? { directLine: DIRECT }
              : null;
      const saved =
        screen === "insurance"
          ? await saveSetupScreen(ctx, screen, { billsInsurance: false })
          : input
            ? await saveSetupScreen(ctx, screen, input)
            : await skipSetupScreen(ctx, screen);
      // A screen this clinic isn't shown is refused, and that is all.
      if (!saved.ok && saved.message === "That step isn't part of your setup.") continue;
      expect(saved.ok, `${screen}: ${JSON.stringify(saved)}`).toBe(true);
    }
    // Phone now waits on the forwarding, O10 is queued, and the steps carry AYA's number.
    expect(await stepUp()).toMatchObject({ waiting_on: "forwarding", live_at: null });
    expect(await noticesOf(id, "channel_ready")).toHaveLength(1);
    expect(
      await withTenant({ clinicId: id, actor: ACTOR }, (tx) =>
        readPhoneStepsNumber(tx.db, tx.clinicId),
      ),
    ).toBe(AYA);

    // The forwarding test: the operator opens the window and the call reaches AYA.
    expect(await data("startForwardingTest", { clinicId: id })).toMatchObject({
      status: "started",
    });
    await ingestCall(
      call(id, { callerPhone: "+14155550888", answeredByAssistant: false, outcome: "abandoned" }),
    );
    expect(await stepUp()).toMatchObject({ waiting_on: null, live_at: null });

    // The operator's go-live, through the envelope, with the voice-era checklist it still asks.
    expect(await data("approveAgentConfig", { clinicId: id, approvedBy: "Dr Chen" })).toMatchObject(
      { status: "updated" },
    );
    for (const step of [
      "covered_entity_confirmed",
      "forwarding_configured",
      "agent_script_approved",
      "booking_requirements_confirmed",
    ]) {
      expect(await data("completeOnboardingStep", { clinicId: id, step }), step).toMatchObject({
        status: "updated",
      });
    }
    const live = await data("goLive", { clinicId: id });
    expect(live.status, JSON.stringify(live)).toBe("live");
    expect((await stepUp()).live_at).not.toBeNull();
    expect(await noticesOf(id, "channel_live")).toHaveLength(1);
  });

  test("the operator's go-live is an input: it moves every channel on as far as the others allow", async () => {
    const c = await phoneClinic("ev-golive", { production: false });
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = false,
              call_routing_confirmed_at = now(),
              agent_approved_at = now(),
              onboarding = jsonb_build_object(
                'hours_confirmed', now()::text, 'phone_type_confirmed', now()::text,
                'call_routing_chosen', now()::text, 'covered_entity_confirmed', now()::text,
                'agent_script_approved', now()::text, 'forwarding_configured', now()::text,
                'test_call_passed', now()::text, 'booking_requirements_confirmed', now()::text)
        where id = $1`,
      [c.clinicId],
    );
    await getMigratorPool().query(
      `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, repeat('d', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@golive.test', now(), now())`,
      [c.organizationId, CURRENT_BAA_VERSION],
    );
    expect((await evaluate(c.clinicId, "voice"))[0]!.missing).toEqual(["go_live"]);
    const result = await goLive(c.clinicId, { label: "ops@healdesk.test" });
    expect(result.status, JSON.stringify(result)).toBe("live");
    expect((await channelRow(c.clinicId, "voice")).live_at).not.toBeNull();
    expect(await noticesOf(c.clinicId, "channel_live")).toHaveLength(1);
  });

  test("the console sees what each channel still needs, and the envelope's attestation refuses what isn't a bought channel", async () => {
    const c = await boughtClinic("ev-ops");
    expect(
      await data("attestChannelAudit", { clinicId: c.clinicId, channel: "phone" }),
    ).toMatchObject({ status: "error" });
    expect(
      await data("attestChannelAudit", { clinicId: c.clinicId, channel: "meta" }),
    ).toMatchObject({
      status: "error",
      message: expect.stringMatching(/didn't buy/),
    });
    expect(await data("attestChannelAudit", { clinicId: c.clinicId, channel: "voice" })).toEqual({
      status: "updated",
    });
    expect(await data("attestChannelAudit", { clinicId: c.clinicId, channel: "voice" })).toEqual({
      status: "updated",
    });
    expect(
      (await eventsOf(c.clinicId, "voice")).filter((e) => e.kind === "audit_passed"),
    ).toHaveLength(1);
    const { rows } = await getMigratorPool().query(
      `select count(*)::int as n from security_events where event = 'channel_audit_attested' and metadata->>'channel' = 'voice'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);

    const view = await data("getOnboarding", { clinicId: c.clinicId });
    const channels = view.channels as {
      channel: string;
      auditPassed: boolean;
      missing: string[];
    }[];
    expect(channels.find((x) => x.channel === "voice")).toMatchObject({
      auditPassed: true,
      missing: ["runtime", "setup", "hours", "direct_line", "clinic_step"],
    });
    expect(channels.find((x) => x.channel === "web")).toMatchObject({
      auditPassed: false,
      missing: ["audit", "setup", "clinic_step"],
    });
  });

  test("the definers keep every writer to one lock order: two that move the same clinic at once both finish", async () => {
    const c = await phoneClinic("ev-order");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => attestChannelAudit(tx, "web"));
    const both = await Promise.all([evaluate(c.clinicId, "voice"), evaluate(c.clinicId, "web")]);
    expect(
      both
        .flat()
        .map((m) => m.channel)
        .sort(),
    ).toEqual(["voice", "web"]);
    const rows = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      tx.db
        .select({ channel: clinicChannels.channel, liveAt: clinicChannels.liveAt })
        .from(clinicChannels),
    );
    expect(rows.find((r) => r.channel === "voice")!.liveAt).not.toBeNull();
  });
});
