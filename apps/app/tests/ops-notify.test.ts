import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { recordDailyQuota } from "@/lib/email/quota";
import { notifyOps, notifyOpsOnce, OPS_DEDUPE_WINDOW_MS } from "@/lib/ops/notify";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * notifyOps, made real (Annex X3 and X5, I1): it still logs every call, it
 * records each alert in the ops log, it mails HEALDESK_OPS_EMAIL through the
 * email platform once per identical alert per hour, and it never throws.
 *
 * Resend is stubbed at the SDK, so the stub IS the wire: what it was handed is
 * what would have left the machine.
 */

const send = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const NOTICE_A = "5f0e4a1b-1111-4222-8333-444455556666";
const NOTICE_B = "5f0e4a1b-1111-4222-8333-777788889999";

const SAVED: Record<string, string | undefined> = {};
const ENV = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_OPS_EMAIL",
  "BETTER_AUTH_URL",
  "HEALDESK_CONSOLE_ORIGIN",
] as const;

let keys = 0;

/** The payloads handed to Resend, in order. */
function sent(): {
  payload: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}[] {
  return send.mock.calls.map((call) => ({
    payload: call[0] as Record<string, unknown>,
    options: call[1] as Record<string, unknown> | undefined,
  }));
}

describeDb("notifyOps", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    for (const key of ENV) SAVED[key] = process.env[key];
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    // A fresh key per test: the SDK client is memoised by key.
    process.env.RESEND_API_KEY = `re_stub_${keys++}`;
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_CONSOLE_ORIGIN = "https://healdesk.test";
    send.mockReset();
    send.mockResolvedValue({ data: { id: "msg_ops" }, error: null, headers: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV) {
      const value = SAVED[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await closePools();
  });

  test("mails the ops address once, ids and counts only, keyed on its ops-log row", async () => {
    await notifyOps("critical_notice_undelivered", {
      clinicId: CLINIC,
      noticeId: NOTICE_A,
      kind: "payment_failed",
      status: "late",
      attempts: 3,
      reason: "Resend said owner@radiance.test bounced",
      email: "owner@radiance.test",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const { payload, options } = sent()[0]!;
    const { rows } = await getMigratorPool().query<{
      id: string;
      sent_at: Date | null;
      message_id: string | null;
    }>(`select id, sent_at, message_id from ops_alerts`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe("msg_ops");
    expect(payload.to).toBe("ops@healdesk.test");
    expect(payload.subject).toBe("healdesk ops: A critical email has not gone out");
    expect(payload.replyTo).toBe("hello@healdesk.io");
    expect(payload.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "ops_alert" },
      { name: "delivery", value: rows[0]!.id },
    ]);
    expect(options).toEqual({ idempotencyKey: `hd-ops_alert-${rows[0]!.id}-1` });

    const body = `${String(payload.text)}\n${String(payload.html)}`;
    expect(body).toContain(NOTICE_A);
    expect(body).toContain("payment_failed");
    // Free text and anything off the allowlist stay in the log, out of the email.
    expect(body).not.toContain("owner@radiance.test");
    expect(body).not.toContain("bounced");
  });

  test("prints the clinic's name beside its id (owner decision D2), never storing it on the alert", async () => {
    const clinic = await seedClinic("opsname");
    await notifyOps("usage_cap_reached", {
      clinicId: clinic.clinicId,
      meter: "voice_minutes",
      windowStart: "2026-10-01T00:00:00.000Z",
      used: 1_001,
      included: 1_000,
    });
    const { payload } = sent()[0]!;
    const body = `${String(payload.text)}\n${String(payload.html)}`;
    expect(body).toContain("opsname Clinic");
    expect(body).toContain(clinic.clinicId);
    expect(body).toContain("1001");
    // And its console page (decision D3), the email's one link.
    expect(body).toContain(`https://healdesk.test/admin/ops/${clinic.clinicId}/care`);
    const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts`,
    );
    expect(JSON.stringify(rows[0]!.fields)).not.toContain("opsname");
  });

  test("identical alerts within the hour are one email; the repeat is counted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    const fields = { clinicId: CLINIC, noticeId: NOTICE_A, kind: "payment_failed", status: "late" };

    await notifyOps("critical_notice_undelivered", { ...fields, attempts: 2 });
    // A counter changing does not make it a different alert.
    await notifyOps("critical_notice_undelivered", { ...fields, attempts: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    const { rows } = await getMigratorPool().query<{ repeats: number }>(
      `select repeats from ops_alerts`,
    );
    expect(rows).toEqual([{ repeats: 1 }]);

    // Another notice is another alert.
    await notifyOps("critical_notice_undelivered", { ...fields, noticeId: NOTICE_B });
    expect(send).toHaveBeenCalledTimes(2);

    // An hour on, the same alert goes again.
    vi.setSystemTime(new Date(Date.now() + OPS_DEDUPE_WINDOW_MS + 1000));
    await notifyOps("critical_notice_undelivered", { ...fields, attempts: 4 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("still writes its log line on every call, deduplicated or not", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyOps("duplicate_subscription", { clinicId: CLINIC, count: 2 });
    await notifyOps("duplicate_subscription", { clinicId: CLINIC, count: 2 });
    const lines = error.mock.calls.filter((call) =>
      String(call[0]).startsWith("[healdesk] ops alert"),
    );
    expect(lines).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("notifyOpsOnce raises an alert once, ever", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    const fields = { clinicId: CLINIC, noticeId: NOTICE_A, kind: "payment_failed", status: "late" };
    await notifyOpsOnce("critical_notice_undelivered", fields);
    vi.setSystemTime(new Date(Date.now() + 5 * OPS_DEDUPE_WINDOW_MS));
    await notifyOpsOnce("critical_notice_undelivered", fields);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("never throws: not when Resend fails, not when it throws, not without an address", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: "internal_server_error", message: "down", statusCode: 500 },
      headers: null,
    });
    await expect(
      notifyOps("support_reply_past_due", { requestId: "req_1" }),
    ).resolves.toBeUndefined();
    const { rows } = await getMigratorPool().query<{ last_error: string | null }>(
      `select last_error from ops_alerts`,
    );
    expect(rows[0]!.last_error).toMatch(/^failed: /);

    send.mockRejectedValue(new Error("socket hang up"));
    await expect(
      notifyOps("support_reply_past_due", { requestId: "req_2" }),
    ).resolves.toBeUndefined();

    delete process.env.HEALDESK_OPS_EMAIL;
    const admin = process.env.HEALDESK_ADMIN_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    try {
      await expect(
        notifyOps("support_reply_past_due", { requestId: "req_3" }),
      ).resolves.toBeUndefined();
    } finally {
      if (admin !== undefined) process.env.HEALDESK_ADMIN_EMAIL = admin;
    }
  });

  test("the day's email count alarms once at 70", async () => {
    const day = new Date("2026-10-06T18:00:00Z");
    await recordDailyQuota(69, day);
    expect(send).not.toHaveBeenCalled();
    await recordDailyQuota(70, day);
    await recordDailyQuota(85, day);
    await recordDailyQuota(80, day); // an older response arriving late never lowers the count
    const alarms = sent().filter((s) => String(s.payload.subject).includes("70 emails"));
    expect(alarms).toHaveLength(1);
    const { rows } = await getMigratorPool().query<{ used: number; alerted_at: Date | null }>(
      `select used, alerted_at from email_daily_quota where day = '2026-10-06'`,
    );
    expect(rows[0]!.used).toBe(85);
    expect(rows[0]!.alerted_at).not.toBeNull();
  });
});
