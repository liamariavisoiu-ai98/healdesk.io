import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, POST as metaPost } from "@/app/api/webhooks/meta/route";
import type { AssistantResponder } from "@/lib/assistant/turn";
import type { PassThroughReason } from "@/lib/billing/answering";
import { updateClinicSettings } from "@/lib/billing/settings";
import {
  evaluateOutages,
  MISS_NOTICE_SETTLE_MS,
  OUTAGE_AFTER_MS,
  ROUTED_PENDING_GRACE_MS,
  runAnswerNoticesSweep,
  settlePending,
} from "@/lib/channels/answer-notices";
import { pauseAya } from "@/lib/channels/pause";
import {
  movesTowardsWorse,
  passThroughResolution,
  recordRouted,
  resolveRouted,
  routedAnsweredCounts,
  routedRefHash,
  timedAnswer,
  type RoutedKey,
  type RoutedResolution,
} from "@/lib/channels/routed-answered";
import { MESSAGE_ANSWER_WITHIN_MS, OUTAGE_MISSED_REASONS } from "@/lib/channels/routed-words";
import { sendWebChatMessage, signToken, webChatClinic } from "@/lib/chat/web-chat";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import {
  gateBInCode,
  ROUTED_ANSWERED_COUNTER_BUILT,
  routedAnsweredCounterBuilt,
} from "@/lib/compliance/gate-b";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { PENDING_TEMPLATES } from "@/lib/email/templates/registry";
import { publicUrl } from "@/lib/public-url";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import type { FrontDoorResponder } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  queuedNotices,
  seedChannels,
  seedClinic,
  seedEntitled,
  setWeekdayHours,
} from "./setup/factories";
import { attestPlatform } from "./setup/platform";

/**
 * The routed/answered counter and its notices (Gate B; drizzle/0137,
 * lib/channels/routed-answered.ts, lib/channels/answer-notices.ts). Pure
 * first: Terms §5's words for a refusal and for timing, and the payloads
 * against the email allowlist. Then against the database: one row per call
 * or conversation, idempotent and only ever moving towards the worse outcome
 * (retries, races, the trigger), no reference kept in the clear; each
 * runtime writing it; the sweep settling what was left pending, and queuing
 * L17, L18 and L21 once each, exactly when the registry says.
 *
 * Every date is pinned in October 2026, clear of the 1 November daylight-
 * saving change in America/New_York, the seeded clinics' zone.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "routed-answered-test" } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 11:00 am EDT, Thursday 15 October 2026. */
const NOW = new Date("2026-10-15T15:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LINE = "+14155550123";
const APP_SECRET = "meta-app-secret-for-routed-tests";
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const SAVED_ENV: Record<string, string | undefined> = {};

const EVERY_PASS_THROUGH: PassThroughReason[] = [
  "no_agreement",
  "agreement_insufficient",
  "host_agreement_lapsed",
  "vendor_agreement_lapsed",
  "unpaid",
  "not_active",
  "cancel_before_start",
  "suspended",
  "canceled",
  "not_purchased",
  "channel_not_live",
  "channel_off",
  "ai_paused",
  "outside_coverage",
  "allowance_cap",
];

describe("Terms §5's words, in code", () => {
  test("the clinic's own state or choice does not count; a lapsed supplier's or host's agreement is our miss", () => {
    for (const reason of EVERY_PASS_THROUGH) {
      const r = passThroughResolution(reason);
      if (reason === "host_agreement_lapsed" || reason === "vendor_agreement_lapsed") {
        expect(r, reason).toEqual({ outcome: "missed", reason });
      } else {
        expect(r, reason).toEqual({ outcome: "excluded", reason });
      }
    }
  });

  test("a message answered within 60 seconds is answered, one a millisecond later is a late miss", () => {
    const routed = NOW;
    expect(timedAnswer(routed, at(MESSAGE_ANSWER_WITHIN_MS), MESSAGE_ANSWER_WITHIN_MS)).toEqual({
      outcome: "answered",
      answeredAt: at(MESSAGE_ANSWER_WITHIN_MS),
    });
    expect(timedAnswer(routed, at(MESSAGE_ANSWER_WITHIN_MS + 1), MESSAGE_ANSWER_WITHIN_MS)).toMatchObject({
      outcome: "missed",
      reason: "late",
    });
  });

  test("an outcome only moves towards the worse; a late answer is not an outage", () => {
    expect(movesTowardsWorse("pending", "answered")).toBe(true);
    expect(movesTowardsWorse("answered", "missed")).toBe(true);
    expect(movesTowardsWorse("missed", "answered")).toBe(false);
    expect(movesTowardsWorse("answered", "excluded")).toBe(false);
    expect(OUTAGE_MISSED_REASONS).not.toContain("late");
  });

  test("the three payloads hold only what an email may carry", () => {
    assertPayloadAllowed(
      { startedAt: NOW.toISOString(), channels: ["voice", "web"], directLineE164: LINE, homeUrl: publicUrl("/c/glow") },
      "outage_started",
    );
    assertPayloadAllowed(
      {
        startedAt: NOW.toISOString(),
        endedAt: at(HOUR).toISOString(),
        callCount: 3,
        chatCount: 1,
        channels: ["voice", "meta"],
        homeUrl: publicUrl("/c/glow"),
      },
      "outage_ended",
    );
    assertPayloadAllowed(
      {
        missedOn: "2026-10-07",
        channels: ["voice"],
        callCount: 1,
        messageCount: 0,
        firstMonthEndsOn: "2026-11-03",
        claimByOn: "2026-12-03",
        homeUrl: publicUrl("/c/glow"),
      },
      "guarantee_miss",
    );
  });

  test("the counter is built; the Gate B item waits only on the three templates", () => {
    expect(ROUTED_ANSWERED_COUNTER_BUILT).toBe(true);
    const runtime = Object.entries(PENDING_TEMPLATES as Record<string, { package: string }>)
      .filter(([, p]) => p.package === "runtime")
      .map(([kind]) => kind)
      .sort();
    expect(routedAnsweredCounterBuilt()).toBe(runtime.length === 0);
    const item = gateBInCode().find((i) => i.id === "routed_answered_counter")!;
    expect(item.built).toBe(runtime.length === 0);
    if (runtime.length > 0) {
      expect(runtime).toEqual(["guarantee_miss", "outage_ended", "outage_started"]);
      expect(item.detail).toMatch(/templates have not shipped/);
    }
  });
});

describeDb("the routed/answered counter, against the database", () => {
  const inClinic = <T>(clinicId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant({ clinicId, actor: ACTOR }, fn);

  async function rows(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const { rows: out } = await client.query<{
        channel: string;
        ref_hash: string;
        routed_at: Date;
        outcome: string;
        reason: string | null;
        answered_at: Date | null;
      }>(`select channel, ref_hash, routed_at, outcome, reason, answered_at from routed_interactions order by routed_at, id`);
      return out;
    });
  }

  const key = (ref: string, routedAt: Date, channel: Channel = "voice"): RoutedKey => ({ channel, ref, routedAt });
  const resolve = (clinicId: string, k: RoutedKey, r: RoutedResolution, now: Date = NOW) =>
    inClinic(clinicId, (tx) => resolveRouted(tx.db, tx.clinicId, k, r, now));
  const note = (clinicId: string, k: RoutedKey) => inClinic(clinicId, (tx) => recordRouted(tx.db, tx.clinicId, k));

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
    for (const k of ["BETTER_AUTH_URL", "META_APP_SECRET"]) SAVED_ENV[k] = process.env[k];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.META_APP_SECRET = APP_SECRET;
  }, 180_000);

  afterAll(async () => {
    __setMetaRuntimeForTests(undefined, undefined);
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closePools();
  });

  test("one row per call: a retried write is the same row, the reference is hashed, and nothing undoes a miss", async () => {
    const c = await seedClinic("ra-idem");
    const k = key("call_abc123", NOW);
    await note(c.clinicId, k);
    await note(c.clinicId, k);
    expect(await rows(c.clinicId)).toMatchObject([{ outcome: "pending", reason: null }]);

    expect(await resolve(c.clinicId, k, { outcome: "answered", answeredAt: at(3_000) })).toBe(true);
    // The same answer again (a retry) changes nothing.
    expect(await resolve(c.clinicId, k, { outcome: "answered", answeredAt: at(9_000) })).toBe(false);
    // A later exclusion never downgrades an answer.
    expect(await resolve(c.clinicId, k, { outcome: "excluded", reason: "ai_paused" })).toBe(false);
    expect(await resolve(c.clinicId, k, { outcome: "missed", reason: "cut_off" })).toBe(true);
    expect(await resolve(c.clinicId, k, { outcome: "answered", answeredAt: at(20_000) })).toBe(false);

    const [row] = await rows(c.clinicId);
    expect(row).toMatchObject({ channel: "voice", outcome: "missed", reason: "cut_off", answered_at: at(3_000) });
    expect(row!.ref_hash).toBe(routedRefHash("voice", "call_abc123"));
    expect(row!.ref_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("call_abc123");
  });

  test("the trigger holds the same rule against the runtime role, and the role cannot delete", async () => {
    const c = await seedClinic("ra-trigger");
    await resolve(c.clinicId, key("call_t", NOW), { outcome: "missed", reason: "error" });
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(
        client.query(`update routed_interactions set outcome = 'answered', reason = null`),
      ).rejects.toThrow(/only moves towards the worse/);
      await client.query("rollback");
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(client.query(`delete from routed_interactions`)).rejects.toThrow(/permission denied/);
      await client.query("rollback");
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(client.query(`update routed_interactions set routed_at = now()`)).rejects.toThrow(
        /permission denied|only the outcome/,
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("racing writers settle on the worst outcome, in one row", async () => {
    const c = await seedClinic("ra-race");
    const k = key("conv-race", NOW, "web");
    const writes: RoutedResolution[] = [
      ...Array.from({ length: 6 }, () => ({ outcome: "answered" as const, answeredAt: at(2_000) })),
      { outcome: "missed", reason: "error" },
      ...Array.from({ length: 3 }, () => ({ outcome: "excluded" as const, reason: "ai_paused" as const })),
    ];
    await Promise.all([note(c.clinicId, k), ...writes.map((w) => resolve(c.clinicId, k, w))]);
    expect(await rows(c.clinicId)).toMatchObject([{ channel: "web", outcome: "missed", reason: "error" }]);
  });

  test("a clinic sees its own rows only, and the counts are per channel and period", async () => {
    const a = await seedClinic("ra-count-a");
    const b = await seedClinic("ra-count-b");
    await resolve(a.clinicId, key("v1", at(-2 * HOUR)), { outcome: "answered", answeredAt: at(-2 * HOUR) });
    await resolve(a.clinicId, key("v2", at(-HOUR)), { outcome: "missed", reason: "start_failed" });
    await resolve(a.clinicId, key("w1", at(-HOUR), "web"), { outcome: "excluded", reason: "ai_paused" });
    await note(a.clinicId, key("m1", at(-MINUTE), "meta"));
    await resolve(a.clinicId, key("v-old", at(-3 * DAY)), { outcome: "missed", reason: "error" });
    await resolve(b.clinicId, key("v1", at(-HOUR)), { outcome: "missed", reason: "error" });

    const counts = await inClinic(a.clinicId, (tx) =>
      routedAnsweredCounts(tx.db, tx.clinicId, { from: at(-DAY), to: NOW }),
    );
    expect(counts.voice).toEqual({ routed: 2, answered: 1, excluded: 0, missed: 1, pending: 0 });
    expect(counts.web).toEqual({ routed: 1, answered: 0, excluded: 1, missed: 0, pending: 0 });
    expect(counts.meta).toEqual({ routed: 1, answered: 0, excluded: 0, missed: 0, pending: 1 });
    // b's tenant reads none of a's rows, and the reverse.
    expect((await rows(b.clinicId)).length).toBe(1);
    const leak = await inClinic(b.clinicId, (tx) => routedAnsweredCounts(tx.db, a.clinicId, { from: at(-DAY), to: NOW }));
    expect(leak.voice.routed).toBe(0);
  });

  test("a row left pending past its grace is missed, `no_outcome`; one inside it waits", async () => {
    const c = await seedClinic("ra-settle");
    await note(c.clinicId, key("stale", at(-ROUTED_PENDING_GRACE_MS - MINUTE)));
    await note(c.clinicId, key("fresh", at(-ROUTED_PENDING_GRACE_MS + MINUTE)));
    expect(await inClinic(c.clinicId, (tx) => settlePending(tx.db, tx.clinicId, NOW))).toBe(1);
    expect(await inClinic(c.clinicId, (tx) => settlePending(tx.db, tx.clinicId, NOW))).toBe(0);
    expect((await rows(c.clinicId)).map((r) => [r.outcome, r.reason])).toEqual([
      ["missed", "no_outcome"],
      ["pending", null],
    ]);
  });

  describe("L17 and L18: one pair per incident", () => {
    const T0 = new Date("2026-10-15T14:00:00Z");
    const t = (ms: number) => new Date(T0.getTime() + ms);

    async function liveVoiceClinic(label: string) {
      const c = await seedClinic(label);
      await seedChannels(c.clinicId, [{ channel: "voice", readyAt: WINDOW_START, liveAt: WINDOW_START }]);
      await inClinic(c.clinicId, (tx) => updateClinicSettings(tx, { directLineE164: LINE }, "test", WINDOW_START));
      return c;
    }

    test("ten minutes of failures with nothing answered sends L17 once; the next answer sends L18 once, with the counts", async () => {
      const c = await liveVoiceClinic("ra-outage");
      await resolve(c.clinicId, key("ok", T0), { outcome: "answered", answeredAt: t(2_000) });
      await resolve(c.clinicId, key("f1", t(MINUTE)), { outcome: "missed", reason: "start_failed" });
      await resolve(c.clinicId, key("f2", t(5 * MINUTE), "web"), { outcome: "missed", reason: "error" });
      // A failure only five minutes on is not ten minutes of failure.
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(6 * MINUTE)))).toEqual({ started: 0, ended: 0 });
      // A late answer is AYA answering: it does not open an incident, and the excluded never count.
      await resolve(c.clinicId, key("x1", t(7 * MINUTE)), { outcome: "excluded", reason: "caller_ended" });
      await resolve(c.clinicId, key("f3", t(MINUTE + OUTAGE_AFTER_MS)), { outcome: "missed", reason: "no_outcome" });
      const now1 = t(12 * MINUTE);
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, now1))).toEqual({ started: 1, ended: 0 });
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, now1))).toEqual({ started: 0, ended: 0 });
      const [started] = await queuedNotices(c.clinicId, ["outage_started"]);
      expect(started).toMatchObject({
        dedupe_key: `outage_started:${t(MINUTE).toISOString()}`,
        payload: {
          startedAt: t(MINUTE).toISOString(),
          channels: ["voice", "web"],
          directLineE164: LINE,
          homeUrl: `https://app.healdesk.test/c/${c.slug}`,
        },
      });
      assertPayloadAllowed(started!.payload, "outage_started");

      // Still failing: no second L17, and no L18 yet.
      await resolve(c.clinicId, key("f4", t(20 * MINUTE)), { outcome: "missed", reason: "error" });
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(21 * MINUTE)))).toEqual({ started: 0, ended: 0 });

      // She answers again.
      await resolve(c.clinicId, key("back", t(30 * MINUTE), "meta"), { outcome: "answered", answeredAt: t(30 * MINUTE + 4_000) });
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(31 * MINUTE)))).toEqual({ started: 0, ended: 1 });
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(32 * MINUTE)))).toEqual({ started: 0, ended: 0 });
      const [ended] = await queuedNotices(c.clinicId, ["outage_ended"]);
      expect(ended).toMatchObject({
        dedupe_key: `outage_ended:${t(MINUTE).toISOString()}`,
        payload: {
          startedAt: t(MINUTE).toISOString(),
          endedAt: t(30 * MINUTE + 4_000).toISOString(),
          callCount: 3,
          chatCount: 1,
          channels: ["voice", "web"],
        },
      });
      assertPayloadAllowed(ended!.payload, "outage_ended");
    });

    test("a blip that ends inside ten minutes sends neither; a clinic with nothing live sends nothing", async () => {
      const c = await liveVoiceClinic("ra-blip");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(4 * MINUTE)), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("ok", t(6 * MINUTE)), { outcome: "answered", answeredAt: t(6 * MINUTE) });
      await resolve(c.clinicId, key("f3", t(30 * MINUTE)), { outcome: "missed", reason: "error" });
      expect(await inClinic(c.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(31 * MINUTE)))).toEqual({ started: 0, ended: 0 });

      const setup = await seedClinic("ra-not-live");
      await resolve(setup.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(setup.clinicId, key("f2", t(20 * MINUTE)), { outcome: "missed", reason: "error" });
      expect(await inClinic(setup.clinicId, (tx) => evaluateOutages(tx.db, tx.clinicId, t(21 * MINUTE)))).toEqual({ started: 0, ended: 0 });
      expect(await queuedNotices(c.clinicId, ["outage_started", "outage_ended"])).toEqual([]);
      expect(await queuedNotices(setup.clinicId, ["outage_started", "outage_ended"])).toEqual([]);
    });
  });

  test("L21: one notice per practice-local day of first-month misses on live channels, after the day has ended, once, on the billing clinic", async () => {
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
    // First go-live 10:00 EDT Monday 5 October 2026; web live only from the 9th.
    const firstLive = new Date("2026-10-05T14:00:00Z");
    const c = await seedClinic("ra-miss");
    await seedChannels(c.clinicId, [
      { channel: "voice", readyAt: firstLive, liveAt: firstLive },
      { channel: "web", readyAt: firstLive, liveAt: new Date("2026-10-09T14:00:00Z") },
    ]);
    // A second location of the same practice.
    const loc = await seedClinic("ra-miss-loc");
    await getMigratorPool().query(
      `update clinics set organization_id = $2, billing_clinic_id = $3 where id = $1`,
      [loc.clinicId, c.organizationId, c.clinicId],
    );
    await seedChannels(loc.clinicId, [{ channel: "voice", readyAt: firstLive, liveAt: firstLive }]);

    // Wednesday 7 October, in New York: two missed calls (one at the
    // location), one excluded, one answered, and a web miss before web
    // was live, which the guarantee does not cover.
    await resolve(c.clinicId, key("c1", new Date("2026-10-07T13:00:00Z")), { outcome: "missed", reason: "start_failed" });
    await resolve(loc.clinicId, key("c2", new Date("2026-10-08T03:30:00Z")), { outcome: "missed", reason: "no_opening" });
    await resolve(c.clinicId, key("c3", new Date("2026-10-07T15:00:00Z")), { outcome: "excluded", reason: "ai_paused" });
    await resolve(c.clinicId, key("c4", new Date("2026-10-07T16:00:00Z")), { outcome: "answered", answeredAt: new Date("2026-10-07T16:00:02Z") });
    await resolve(c.clinicId, key("w1", new Date("2026-10-07T17:00:00Z"), "web"), { outcome: "missed", reason: "error" });

    // 23:50 on the 7th in New York: the day has not ended.
    let r = await runAnswerNoticesSweep(new Date("2026-10-08T03:50:00Z"));
    expect(r.status).toBe("ok");
    expect(await queuedNotices(c.clinicId, ["guarantee_miss"])).toEqual([]);

    // 00:05 on the 8th: ended, but not settled for MISS_NOTICE_SETTLE_MS.
    r = await runAnswerNoticesSweep(new Date(Date.parse("2026-10-08T04:00:00Z") + MISS_NOTICE_SETTLE_MS - 10 * MINUTE));
    expect(await queuedNotices(c.clinicId, ["guarantee_miss"])).toEqual([]);

    // 00:20 on the 8th.
    const settled = new Date("2026-10-08T04:20:00Z");
    r = await runAnswerNoticesSweep(settled);
    expect(r).toMatchObject({ status: "ok", missNotices: 1 });
    r = await runAnswerNoticesSweep(new Date(settled.getTime() + MINUTE));
    expect(r.missNotices).toBe(0);
    const notices = await queuedNotices(c.clinicId, ["guarantee_miss"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      dedupe_key: "guarantee_miss:2026-10-07",
      payload: {
        missedOn: "2026-10-07",
        channels: ["voice"],
        callCount: 2,
        messageCount: 0,
        firstMonthEndsOn: "2026-11-03",
        claimByOn: "2026-12-03",
        homeUrl: `https://app.healdesk.test/c/${c.slug}`,
      },
    });
    assertPayloadAllowed(notices[0]!.payload, "guarantee_miss");
    // The location's own outbox holds none: the account owner is told, once.
    expect(await queuedNotices(loc.clinicId, ["guarantee_miss"])).toEqual([]);

    // A miss after the first month ended is outside the guarantee.
    await resolve(c.clinicId, key("late-month", new Date("2026-11-05T15:00:00Z")), { outcome: "missed", reason: "error" });
    await runAnswerNoticesSweep(new Date("2026-11-06T15:00:00Z"));
    expect((await queuedNotices(c.clinicId, ["guarantee_miss"])).map((n) => n.dedupe_key)).toEqual(["guarantee_miss:2026-10-07"]);
  });

  describe("each runtime writes the counter", () => {
    const asked: string[] = [];
    const responder: AssistantResponder = async ({ messages }) => {
      asked.push(messages[messages.length - 1]!.content);
      return JSON.stringify({ reply: "Happy to help." });
    };
    const sender: MetaSender = async () => {};
    const metaResponder: FrontDoorResponder = async () => JSON.stringify({ reply: "We're open Saturday, 10 to 2." });

    async function liveClinic(label: string) {
      const c = await seedClinic(label);
      const pageId = String(320_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
      await bindAgreementInEffect(c.clinicId);
      await setWeekdayHours(c.clinicId);
      await getMigratorPool().query(
        `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(),
                website = $2 where id = $1`,
        [c.clinicId, `${c.slug}.test`],
      );
      await seedEntitled(c.clinicId, {
        planStartedAt: WINDOW_START,
        channelRows: (["voice", "web", "meta"] as const).map((ch) => ({ channel: ch, liveAt: WINDOW_START, readyAt: WINDOW_START })),
      });
      await inClinic(c.clinicId, async (tx) => {
        await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
        await updateAgentConfig(tx, {
          greeting: "Hi",
          services: [{ name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 }],
          escalationPhone: null,
          escalationHours: "Weekdays 9 to 5",
          notes: null,
        });
        await approveAgentConfig(tx, "Dr Chen");
        await attachMetaChannel(tx, { platform: "messenger", externalId: pageId, accessToken: "EAAB-page-token-0123456789" });
        await setMetaFrontDoor(tx, true);
        await updateClinicSettings(tx, { directLineE164: LINE }, "test", at(-48 * HOUR));
      });
      return { ...c, pageId };
    }

    async function everyEntryPoint(c: { clinicId: string; slug: string; pageId: string }, when: Date) {
      const clinic = (await webChatClinic(c.slug))!;
      const token = signToken({ clinicId: c.clinicId, conversationId: null, sessionId: randomUUID(), issuedAt: when.getTime() });
      await sendWebChatMessage(clinic, token, "Do you have anything on Friday?", { responder, now: when });
      const session = new RetellCallSession(c.clinicId, `call_${randomUUID()}`, (_m: RetellOutbound) => {}, {
        responder,
        realCalls: true,
        now: () => when,
        ingest: async () => ({ conversationId: randomUUID(), duplicate: false, transcriptEmailId: null }) as never,
      });
      await session.open();
      session.socketClosed();
      await session.finish();
      __setMetaRuntimeForTests(metaResponder, sender, undefined, when);
      const raw = JSON.stringify({
        object: "page",
        entry: [
          {
            id: c.pageId,
            messaging: [
              {
                sender: { id: `psid-${randomUUID().slice(0, 8)}` },
                recipient: { id: c.pageId },
                timestamp: when.getTime() - MINUTE,
                message: { mid: `m-${randomUUID()}`, text: "are you open saturday?" },
              },
            ],
          },
        ],
      });
      await metaPost(
        new Request("http://app.test/api/webhooks/meta", {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, APP_SECRET) },
          body: raw,
        }),
      );
    }

    test("answering, each channel counts an answer; paused, each counts an exclusion, never a miss", async () => {
      const c = await liveClinic("ra-runtime");
      await everyEntryPoint(c, NOW);
      const answered = await rows(c.clinicId);
      expect(answered.map((r) => [r.channel, r.outcome, r.reason]).sort()).toEqual([
        ["meta", "answered", null],
        ["voice", "answered", null],
        ["web", "answered", null],
      ]);
      expect(answered.every((r) => r.answered_at !== null)).toBe(true);

      await inClinic(c.clinicId, (tx) => pauseAya(tx, { choice: "indefinite", actorLabel: "Front desk Mac", now: at(-10 * MINUTE) }));
      await everyEntryPoint(c, at(MINUTE));
      const paused = (await rows(c.clinicId)).filter((r) => r.routed_at.getTime() === at(MINUTE).getTime());
      expect(paused.map((r) => [r.channel, r.outcome, r.reason]).sort()).toEqual([
        ["meta", "excluded", "ai_paused"],
        ["voice", "excluded", "ai_paused"],
        ["web", "excluded", "ai_paused"],
      ]);
    });

    test("a call whose opening line starts more than ten seconds after it reached us is a late miss; one hung up within five seconds does not count", async () => {
      const c = await seedClinic("ra-voice-timing");
      const resolved: RoutedResolution[] = [];
      const routed = {
        note: async () => {},
        resolve: async (_clinicId: string, _key: RoutedKey, r: RoutedResolution) => {
          resolved.push(r);
        },
      };
      let clock = NOW;
      const slow = new RetellCallSession(c.clinicId, "call_slow", () => {}, {
        responder,
        realCalls: true,
        now: () => clock,
        gate: async () => {
          clock = at(11_000);
          return { decision: "answer" };
        },
        ingest: async () => ({ conversationId: randomUUID(), duplicate: false, transcriptEmailId: null }) as never,
        routed,
      });
      await slow.open();
      slow.socketClosed();
      await slow.finish();

      clock = NOW;
      const hungUp = new RetellCallSession(c.clinicId, "call_gone", () => {}, {
        responder,
        realCalls: true,
        now: () => clock,
        gate: () => new Promise(() => {}),
        startDeadlineMs: 0,
        callDetailsWaitMs: 0,
        fallbackLine: async () => null,
        ingest: async () => ({ conversationId: randomUUID(), duplicate: false, transcriptEmailId: null }) as never,
        routed,
      });
      hungUp.socketClosed();
      clock = at(4_000);
      await hungUp.finish();

      expect(resolved[0]).toMatchObject({ outcome: "missed", reason: "late" });
      expect(resolved[1]).toEqual({ outcome: "excluded", reason: "caller_ended" });
    });
  });
});
