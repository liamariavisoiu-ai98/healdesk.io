import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { moveSetupDeadline } from "@/lib/clinic/setup-window";
import { watchLifecycles } from "@/lib/lifecycle/watch";
import { collectDigest, sendOpsDigest } from "@/lib/ops/digest";
import { runOperation, type Operator } from "@/lib/ops/api";
import { queueSetupReminder } from "@/lib/setup/reminders";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedDemoClinic } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The lifecycle watch against the database (design E2, steps 3, 4 and 7;
 * owner decisions D4 to D7): the stage row, the reminder ledger that records
 * the setup-reminders job's six reminders without sending or changing one,
 * the ops waves (Slack alone, or Slack and the ops address for an
 * escalation), the snooze, the decision, the console's operations and the
 * digest's Lifecycle block. Resend is stubbed at the SDK; the clock is the
 * test's.
 */

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;
// Noon in New York, where these clinics are.
const NOON = new Date("2026-10-20T16:00:00Z");
const ENV = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_OPS_EMAIL",
  "BETTER_AUTH_URL",
  "HEALDESK_APP_URL",
  "HEALDESK_CONSOLE_ORIGIN",
  "HEALDESK_CALL_BOOKING_URL",
  "SLACK_WEBHOOK_URL",
] as const;
const SAVED: Record<string, string | undefined> = {};
let keys = 0;

/**
 * The deadline that makes `at` (noon in New York) fall on window day `day`:
 * just past the end of the window's last day there, in summer time or winter.
 */
const deadlineFor = (day: number, at: Date = NOON) =>
  new Date(at.getTime() + (31 - day) * DAY - 11 * HOUR);

/** One statement in the clinic's tenant: its tables are forced under row-level security. */
async function asTenant(c: PortalClinic, text: string, values: unknown[] = []): Promise<void> {
  await inTenant(c.clinicId, (q) => q.query(text, values));
}

/** Resend's word on a notice: sent at `at`, and what its webhook later said. */
async function delivered(
  c: PortalClinic,
  noticeId: string,
  at: Date,
  status: string | null,
  messageId = "msg",
): Promise<void> {
  await asTenant(c, `update billing_notices set sent_at = $2 where id = $1`, [noticeId, at]);
  await asTenant(
    c,
    `insert into report_deliveries (clinic_id, kind, period_key, recipient, status, message_id, sent_at, delivery_status, delivery_at)
     values ($1, 'setup_reminder', $2, $3, 'sent', $4, $5, $6, $7)`,
    [c.clinicId, noticeId, c.email, messageId, at, status, status ? at : null],
  );
}

async function clinic(
  label: string,
  options: { day?: number; screens?: number } = {},
): Promise<PortalClinic> {
  const c = await provisionPortalClinic(`${label}-${randomUUID().slice(0, 4)}`, {
    plan: "voice-metachat-1000-1000",
  });
  // A paying clinic in setup, left `synthetic` as every real clinic is until
  // it goes live (app_mark_clinic_production): it has its Stripe customer and
  // subscription, so it is not healdesk's demo clinic (app_clinic_is_demo).
  await getMigratorPool().query(`update clinics set timezone = 'America/New_York' where id = $1`, [
    c.clinicId,
  ]);
  await asTenant(
    c,
    `update entitlements set stripe_customer_id = $2, stripe_subscription_id = $3 where clinic_id = $1`,
    [c.clinicId, `cus_test_${randomUUID().slice(0, 8)}`, `sub_test_${randomUUID().slice(0, 8)}`],
  );
  expect(
    (
      await getMigratorPool().query(`select data_classification from clinics where id = $1`, [
        c.clinicId,
      ])
    ).rows[0].data_classification,
  ).toBe("synthetic");
  await setDeadline(c, deadlineFor(options.day ?? 10));
  if (options.screens) await answerScreens(c, options.screens, new Date(NOON.getTime() - 8 * DAY));
  return c;
}

async function setDeadline(c: PortalClinic, at: Date): Promise<void> {
  await inTenant(c.clinicId, (q) =>
    q.query(
      `update entitlements set setup_deadline_at = $2, status = 'active' where clinic_id = $1`,
      [c.clinicId, at],
    ),
  );
}

/** Answer the first `n` setup screens at `at`. */
async function answerScreens(c: PortalClinic, n: number, at: Date): Promise<void> {
  await inTenant(c.clinicId, async (q) => {
    for (const screen of SETUP_SCREENS.slice(0, n)) {
      await q.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, 'skipped', $3, 'test') on conflict (clinic_id, screen) do nothing`,
        [c.clinicId, screen, at],
      );
    }
  });
}

async function lifecycleRow(c: PortalClinic) {
  return inTenant(
    c.clinicId,
    async (q) =>
      (await q.query(`select * from clinic_lifecycle where clinic_id = $1`, [c.clinicId])).rows[0]!,
  );
}

async function ledger(c: PortalClinic) {
  return inTenant(
    c.clinicId,
    async (q) =>
      (
        await q.query<{
          wave: string;
          target: string;
          stage: string;
          notice_id: string | null;
          ops_alert_id: string | null;
          escalated: boolean;
          delivery: string | null;
          error: string | null;
        }>(`select * from lifecycle_waves where clinic_id = $1 order by queued_at, target`, [
          c.clinicId,
        ])
      ).rows,
  );
}

async function notices(c: PortalClinic) {
  return inTenant(
    c.clinicId,
    async (q) =>
      (
        await q.query(
          `select id, kind, dedupe_key, payload, created_at, send_after, sent_at, attempts, last_error
             from billing_notices where clinic_id = $1 order by created_at, id`,
          [c.clinicId],
        )
      ).rows,
  );
}

async function alerts() {
  return (
    await getMigratorPool().query<{
      id: string;
      event: string;
      fields: Record<string, unknown>;
      sent_at: Date | null;
      last_error: string | null;
      slack_next_at: Date | null;
    }>(
      `select id, event, fields, sent_at, last_error, slack_next_at from ops_alerts order by raised_at, id`,
    )
  ).rows;
}

/** The emails handed to Resend, by recipient and subject. */
function mailed(): { to: unknown; subject: unknown }[] {
  return send.mock.calls.map((call) => ({
    to: (call[0] as Record<string, unknown>).to,
    subject: (call[0] as Record<string, unknown>).subject,
  }));
}

describeDb("the lifecycle watch, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    for (const key of ENV) SAVED[key] = process.env[key];
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = `re_stub_${keys++}`;
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_CONSOLE_ORIGIN = "https://healdesk.test";
    delete process.env.HEALDESK_APP_URL;
    delete process.env.HEALDESK_CALL_BOOKING_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    send.mockReset();
    send.mockResolvedValue({ data: { id: "msg_ops" }, error: null, headers: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  afterAll(async () => {
    await closePools();
  });

  test("records the six spec reminders with their delivery, sends and changes none, and a replay records nothing twice", async () => {
    const c = await clinic("six", { day: 30 });
    // The setup-reminders job's own six, on days 5 to 30.
    for (let n = 1; n <= 6; n += 1) {
      expect(
        await queueSetupReminder(c.clinicId, new Date(NOON.getTime() - (30 - 5 * n) * DAY)),
      ).toBe("queued");
    }
    const queued = await notices(c);
    expect(queued.map((n) => n.dedupe_key)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `setup_reminder:${n}`),
    );
    // What Resend later said of each: four delivered, one bounced, one sent and not yet heard of,
    // and the sixth's notice used every attempt.
    const statuses = ["delivered", "delivered", "bounced", "delivered", "delivered", null];
    for (const [i, notice] of queued.entries()) {
      if (i === 5)
        await asTenant(c, `update billing_notices set attempts = 6 where id = $1`, [notice.id]);
      else await delivered(c, notice.id as string, NOON, statuses[i] ?? null, `msg_${i}`);
    }
    const before = await notices(c);

    send.mockClear();
    const first = await watchLifecycles(NOON);
    expect(first).toMatchObject({ clinics: 1, recorded: 6, failures: 0 });
    // The watch wrote nothing to the outbox and changed nothing in it, and
    // mailed only the ops address, never the clinic.
    expect(await notices(c)).toEqual(before);
    expect(mailed().every((m) => m.to === "ops@healdesk.test")).toBe(true);
    // And the reminders job, run again, says what it would have said without it.
    expect(await queueSetupReminder(c.clinicId, NOON)).toBe("already_queued");
    expect(await notices(c)).toEqual(before);

    const rows = (await ledger(c)).filter((r) => r.target === "clinic_email");
    expect(rows.map((r) => [r.wave, r.target, r.notice_id])).toEqual(
      queued.map((n) => [n.dedupe_key, "clinic_email", n.id]),
    );
    const read = await runOperation("listLifecycleWaves", { clinicId: c.clinicId }, OPERATOR);
    const waves = (
      read.body as {
        data: {
          waves: { wave: string; target: string; outcome: string; providerId: string | null }[];
        };
      }
    ).data.waves.filter((w) => w.target === "clinic_email");
    expect(waves.map((w) => w.outcome)).toEqual([
      "delivered",
      "delivered",
      "bounced",
      "delivered",
      "delivered",
      "failed",
    ]);
    expect(waves[0]!.providerId).toBe("msg_0");

    // Day 30, nothing answered, two reminders arrived in a row with nothing
    // moving, and the last one failed after the last that arrived: one
    // escalation each, once.
    expect((await alerts()).map((a) => a.event).sort()).toEqual([
      "lifecycle_decision_due",
      "lifecycle_reminder_undelivered",
      "lifecycle_reminders_unanswered",
    ]);
    const recorded = (await ledger(c)).length;

    const again = await watchLifecycles(new Date(NOON.getTime() + HOUR));
    expect(again).toMatchObject({ recorded: 0, raised: 0 });
    expect(await ledger(c)).toHaveLength(recorded);
    expect((await ledger(c)).filter((r) => r.target === "clinic_email")).toHaveLength(6);
  }, 120_000);

  test("the stage row: first seen, moved on, and an extension recorded as the decision", async () => {
    const c = await clinic("stage", { day: 10 });
    await watchLifecycles(NOON);
    let row = await lifecycleRow(c);
    expect(row).toMatchObject({ stage: "not_started", decision: "none", last_progress_at: null });
    const firstSince = row.stage_since;

    await answerScreens(c, 2, new Date(NOON.getTime() + HOUR));
    await watchLifecycles(new Date(NOON.getTime() + 2 * HOUR));
    row = await lifecycleRow(c);
    expect(row.stage).toBe("in_setup");
    expect(row.stage_since).toEqual(new Date(NOON.getTime() + 2 * HOUR));
    expect(row.stage_since).not.toEqual(firstSince);
    expect(row.last_progress_at).toEqual(new Date(NOON.getTime() + HOUR));
    expect(row.steps_left).toBeGreaterThan(0);

    // A time-zone correction moves the deadline's instant and keeps its last
    // day (moveSetupDeadline): not an extension.
    await getMigratorPool().query(
      `update clinics set timezone = 'America/Los_Angeles' where id = $1`,
      [c.clinicId],
    );
    await setDeadline(
      c,
      moveSetupDeadline(deadlineFor(10), "America/New_York", "America/Los_Angeles"),
    );
    await watchLifecycles(new Date(NOON.getTime() + 150 * 60_000));
    expect((await lifecycleRow(c)).decision).toBe("none");

    // extendSetupDeadline moved the last day later: the watch records the decision, never the move.
    await setDeadline(
      c,
      new Date(
        moveSetupDeadline(deadlineFor(10), "America/New_York", "America/Los_Angeles").getTime() +
          7 * DAY,
      ),
    );
    await watchLifecycles(new Date(NOON.getTime() + 3 * HOUR));
    row = await lifecycleRow(c);
    expect(row).toMatchObject({ decision: "extended", decided_by: "setup deadline extended" });
  }, 120_000);

  test("routine waves are Slack alone; an escalation is Slack and the ops address, once, replay or not (D5)", async () => {
    // Day 7, no progress for eight days: Slack only.
    const quiet = await clinic("quiet", { day: 7, screens: 1 });
    // Day 22 with two steps and more left: the decision, escalated (D7).
    const stalled = await clinic("stalled", { day: 22, screens: 1 });

    send.mockClear();
    const result = await watchLifecycles(NOON);
    expect(result).toMatchObject({ raised: 2, deferred: 0, failures: 0 });

    const raised = await alerts();
    expect(raised.map((a) => a.event).sort()).toEqual([
      "lifecycle_decision_due",
      "lifecycle_no_progress",
    ]);
    const routine = raised.find((a) => a.event === "lifecycle_no_progress")!;
    const escalation = raised.find((a) => a.event === "lifecycle_decision_due")!;
    // The routine one is not emailed and not counted as unsent: Slack posts it.
    expect(routine).toMatchObject({ sent_at: null, last_error: null });
    expect(routine.fields).toMatchObject({ clinicId: quiet.clinicId, setupDays: 7 });
    expect(escalation.sent_at).not.toBeNull();
    expect(escalation.fields).toMatchObject({
      clinicId: stalled.clinicId,
      remainingDays: 8,
      decision: "none",
      recommendation: expect.any(String),
    });
    expect(mailed()).toEqual([
      { to: "ops@healdesk.test", subject: expect.stringContaining("A stalled setup closes soon") },
    ]);

    expect((await ledger(quiet)).map((r) => [r.wave, r.target, r.escalated])).toEqual([
      ["day_7", "slack", false],
    ]);
    const stalledRows = await ledger(stalled);
    expect(stalledRows.map((r) => [r.target, r.escalated, r.ops_alert_id])).toEqual([
      ["ops_email", true, escalation.id],
      ["slack", true, escalation.id],
    ]);

    // Replay: same hour, next hour. Nothing raised, recorded or mailed twice.
    await watchLifecycles(NOON);
    await watchLifecycles(new Date(NOON.getTime() + HOUR));
    expect(await alerts()).toHaveLength(2);
    expect(await ledger(stalled)).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);

    // Even a ledger row lost after its alert was raised is recorded against the same alert.
    await asTenant(stalled, `delete from lifecycle_waves where clinic_id = $1`, [stalled.clinicId]);
    await watchLifecycles(new Date(NOON.getTime() + 2 * HOUR));
    expect(await alerts()).toHaveLength(2);
    expect((await ledger(stalled)).map((r) => r.ops_alert_id)).toEqual([
      escalation.id,
      escalation.id,
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  }, 120_000);

  test("a snooze mutes the routine waves and never an escalation or the clinic's own reminder", async () => {
    const stalled = await clinic("snooze", { day: 22, screens: 1 });
    const quiet = await clinic("snooze7", { day: 7, screens: 1 });
    await watchLifecycles(new Date(NOON.getTime() - 15 * DAY)); // the watch has seen both
    await getMigratorPool().query(`truncate ops_alerts`);
    send.mockClear();
    expect(
      (await runOperation("snoozeLifecycle", { clinicId: stalled.clinicId, days: 5 }, OPERATOR))
        .status,
    ).toBe(400);
    for (const c of [stalled, quiet]) {
      expect(
        (await runOperation("snoozeLifecycle", { clinicId: c.clinicId, days: 7 }, OPERATOR)).status,
      ).toBe(200);
    }

    await watchLifecycles(NOON);
    // The stalled clinic's day-22 decision is an escalation: it still goes, to Slack and the ops address.
    expect((await alerts()).map((a) => [a.event, a.fields.clinicId])).toEqual([
      ["lifecycle_decision_due", stalled.clinicId],
    ]);
    expect(mailed()).toEqual([
      { to: "ops@healdesk.test", subject: expect.stringContaining("A stalled setup") },
    ]);
    expect(
      (await ledger(stalled))
        .filter((r) => r.wave.startsWith("day_22"))
        .map((r) => [r.target, r.delivery]),
    ).toEqual([
      ["ops_email", null],
      ["slack", null],
    ]);
    // The quiet clinic's day-7 note is routine: recorded as skipped, never raised.
    expect((await ledger(quiet)).map((r) => [r.wave, r.target, r.delivery, r.error])).toEqual([
      ["day_7", "slack", "skipped", "snoozed"],
    ]);
    // The clinic's spec reminder (day 20's) still goes.
    expect(await queueSetupReminder(stalled.clinicId, NOON)).toBe("queued");

    // Its audit row and security event.
    const audit = await inTenant(stalled.clinicId, (q) =>
      q.query(
        `select resource_type from audit_log where clinic_id = $1 and resource_type = 'clinic_lifecycle'`,
        [stalled.clinicId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    const events = await getMigratorPool().query(
      `select event from security_events where event = 'lifecycle_snoozed'`,
    );
    expect(events.rows).toHaveLength(2);
  }, 120_000);

  test("Resend's word on a reminder: sent or delayed is not a failure; bounced, complained or suppressed is", async () => {
    const cases = ["sent", "delayed", "delivered", "bounced", "complained", "suppressed"] as const;
    const made: [string, PortalClinic][] = [];
    for (const status of cases) {
      const c = await clinic(`said-${status}`, { day: 6, screens: 1 });
      expect(await queueSetupReminder(c.clinicId, NOON)).toBe("queued");
      const [notice] = await notices(c);
      await delivered(c, notice!.id as string, NOON, status);
      made.push([status, c]);
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
    await watchLifecycles(NOON);
    const raised = (await alerts()).filter((a) => a.event === "lifecycle_reminder_undelivered");
    const listed = (
      (await runOperation("listLifecycle", {}, OPERATOR)).body as {
        data: {
          clinics: {
            clinicId: string;
            undeliveredCount: number;
            recommendation: { action: string };
          }[];
        };
      }
    ).data.clinics;
    for (const [status, c] of made) {
      const read = await runOperation("listLifecycleWaves", { clinicId: c.clinicId }, OPERATOR);
      const outcome = (
        read.body as { data: { waves: { target: string; outcome: string }[] } }
      ).data.waves.find((w) => w.target === "clinic_email")!.outcome;
      const failed = status === "bounced" || status === "complained" || status === "suppressed";
      expect([status, outcome]).toEqual([
        status,
        failed ? "bounced" : status === "delivered" ? "delivered" : "sent",
      ]);
      expect([status, raised.some((a) => a.fields.clinicId === c.clinicId)]).toEqual([
        status,
        failed,
      ]);
      const row = listed.find((r) => r.clinicId === c.clinicId)!;
      expect([
        status,
        row.undeliveredCount,
        row.recommendation.action === "phone_the_clinic",
      ]).toEqual([status, failed ? 1 : 0, failed]);
    }
  }, 180_000);

  test("healdesk's demo clinic is never watched: no stage, no ledger, no alert", async () => {
    const demo = await seedDemoClinic("lifecycle");
    const result = await watchLifecycles(NOON);
    expect(result).toMatchObject({ clinics: 0, raised: 0, failures: 0 });
    expect(await alerts()).toEqual([]);
    const rows = await inTenant(demo.clinicId, (q) =>
      q.query(`select 1 from clinic_lifecycle where clinic_id = $1`, [demo.clinicId]),
    );
    expect(rows.rows).toEqual([]);
  }, 120_000);

  test("a clinic waiting on us on day 27 is warned, escalated, with the days it waited as the extension", async () => {
    const c = await clinic("waiting", { day: 27 });
    // Every screen answered, and its channels still being prepared on our side.
    await answerScreens(c, SETUP_SCREENS.length, new Date(NOON.getTime() - 3 * DAY));
    await asTenant(
      c,
      `update clinic_channels set ready_at = null, live_at = null where clinic_id = $1`,
      [c.clinicId],
    );
    await watchLifecycles(NOON);
    expect((await lifecycleRow(c)).stage).toBe("waiting_on_us");
    const raised = (await alerts()).filter((a) => a.event === "lifecycle_closing_waiting_on_us");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.fields).toMatchObject({
      remainingDays: 3,
      recommendation: "extend",
      extendDays: 3,
    });
    expect(raised[0]!.sent_at).not.toBeNull();
  }, 120_000);

  test("letting a setup close stops the day-27 and day-30 waves, not day 22", async () => {
    const late = await clinic("late", { day: 27, screens: 1 });
    const early = await clinic("early", { day: 22, screens: 1 });
    await watchLifecycles(new Date(NOON.getTime() - 20 * DAY));
    await getMigratorPool().query(`truncate ops_alerts`);
    expect(
      (
        await runOperation(
          "decideLifecycle",
          { clinicId: late.clinicId, decision: "extended" },
          OPERATOR,
        )
      ).status,
    ).toBe(400);
    for (const c of [late, early]) {
      expect(
        (
          await runOperation(
            "decideLifecycle",
            { clinicId: c.clinicId, decision: "let_close" },
            OPERATOR,
          )
        ).status,
      ).toBe(200);
    }
    await watchLifecycles(NOON);
    expect((await alerts()).map((a) => a.fields.clinicId)).toEqual([early.clinicId]);
    const lateRows = await ledger(late);
    expect(
      lateRows.filter((r) => r.wave.startsWith("day_27")).map((r) => [r.delivery, r.error]),
    ).toEqual([
      ["skipped", "let_close"],
      ["skipped", "let_close"],
    ]);
    expect((await lifecycleRow(late)).decided_by).toBe("ops@healdesk.test");
  }, 120_000);

  test("escalations: a bounced reminder (linked to the address alert when there is one) and two delivered with nothing moving", async () => {
    const bounced = await clinic("bounce", { day: 6 });
    const linked = await clinic("linked", { day: 6 });
    const unanswered = await clinic("quiet2", { day: 11 });
    for (const c of [bounced, linked]) {
      expect(await queueSetupReminder(c.clinicId, NOON)).toBe("queued");
      const [notice] = await notices(c);
      await delivered(c, notice!.id as string, NOON, "bounced");
    }
    const [addressAlert] = (
      await getMigratorPool().query<{ id: string }>(
        `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at)
         values ('clinic_address_bounced', 'x', $1, now(), now()) returning id`,
        [{ clinicId: linked.clinicId }],
      )
    ).rows;
    for (const day of [5, 10]) {
      const at = new Date(NOON.getTime() - (11 - day) * DAY);
      expect(await queueSetupReminder(unanswered.clinicId, at)).toBe("queued");
      const [notice] = (await notices(unanswered)).slice(-1);
      await delivered(unanswered, notice!.id as string, at, "delivered");
    }
    send.mockClear();

    await watchLifecycles(NOON);
    const raised = await alerts();
    expect(
      raised
        .filter((a) => a.event === "lifecycle_reminder_undelivered")
        .map((a) => a.fields.clinicId),
    ).toEqual([bounced.clinicId]);
    expect(
      raised
        .filter((a) => a.event === "lifecycle_reminders_unanswered")
        .map((a) => a.fields.clinicId),
    ).toEqual([unanswered.clinicId]);
    // The linked clinic's wave points at the address alert already raised: no second alert.
    const linkedRows = (await ledger(linked)).filter((r) => r.wave.startsWith("undelivered:"));
    expect(linkedRows.map((r) => [r.target, r.escalated, r.ops_alert_id])).toEqual([
      ["ops_email", true, addressAlert!.id],
      ["slack", true, addressAlert!.id],
    ]);
    // Two escalations of our own, each mailed once.
    expect(send).toHaveBeenCalledTimes(2);
  }, 120_000);

  test("the console's list shows every paying clinic, still synthetic or not, owing decisions first, and never the demo clinic", async () => {
    const owed = await clinic("owed", { day: 23, screens: 1 });
    const fine = await clinic("fine", { day: 3, screens: 1 });
    const untouched = await clinic("untouched", { day: 23 });
    const demo = await seedDemoClinic("list");
    await watchLifecycles(NOON);
    // The console reads at its own clock: the test's noon.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);

    const list = async (args: Record<string, unknown>) =>
      (
        (await runOperation("listLifecycle", args, OPERATOR)).body as {
          data: {
            clinics: {
              clinicId: string;
              decisionOwed: boolean;
              recommendation: { action: string; reason: string };
              remainingDays: number | null;
              clinicName: string;
            }[];
          };
        }
      ).data.clinics;
    const shown = await list({});
    expect(shown.map((r) => r.clinicId)).toEqual([
      owed.clinicId,
      untouched.clinicId,
      fine.clinicId,
    ]);
    expect(shown[0]).toMatchObject({ decisionOwed: true, remainingDays: 7 });
    expect(shown[0]!.recommendation.reason).toMatch(/\.$/);
    // Nobody has answered a screen: a call, never "let it close" on that alone.
    expect(shown[1]).toMatchObject({
      decisionOwed: true,
      recommendation: { action: "phone_the_clinic" },
    });
    expect(shown[2]).toMatchObject({ decisionOwed: false });
    expect(shown.map((r) => r.clinicId)).not.toContain(demo.clinicId);

    expect((await runOperation("listLifecycleWaves", { clinicId: "nope" }, OPERATOR)).status).toBe(
      400,
    );
    expect(
      (await runOperation("snoozeLifecycle", { clinicId: randomUUID(), days: 3 }, OPERATOR)).status,
    ).toBe(404);
  }, 120_000);

  test("the digest's Lifecycle block is counts only, passes the allowlist, names nobody, and goes to Slack as one line", async () => {
    const owed = await clinic("digest", { day: 23, screens: 1 });
    await watchLifecycles(NOON);
    const at = new Date(NOON.getTime() + HOUR);
    const payload = await collectDigest(at);
    expect(payload.lifecycleRows).toEqual([
      { status: "in_setup", count: 1, oldestDays: expect.any(Number) },
    ]);
    expect(payload.decisionsOwedCount).toBe(1);
    expect(payload.waitingOnUsCount).toBe(0);
    expect(payload.lifecycleWaveRows).toEqual(
      expect.arrayContaining([
        { type: "slack", outcome: "pending", count: 1 },
        { type: "ops_email", outcome: "sent", count: 1 },
      ]),
    );
    expect(payload.slackUnpostedCount).toBeNull();
    expect(() => assertPayloadAllowed(payload, "ops_digest")).not.toThrow();
    const name = (
      await getMigratorPool().query(`select name from clinics where id = $1`, [owed.clinicId])
    ).rows[0].name;
    expect(JSON.stringify(payload)).not.toContain(name);

    const morning = new Date("2026-10-21T07:30:00Z");
    expect((await sendOpsDigest(morning)).status).toBe("sent");
    expect((await sendOpsDigest(morning)).status).toBe("already_sent");
    // A Slack line lost after the email went is recorded on the next hourly
    // run of the same day, once.
    await getMigratorPool().query(`delete from ops_alerts where event = 'ops_digest_summary'`);
    expect((await sendOpsDigest(new Date("2026-10-21T08:30:00Z"))).status).toBe("already_sent");
    expect((await sendOpsDigest(new Date("2026-10-21T09:30:00Z"))).status).toBe("already_sent");
    const rows = await alerts();
    const summary = rows.filter((a) => a.event === "ops_digest_summary");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.fields).toMatchObject({ decisionsOwedCount: 1, waitingOnUsCount: 0 });
    expect(summary[0]!.sent_at).toBeNull();
    // The digest's own row is not posted to Slack: its summary is.
    const digestRow = rows.find((a) => (a.event as string) === "ops_digest")!;
    expect(String(digestRow.slack_next_at)).toMatch(/infinity/i);
  }, 120_000);
});
