import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { updateClinicSettings } from "@/lib/billing/settings";
import {
  firstMonthOf,
  missedPath,
  noteSweepOutcome,
  OUTAGE_ESCALATE_AFTER_MS,
  OUTAGE_ESCALATE_EVERY_MS,
  outageRunStart,
  RECOVERY_QUIET_MS,
  resetSweepFailures,
  ROUTED_PENDING_GRACE_MS,
  runAnswerNoticesSweep,
  SWEEP_FAILING_AFTER_RUNS,
} from "@/lib/channels/answer-notices";
import {
  closingNoteOf,
  linkMissCaseReply,
  listAnswerCases,
  missReplyOf,
  setMissCaseStatus,
  supportCaseIdForMissReply,
} from "@/lib/channels/miss-cases";
import { recordRouted, resolveRouted, type RoutedKey, type RoutedResolution } from "@/lib/channels/routed-answered";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { erasePerson } from "@/lib/patient-rights/erasure";
import { amendContact } from "@/lib/patient-rights/export";
import { readAnswerAttention } from "@/lib/portal/missed-contacts";
import type { DeliveryResult, EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedContact } from "./setup/factories";
import { attestPlatform } from "./setup/platform";

/**
 * The workflows behind the routed/answered counter's three notices, end to
 * end against the database (lib/channels/answer-notices.ts, miss-cases.ts,
 * lib/portal/missed-contacts.ts; docs/design/launch-readiness-2026-10-27/
 * gate-b-notice-workflows.md):
 *
 *   - fault → L17 + the incident + the ops alert → recovery (ten quiet
 *     minutes, a failure inside them starting the clock again) → L18 once →
 *     the incident closed with its counts; one that stays open escalated;
 *   - a send that fails is retried by the outbox, then sent;
 *   - miss → the missed-contact record → after the day, L21 + the miss case
 *     + the ops alert, a burst collapsed into one case → a reply joins it,
 *     a second reply finds the same support case → explained with a note,
 *     which reaches the missed contacts;
 *   - the missed-contact record: one per call, never for an answer, its 30
 *     days, a person's erasure by number;
 *   - every run twice: nothing twice.
 *
 * Dates pinned in October 2026, clear of the 1 November clock change in
 * America/New_York, the seeded clinics' zone.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "answer-workflows-test" } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LINE = "+14155550123";
const CALLER = "+14155550177";
const LIVE_SINCE = new Date("2026-10-05T14:00:00Z");
const SAVED_ENV: Record<string, string | undefined> = {};

describe("the workflows' words", () => {
  test("a reply to L21 is read for its noun and its day only", () => {
    expect(missReplyOf("Re: Looking into a call from Wednesday 7 October")).toEqual({ noun: "call", when: "wednesday 7 october" });
    expect(missReplyOf("RE: Looking into a message from Monday 5 October")).toMatchObject({ noun: "message" });
    expect(missReplyOf("Re: AYA is answering again")).toBeNull();
  });

  test("a closing note is one or two plain lines, never an address or a link", () => {
    expect(closingNoteOf("  A supplier was down for 20 minutes.\n It is fixed.  ")).toBe("A supplier was down for 20 minutes. It is fixed.");
    expect(closingNoteOf("Write to ops@healdesk.io")).toBeNull();
    expect(closingNoteOf("See https://status.example")).toBeNull();
    expect(closingNoteOf("x".repeat(281))).toBeNull();
    expect(closingNoteOf("")).toBeNull();
  });

  test("the first month is the go-live day and the 29 after it, on the practice's calendar", () => {
    expect(firstMonthOf(LIVE_SINCE, "America/New_York")).toEqual({ startsOn: "2026-10-05", endsOn: "2026-11-03", claimByOn: "2026-12-03" });
    expect(missedPath("glow")).toBe("/c/glow/missed");
    expect(missedPath("glow", "abc")).toBe("/c/glow/missed/abc");
  });
});

describeDb("the notice workflows, against the database", () => {
  const key = (ref: string, routedAt: Date, channel: Channel = "voice"): RoutedKey => ({ channel, ref, routedAt });
  const resolve = (clinicId: string, k: RoutedKey, r: RoutedResolution) =>
    withTenant({ clinicId, actor: ACTOR }, (tx) => resolveRouted(tx.db, tx.clinicId, k, r, k.routedAt));

  async function liveClinic(label: string, channels: Channel[] = ["voice", "web"]) {
    const c = await seedClinic(label);
    await seedChannels(c.clinicId, channels.map((channel) => ({ channel, readyAt: LIVE_SINCE, liveAt: LIVE_SINCE })));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => updateClinicSettings(tx, { directLineE164: LINE }, "test", LIVE_SINCE));
    return c;
  }

  async function notices(clinicId: string, kinds: string[]) {
    return inTenant(clinicId, async (q) => {
      const { rows } = await q.query<{ id: string; kind: string; dedupe_key: string; payload: Record<string, unknown> }>(
        `select id, kind, dedupe_key, payload from billing_notices where kind = any($1::text[]) order by created_at, id`,
        [kinds],
      );
      return rows;
    });
  }

  async function alerts(event: string, clinicId: string) {
    const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = $1 and fields->>'clinicId' = $2 order by raised_at`,
      [event, clinicId],
    );
    return rows.map((r) => r.fields);
  }

  async function outages(clinicId: string) {
    return inTenant(clinicId, async (q) => {
      const { rows } = await q.query<{
        id: string;
        status: string;
        started_at: Date;
        ended_at: Date | null;
        call_count: number | null;
        chat_count: number | null;
        channels: string[];
        escalations: number;
      }>(`select id, status, started_at, ended_at, call_count, chat_count, channels, escalations from answer_outages order by started_at`);
      return rows;
    });
  }

  async function missed(clinicId: string) {
    return inTenant(clinicId, async (q) => {
      const { rows } = await q.query<{
        id: string;
        channel: string;
        missed_at: Date;
        caller_phone: string | null;
        outcome: string;
        reached_direct_line: boolean;
        miss_case_id: string | null;
        closing_note: string | null;
      }>(`select id, channel, missed_at, caller_phone, outcome, reached_direct_line, miss_case_id, closing_note from missed_contacts order by missed_at, id`);
      return rows;
    });
  }

  beforeAll(async () => {
    await runMigrations();
    for (const k of ["BETTER_AUTH_URL"]) SAVED_ENV[k] = process.env[k];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 180_000);

  beforeEach(async () => {
    // The sweep walks every clinic, and ops_alerts is shared: each test starts clean.
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
    await getMigratorPool().query(`delete from ops_alerts`);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closePools();
  });

  describe("fault → L17 → incident → recovery → L18", () => {
    const T0 = new Date("2026-10-15T14:00:00Z");
    const t = (ms: number) => new Date(T0.getTime() + ms);

    test("the incident opens with L17 and an alert once, takes later failures in, survives a flap, and closes with L18 once, with its counts", async () => {
      const c = await liveClinic("wf-outage");
      await resolve(c.clinicId, key("ok", T0), { outcome: "answered", answeredAt: T0 });
      await resolve(c.clinicId, key("f1", t(MINUTE)), { outcome: "missed", reason: "start_failed", wentTo: "direct_line" });
      await resolve(c.clinicId, key("f2", t(5 * MINUTE), "web"), { outcome: "missed", reason: "error" });
      // Five minutes of failure is not ten.
      await runAnswerNoticesSweep(t(6 * MINUTE));
      expect(await outages(c.clinicId)).toEqual([]);
      await resolve(c.clinicId, key("f3", t(11 * MINUTE)), { outcome: "missed", reason: "no_opening" });

      for (const at of [t(12 * MINUTE), t(13 * MINUTE)]) await runAnswerNoticesSweep(at);
      const [incident] = await outages(c.clinicId);
      expect(incident).toMatchObject({ status: "open", started_at: t(MINUTE), channels: ["voice", "web"] });
      const started = await notices(c.clinicId, ["outage_started"]);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        dedupe_key: `outage_started:${incident!.id}`,
        payload: {
          startedAt: t(MINUTE).toISOString(),
          homeUrl: `https://app.healdesk.test/c/${c.slug}`,
          canReachDirectLine: true,
          isChatAffected: true,
        },
      });
      expect(Object.keys(started[0]!.payload).sort()).toEqual(["canReachDirectLine", "homeUrl", "isChatAffected", "startedAt"]);
      assertPayloadAllowed(started[0]!.payload, "outage_started");
      expect(await alerts("aya_outage_started", c.clinicId)).toEqual([
        expect.objectContaining({ clinicId: c.clinicId, eventId: incident!.id, windowStart: t(MINUTE).toISOString(), code: "voice_web" }),
      ]);

      // She answers, then fails again inside the quiet time: still open.
      await resolve(c.clinicId, key("a1", t(20 * MINUTE)), { outcome: "answered", answeredAt: t(20 * MINUTE) });
      await runAnswerNoticesSweep(t(25 * MINUTE));
      await resolve(c.clinicId, key("f4", t(27 * MINUTE)), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("a2", t(28 * MINUTE), "web"), { outcome: "answered", answeredAt: t(28 * MINUTE + 3_000) });
      await runAnswerNoticesSweep(t(28 * MINUTE + RECOVERY_QUIET_MS - MINUTE));
      expect((await outages(c.clinicId))[0]).toMatchObject({ status: "open" });
      expect(await notices(c.clinicId, ["outage_ended"])).toEqual([]);

      // Ten quiet minutes after the answer that followed the last failure.
      for (const at of [t(28 * MINUTE + RECOVERY_QUIET_MS), t(28 * MINUTE + RECOVERY_QUIET_MS + MINUTE)]) await runAnswerNoticesSweep(at);
      expect((await outages(c.clinicId))[0]).toMatchObject({
        status: "closed",
        ended_at: t(28 * MINUTE + 3_000),
        // Of the three failed calls only f1 rang through to the direct line.
        call_count: 1,
        chat_count: 1,
      });
      const ended = await notices(c.clinicId, ["outage_ended"]);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({
        dedupe_key: `outage_ended:${incident!.id}`,
        payload: {
          endedAt: t(28 * MINUTE + 3_000).toISOString(),
          callCount: 1,
          chatCount: 1,
          homeUrl: `https://app.healdesk.test/c/${c.slug}`,
          missedUrl: `https://app.healdesk.test/c/${c.slug}/missed`,
        },
      });
      assertPayloadAllowed(ended[0]!.payload, "outage_ended");
      // A closed incident is final.
      await expect(
        inTenant(c.clinicId, (q) => q.query(`update answer_outages set status = 'open', ended_at = null, call_count = null, chat_count = null`)),
      ).rejects.toThrow(/is closed/);
    });

    test("an incident that stays open is escalated at its reply-by, then every twelve hours; no L18 without an L17", async () => {
      const c = await liveClinic("wf-stuck");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      const opened = t(11 * MINUTE).getTime();
      await runAnswerNoticesSweep(new Date(opened + OUTAGE_ESCALATE_AFTER_MS - MINUTE));
      expect(await alerts("aya_outage_unresolved", c.clinicId)).toEqual([]);
      for (const at of [opened + OUTAGE_ESCALATE_AFTER_MS, opened + OUTAGE_ESCALATE_AFTER_MS + MINUTE]) {
        await runAnswerNoticesSweep(new Date(at));
      }
      expect(await alerts("aya_outage_unresolved", c.clinicId)).toEqual([expect.objectContaining({ count: 1 })]);
      await runAnswerNoticesSweep(new Date(opened + OUTAGE_ESCALATE_AFTER_MS + OUTAGE_ESCALATE_EVERY_MS));
      // Raised again: twelve hours apart in production, past the alert's
      // one-hour dedupe; here, inside the same real hour, it shows as a repeat.
      const { rows: raised } = await getMigratorPool().query<{ repeats: number }>(
        `select repeats from ops_alerts where event = 'aya_outage_unresolved' and fields->>'clinicId' = $1`,
        [c.clinicId],
      );
      expect(raised.map((r) => r.repeats)).toEqual([1]);
      expect((await outages(c.clinicId))[0]).toMatchObject({ status: "open", escalations: 2 });

      // A blip that ended inside ten minutes, at another clinic: no incident, so no L17 and no L18.
      const blip = await liveClinic("wf-blip");
      await resolve(blip.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(blip.clinicId, key("ok", t(4 * MINUTE)), { outcome: "answered", answeredAt: t(4 * MINUTE) });
      await runAnswerNoticesSweep(t(40 * MINUTE));
      expect(await outages(blip.clinicId)).toEqual([]);
      expect(await notices(blip.clinicId, ["outage_started", "outage_ended"])).toEqual([]);
    });

    test("an L17 whose send fails is retried by the outbox, then sent", async () => {
      const c = await liveClinic("wf-retry");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      const [notice] = await notices(c.clinicId, ["outage_started"]);
      const failing: EmailTransport = {
        name: "down",
        async send(): Promise<DeliveryResult> {
          return { status: "failed", reason: "unavailable", statusCode: 503 };
        },
      };
      const sent: string[] = [];
      const working: EmailTransport = {
        name: "capture",
        async send(_to, message): Promise<DeliveryResult> {
          sent.push(message.subject);
          return { status: "sent", messageId: `m-${sent.length}` };
        },
      };
      const due = new Date(Date.now() + MINUTE);
      expect(await deliverNotice(c.clinicId, notice!.id, { now: due, transport: failing })).toBe("retrying");
      expect(await deliverNotice(c.clinicId, notice!.id, { now: new Date(due.getTime() + DAY), transport: working })).toBe("sent");
      expect(sent).toHaveLength(1);
    });
  });

  describe("the final review's fixes: when an outage is one, and what it says", () => {
    const T0 = new Date("2026-10-16T13:02:00Z");
    const t = (ms: number) => new Date(T0.getTime() + ms);

    test("two failures hours apart, with no answer between, are no outage", async () => {
      const c = await liveClinic("fx-apart");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(5 * HOUR)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(5 * HOUR + MINUTE));
      expect(await outages(c.clinicId)).toEqual([]);
      expect(await notices(c.clinicId, ["outage_started"])).toEqual([]);
      // A continuous run after them still is one, dated from its own start.
      await resolve(c.clinicId, key("f3", t(5 * HOUR + 6 * MINUTE)), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f4", t(5 * HOUR + 12 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(5 * HOUR + 13 * MINUTE));
      expect(await outages(c.clinicId)).toMatchObject([{ status: "open", started_at: t(5 * HOUR) }]);
    });

    test("the run rule: each failure within ten minutes of the one before, lasting ten minutes", () => {
      const at = (...minutes: number[]) => minutes.map((m) => t(m * MINUTE));
      expect(outageRunStart(at(0))).toBeNull();
      expect(outageRunStart(at(0, 300))).toBeNull();
      expect(outageRunStart(at(0, 9))).toBeNull();
      expect(outageRunStart(at(0, 10))).toBe(0);
      expect(outageRunStart(at(0, 5, 11))).toBe(0);
      expect(outageRunStart(at(0, 11, 15, 21))).toBe(1);
      expect(outageRunStart(at(0, 11, 22))).toBeNull();
    });

    test("only failed calls say calls ring through to the direct line, and L18 counts only calls that reached it", async () => {
      const web = await liveClinic("fx-web-only");
      await resolve(web.clinicId, key("w1", T0, "web"), { outcome: "missed", reason: "error", wentTo: "contact_form" });
      await resolve(web.clinicId, key("w2", t(10 * MINUTE), "web"), { outcome: "missed", reason: "error", wentTo: "contact_form" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      expect((await notices(web.clinicId, ["outage_started"]))[0]).toMatchObject({
        payload: { canReachDirectLine: false, isChatAffected: true },
      });

      const calls = await liveClinic("fx-calls");
      await resolve(calls.clinicId, key("c1", T0), { outcome: "missed", reason: "start_failed", wentTo: "direct_line" });
      await resolve(calls.clinicId, key("c2", t(5 * MINUTE)), { outcome: "missed", reason: "error" });
      await resolve(calls.clinicId, key("c3", t(10 * MINUTE)), { outcome: "missed", reason: "no_opening", wentTo: "direct_line" });
      await resolve(calls.clinicId, key("m1", t(11 * MINUTE), "web"), { outcome: "missed", reason: "error", wentTo: "contact_form" });
      await runAnswerNoticesSweep(t(12 * MINUTE));
      expect((await notices(calls.clinicId, ["outage_started"]))[0]).toMatchObject({ payload: { canReachDirectLine: true } });
      await resolve(calls.clinicId, key("ok", t(20 * MINUTE)), { outcome: "answered", answeredAt: t(20 * MINUTE) });
      await runAnswerNoticesSweep(t(20 * MINUTE + RECOVERY_QUIET_MS));
      // Three failed calls, two put through to the direct line; one chat.
      expect((await notices(calls.clinicId, ["outage_ended"]))[0]).toMatchObject({ payload: { callCount: 2, chatCount: 1 } });
    });

    test("a clinic with no usable direct line is never told calls ring through to it", async () => {
      const c = await seedClinic("fx-no-line");
      await seedChannels(c.clinicId, [{ channel: "voice", readyAt: LIVE_SINCE, liveAt: LIVE_SINCE }]);
      await resolve(c.clinicId, key("c1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("c2", t(10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      expect((await notices(c.clinicId, ["outage_started"]))[0]).toMatchObject({ payload: { canReachDirectLine: false } });
    });

    test("recovery waits for a call still pending inside the quiet time", async () => {
      const c = await liveClinic("fx-pending");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      await resolve(c.clinicId, key("ok", t(12 * MINUTE)), { outcome: "answered", answeredAt: t(12 * MINUTE) });
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordRouted(tx.db, tx.clinicId, key("p1", t(15 * MINUTE))));
      await runAnswerNoticesSweep(t(12 * MINUTE + RECOVERY_QUIET_MS));
      expect((await outages(c.clinicId))[0]).toMatchObject({ status: "open" });
      expect(await notices(c.clinicId, ["outage_ended"])).toEqual([]);
      // It was answered after all: now the incident closes.
      await resolve(c.clinicId, key("p1", t(15 * MINUTE)), { outcome: "answered", answeredAt: t(15 * MINUTE) });
      await runAnswerNoticesSweep(t(12 * MINUTE + RECOVERY_QUIET_MS + MINUTE));
      expect((await outages(c.clinicId))[0]).toMatchObject({ status: "closed", ended_at: t(12 * MINUTE) });
      expect(await notices(c.clinicId, ["outage_ended"])).toHaveLength(1);
    });

    test("flapping: an outage within the hour of the last closing sends no L17 and no L18, and ops is told once", async () => {
      const c = await liveClinic("fx-flap");
      await resolve(c.clinicId, key("f1", T0), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("f2", t(10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(11 * MINUTE));
      await resolve(c.clinicId, key("ok1", t(12 * MINUTE)), { outcome: "answered", answeredAt: t(12 * MINUTE) });
      await runAnswerNoticesSweep(t(22 * MINUTE));
      expect(await outages(c.clinicId)).toMatchObject([{ status: "closed" }]);
      expect(await notices(c.clinicId, ["outage_started", "outage_ended"])).toHaveLength(2);

      // Failing again from 30 minutes, under an hour after it closed at 22.
      await resolve(c.clinicId, key("g1", t(30 * MINUTE)), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("g2", t(40 * MINUTE)), { outcome: "missed", reason: "error" });
      for (const at of [t(41 * MINUTE), t(42 * MINUTE)]) await runAnswerNoticesSweep(at);
      const [, second] = await outages(c.clinicId);
      expect(second).toMatchObject({ status: "open", started_at: t(30 * MINUTE) });
      expect(await notices(c.clinicId, ["outage_started"])).toHaveLength(1);
      expect(await alerts("aya_outage_flapping", c.clinicId)).toEqual([expect.objectContaining({ clinicId: c.clinicId })]);
      expect(await alerts("aya_outage_started", c.clinicId)).toHaveLength(1);

      await resolve(c.clinicId, key("ok2", t(45 * MINUTE)), { outcome: "answered", answeredAt: t(45 * MINUTE) });
      await runAnswerNoticesSweep(t(45 * MINUTE + RECOVERY_QUIET_MS));
      expect((await outages(c.clinicId))[1]).toMatchObject({ status: "closed" });
      expect(await notices(c.clinicId, ["outage_ended"])).toHaveLength(1);

      // Past the hour, an outage is told again.
      await resolve(c.clinicId, key("h1", t(3 * HOUR)), { outcome: "missed", reason: "error" });
      await resolve(c.clinicId, key("h2", t(3 * HOUR + 10 * MINUTE)), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(t(3 * HOUR + 11 * MINUTE));
      expect(await notices(c.clinicId, ["outage_started"])).toHaveLength(2);
    });

    test("a conversation's later failure is dated when it failed, and its earlier answer still counts", async () => {
      const c = await liveClinic("fx-meta", ["voice", "web", "meta"]);
      const nine = new Date("2026-10-16T13:00:00Z");
      await resolve(c.clinicId, key("other-a", new Date(nine.getTime() - 5 * MINUTE), "meta"), { outcome: "missed", reason: "error" });
      // The thread's first message, answered at 09:00 New York.
      await resolve(c.clinicId, key("thread", nine, "meta"), { outcome: "answered", answeredAt: nine });
      await resolve(c.clinicId, key("other-b", new Date(nine.getTime() + 6 * MINUTE), "meta"), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(new Date(nine.getTime() + 7 * MINUTE));
      // A later message of the same thread fails at 14:00 New York.
      const two = new Date("2026-10-16T18:00:00Z");
      await resolve(c.clinicId, key("thread", two, "meta"), { outcome: "missed", reason: "failure_line", wentTo: "nowhere" });
      await runAnswerNoticesSweep(new Date(two.getTime() + MINUTE));
      // Neither 08:55 to 09:06 (answered between) nor 09:06 to 14:00 (hours apart) is an outage.
      expect(await outages(c.clinicId)).toEqual([]);
      const row = await inTenant(c.clinicId, async (q) =>
        (
          await q.query<{ routed_at: Date; failed_at: Date; answered_at: Date; outcome: string }>(
            `select routed_at, failed_at, answered_at, outcome from routed_interactions where channel = 'meta' and answered_at is not null`,
          )
        ).rows,
      );
      expect(row).toEqual([{ routed_at: nine, failed_at: two, answered_at: nine, outcome: "missed" }]);
      const thread = (await missed(c.clinicId)).find((m) => m.missed_at.getTime() === two.getTime());
      expect(thread).toMatchObject({ channel: "meta", outcome: "nowhere" });
      // A second failure ten minutes on makes it an outage dated 14:00, not 09:00.
      await resolve(c.clinicId, key("other-c", new Date(two.getTime() + 10 * MINUTE), "meta"), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(new Date(two.getTime() + 11 * MINUTE));
      expect(await outages(c.clinicId)).toMatchObject([{ status: "open", started_at: two }]);
      expect((await notices(c.clinicId, ["outage_started"]))[0]).toMatchObject({ payload: { startedAt: two.toISOString() } });
      // The miss is a time a guard cannot change.
      await expect(
        inTenant(c.clinicId, (q) => q.query(`update routed_interactions set failed_at = now() where failed_at is not null`)),
      ).rejects.toThrow(/written once/);
    });

    test("L21 dates a thread's miss by the day it failed, not the day it began", async () => {
      const c = await liveClinic("fx-meta-day", ["voice", "web", "meta"]);
      // Begun 23:30 on Wednesday 7 October in New York, failed 00:30 on Thursday 8.
      const begun = new Date("2026-10-08T03:30:00Z");
      const failed = new Date("2026-10-08T04:30:00Z");
      await resolve(c.clinicId, key("late-thread", begun, "meta"), { outcome: "answered", answeredAt: begun });
      await resolve(c.clinicId, key("late-thread", failed, "meta"), { outcome: "missed", reason: "error" });
      await runAnswerNoticesSweep(new Date("2026-10-09T04:30:00Z"));
      const l21 = await notices(c.clinicId, ["guarantee_miss"]);
      expect(l21).toHaveLength(1);
      expect(l21[0]).toMatchObject({ payload: { channel: "meta", missedAt: failed.toISOString() } });
      const cases = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async () => listAnswerCases(ACTOR));
      expect(cases.missCases).toMatchObject([{ channel: "meta", missedOn: "2026-10-08" }]);
    });
  });

  describe("the sweep that keeps failing is told to ops", () => {
    const failing = async () => {
      const { rows } = await getMigratorPool().query<{ repeats: number; fields: Record<string, unknown> }>(
        `select repeats, fields from ops_alerts where event = 'answer_notices_failing'`,
      );
      return rows;
    };

    test(`after ${SWEEP_FAILING_AFTER_RUNS} failed runs in a row, once an hour while it goes on; an ok run starts the count again`, async () => {
      resetSweepFailures();
      for (let i = 1; i < SWEEP_FAILING_AFTER_RUNS; i += 1) expect(await noteSweepOutcome("failed")).toBe(false);
      expect(await failing()).toEqual([]);
      expect(await noteSweepOutcome("failed")).toBe(true);
      expect(await failing()).toEqual([expect.objectContaining({ repeats: 0, fields: expect.objectContaining({ count: SWEEP_FAILING_AFTER_RUNS }) })]);
      // The next failed minute is the same alert inside its hour: a repeat, no second email.
      await noteSweepOutcome("failed");
      expect((await failing()).map((r) => r.repeats)).toEqual([1]);
      // An ok run resets: four more failures raise nothing.
      expect(await noteSweepOutcome("ok")).toBe(false);
      for (let i = 1; i < SWEEP_FAILING_AFTER_RUNS; i += 1) expect(await noteSweepOutcome("failed")).toBe(false);
      expect((await failing()).map((r) => r.repeats)).toEqual([1]);
      resetSweepFailures();
    });
  });

  describe("a corrected number reaches the missed-contact record", () => {
    test("amending a contact's number corrects it on its missed calls, and clearing it clears them", async () => {
      const c = await liveClinic("fx-amend");
      const now = new Date("2026-10-15T15:00:00Z");
      const contactId = await seedContact(c.clinicId, CALLER);
      await resolve(c.clinicId, key("m1", now), { outcome: "missed", reason: "error", callerPhone: CALLER });
      await resolve(c.clinicId, key("m2", new Date(now.getTime() + MINUTE)), { outcome: "missed", reason: "error", callerPhone: "+14155550188" });
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => amendContact(tx, contactId, { phone: "+14155550199" }, "practice"));
      expect((await missed(c.clinicId)).map((m) => m.caller_phone)).toEqual(["+14155550199", "+14155550188"]);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => amendContact(tx, contactId, { phone: null }, "practice"));
      expect((await missed(c.clinicId)).map((m) => m.caller_phone)).toEqual([null, "+14155550188"]);
    });
  });

  describe("miss → missed contact → L21 → miss case → reply", () => {
    test("a day's misses on a channel are one case and one email, after the day, once; the reply joins one support case; the closing note reaches the missed contacts", async () => {
      const c = await liveClinic("wf-miss");
      // Wednesday 7 October in New York: three missed calls, one with the
      // caller's number, put through to the direct line; one answered.
      await resolve(c.clinicId, key("c1", new Date("2026-10-07T13:00:00Z")), {
        outcome: "missed",
        reason: "start_failed",
        wentTo: "direct_line",
        callerPhone: CALLER,
      });
      await resolve(c.clinicId, key("c2", new Date("2026-10-07T15:00:00Z")), { outcome: "missed", reason: "no_opening" });
      await resolve(c.clinicId, key("c3", new Date("2026-10-07T16:00:00Z")), { outcome: "missed", reason: "cut_off", wentTo: "direct_line" });
      await resolve(c.clinicId, key("ok", new Date("2026-10-07T17:00:00Z")), { outcome: "answered", answeredAt: new Date("2026-10-07T17:00:02Z") });
      // A call left pending, settled by the sweep as missed, where it went unknown.
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => recordRouted(tx.db, tx.clinicId, key("c4", new Date("2026-10-07T18:00:00Z"))));

      await runAnswerNoticesSweep(new Date("2026-10-07T23:00:00Z"));
      const rows = await missed(c.clinicId);
      expect(rows.map((r) => [r.outcome, r.reached_direct_line, r.caller_phone])).toEqual([
        ["direct_line", true, CALLER],
        ["nowhere", false, null],
        ["direct_line", true, null],
        ["unknown", false, null],
      ]);
      // The day has not ended: nothing yet.
      expect(await notices(c.clinicId, ["guarantee_miss"])).toEqual([]);

      for (const at of ["2026-10-08T04:20:00Z", "2026-10-08T04:21:00Z"]) await runAnswerNoticesSweep(new Date(at));
      const l21 = await notices(c.clinicId, ["guarantee_miss"]);
      expect(l21).toHaveLength(1);
      const cases = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async () => listAnswerCases(ACTOR));
      expect(cases.missCases).toHaveLength(1);
      const missCase = cases.missCases[0]!;
      expect(missCase).toMatchObject({ channel: "voice", missedOn: "2026-10-07", missCount: 4, status: "open", replied: false });
      expect(l21[0]).toMatchObject({
        dedupe_key: `guarantee_miss:${missCase.caseId}`,
        payload: {
          channel: "voice",
          missedAt: "2026-10-07T13:00:00.000Z",
          wasRoutedToDirectLine: true,
          missedUrl: `https://app.healdesk.test/c/${c.slug}/missed/${rows[0]!.id}`,
        },
      });
      expect(Object.keys(l21[0]!.payload).sort()).toEqual(["channel", "missedAt", "missedUrl", "wasRoutedToDirectLine"]);
      assertPayloadAllowed(l21[0]!.payload, "guarantee_miss");
      expect((await missed(c.clinicId)).every((r) => r.miss_case_id === missCase.caseId)).toBe(true);
      expect(await alerts("aya_miss_case_opened", c.clinicId)).toEqual([
        expect.objectContaining({ clinicId: c.clinicId, channel: "voice", eventId: missCase.caseId, count: 4 }),
      ]);

      // The clinic's reply opened a support case; it joins the miss once.
      const { rows: support } = await getMigratorPool().query<{ id: string }>(
        `insert into support_cases (ref, subject_clinic_id, source, category, symptom, urgency, reply_by_on)
         values ('MXS12', $1, 'email', 'other', 'other', 'this_week', '2026-10-09') returning id`,
        [c.clinicId],
      );
      const subject = "Re: Looking into a call from Wednesday 7 October";
      const at = new Date("2026-10-08T15:00:00Z");
      expect(await linkMissCaseReply(c.clinicId, subject, support[0]!.id, at)).toBe(1);
      expect(await linkMissCaseReply(c.clinicId, subject, randomUUID(), at)).toBe(0);
      // A second reply to the same email finds the same support case.
      expect(await supportCaseIdForMissReply(c.clinicId, subject, at)).toBe(support[0]!.id);
      expect(await supportCaseIdForMissReply(c.clinicId, "Re: something else", at)).toBeNull();

      // Explained, with the closing note the clinic reads beside each missed call.
      expect(await setMissCaseStatus(c.clinicId, missCase.caseId, "explained", ACTOR, { note: "ops@x.test" })).toEqual({ status: "bad_note" });
      expect(await setMissCaseStatus(c.clinicId, missCase.caseId, "looking", ACTOR)).toEqual({ status: "moved" });
      expect(
        await setMissCaseStatus(c.clinicId, missCase.caseId, "explained", ACTOR, { note: "Our phone supplier failed that afternoon. It is fixed." }),
      ).toEqual({ status: "moved" });
      expect((await missed(c.clinicId)).every((r) => r.closing_note === "Our phone supplier failed that afternoon. It is fixed.")).toBe(true);
      expect(await setMissCaseStatus(c.clinicId, missCase.caseId, "closed", ACTOR)).toEqual({ status: "moved" });
      expect(await setMissCaseStatus(c.clinicId, missCase.caseId, "open", ACTOR)).toEqual({ status: "closed" });
    });

    test("one missed contact per call, none for an answer or a late answer, and Home's counts", async () => {
      const c = await liveClinic("wf-contacts");
      const now = new Date("2026-10-15T15:00:00Z");
      const k = key("call-1", now);
      const miss: RoutedResolution = { outcome: "missed", reason: "error", wentTo: "nowhere", callerPhone: CALLER };
      await Promise.all([resolve(c.clinicId, k, miss), resolve(c.clinicId, k, miss), resolve(c.clinicId, k, miss)]);
      await resolve(c.clinicId, key("call-2", now), { outcome: "answered", answeredAt: now });
      await resolve(c.clinicId, key("call-3", now), { outcome: "missed", reason: "late", answeredAt: new Date(now.getTime() + 12_000) });
      await resolve(c.clinicId, key("call-4", now), { outcome: "missed", reason: "error", callerPhone: "not a number" });
      // Both at the same moment, so in no particular order.
      expect((await missed(c.clinicId)).map((r) => r.caller_phone ?? "none").sort()).toEqual([CALLER, "none"].sort());
      expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readAnswerAttention(tx, now))).toEqual({
        outageOpen: false,
        notCalledBack: 2,
      });
      // Called back: the count drops.
      await inTenant(c.clinicId, (q) => q.query(`update missed_contacts set called_back_at = now() where caller_phone = $1`, [CALLER]));
      expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readAnswerAttention(tx, now))).toEqual({
        outageOpen: false,
        notCalledBack: 1,
      });
    });

    test("the record is kept 30 days and no more, and a person's erasure takes theirs by number", async () => {
      const c = await liveClinic("wf-retention");
      const now = new Date("2026-10-20T15:00:00Z");
      await resolve(c.clinicId, key("old", new Date(now.getTime() - 30 * DAY - MINUTE)), { outcome: "missed", reason: "error", callerPhone: CALLER });
      await resolve(c.clinicId, key("young", new Date(now.getTime() - 30 * DAY + MINUTE)), { outcome: "missed", reason: "error", callerPhone: CALLER });
      await resolve(c.clinicId, key("other", new Date(now.getTime() - DAY)), { outcome: "missed", reason: "error", callerPhone: "+14155550188" });
      const r = await runAnswerNoticesSweep(now);
      expect(r.missedContactsDeleted).toBe(1);
      expect((await missed(c.clinicId)).length).toBe(2);
      // The counter row stays: it holds no number.
      const counted = await inTenant(c.clinicId, async (q) => (await q.query(`select 1 from routed_interactions`)).rows.length);
      expect(counted).toBe(3);

      const erased = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { phone: CALLER, requestedBy: "practice" }));
      expect(erased.deleted).toMatchObject({ missedContacts: 1 });
      expect((await missed(c.clinicId)).map((m) => m.caller_phone)).toEqual(["+14155550188"]);
    });

    test("a pending row past its grace becomes a missed contact whose outcome is unknown", async () => {
      const c = await liveClinic("wf-pending");
      const now = new Date("2026-10-15T15:00:00Z");
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        recordRouted(tx.db, tx.clinicId, key("stale", new Date(now.getTime() - ROUTED_PENDING_GRACE_MS - MINUTE), "meta")),
      );
      await runAnswerNoticesSweep(now);
      await runAnswerNoticesSweep(new Date(now.getTime() + MINUTE));
      expect((await missed(c.clinicId)).map((m) => [m.channel, m.outcome])).toEqual([["meta", "unknown"]]);
    });
  });
});
