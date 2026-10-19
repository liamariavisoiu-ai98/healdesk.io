import {
  BACKUP_RETENTION_DAYS,
  CARRIERS,
  FORWARDING_PASS_THROUGH_DAYS,
  forwardingInstructions,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { supersededReason } from "@/lib/email/superseded";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import { renderPassThroughEnding } from "@/lib/email/templates/pass_through_ending";
import {
  backupsExpireOn,
  DESTRUCTION_NOTICE_DAYS,
  destructionNoticeExpired,
  downloadByOn,
  EXPORT_REMINDER_DAYS,
  exportReminderDue,
  passThroughEndsAt,
  passThroughNoticeDue,
  queueAfterCancellationNotices,
  readAfterCancellation,
  runDestructionNotices,
  sendDestructionNotice,
} from "@/lib/offboarding/after-cancellation";
import {
  destroyDueClinics,
  destructionPlan,
  markExportDelivered,
  startOffboarding,
  type DestructionInput,
} from "@/lib/offboarding/offboarding";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedChannels,
  seedClinic,
  seedContact,
  seedConversation,
  type SeededClinic,
} from "./setup/factories";

/**
 * After cancellation (Annex X5, E3–E6; lib/offboarding/after-cancellation.ts).
 *
 * What a leaving clinic is told between the end of its service and the
 * destruction of its data, each email once, each a pointer: E4 when the
 * service has ended, pointing at the export behind the sign-in; E5 a week
 * before the data goes undownloaded; E3 a week and a day before forwarded
 * calls stop passing through, while any still are; and E6 when the data is
 * destroyed, to the address captured in the destruction's own transaction,
 * which goes itself once E6 is sent, refused, or a week old.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "after-cancellation-test" } as const;
const ORIGIN = "https://app.healdesk.test";

// -----------------------------------------------------------------------------
// The dates, as pure functions
// -----------------------------------------------------------------------------

const ended = new Date("2026-11-01T15:00:00Z");
const at = (days: number, hours = 0) => new Date(ended.getTime() + days * DAY + hours * HOUR);

function planOn(version: string | null, exportDays: number | null = null) {
  const input: DestructionInput = {
    offboardingStartedAt: ended,
    destroyAfter: at(30),
    exportDeliveredAt: exportDays === null ? null : at(exportDays),
    destructionAgreementVersion: version,
  };
  const plan = destructionPlan(input);
  if (!plan) throw new Error("no plan");
  return plan;
}

describe("E3's notices: a week ahead, then a day ahead, and none once the pass-through has ended", () => {
  test("the pass-through ends the Terms' days after the service does", () => {
    expect(passThroughEndsAt(ended)).toEqual(at(FORWARDING_PASS_THROUGH_DAYS));
    expect(FORWARDING_PASS_THROUGH_DAYS).toBe(30);
  });

  test.each([
    [0, 0, null],
    [22, 23, null],
    [23, 0, 7],
    [28, 23, 7],
    [29, 0, 1],
    [29, 23, 1],
    [30, 0, null],
    [45, 0, null],
  ] as const)("day %i, hour %i: %s", (days, hours, due) => {
    expect(passThroughNoticeDue(ended, at(days, hours))).toBe(due);
  });
});

describe("E5's day, and the download deadline it names", () => {
  test("on the export rule, a week before day 89, while nothing is delivered", () => {
    const plan = planOn("1.5.1");
    expect(plan.latestDestroyAt).toEqual(at(89));
    expect(exportReminderDue(plan, null, at(81, 23))).toBe(false);
    expect(exportReminderDue(plan, null, at(89 - EXPORT_REMINDER_DAYS))).toBe(true);
    expect(exportReminderDue(plan, null, at(88, 23))).toBe(true);
    expect(exportReminderDue(plan, null, at(89))).toBe(false);
    // A delivered export is never reminded of.
    expect(exportReminderDue(plan, at(40), at(85))).toBe(false);
    // The last whole day a download beats day 89's run: day 88's date.
    expect(downloadByOn(plan)).toBe(at(88).toISOString().slice(0, 10));
  });

  test("on the thirty days, a week before day 29, and the deadline is E2's own exportByOn", () => {
    const plan = planOn("1.2.1");
    expect(exportReminderDue(plan, null, at(21, 23))).toBe(false);
    expect(exportReminderDue(plan, null, at(22))).toBe(true);
    expect(exportReminderDue(plan, null, at(29))).toBe(false);
    expect(downloadByOn(plan)).toBe(plan.exportByOn);
  });
});

describe("E6's dates and its bound", () => {
  test("backups expire BACKUP_RETENTION_DAYS after the destruction; the captured address waits a week at most", () => {
    const destroyed = new Date("2026-12-05T15:02:00Z");
    expect(backupsExpireOn(destroyed)).toBe(
      new Date(destroyed.getTime() + BACKUP_RETENTION_DAYS * DAY).toISOString().slice(0, 10),
    );
    expect(DESTRUCTION_NOTICE_DAYS).toBe(7);
    expect(destructionNoticeExpired(destroyed, new Date(destroyed.getTime() + 7 * DAY - 1))).toBe(
      false,
    );
    expect(destructionNoticeExpired(destroyed, new Date(destroyed.getTime() + 7 * DAY))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The database
// -----------------------------------------------------------------------------

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(
    private readonly answer: () => DeliveryResult = () => ({
      status: "sent",
      messageId: `msg_${Date.now()}`,
    }),
  ) {}
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return this.answer();
  }
}

/** Time passing for the offboarding clock, as the migrator, which owns clinics. */
async function moveBack(clinicId: string, hours: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(hours => $2),
            destroy_after = destroy_after - make_interval(hours => $2),
            export_delivered_at = export_delivered_at - make_interval(hours => $2)
      where id = $1`,
    [clinicId, hours],
  );
}

/**
 * An agreement bound a year ago, as the migrator: the destruction rule is
 * the agreement's in force when the service ended (app_agreement_at_end), so
 * it must predate every end these tests move back to.
 */
async function bindAgreement(organizationId: string, version: string): Promise<void> {
  await getMigratorPool().query(
    `insert into baa_acceptances
       (organization_id, document_version, document_hash, rendered_text, variables, assent_label,
        accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, repeat('c', 64), 'AGREEMENT (test)', '{}'::jsonb, 'I agree', 'Alex Chen',
             'alex@after-cancellation.test', now() - interval '1 year', now() - interval '1 year')`,
    [organizationId, version],
  );
}

async function offboard(c: SeededClinic, version = "1.5.1"): Promise<void> {
  await bindAgreement(c.organizationId, version);
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
    startOffboarding(tx, "operator"),
  );
}

type NoticeRow = { kind: string; dedupe_key: string; payload: Record<string, unknown> };

async function notices(clinicId: string, kinds?: string[]): Promise<NoticeRow[]> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<NoticeRow>(
      `select kind, dedupe_key, payload from billing_notices where clinic_id = $1 order by created_at, dedupe_key`,
      [clinicId],
    );
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  });
}

async function noticeAddress(clinicId: string): Promise<string | null> {
  const { rows } = await getMigratorPool().query<{ a: string | null }>(
    `select destruction_notice_address as a from clinics where id = $1`,
    [clinicId],
  );
  return rows[0]!.a;
}

async function ledger(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      kind: string;
      period_key: string;
      recipient: string;
      status: string;
    }>(
      `select kind, period_key, recipient, status from report_deliveries where kind = 'data_destroyed'`,
    );
    return rows;
  });
}

async function opsAlerts(event: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1 order by raised_at`,
    [event],
  );
  return rows.map((r) => r.fields);
}

/** A clinic on BAA 1.5.1 whose export was delivered and whose data is destroyed now. */
async function destroyedClinic(label: string): Promise<SeededClinic> {
  const c = await seedClinic(label);
  await seedContact(c.clinicId, "+14155550134");
  await offboard(c);
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
    markExportDelivered(tx, "bundle handed to the practice manager"),
  );
  await moveBack(c.clinicId, 30 * 24);
  const destroyed = await destroyDueClinics(new Date());
  expect(destroyed.map((d) => d.clinicId)).toContain(c.clinicId);
  return c;
}

describeDb("after cancellation, in the database", () => {
  beforeAll(async () => {
    await runMigrations();
    process.env.BETTER_AUTH_URL = ORIGIN;
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts`);
    process.env.BETTER_AUTH_URL = ORIGIN;
  });

  afterAll(async () => {
    await closePools();
  });

  test("E4: once the service has ended, 'Your export is ready' is queued once, pointing at the export behind the sign-in; none while in service", async () => {
    const live = await seedClinic("export-live");
    await seedConversation(live.clinicId, { startedAt: new Date() });
    const leaving = await seedClinic("export-leaving");
    await seedContact(leaving.clinicId, "+14155550134");
    await offboard(leaving);

    await queueAfterCancellationNotices(new Date());
    await queueAfterCancellationNotices(new Date());

    expect(await notices(live.clinicId)).toEqual([]);
    const queued = await notices(leaving.clinicId, ["export_ready"]);
    expect(queued).toHaveLength(1);
    const plan = await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, async (tx) => {
      const { destructionPlanIn } = await import("@/lib/offboarding/offboarding");
      return destructionPlanIn(tx);
    });
    expect(queued[0]!.payload).toEqual({
      exportByOn: plan!.exportByOn,
      destroyByOn: plan!.destroyByOn,
      exportUrl: `${ORIGIN}/c/${leaving.slug}/conversations#export`,
    });
    expect(() => assertPayloadAllowed(queued[0]!.payload, "export_ready")).not.toThrow();
    // A pointer: nothing of the patient in it.
    expect(JSON.stringify(queued)).not.toMatch(/Synthetic Patient|0134/);
  });

  test("E4 and E5 skip a clinic with nothing to export that no E2 promised one to, and reach one that was", async () => {
    const closed = await seedClinic("export-empty");
    await offboard(closed);
    await queueAfterCancellationNotices(new Date());
    expect(await notices(closed.clinicId, ["export_ready"])).toEqual([]);

    // E2 told it an export is coming (Package C's `canceled`), so it gets one, empty or not.
    await inTenant(closed.clinicId, (c) =>
      c.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key, payload) values ($1, 'canceled', 'sub_test', '{}'::jsonb)`,
        [closed.clinicId],
      ),
    );
    await queueAfterCancellationNotices(new Date());
    expect((await notices(closed.clinicId, ["export_ready"])).map((n) => n.dedupe_key)).toEqual([
      "export_ready",
    ]);
  });

  test("E5: a week before the data goes undownloaded, once, with the last day a download beats it; never once delivered", async () => {
    const c = await seedClinic("export-reminder");
    await seedContact(c.clinicId, "+14155550134");
    await offboard(c, "1.5.1");
    // Day 81: not yet.
    await moveBack(c.clinicId, 81 * 24);
    await queueAfterCancellationNotices(new Date());
    expect(await notices(c.clinicId, ["export_reminder"])).toEqual([]);
    // Day 82 and an hour: due.
    await moveBack(c.clinicId, 25);
    await queueAfterCancellationNotices(new Date());
    await queueAfterCancellationNotices(new Date());
    const reminders = await notices(c.clinicId, ["export_reminder"]);
    expect(reminders).toHaveLength(1);
    const { rows } = await getMigratorPool().query<{ started: Date }>(
      `select offboarding_started_at as started from clinics where id = $1`,
      [c.clinicId],
    );
    const started = rows[0]!.started;
    expect(reminders[0]!.payload).toMatchObject({
      downloadByOn: new Date(started.getTime() + 88 * DAY).toISOString().slice(0, 10),
      destroyByOn: new Date(started.getTime() + 90 * DAY).toISOString().slice(0, 10),
      exportUrl: `${ORIGIN}/c/${c.slug}/conversations#export`,
    });
    expect(() => assertPayloadAllowed(reminders[0]!.payload, "export_reminder")).not.toThrow();

    // Delivered before it goes: the outbox closes it unsent, and E4 with it.
    const superseded = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const before = await supersededReason(tx, "export_reminder", reminders[0]!.payload);
      await markExportDelivered(tx, "downloaded in full by the clinic");
      return {
        before,
        reminder: await supersededReason(tx, "export_reminder", reminders[0]!.payload),
        ready: await supersededReason(tx, "export_ready", {}),
      };
    });
    expect(superseded).toEqual({
      before: null,
      reminder: "the export was delivered before it could go",
      ready: "the export was delivered before it could go",
    });

    // And a delivered export is never reminded of at all.
    const other = await seedClinic("export-delivered");
    await seedContact(other.clinicId, "+14155550135");
    await offboard(other, "1.5.1");
    await withTenant({ clinicId: other.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await moveBack(other.clinicId, 83 * 24);
    await queueAfterCancellationNotices(new Date());
    expect(await notices(other.clinicId, ["export_reminder", "export_ready"])).toEqual([]);
  });

  test("E5 on the thirty days: a week before day 29, with E2's own download date", async () => {
    const c = await seedClinic("export-thirty");
    await seedContact(c.clinicId, "+14155550134");
    await offboard(c, "1.2.1");
    await moveBack(c.clinicId, 22 * 24 + 1);
    await queueAfterCancellationNotices(new Date());
    const [reminder] = await notices(c.clinicId, ["export_reminder"]);
    const [ready] = await notices(c.clinicId, ["export_ready"]);
    expect(reminder!.payload.downloadByOn).toBe(ready!.payload.exportByOn);
  });

  test("E3: a week and a day before the pass-through ends, to a clinic that cancelled with phone live, with no call recorded after the end; and with the clinic's undo codes", async () => {
    // A production clinic whose phone went live two months ago: once its
    // service has ended the database takes no new patient row, so a call
    // passed through after the end leaves no conversation behind.
    const c = await seedClinic("pass-through");
    await getMigratorPool().query(
      `update clinics set carrier = 'att', phone_system_type = 'landline' where id = $1`,
      [c.clinicId],
    );
    await inTenant(c.clinicId, (q) =>
      q.query(
        `insert into clinic_settings (clinic_id, coverage_mode) values ($1, 'after_hours_only')
           on conflict (clinic_id) do update set coverage_mode = excluded.coverage_mode`,
        [c.clinicId],
      ),
    );
    await seedChannels(c.clinicId, [
      {
        channel: "voice",
        readyAt: new Date(Date.now() - 61 * DAY),
        liveAt: new Date(Date.now() - 60 * DAY),
      },
    ]);
    // Forwarding seen by a test call, though phone never went live.
    const observed = await seedClinic("pass-observed");
    await getMigratorPool().query(
      `update clinics set forwarding_test_observed = $2::jsonb where id = $1`,
      [
        observed.clinicId,
        JSON.stringify({
          arrivedAt: new Date(Date.now() - 40 * DAY).toISOString(),
          conversationId: "00000000-0000-4000-8000-000000000000",
          callerIdPreserved: true,
          condition: "no_answer",
        }),
      ],
    );
    // Website chat only: no line was ever pointed at us.
    const chatOnly = await seedClinic("pass-chat-only");
    await seedChannels(chatOnly.clinicId, [
      {
        channel: "web",
        readyAt: new Date(Date.now() - 61 * DAY),
        liveAt: new Date(Date.now() - 60 * DAY),
      },
    ]);
    for (const clinic of [c, observed, chatOnly]) await offboard(clinic);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now() - interval '1 year' where id = $1`,
      [c.clinicId],
    );
    await expect(
      inTenant(c.clinicId, (q) =>
        q.query(
          `insert into conversations (clinic_id, channel, started_at) values ($1, 'voice', now())`,
          [c.clinicId],
        ),
      ),
    ).rejects.toThrow(/refusing to write PHI to conversations/);
    const conversationsAfter = async () =>
      (
        await getMigratorPool().query<{ n: number }>(
          `select count(*)::int as n from conversations where clinic_id = $1`,
          [c.clinicId],
        )
      ).rows[0]!.n;
    expect(await conversationsAfter()).toBe(0);

    // Day 22: nothing yet.
    for (const clinic of [c, observed, chatOnly]) await moveBack(clinic.clinicId, 22 * 24);
    await queueAfterCancellationNotices(new Date());
    expect(await notices(c.clinicId, ["pass_through_ending"])).toEqual([]);

    // Day 23: the week's notice, once, to both clinics whose line was pointed at us.
    for (const clinic of [c, observed, chatOnly]) await moveBack(clinic.clinicId, 25);
    await queueAfterCancellationNotices(new Date());
    await queueAfterCancellationNotices(new Date());
    const week = await notices(c.clinicId, ["pass_through_ending"]);
    expect(week.map((n) => n.dedupe_key)).toEqual(["pass_through_ending:7"]);
    expect(await conversationsAfter()).toBe(0);
    const { rows } = await getMigratorPool().query<{ started: Date }>(
      `select offboarding_started_at as started from clinics where id = $1`,
      [c.clinicId],
    );
    expect(week[0]!.payload).toEqual({
      passThroughEndsAt: new Date(rows[0]!.started.getTime() + 30 * DAY).toISOString(),
      noticeDays: 7,
      carrier: "att",
      phoneSystem: "landline",
      routing: "after_hours_only",
    });
    expect(() => assertPayloadAllowed(week[0]!.payload, "pass_through_ending")).not.toThrow();
    expect(
      (await notices(observed.clinicId, ["pass_through_ending"])).map((n) => n.dedupe_key),
    ).toEqual(["pass_through_ending:7"]);
    expect(await notices(chatOnly.clinicId, ["pass_through_ending"])).toEqual([]);

    // The undo codes are the catalog's for that carrier and mode: After hours
    // only is all-call forwarding, so its undo is the all-call cancel code.
    const rendered = renderPassThroughEnding(week[0]!.payload as never, {
      clinicName: "pass-through Clinic",
      audience: audienceFor("med-spa"),
      reason: clinicReason("pass-through Clinic"),
      raisedAt: new Date(),
      timeZone: "America/New_York",
    });
    const undo = forwardingInstructions({
      carrier: "att",
      phoneSystemType: "landline",
      routing: "after_hours_only",
      destinationE164: "",
    }).undo;
    expect(undo.length).toBeGreaterThan(0);
    for (const step of undo) expect(rendered.text).toContain(step.dial);
    expect(rendered.text).toContain(CARRIERS.find((x) => x.id === "att")!.name);
    expect(rendered.text).toContain("If you haven't undone the forwarding yet");

    // Day 29: the day's notice.
    await moveBack(c.clinicId, 6 * 24);
    await queueAfterCancellationNotices(new Date());
    expect((await notices(c.clinicId, ["pass_through_ending"])).map((n) => n.dedupe_key)).toEqual([
      "pass_through_ending:7",
      "pass_through_ending:1",
    ]);
    // Day 30: the pass-through has ended, and nothing more is queued.
    await moveBack(c.clinicId, 24);
    await queueAfterCancellationNotices(new Date());
    expect(await notices(c.clinicId, ["pass_through_ending"])).toHaveLength(2);
  });

  test("AYA's number outlives a day-29 destruction until the pass-through ends: kept on days 29, released on day 30, still gone on day 31; and E3's day-ahead notice still reaches the destroyed clinic", async () => {
    const NUMBER = "+18885550142";
    // On BAA 1.5.1 with its export delivered, and on BAA 1.2.1 without: both
    // are destroyed on day 29.
    const delivered = await seedClinic("number-export-rule");
    const thirty = await seedClinic("number-thirty-days");
    for (const clinic of [delivered, thirty]) {
      await getMigratorPool().query(`update clinics set assistant_number_e164 = $2 where id = $1`, [
        clinic.clinicId,
        NUMBER,
      ]);
      await seedContact(clinic.clinicId, "+14155550134");
      await seedChannels(clinic.clinicId, [
        {
          channel: "voice",
          readyAt: new Date(Date.now() - 61 * DAY),
          liveAt: new Date(Date.now() - 60 * DAY),
        },
      ]);
    }
    await offboard(delivered, "1.5.1");
    await withTenant({ clinicId: delivered.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );
    await offboard(thirty, "1.2.1");
    const both = [delivered, thirty];
    const state = async (clinicId: string) =>
      (
        await getMigratorPool().query<{ number: string | null; destroyed: Date | null }>(
          `select assistant_number_e164 as number, destroyed_at as destroyed from clinics where id = $1`,
          [clinicId],
        )
      ).rows[0]!;
    // One hour as the tick runs it: destruction, then the after-cancellation notices.
    const hour = async () => {
      await destroyDueClinics(new Date());
      await queueAfterCancellationNotices(new Date());
    };

    // Day 29: destroyed, and the number kept: calls still forward until day 30.
    for (const clinic of both) await moveBack(clinic.clinicId, 29 * 24 + 1);
    await hour();
    for (const clinic of both) {
      expect(await state(clinic.clinicId)).toEqual({ number: NUMBER, destroyed: expect.any(Date) });
      // The destroyed clinic is still told its pass-through ends tomorrow.
      expect(
        (await notices(clinic.clinicId, ["pass_through_ending"])).map((n) => n.dedupe_key),
      ).toEqual(["pass_through_ending:1"]);
    }

    // The last hour of day 29: still kept.
    for (const clinic of both) await moveBack(clinic.clinicId, 22);
    await hour();
    for (const clinic of both) expect((await state(clinic.clinicId)).number).toBe(NUMBER);

    // Day 30: the pass-through has ended, and the next run releases the number.
    for (const clinic of both) await moveBack(clinic.clinicId, 1);
    await hour();
    for (const clinic of both) {
      expect((await state(clinic.clinicId)).number).toBeNull();
      const released = await inTenant(clinic.clinicId, (q) =>
        q.query<{ n: number }>(
          `select count(*)::int as n from audit_log
            where clinic_id = $1 and resource_type = 'clinic_offboarding'
              and metadata->>'numberReleased' = 'true'`,
          [clinic.clinicId],
        ),
      );
      expect(released.rows[0]!.n).toBe(1);
    }

    // Day 31: nothing more happens, and nothing more is queued.
    for (const clinic of both) await moveBack(clinic.clinicId, 24);
    await hour();
    for (const clinic of both) {
      expect((await state(clinic.clinicId)).number).toBeNull();
      expect(await notices(clinic.clinicId, ["pass_through_ending"])).toHaveLength(1);
    }
  });

  test("a destruction after the pass-through has ended releases the number with the data", async () => {
    const c = await seedClinic("number-late");
    await getMigratorPool().query(
      `update clinics set assistant_number_e164 = '+18885550143' where id = $1`,
      [c.clinicId],
    );
    await seedContact(c.clinicId, "+14155550134");
    // BAA 1.5.1, export never delivered: destroyed on day 89.
    await offboard(c, "1.5.1");
    await moveBack(c.clinicId, 89 * 24 + 1);
    await destroyDueClinics(new Date());
    const { rows } = await getMigratorPool().query<{
      number: string | null;
      destroyed: Date | null;
    }>(
      `select assistant_number_e164 as number, destroyed_at as destroyed from clinics where id = $1`,
      [c.clinicId],
    );
    expect(rows[0]).toEqual({ number: null, destroyed: expect.any(Date) });
  });

  test("E6: destruction captures the address before it deletes anything; the email goes there once, to the captured address, and the address is gone", async () => {
    const c = await destroyedClinic("destroyed-sent");
    expect(await noticeAddress(c.clinicId)).toBe(c.staffEmail.toLowerCase());

    // The sign-in changes after the destruction: E6 still goes where it was.
    await getMigratorPool().query(
      `update "user" set email = 'someone-else@example-clinic.test' where id = $1`,
      [c.staffUserId],
    );
    await inTenant(c.clinicId, (q) =>
      q.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [
        c.clinicId,
      ]),
    );

    const transport = new FakeTransport();
    const run = await runDestructionNotices({ transport });
    expect(run).toEqual({ owed: 1, sent: 1, retrying: 0, givenUp: 0 });
    expect(transport.sent).toHaveLength(1);
    const { target, message } = transport.sent[0]!;
    expect(target.to).toBe(c.staffEmail.toLowerCase());
    expect(message.subject).toBe("Your healdesk data has been destroyed");
    expect(message.text).toContain("What remains, and why:");
    expect(message.text).toContain("record of disclosures");
    expect(message.text).not.toMatch(/Synthetic Patient|0134/);
    expect(message.idempotencyKey).toMatch(/^hd-data_destroyed-[0-9a-f-]{36}-1$/);
    expect(await ledger(c.clinicId)).toEqual([
      {
        kind: "data_destroyed",
        period_key: "destroyed",
        recipient: c.staffEmail.toLowerCase(),
        status: "sent",
      },
    ]);
    expect(await noticeAddress(c.clinicId)).toBeNull();

    // Once: nothing is owed now, and a second run sends nothing.
    expect(await runDestructionNotices({ transport })).toEqual({
      owed: 0,
      sent: 0,
      retrying: 0,
      givenUp: 0,
    });
    expect(transport.sent).toHaveLength(1);
  });

  test("E6: a send that may yet succeed keeps the address for the next hour; a refusal, or a week without a send, gives up, clears it and tells ops", async () => {
    const c = await destroyedClinic("destroyed-retry");
    const unavailable = new FakeTransport(() => ({
      status: "failed",
      reason: "503 from the provider",
      statusCode: 503,
    }));
    expect(await sendDestructionNotice(c.clinicId, { transport: unavailable })).toBe("retrying");
    expect(await noticeAddress(c.clinicId)).toBe(c.staffEmail.toLowerCase());
    expect((await ledger(c.clinicId))[0]!.status).toBe("failed");

    const rejected = new FakeTransport(() => ({
      status: "failed",
      reason: "422 invalid recipient",
      statusCode: 422,
      errorName: "validation_error",
    }));
    expect(await sendDestructionNotice(c.clinicId, { transport: rejected })).toBe("given_up");
    expect(await noticeAddress(c.clinicId)).toBeNull();
    expect(await opsAlerts("destruction_notice_undelivered")).toEqual([
      { clinicId: c.clinicId, phase: "rejected" },
    ]);

    const late = await destroyedClinic("destroyed-late");
    await getMigratorPool().query(
      `update clinics set destroyed_at = destroyed_at - interval '7 days' where id = $1`,
      [late.clinicId],
    );
    const never = new FakeTransport();
    expect(await runDestructionNotices({ transport: never })).toEqual({
      owed: 1,
      sent: 0,
      retrying: 0,
      givenUp: 1,
    });
    expect(never.sent).toEqual([]);
    expect(await noticeAddress(late.clinicId)).toBeNull();
    expect((await opsAlerts("destruction_notice_undelivered")).at(-1)).toEqual({
      clinicId: late.clinicId,
      phase: "expired",
    });
  });

  test("E6 on a data protection agreement names no record of disclosures, and says client", async () => {
    const c = await seedClinic("destroyed-dpa");
    await getMigratorPool().query(`update clinics set specialty = 'veterinary' where id = $1`, [
      c.clinicId,
    ]);
    await seedContact(c.clinicId, "+14155550134");
    await offboard(c, "dpa/1.0.0");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await moveBack(c.clinicId, 30 * 24);
    await destroyDueClinics(new Date());
    const transport = new FakeTransport();
    expect(await sendDestructionNotice(c.clinicId, { transport })).toBe("sent");
    const { text } = transport.sent[0]!.message;
    expect(text).not.toContain("record of disclosures");
    expect(text).toContain("The signed agreement, kept for at least six years");
    expect(text).toContain("client information");
  });

  test("the captured address is held only by a destroyed clinic, the runtime role can write it, and the owed list names ids only", async () => {
    const live = await seedClinic("address-live");
    await expect(
      getMigratorPool().query(
        `update clinics set destruction_notice_address = 'owner@example-clinic.test' where id = $1`,
        [live.clinicId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const { rows } = await getMigratorPool().query<{
      update: boolean;
      app: boolean;
      anyone: boolean;
    }>(
      `select has_column_privilege('healdesk_app', 'clinics', 'destruction_notice_address', 'UPDATE') as update,
              has_function_privilege('healdesk_app', 'app_destruction_notices_owed()', 'EXECUTE') as app,
              has_function_privilege('public', 'app_destruction_notices_owed()', 'EXECUTE') as anyone`,
    );
    expect(rows[0]).toEqual({ update: true, app: true, anyone: false });

    const c = await destroyedClinic("address-owed");
    const owed = await getAppPool().query(`select * from app_destruction_notices_owed()`);
    expect(owed.rows.map((r) => Object.keys(r).sort())).toEqual([["clinic_id", "destroyed_at"]]);
    expect(owed.rows[0]!.clinic_id).toBe(c.clinicId);
  });

  test("Billing's view after cancellation: the download deadline, then the delivery and the destruction", async () => {
    const c = await seedClinic("billing-view");
    await seedContact(c.clinicId, "+14155550134");
    expect(await readAfterCancellation({ clinicId: c.clinicId, actor: ACTOR })).toBeNull();
    await offboard(c, "1.5.1");
    const first = await readAfterCancellation({ clinicId: c.clinicId, actor: ACTOR });
    expect(first).toMatchObject({ exportDeliveredAt: null, destroyedAt: null });
    expect(first!.downloadByOn).toBe(first!.exportByOn);

    // Past day 29 undelivered: the deadline is the last day before day 89.
    await moveBack(c.clinicId, 40 * 24);
    const later = await readAfterCancellation({ clinicId: c.clinicId, actor: ACTOR });
    expect(later!.downloadByOn).toBe(
      new Date(later!.endedAt.getTime() + 88 * DAY).toISOString().slice(0, 10),
    );

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "downloaded in full"),
    );
    const delivered = await readAfterCancellation({ clinicId: c.clinicId, actor: ACTOR });
    expect(delivered!.exportDeliveredAt).toBeInstanceOf(Date);
    await destroyDueClinics(new Date());
    const gone = await readAfterCancellation({ clinicId: c.clinicId, actor: ACTOR });
    expect(gone!.destroyedAt).toBeInstanceOf(Date);
  });
});
