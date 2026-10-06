import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { enqueueNotice, type NoticePayloads } from "@/lib/billing/notices";
import type { NoticeKind } from "@/lib/email/kinds";
import {
  deliverCriticalAfterCommit,
  deliverNotice,
  lateCriticalNotices,
  MAX_NOTICE_ATTEMPTS,
  nextDaytime,
  nextQuotaReset,
  runBillingNoticesJob,
  sendPendingNotices,
  verdictOf,
} from "@/lib/email/outbox";
import { compose } from "@/lib/email/templates/compose";
import type { TemplateEntry } from "@/lib/email/templates/registry";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { JOB_BILLING_NOTICES, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The outbox sender (lib/email/outbox.ts), against the real tables: the claim
 * and its lease, two workers, the retry schedule, the daily quota, Resend's
 * 409, a final 4xx, dead letters, critical notices in-process, quiet hours, a
 * kind with no template, the switch, and /api/health.
 *
 * Every send goes to a fake transport that records what it was handed: no
 * email leaves the machine. No kind has a real template yet (Package C writes
 * them), so the tests hand the sender one for the kinds they use.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "email-outbox-test" } as const;
const ORIGIN = "https://app.healdesk.test";
const MINUTE = 60_000;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly calls: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(
    private readonly respond: (n: number) => DeliveryResult | Promise<DeliveryResult> = (n) => ({
      status: "sent",
      messageId: `msg_${n}`,
    }),
  ) {}
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.calls.push({ target, message });
    return this.respond(this.calls.length);
  }
}

const failing =
  (statusCode: number | null, errorName: string, extra: Partial<DeliveryResult> = {}) =>
  (): DeliveryResult =>
    ({
      status: "failed",
      reason: `Resend refused (${errorName})`,
      statusCode,
      errorName,
      ...extra,
    }) as DeliveryResult;

/** The template the tests give the kinds they use. Renders only from the payload and the context. */
const TEST_TEMPLATE: TemplateEntry = {
  render: (payload, ctx) =>
    compose(
      {
        subject: `A notice for ${ctx.clinicName ?? "nobody"}`,
        preheader: "A test notice.",
        blocks: [
          { type: "paragraph", text: `Amount due: ${String(payload.amountDueCents ?? 0)} cents.` },
          { type: "action", label: "Open Billing", url: `${ORIGIN}/c/radiance/billing` },
        ],
      },
      ctx,
    ),
  fixture: {},
};
const TEMPLATED: ReadonlySet<string> = new Set(["payment_failed", "renewal_upcoming", "restored"]);
const templates = (kind: string) => (TEMPLATED.has(kind) ? TEST_TEMPLATE : undefined);

async function enqueue<K extends NoticeKind>(
  clinicId: string,
  kind: K,
  key: string,
  payload: NoticePayloads[K],
  sendAfter: Date,
): Promise<string> {
  await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    enqueueNotice(tx, kind, key, payload, { sendAfter }),
  );
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select id from billing_notices where clinic_id = $1 and kind = $2 and dedupe_key = $3`,
      [clinicId, kind, key],
    );
    return rows[0]!.id;
  });
}

type NoticeRow = {
  send_after: Date;
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
  recipients_count: number | null;
};

async function notice(clinicId: string, id: string): Promise<NoticeRow> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<NoticeRow>(
      `select send_after, sent_at, attempts, last_error, recipients_count from billing_notices where id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

type LedgerRow = {
  id: string;
  kind: string;
  period_key: string;
  recipient: string;
  status: string;
  message_id: string | null;
};

async function ledger(clinicId: string): Promise<LedgerRow[]> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<LedgerRow>(
      `select id, kind, period_key, recipient, status, message_id from report_deliveries order by attempted_at`,
    );
    return rows;
  });
}

async function opsAlerts(
  event: string,
): Promise<{ fields: Record<string, unknown>; repeats: number }[]> {
  const { rows } = await getMigratorPool().query<{
    fields: Record<string, unknown>;
    repeats: number;
  }>(`select fields, repeats from ops_alerts where event = $1 order by raised_at`, [event]);
  return rows;
}

async function setTimezone(clinicId: string, timezone: string): Promise<void> {
  await getMigratorPool().query(`update clinics set timezone = $2 where id = $1`, [
    clinicId,
    timezone,
  ]);
}

let opsUser = "";

describeDb("the outbox sender", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
    opsUser = `usr_ops_${randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
      [opsUser, `${opsUser}@healdesk.test`],
    );
    // Jobs ship off; the sender's switch is the billing-notices row.
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    process.env.BETTER_AUTH_URL = ORIGIN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  test("claims a notice with a two-minute lease, sends once, and keys the email on its ledger row", async () => {
    const c = await seedClinic("outbox-send");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(
      c.clinicId,
      "payment_failed",
      "in_1",
      { amountDueCents: 8970, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
      T,
    );

    let leasedUntil: Date | null = null;
    const transport = new FakeTransport(async () => {
      leasedUntil = (await notice(c.clinicId, id)).send_after;
      return { status: "sent", messageId: "msg_1" };
    });
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("sent");

    // While the send was in flight the row was leased two minutes out.
    expect(leasedUntil!.getTime()).toBe(T.getTime() + 2 * MINUTE);
    expect(transport.calls).toHaveLength(1);
    const { target, message } = transport.calls[0]!;
    expect(target.to).toBe(c.staffEmail);

    const rows = await ledger(c.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "payment_failed",
      period_key: id,
      recipient: c.staffEmail,
      status: "sent",
      message_id: "msg_1",
    });
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "payment_failed" },
      { name: "clinic", value: c.clinicId },
      { name: "delivery", value: rows[0]!.id },
    ]);
    expect(JSON.stringify(message.tags)).not.toContain("@");
    expect(message.idempotencyKey).toBe(`hd-payment_failed-${id}-1`);
    expect(message.replyTo).toBe("hello@healdesk.io");
    expect(message.text).toContain("Amount due: 8970 cents.");

    expect(await notice(c.clinicId, id)).toMatchObject({
      attempts: 1,
      recipients_count: 1,
      last_error: null,
    });
    expect((await notice(c.clinicId, id)).sent_at).not.toBeNull();

    // Sent is sent: a second delivery finds nothing to claim.
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("not_due");
    expect(transport.calls).toHaveLength(1);
  });

  test("two workers running at once never send one notice twice", async () => {
    const a = await seedClinic("outbox-race-a");
    const b = await seedClinic("outbox-race-b");
    const T = new Date("2026-10-06T15:00:00Z");
    for (let i = 0; i < 3; i += 1) {
      await enqueue(a.clinicId, "restored", `r${i}`, { receiptUrl: null }, T);
      await enqueue(b.clinicId, "restored", `r${i}`, { receiptUrl: null }, T);
    }
    const transport = new FakeTransport(async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: "sent", messageId: `msg_${n}` };
    });

    const [first, second] = await Promise.all([
      sendPendingNotices({ now: T, transport, templates }),
      sendPendingNotices({ now: T, transport, templates }),
    ]);
    expect(first.sent + second.sent).toBe(6);
    expect(transport.calls).toHaveLength(6);
    expect(new Set(transport.calls.map((call) => call.message.idempotencyKey)).size).toBe(6);
  });

  test("retries at 1, 5, 30, 120 and 360 minutes under the same key, then dies and tells ops", async () => {
    const c = await seedClinic("outbox-retry");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport(failing(500, "internal_server_error"));

    let now = T;
    for (const delay of [1, 5, 30, 120, 360]) {
      expect(await deliverNotice(c.clinicId, id, { now, transport, templates })).toBe("retrying");
      const row = await notice(c.clinicId, id);
      expect(row.send_after.getTime(), `after ${delay}`).toBe(now.getTime() + delay * MINUTE);
      // Not due a minute early.
      expect(
        await deliverNotice(c.clinicId, id, {
          now: new Date(row.send_after.getTime() - MINUTE),
          transport,
          templates,
        }),
      ).toBe("not_due");
      now = row.send_after;
    }
    expect(await deliverNotice(c.clinicId, id, { now, transport, templates })).toBe("dead");

    const row = await notice(c.clinicId, id);
    expect(row.attempts).toBe(MAX_NOTICE_ATTEMPTS);
    expect(row.sent_at).toBeNull();
    expect(row.last_error).toMatch(/^dead: /);
    expect(transport.calls).toHaveLength(6);
    expect(new Set(transport.calls.map((call) => call.message.idempotencyKey))).toEqual(
      new Set([`hd-restored-${id}-1`]),
    );
    // The ledger row was claimed again on every retry: one row, still failed.
    expect((await ledger(c.clinicId)).map((r) => r.status)).toEqual(["failed"]);

    const alerts = await opsAlerts("critical_notice_undelivered");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.fields).toMatchObject({
      clinicId: c.clinicId,
      noticeId: id,
      kind: "restored",
      status: "dead",
    });

    // Dead is out of every query.
    expect(
      await deliverNotice(c.clinicId, id, {
        now: new Date(now.getTime() + 24 * 60 * MINUTE),
        transport,
        templates,
      }),
    ).toBe("not_due");
  });

  test("a retry inside Resend's window sends exactly the bytes of the first attempt", async () => {
    const c = await seedClinic("outbox-same-bytes");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(
      c.clinicId,
      "payment_failed",
      "in_2",
      { amountDueCents: 100, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
      T,
    );
    const transport = new FakeTransport((n) =>
      n === 1 ? failing(null, "timeout")() : { status: "sent", messageId: "msg_2" },
    );
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("retrying");
    expect(
      await deliverNotice(c.clinicId, id, {
        now: new Date(T.getTime() + MINUTE),
        transport,
        templates,
      }),
    ).toBe("sent");
    const [first, second] = transport.calls.map((call) => call.message);
    expect(second).toEqual(first);
    expect((await ledger(c.clinicId)).map((r) => r.status)).toEqual(["sent"]);
  });

  test("Resend's daily quota waits until 00:05 UTC without spending an attempt", async () => {
    const c = await seedClinic("outbox-quota");
    const T = new Date("2026-10-06T22:10:00Z");
    const id = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport(failing(429, "daily_quota_exceeded", { quota: 100 }));

    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("waiting");
    const row = await notice(c.clinicId, id);
    expect(row.attempts).toBe(0);
    expect(row.send_after.toISOString()).toBe("2026-10-07T00:05:00.000Z");
    expect(row.last_error).toMatch(/daily quota/);

    // The header was recorded, and 100 is past the alarm: one alert for the day.
    const { rows } = await getMigratorPool().query<{ used: number }>(
      `select used from email_daily_quota where day = '2026-10-06'`,
    );
    expect(rows[0]!.used).toBe(100);
    expect(await opsAlerts("daily_email_count_70")).toHaveLength(1);
  });

  test("a 409 invalid_idempotent_request is recorded as sent", async () => {
    const c = await seedClinic("outbox-409");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport(failing(409, "invalid_idempotent_request"));
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("sent");
    expect((await notice(c.clinicId, id)).sent_at).not.toBeNull();
    expect((await ledger(c.clinicId)).map((r) => r.status)).toEqual(["sent"]);
  });

  test("any other 4xx is final: dead at once, and ops is told", async () => {
    const c = await seedClinic("outbox-4xx");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport(failing(422, "validation_error"));
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("dead");
    expect(transport.calls).toHaveLength(1);
    expect((await notice(c.clinicId, id)).attempts).toBe(MAX_NOTICE_ATTEMPTS);
    expect(await opsAlerts("critical_notice_undelivered")).toHaveLength(1);
  });

  test("a payload off the allowlist is final, and never reaches the transport", async () => {
    const c = await seedClinic("outbox-payload");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(
      c.clinicId,
      "restored",
      "r",
      { email: "owner@radiance.test" } as never,
      T,
    );
    const transport = new FakeTransport();
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("dead");
    expect(transport.calls).toHaveLength(0);
    const row = await notice(c.clinicId, id);
    expect(row.last_error).toContain('payload field "email"');
    expect(row.last_error).not.toContain("owner@radiance.test");
  });

  test("a clinic with no address to send to is a dead letter, not a retry", async () => {
    const c = await seedClinic("outbox-nobody");
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [
        c.clinicId,
      ]),
    );
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport();
    expect(await deliverNotice(c.clinicId, id, { now: T, transport, templates })).toBe("dead");
    expect(transport.calls).toHaveLength(0);
    expect((await notice(c.clinicId, id)).last_error).toMatch(/no address/);
  });

  test("critical kinds go in-process after commit: through after() in a route, as a promise elsewhere", async () => {
    const c = await seedClinic("outbox-critical");
    const T = new Date("2026-10-06T15:00:00Z");
    const critical = await enqueue(
      c.clinicId,
      "payment_failed",
      "in_3",
      { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
      T,
    );
    const normal = await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    const transport = new FakeTransport();

    let scheduled: (() => Promise<void>) | undefined;
    await deliverCriticalAfterCommit(c.clinicId, {
      now: T,
      transport,
      templates,
      after: (task) => {
        scheduled = task;
      },
    });
    // Nothing yet: after() runs the task once the response has gone.
    expect(transport.calls).toHaveLength(0);
    await scheduled!();
    expect(transport.calls.map((call) => call.message.tags?.[1]?.value)).toEqual([
      "payment_failed",
    ]);
    expect((await notice(c.clinicId, critical)).sent_at).not.toBeNull();
    // The normal notice waits for the minute queue.
    expect((await notice(c.clinicId, normal)).sent_at).toBeNull();

    // Outside a request scope after() throws, and the send happens now instead.
    const d = await seedClinic("outbox-critical-2");
    await enqueue(
      d.clinicId,
      "payment_failed",
      "in_4",
      { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
      T,
    );
    await deliverCriticalAfterCommit(d.clinicId, {
      now: T,
      transport,
      templates,
      after: () => {
        throw new Error("`after` was called outside a request scope.");
      },
    });
    expect(transport.calls).toHaveLength(2);
  });

  test("quiet hours: a daytime kind waits for 07:00 at the clinic, an any-hour kind goes at once", async () => {
    const c = await seedClinic("outbox-quiet");
    await setTimezone(c.clinicId, "America/New_York");
    // 07:00 UTC on 6 October is 03:00 in New York (EDT).
    const night = new Date("2026-10-06T07:00:00Z");
    const reminder = await enqueue(
      c.clinicId,
      "renewal_upcoming",
      "2026-11-05",
      {
        renewsOn: "2026-11-05",
        amountCents: 120_000,
        planName: "Complete FrontDesk AI",
        locations: 1,
        noticeDays: 30,
      },
      night,
    );
    const urgent = await enqueue(
      c.clinicId,
      "payment_failed",
      "in_5",
      { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
      night,
    );
    const transport = new FakeTransport();

    expect(await deliverNotice(c.clinicId, reminder, { now: night, transport, templates })).toBe(
      "waiting",
    );
    const waiting = await notice(c.clinicId, reminder);
    expect(waiting.send_after.toISOString()).toBe("2026-10-06T11:00:00.000Z");
    expect(waiting.attempts).toBe(0);
    expect(await deliverNotice(c.clinicId, urgent, { now: night, transport, templates })).toBe(
      "sent",
    );

    expect(
      await deliverNotice(c.clinicId, reminder, {
        now: new Date("2026-10-06T11:00:00Z"),
        transport,
        templates,
      }),
    ).toBe("sent");
    expect(transport.calls).toHaveLength(2);
  });

  test("a kind with no template is held: never claimed, logged once, counted", async () => {
    const c = await seedClinic("outbox-held");
    const T = new Date("2026-10-06T15:00:00Z");
    const id = await enqueue(
      c.clinicId,
      "suspended",
      "in_6",
      {
        hostedInvoiceUrl: null,
        amountDueCents: null,
        carrier: null,
        phoneSystem: "unknown",
        routing: "overflow_after_hours",
      },
      T,
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const transport = new FakeTransport();

    const first = await sendPendingNotices({ now: T, transport, templates });
    const second = await sendPendingNotices({ now: T, transport, templates });
    expect(first).toEqual({ sent: 0, failed: 0, skipped: 0, held: 1 });
    expect(second.held).toBe(1);
    expect(transport.calls).toHaveLength(0);
    expect(await notice(c.clinicId, id)).toMatchObject({
      attempts: 0,
      sent_at: null,
      last_error: null,
    });
    expect((await notice(c.clinicId, id)).send_after.getTime()).toBe(T.getTime());
    const heldLines = info.mock.calls.filter((call) => String(call[0]).includes("notice held"));
    expect(heldLines).toHaveLength(1);
    expect(String(heldLines[0]![0])).toContain(id);

    // The job's note says so.
    const outcome = await runBillingNoticesJob({ now: T, transport, templates });
    expect(outcome).toMatchObject({ status: "ok" });
    expect(outcome.status === "ok" && outcome.note).toContain("1 held (no template yet)");
  });

  test("the billing-notices job row is the switch: off, nothing is sent", async () => {
    const c = await seedClinic("outbox-switch");
    const T = new Date("2026-10-06T15:00:00Z");
    await enqueue(c.clinicId, "restored", "r", { receiptUrl: null }, T);
    await setJobEnabled(JOB_BILLING_NOTICES, false, opsUser);
    const transport = new FakeTransport();
    expect(await sendPendingNotices({ now: T, transport, templates })).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      held: 0,
    });
    expect(await runBillingNoticesJob({ now: T, transport, templates })).toEqual({
      status: "disabled",
    });
    await deliverCriticalAfterCommit(c.clinicId, { now: T, transport, templates });
    expect(transport.calls).toHaveLength(0);
  });

  test("the minute job sends every clinic's due notices and records its note", async () => {
    const a = await seedClinic("outbox-job-a");
    const b = await seedClinic("outbox-job-b");
    const T = new Date("2026-10-06T15:00:00Z");
    await enqueue(a.clinicId, "restored", "r", { receiptUrl: null }, T);
    await enqueue(b.clinicId, "restored", "r", { receiptUrl: null }, T);
    // Not due yet: left alone.
    await enqueue(
      b.clinicId,
      "restored",
      "later",
      { receiptUrl: null },
      new Date(T.getTime() + 10 * MINUTE),
    );
    const transport = new FakeTransport();
    const outcome = await runBillingNoticesJob({ now: T, transport, templates });
    expect(outcome).toEqual({ status: "ok", note: "2 sent, 0 failed, 0 waiting or skipped." });
    expect(transport.calls).toHaveLength(2);
  });

  describe("a critical notice ten minutes late", () => {
    async function pollAlerts(
      event: string,
      n: number,
    ): Promise<{ fields: Record<string, unknown>; repeats: number }[]> {
      for (let i = 0; i < 40; i += 1) {
        const rows = await opsAlerts(event);
        if (rows.length >= n) return rows;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return opsAlerts(event);
    }

    test("turns /api/health red with a reason, and tells ops once however often it is probed", async () => {
      const c = await seedClinic("outbox-health");
      const now = new Date();
      const late = await enqueue(
        c.clinicId,
        "payment_failed",
        "late",
        { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
        new Date(now.getTime() - 11 * MINUTE),
      );
      // Five minutes is not late, and a normal kind is never "critical late".
      await enqueue(
        c.clinicId,
        "payment_failed",
        "recent",
        { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
        new Date(now.getTime() - 5 * MINUTE),
      );
      await enqueue(
        c.clinicId,
        "restored",
        "normal",
        { receiptUrl: null },
        new Date(now.getTime() - 60 * MINUTE),
      );

      expect((await lateCriticalNotices(now)).map((n) => n.id)).toEqual([late]);

      const red = await health(new Request("http://localhost/api/health"));
      expect(red.status).toBe(503);
      const body = (await red.json()) as {
        ok: boolean;
        reasons: string[];
        email: { lateCriticalNotices: number };
      };
      expect(body.ok).toBe(false);
      expect(body.reasons).toEqual(["critical_notice_undelivered"]);
      expect(body.email.lateCriticalNotices).toBe(1);
      // The body names no clinic and no notice.
      expect(JSON.stringify(body)).not.toContain(c.clinicId);

      const alerts = await pollAlerts("critical_notice_undelivered", 1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.fields).toMatchObject({ noticeId: late, status: "late" });

      await health(new Request("http://localhost/api/health"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await opsAlerts("critical_notice_undelivered")).toHaveLength(1);

      // The load balancer's probe is liveness only, and stays green.
      const live = await health(new Request("http://localhost/api/health?probe=liveness"));
      expect(live.status).toBe(200);
    });

    test("a retried notice is late from when it was queued; a dead one is not counted", async () => {
      const c = await seedClinic("outbox-health-2");
      const now = new Date();
      const retried = await enqueue(
        c.clinicId,
        "payment_failed",
        "retried",
        { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
        new Date(now.getTime() + 20 * MINUTE),
      );
      const dead = await enqueue(
        c.clinicId,
        "payment_failed",
        "dead",
        { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
        new Date(now.getTime() - 60 * MINUTE),
      );
      // Waiting for the daily quota gives its attempt back, but it has still
      // been tried: a quota that ran out is a mail outage, and health says so.
      const quota = await enqueue(
        c.clinicId,
        "payment_failed",
        "quota",
        { amountDueCents: 1, hostedInvoiceUrl: null, graceEndsAt: null, isFirstPlanCharge: false },
        new Date(now.getTime() + 6 * 60 * MINUTE),
      );
      await inTenant(c.clinicId, async (client) => {
        await client.query(
          `update billing_notices set attempts = 2, created_at = now() - interval '15 minutes' where id = $1`,
          [retried],
        );
        await client.query(`update billing_notices set attempts = $2 where id = $1`, [
          dead,
          MAX_NOTICE_ATTEMPTS,
        ]);
        await client.query(
          `update billing_notices set last_error = 'waiting: Resend''s daily quota is used up until 00:00 UTC',
                  created_at = now() - interval '12 minutes' where id = $1`,
          [quota],
        );
      });
      expect((await lateCriticalNotices(now)).map((n) => n.id).sort()).toEqual(
        [retried, quota].sort(),
      );
    });

    test("with nothing late, health is green", async () => {
      const ok = await health(new Request("http://localhost/api/health"));
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    });
  });
});

describe("the sender's arithmetic", () => {
  test("how each result is read", () => {
    const failed = (statusCode: number | null | undefined, errorName?: string): DeliveryResult => ({
      status: "failed",
      reason: "x",
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(errorName ? { errorName } : {}),
    });
    expect(verdictOf({ status: "sent", messageId: "m" })).toBe("sent");
    expect(verdictOf({ status: "skipped", reason: "no transport" })).toBe("skipped");
    expect(verdictOf(failed(429, "rate_limit_exceeded"))).toBe("retry");
    expect(verdictOf(failed(500, "internal_server_error"))).toBe("retry");
    expect(verdictOf(failed(503, "application_error"))).toBe("retry");
    expect(verdictOf(failed(null, "timeout"))).toBe("retry");
    expect(verdictOf(failed(null, "application_error"))).toBe("retry");
    expect(verdictOf(failed(undefined))).toBe("retry");
    expect(verdictOf(failed(409, "concurrent_idempotent_requests"))).toBe("retry");
    expect(verdictOf(failed(409, "invalid_idempotent_request"))).toBe("sent");
    expect(verdictOf(failed(429, "daily_quota_exceeded"))).toBe("quota");
    expect(verdictOf(failed(422, "validation_error"))).toBe("permanent");
    expect(verdictOf(failed(403, "validation_error"))).toBe("permanent");
    expect(verdictOf(failed(undefined, "invalid_message"))).toBe("permanent");
  });

  test("quiet hours follow the clinic's clock across daylight saving", () => {
    const ny = "America/New_York";
    // Daytime: now.
    const noon = new Date("2026-10-06T16:00:00Z");
    expect(nextDaytime(noon, ny)).toBe(noon);
    // 20:30 EDT waits for 07:00 EDT the next morning.
    expect(nextDaytime(new Date("2026-10-07T00:30:00Z"), ny).toISOString()).toBe(
      "2026-10-07T11:00:00.000Z",
    );
    // The night the clocks go back: midnight EDT, 07:00 EST.
    expect(nextDaytime(new Date("2026-11-01T04:00:00Z"), ny).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    // The night they go forward: midnight EST, 07:00 EDT.
    expect(nextDaytime(new Date("2027-03-14T05:00:00Z"), ny).toISOString()).toBe(
      "2027-03-14T11:00:00.000Z",
    );
    // An unknown zone has no quiet hours.
    const any = new Date("2026-10-06T07:00:00Z");
    expect(nextDaytime(any, "Not/AZone")).toBe(any);
  });

  test("the daily quota resets at 00:05 UTC", () => {
    expect(nextQuotaReset(new Date("2026-10-06T22:10:00Z")).toISOString()).toBe(
      "2026-10-07T00:05:00.000Z",
    );
    expect(nextQuotaReset(new Date("2026-10-07T00:02:00Z")).toISOString()).toBe(
      "2026-10-07T00:05:00.000Z",
    );
  });
});
