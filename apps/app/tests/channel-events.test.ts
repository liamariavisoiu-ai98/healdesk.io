import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { __setMetaRuntimeForTests, POST as metaPost } from "@/app/api/webhooks/meta/route";
import { CURRENT_BAA_VERSION, type Channel } from "@healdesk/catalog";
import { billingRequests, channelEvents } from "@/db/schema";
import { getEntitlements } from "@/lib/billing/entitlements";
import { decideReconcile } from "@/lib/billing/reconcile";
import { readBillingGroupChannels } from "@/lib/billing/requests";
import { attestChannelAudit } from "@/lib/channels/audit-seam";
import { readPhoneStepsNumber } from "@/lib/channels/state";
import {
  CHANNEL_READY_EMAIL_DELAY_MS,
  channelInputs,
  decideChannel,
  evaluateChannels,
  firstAnswerExclusion,
  recordFirstAnswer,
  sweepChannelStates,
  voiceFirstAnswerEvidence,
  type ChannelInputs,
  type FirstAnswerEvidence,
  type ReadinessFacts,
} from "@/lib/channels/events";
import { sendWebChatMessage, startWebChat, webChatClinic } from "@/lib/chat/web-chat";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { assertPayloadAllowed, copyProblems, subjectProblems } from "@/lib/email/lint";
import { CHANNEL_LIVE_ENTRY, renderChannelLive } from "@/lib/email/templates/channel_live";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import type { FrontDoorResponder } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { goLive } from "@/lib/onboarding/go-live";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { runOperation, type Operator } from "@/lib/ops/api";
import { skipSetupScreen } from "@/lib/setup/save";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";
import { withTenant } from "@/lib/tenant";
import type { AnswerDecision } from "@/lib/billing/answering";
import { ingestCall, voiceMeteringFor, type VoiceCallEvent } from "@/lib/voice/ingest";
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

/**
 * Channel events (lib/channels/events.ts): the one writer of a channel's
 * ready, waiting_on, live and first_answer, and the billing hooks the first
 * answer records (healdesk-io-58's startPlan and stepUpPackage).
 *
 *   - live needs all four inputs, and the audit seam fails closed;
 *   - phone waits on forwarding, queues O10 an hour out, goes live on the
 *     forwarding test and sends L1 once;
 *   - website chat goes live on the widget's first load on the clinic's own
 *     site, before the gate is asked;
 *   - the first answer records startPlan for the clinic's first channel and
 *     stepUpPackage for each later one, once each, never for an excluded
 *     answer, and never so the reconcile records a second plan start;
 *   - each runtime calls it: the voice ingest, web chat and the Meta webhook.
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
  opsReady: true,
  auditPassed: true,
  runtimeOurs: true,
  setupDone: true,
  directLine: true,
  clinicStepDone: true,
};

describe("decideChannel: live needs all four inputs", () => {
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

  test("our side missing anything is not ready, and waits on nothing of the clinic's", () => {
    const cases: [Partial<ChannelInputs>, string][] = [
      [{ opsReady: false }, "go_live"],
      [{ auditPassed: false }, "audit"],
      [{ runtimeOurs: false }, "runtime"],
    ];
    for (const [over, missing] of cases) {
      const d = decideChannel({ ...ALL_IN, ...over });
      expect(d, missing).toMatchObject({ ready: false, waitingOn: null, live: false });
      expect(d.missing).toEqual([missing]);
    }
  });

  test("ready on our side waits on the clinic's one next action, setup first", () => {
    expect(decideChannel({ ...ALL_IN, setupDone: false, clinicStepDone: false })).toMatchObject({
      ready: true,
      waitingOn: "setup",
      live: false,
      missing: ["setup", "clinic_step"],
    });
    // Phone with no direct line is setup's to finish: every call AYA can't answer goes there.
    expect(decideChannel({ ...ALL_IN, directLine: false })).toMatchObject({
      waitingOn: "setup",
      missing: ["direct_line"],
    });
    // The other channels need no direct line.
    expect(decideChannel({ ...ALL_IN, channel: "web", directLine: false }).live).toBe(true);
    expect(decideChannel({ ...ALL_IN, clinicStepDone: false }).waitingOn).toBe("forwarding");
    expect(decideChannel({ ...ALL_IN, channel: "web", clinicStepDone: false }).waitingOn).toBe(
      "snippet",
    );
    expect(decideChannel({ ...ALL_IN, channel: "meta", clinicStepDone: false }).waitingOn).toBe(
      "meta_connect",
    );
  });

  test("a clinic that has left never goes live", () => {
    expect(decideChannel({ ...ALL_IN, leaving: true })).toEqual({
      ready: false,
      waitingOn: null,
      live: false,
      missing: ["leaving"],
    });
  });

  test("each channel reads its own runtime: AYA's number, the front door and a connection, the widget seen", () => {
    const facts: ReadinessFacts = {
      slug: "x",
      leaving: false,
      opsReady: true,
      setupDone: true,
      directLine: true,
      assistantNumberE164: null,
      metaFrontDoor: false,
      metaConnected: true,
      forwardingConfirmed: true,
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

describe("firstAnswerExclusion", () => {
  test("a patient conversation the gate answered counts; every excluded kind does not", () => {
    expect(firstAnswerExclusion(PATIENT)).toBeNull();
    const cases: [Partial<FirstAnswerEvidence>, string][] = [
      [{ source: "preview" }, "preview"],
      [{ source: "practice" }, "practice"],
      [{ gateAnswered: false }, "not_answered"],
      [{ healdeskTest: true }, "healdesk_test"],
      [{ ownNumber: true }, "own_number"],
      [{ localTest: true }, "local_test"],
      [{ personAnswered: false }, "no_conversation"],
    ];
    for (const [over, reason] of cases) {
      expect(firstAnswerExclusion({ ...PATIENT, ...over }), reason).toBe(reason);
    }
  });

  test("a call's evidence reuses its metering: the forwarding test and the clinic's own numbers are excluded", () => {
    const startedAt = new Date("2026-10-14T15:00:00Z");
    const call = { callerPhone: "+14155550777", startedAt, durationSeconds: 90 };
    const own = [PUBLISHED, DIRECT, AYA];
    const evidence = (
      over: Partial<VoiceCallEvent>,
      facts: { isTestCall?: boolean } = {},
    ): FirstAnswerEvidence =>
      voiceFirstAnswerEvidence(
        { answeredByAssistant: true, outcome: "qualified_no_booking", ...over },
        voiceMeteringFor(
          { ...call, ...over },
          { isTestCall: facts.isTestCall ?? false, ownNumbers: own },
        ),
        "conv-1",
      );
    expect(firstAnswerExclusion(evidence({}))).toBeNull();
    expect(firstAnswerExclusion(evidence({}, { isTestCall: true }))).toBe("healdesk_test");
    for (const number of own) {
      expect(firstAnswerExclusion(evidence({ callerPhone: number })), number).toBe("own_number");
    }
    expect(firstAnswerExclusion(evidence({ answeredByAssistant: false }))).toBe("not_answered");
    expect(firstAnswerExclusion(evidence({ answeredByAssistant: undefined }))).toBe("not_answered");
    expect(firstAnswerExclusion(evidence({ outcome: "abandoned" }))).toBe("no_conversation");
    expect(firstAnswerExclusion(evidence({ outcome: undefined }))).toBe("no_conversation");
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
    expect(after.text).not.toContain("Your monthly plan starts");
    const vet = renderChannelLive({ ...fixture, channel: "meta" }, { ...ctx, audience: "clients" });
    expect(vet.text).toContain("first answers a client");
    for (const rendered of [before, after, vet]) {
      expect(subjectProblems(rendered.subject)).toEqual([]);
      expect(copyProblems(`${rendered.subject}\n${rendered.text}`)).toEqual([]);
      // A pointer: no price, no charge date in it.
      expect(rendered.text).not.toMatch(/\$\d/);
    }
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

/** A clinic bought on `plan` (its plan not started), with `channels` rows and nothing else recorded. */
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

async function finishSetup(clinicId: string): Promise<void> {
  await inTenant(clinicId, async (client) => {
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      await client.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, 'skipped', now(), 'test') on conflict do nothing`,
        [clinicId, screen],
      );
    }
  });
}

async function setDirectLine(clinicId: string): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [clinicId, DIRECT],
    ),
  );
}

async function setPhoneRuntime(clinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics set assistant_number_e164 = $2, published_phone_e164 = $3 where id = $1`,
    [clinicId, AYA, PUBLISHED],
  );
}

async function confirmForwarding(clinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics set onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('test_call_passed', now()::text) where id = $1`,
    [clinicId],
  );
}

function attest(clinicId: string, channel: Channel) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => attestChannelAudit(tx, channel));
}

function evaluate(clinicId: string, only?: Channel, now?: Date) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => evaluateChannels(tx, { only, now }));
}

function firstAnswer(clinicId: string, evidence: FirstAnswerEvidence, now?: Date) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => recordFirstAnswer(tx, evidence, now));
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

describeDb("channel events against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterEach(() => {
    flags.failBilling = false;
  });

  afterAll(async () => {
    __setMetaRuntimeForTests(undefined, undefined);
    await closePools();
  });

  test("nothing goes live on a synthetic clinic, however complete, and nothing is written", async () => {
    const c = await boughtClinic("ev-synthetic", { production: false });
    await finishSetup(c.clinicId);
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await confirmForwarding(c.clinicId);
    await attest(c.clinicId, "voice");
    const moved = await evaluate(c.clinicId);
    expect(moved.find((m) => m.channel === "voice")).toMatchObject({
      readied: false,
      wentLive: false,
      missing: ["go_live"],
    });
    expect(await channelRow(c.clinicId, "voice")).toMatchObject({ ready_at: null, live_at: null });
    expect((await eventsOf(c.clinicId)).map((e) => e.kind)).toEqual(["audit_passed"]);
  });

  test("the audit seam fails closed: no attestation, no readiness; a second attestation records nothing", async () => {
    const c = await boughtClinic("ev-seam");
    await finishSetup(c.clinicId);
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await confirmForwarding(c.clinicId);
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({
      readied: false,
      missing: ["audit"],
    });
    expect(await channelRow(c.clinicId, "voice")).toMatchObject({ ready_at: null, live_at: null });

    expect(await attest(c.clinicId, "voice")).toEqual({ recorded: true });
    expect(await attest(c.clinicId, "voice")).toEqual({ recorded: false });
    const audit = (await eventsOf(c.clinicId, "voice")).filter((e) => e.kind === "audit_passed");
    expect(audit).toEqual([
      { channel: "voice", kind: "audit_passed", waiting_on: null, actor: "ops" },
    ]);
    // An unbought channel is refused.
    await expect(attest(c.clinicId, "meta")).rejects.toThrow(/didn't buy/);
  });

  test("phone: ready waits on forwarding with O10 due an hour out, then goes live on the forwarding test, with L1 once", async () => {
    const c = await boughtClinic("ev-phone");
    await finishSetup(c.clinicId);
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await attest(c.clinicId, "voice");

    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({
      readied: true,
      waitingOn: "forwarding",
      wentLive: false,
      missing: ["clinic_step"],
    });
    const readyAt = (await channelRow(c.clinicId, "voice")).ready_at!;
    expect(readyAt).not.toBeNull();
    expect(await channelRow(c.clinicId, "voice")).toMatchObject({
      waiting_on: "forwarding",
      live_at: null,
    });
    const ready = await noticesOf(c.clinicId, "channel_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.dedupe_key).toBe(`channel_ready:voice:${readyAt.toISOString()}`);
    expect(ready[0]!.send_after.getTime()).toBe(readyAt.getTime() + CHANNEL_READY_EMAIL_DELAY_MS);
    // Asked again with nothing changed: nothing written.
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({
      readied: false,
      wentLive: false,
    });

    await confirmForwarding(c.clinicId);
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
    expect((await eventsOf(c.clinicId, "voice")).map((e) => [e.kind, e.waiting_on])).toEqual([
      ["audit_passed", null],
      ["ready", null],
      ["waiting", "forwarding"],
      ["live", null],
    ]);
    const live = await noticesOf(c.clinicId, "channel_live");
    expect(live).toHaveLength(1);
    expect(live[0]!.dedupe_key).toBe("channel_live:voice");
    expect(live[0]!.payload).toMatchObject({ channel: "voice", isPlanStarted: false });
    expect(() => assertPayloadAllowed(live[0]!.payload, "channel_live")).not.toThrow();
  });

  test("the hourly sweep moves a production clinic's channel on; a synthetic one is left alone", async () => {
    const prod = await boughtClinic("ev-sweep");
    const synth = await boughtClinic("ev-sweep-synth", { production: false });
    for (const c of [prod, synth]) {
      await finishSetup(c.clinicId);
      await setDirectLine(c.clinicId);
      await setPhoneRuntime(c.clinicId);
      await confirmForwarding(c.clinicId);
      await attest(c.clinicId, "voice");
    }
    const summary = await sweepChannelStates();
    expect(summary.failures).toBe(0);
    expect((await channelRow(prod.clinicId, "voice")).live_at).not.toBeNull();
    expect((await channelRow(synth.clinicId, "voice")).live_at).toBeNull();
  });

  test("the first answer: startPlan for the clinic's first channel, stepUpPackage for the next, once each", async () => {
    const c = await boughtClinic("ev-first", {
      channels: [
        { channel: "voice", liveAt: LIVE },
        { channel: "web", liveAt: LIVE },
      ],
    });
    const web: FirstAnswerEvidence = { ...PATIENT, channel: "web", conversationId: randomUUID() };
    expect(await firstAnswer(c.clinicId, web)).toEqual({
      recorded: true,
      billing: "plan_start",
      billingRecorded: true,
    });
    expect((await channelRow(c.clinicId, "web")).first_answer_at).not.toBeNull();
    expect(await firstAnswer(c.clinicId, web)).toEqual({ recorded: false, reason: "already" });
    expect(await firstAnswer(c.clinicId, { ...PATIENT, conversationId: randomUUID() })).toEqual({
      recorded: true,
      billing: "step_up",
      billingRecorded: true,
    });
    expect(await firstAnswer(c.clinicId, PATIENT)).toEqual({ recorded: false, reason: "already" });
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
      { kind: "step_up", channel_key: "voice", reason: "first_answer" },
    ]);
    expect((await eventsOf(c.clinicId)).filter((e) => e.kind === "first_answer")).toHaveLength(2);

    // The hourly reconcile now sees both channels in service and the plan
    // start already on the ledger: it records no second plan start, and no
    // step-up before the plan has started (the start prices both in).
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
    const results = await Promise.all([
      firstAnswer(c.clinicId, { ...PATIENT, channel: "web" }),
      firstAnswer(c.clinicId, PATIENT),
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

  test("once the plan has started, even the first answered channel steps up rather than starting it again", async () => {
    const c = await boughtClinic("ev-started", {
      planStartedAt: new Date("2026-10-01T00:00:00Z"),
      channels: [{ channel: "voice", liveAt: LIVE }],
    });
    expect(await firstAnswer(c.clinicId, PATIENT)).toMatchObject({
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
      expect((await firstAnswer(c.clinicId, { ...PATIENT, ...over })).recorded).toBe(false);
    }
    expect(await firstAnswer(c.clinicId, { ...PATIENT, channel: "web" })).toEqual({
      recorded: false,
      reason: "not_live",
    });
    expect(await firstAnswer(c.clinicId, { ...PATIENT, channel: "meta" })).toEqual({
      recorded: false,
      reason: "not_bought",
    });
    expect(await requestsOf(c.clinicId)).toEqual([]);
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
    expect((await eventsOf(c.clinicId)).filter((e) => e.kind === "first_answer")).toEqual([]);
  });

  test("a billing failure rolls back the first answer with its request, and never the caller's own work", async () => {
    const c = await boughtClinic("ev-rollback", { channels: [{ channel: "voice", liveAt: LIVE }] });
    flags.failBilling = true;
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      // The caller's own write, standing in for the conversation it records.
      await tx.db
        .insert(channelEvents)
        .values({ clinicId: c.clinicId, channel: "voice", kind: "turned_on", actor: "caller" });
      return recordFirstAnswer(tx, PATIENT);
    });
    expect(result).toEqual({ recorded: false, reason: "failed" });
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
    expect((await eventsOf(c.clinicId)).map((e) => e.kind)).toEqual(["turned_on"]);
    expect(await requestsOf(c.clinicId)).toEqual([]);
    // The next answered conversation records it.
    flags.failBilling = false;
    expect(await firstAnswer(c.clinicId, PATIENT)).toMatchObject({
      recorded: true,
      billing: "plan_start",
    });
  });

  test("the voice ingest records phone's first answer for an answered call, never for the forwarding test, an own number or a refused call", async () => {
    const c = await boughtClinic("ev-ingest", { channels: [{ channel: "voice", liveAt: LIVE }] });
    await setPhoneRuntime(c.clinicId);
    await setDirectLine(c.clinicId);
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const call = (over: Partial<VoiceCallEvent>): VoiceCallEvent => ({
      externalCallId: `call-${randomUUID()}`,
      clinicId: c.clinicId,
      callerPhone: "+14155550777",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 90_000),
      durationSeconds: 90,
      answeredByAssistant: true,
      outcome: "qualified_no_booking",
      ...over,
    });
    await ingestCall(call({ answeredByAssistant: false }));
    await ingestCall(call({ callerPhone: PUBLISHED }));
    await ingestCall(call({ callerPhone: DIRECT }));
    await ingestCall(call({ outcome: "abandoned" }));
    await getMigratorPool().query(`update clinics set forwarding_test_until = $2 where id = $1`, [
      c.clinicId,
      new Date(startedAt.getTime() + 60_000),
    ]);
    await ingestCall(call({}));
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([]);

    await ingestCall(call({ startedAt: new Date(), endedAt: new Date(Date.now() + 60_000) }));
    expect((await channelRow(c.clinicId, "voice")).first_answer_at).not.toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
    ]);
  });

  test("the Retell process tells the ingest whether the gate answered: the safe script for a refused call never counts", async () => {
    const clinic = await seedClinic("ev-retell");
    const run = async (decision: AnswerDecision) => {
      const events: VoiceCallEvent[] = [];
      const session = new RetellCallSession(
        clinic.clinicId,
        `call_${randomUUID()}`,
        () => undefined,
        {
          responder: null,
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
      await session.finish();
      return events[0]!;
    };
    expect((await run({ decision: "answer" })).answeredByAssistant).toBe(true);
    // No direct line: AYA takes the caller's details with the safe script, which is not an answer.
    const refused = await run({
      decision: "pass_through",
      reason: "channel_not_live",
      fallback: "direct_line",
      directLine: null,
    });
    expect(refused.answeredByAssistant).toBe(false);
    expect(refused.disclosurePlayedAt).toBeDefined();
  });

  test("website chat goes live on the widget's first load on the clinic's own site, and its first conversation starts the plan; a local page does neither", async () => {
    const c = await boughtClinic("ev-web", {
      plan: "webchat-1000",
      channels: [{ channel: "web" }],
    });
    await getMigratorPool().query(
      `update clinics set website = 'radiance-widget.test' where id = $1`,
      [c.clinicId],
    );
    await setWeekdayHours(c.clinicId);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: PUBLISHED });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    await finishSetup(c.clinicId);
    await attest(c.clinicId, "web");
    // As the operator's attestation does (lib/ops/api.ts): ready, waiting on the line on the site.
    expect(await evaluate(c.clinicId, "web")).toMatchObject([
      { readied: true, waitingOn: "snippet" },
    ]);
    const clinic = (await webChatClinic(c.slug))!;

    expect(await startWebChat(clinic, new Date(), "http://localhost:3000")).toMatchObject({
      mode: "contact_form",
      reason: "channel_not_live",
    });
    expect((await eventsOf(c.clinicId, "web")).map((e) => e.kind)).toEqual([
      "audit_passed",
      "ready",
      "waiting",
    ]);

    const start = await startWebChat(clinic, new Date(), "https://www.radiance-widget.test");
    expect(start.mode).toBe("chat");
    expect((await channelRow(c.clinicId, "web")).live_at).not.toBeNull();
    // The load and the go-live it caused share one instant.
    expect((await eventsOf(c.clinicId, "web")).map((e) => e.kind).sort()).toEqual(
      ["audit_passed", "ready", "waiting", "runtime_seen", "live"].sort(),
    );
    // A second load records nothing more.
    await startWebChat(clinic, new Date(), "https://radiance-widget.test");
    expect(
      (await eventsOf(c.clinicId, "web")).filter((e) => e.kind === "runtime_seen"),
    ).toHaveLength(1);
    expect(await noticesOf(c.clinicId, "channel_live")).toHaveLength(1);

    const responder: AssistantResponder = async () =>
      JSON.stringify({ reply: "We're open weekdays.", booking: {} });
    if (start.mode !== "chat") throw new Error("no chat");
    // A chat on a local page is the clinic trying its own widget: answered, never counted as the first.
    const local = await startWebChat(clinic, new Date(), "http://localhost:3000");
    if (local.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, local.token, "When are you open?", {
      responder,
      origin: "http://localhost:3000",
    });
    expect((await channelRow(c.clinicId, "web")).first_answer_at).toBeNull();

    await sendWebChatMessage(clinic, start.token, "When are you open?", {
      responder,
      origin: "https://www.radiance-widget.test",
    });
    expect((await channelRow(c.clinicId, "web")).first_answer_at).not.toBeNull();
    expect(await requestsOf(c.clinicId)).toEqual([
      { kind: "plan_start", channel_key: "-", reason: "first_answer" },
    ]);
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

  test("the operator's go-live is an input: it moves every channel on as far as the others allow", async () => {
    const c = await boughtClinic("ev-golive", {
      production: false,
      channels: [{ channel: "voice" }],
    });
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = false,
              opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb,
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
    await finishSetup(c.clinicId);
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await attest(c.clinicId, "voice");
    expect((await evaluate(c.clinicId, "voice"))[0]!.missing).toEqual(["go_live"]);

    const result = await goLive(c.clinicId, { label: "ops@healdesk.test" });
    expect(result.status, JSON.stringify(result)).toBe("live");
    expect((await channelRow(c.clinicId, "voice")).live_at).not.toBeNull();
    expect(await noticesOf(c.clinicId, "channel_live")).toHaveLength(1);
  });

  test("a setup screen saved or skipped moves the channels on: finishing setup can be the last input", async () => {
    const c = await boughtClinic("ev-setup", { channels: [{ channel: "voice" }] });
    await setDirectLine(c.clinicId);
    await setPhoneRuntime(c.clinicId);
    await confirmForwarding(c.clinicId);
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
    const live = (await eventsOf(c.clinicId, "voice")).find((e) => e.kind === "live");
    expect(live?.actor).toBe("Front desk Mac");
  });

  test("AYA's number for the forwarding steps exists only once phone is ready on our side", async () => {
    const c = await boughtClinic("ev-steps", { channels: [{ channel: "voice" }] });
    await setPhoneRuntime(c.clinicId);
    const number = () =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        readPhoneStepsNumber(tx.db, tx.clinicId),
      );
    expect(await number()).toBeNull();
    await attest(c.clinicId, "voice");
    await evaluate(c.clinicId, "voice");
    expect(await number()).toBe(AYA);
    const web = await boughtClinic("ev-steps-web", {
      plan: "webchat-1000",
      channels: [{ channel: "web" }],
    });
    expect(
      await withTenant({ clinicId: web.clinicId, actor: ACTOR }, (tx) =>
        readPhoneStepsNumber(tx.db, tx.clinicId),
      ),
    ).toBeNull();
  });

  test("the operator attests a channel's audit through the envelope, once, and the console sees what each channel still needs", async () => {
    const c = await boughtClinic("ev-ops");
    const data = async (op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) =>
      ((await runOperation(op, args, OPERATOR)).body as { data: Record<string, unknown> }).data;

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
      missing: ["runtime", "setup", "direct_line", "clinic_step"],
    });
    expect(channels.find((x) => x.channel === "web")).toMatchObject({
      auditPassed: false,
      missing: ["audit", "setup", "clinic_step"],
    });
  });
});
