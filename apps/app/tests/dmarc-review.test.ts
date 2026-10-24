import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DMARC_REVIEW_EVENT,
  resendFirstSendingDay,
  runDmarcReviewJob,
} from "@/lib/scheduler/dmarc-review";
import { getJob, JOB_DMARC_REVIEW } from "@/lib/scheduler/jobs";
import { runTick } from "@/lib/scheduler/tick";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The DMARC review reminder (lib/scheduler/dmarc-review.ts): one ops alert,
 * ever, on the 14th UTC day after Resend first sent as healdesk.io, as
 * apps/app's own records show it. Nothing before then, nothing after it has
 * fired, nothing at all while nothing has been sent.
 *
 * Resend is stubbed at the SDK, as in tests/ops-notify.test.ts, so the stub
 * is the wire: an email it was not handed did not leave the machine.
 */

const send = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

/**
 * Each test truncates, seeds a clinic or two and runs the job, some of them
 * several times, which a loaded machine can stretch past vitest's defaults (5
 * seconds a test, 10 a hook) while every assertion holds. The bounds are
 * generous so that only a real hang fails for time.
 */
const TEST_MS = 30_000;
const HOOK_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A run at the job's own hour, 08 UTC. */
const NOW = new Date("2026-10-20T08:00:00Z");
const daysBefore = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY_MS);

const SAVED: Record<string, string | undefined> = {};
const ENV = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_OPS_EMAIL",
  "BETTER_AUTH_URL",
] as const;

let keys = 0;

/** One ledger row, as the outbox writes it: sent_at only on a send that went. */
async function recordLedgerSend(clinicId: string, at: Date, status = "sent"): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into report_deliveries
         (clinic_id, kind, period_key, recipient, status, message_id, attempted_at, sent_at)
       values ($1, 'payment_failed', $2, 'owner@example-clinic.test', $3::text,
               case when $3::text = 'sent' then 'msg_ledger' end, $4::timestamptz,
               case when $3::text = 'sent' then $4::timestamptz end)`,
      [clinicId, randomUUID(), status, at],
    ),
  );
}

/** One day of Resend's account-wide count, as lib/email/quota.ts records it. */
async function recordQuotaDay(at: Date, used: number): Promise<void> {
  await getMigratorPool().query(
    `insert into email_daily_quota (day, used, observed_at) values ($1::date, $2, $3)`,
    [at.toISOString().slice(0, 10), used, at],
  );
}

async function alerts() {
  const { rows } = await getMigratorPool().query<{
    event: string;
    fields: Record<string, unknown>;
    repeats: number;
    sent_at: Date | null;
  }>(`select event, fields, repeats, sent_at from ops_alerts order by raised_at`);
  return rows;
}

async function switchOn(): Promise<void> {
  await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [
    JOB_DMARC_REVIEW,
  ]);
}

describeDb("the DMARC review reminder", { timeout: TEST_MS }, () => {
  beforeAll(async () => {
    await runMigrations();
  }, HOOK_MS);

  beforeEach(async () => {
    for (const key of ENV) SAVED[key] = process.env[key];
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    // A fresh key per test: the SDK client is memoised by key.
    process.env.RESEND_API_KEY = `re_stub_dmarc_${keys++}`;
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    send.mockReset();
    send.mockResolvedValue({ data: { id: "msg_dmarc" }, error: null, headers: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // Clinics cascade to the ledger; the two ops tables have no clinic.
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
    await switchOn();
  }, HOOK_MS);

  afterEach(() => {
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

  test("does nothing at all while nothing has been sent", async () => {
    // A failed or skipped ledger row is not a send, and neither is a count of
    // zero: Resend refused a request on a day the account had sent nothing.
    const { clinicId } = await seedClinic("dmarc-nothing");
    await recordLedgerSend(clinicId, daysBefore(30), "failed");
    await recordLedgerSend(clinicId, daysBefore(30), "skipped");
    await recordQuotaDay(daysBefore(30), 0);
    expect(await resendFirstSendingDay()).toBeNull();

    expect(await runDmarcReviewJob({ now: NOW })).toEqual({
      status: "ok",
      note: "No email sent through Resend is on record yet; nothing to do.",
    });
    expect(send).not.toHaveBeenCalled();
    expect(await alerts()).toEqual([]);
  });

  test("waits while Resend's first send is 13 days old", async () => {
    const { clinicId } = await seedClinic("dmarc-13");
    await recordLedgerSend(clinicId, daysBefore(13));
    await recordQuotaDay(daysBefore(13), 4);

    expect(await runDmarcReviewJob({ now: NOW })).toEqual({
      status: "ok",
      note: "Resend first sent on 2026-10-07, 13 days ago; the DMARC review is due on 2026-10-21.",
    });
    expect(send).not.toHaveBeenCalled();
    expect(await alerts()).toEqual([]);
  });

  test("raises one alert to ops when the first send is 14 days old", async () => {
    const { clinicId } = await seedClinic("dmarc-14");
    await recordLedgerSend(clinicId, daysBefore(14));
    await recordLedgerSend(clinicId, daysBefore(3));
    await recordQuotaDay(daysBefore(14), 2);

    expect(await runDmarcReviewJob({ now: NOW })).toEqual({
      status: "ok",
      note: "Resend first sent on 2026-10-06, 14 days ago: raised the DMARC review alert and emailed it.",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.to).toBe("ops@healdesk.test");
    expect(payload.subject).toBe("healdesk ops: Time to review the DMARC reports");
    const text = String(payload.text);
    expect(text).toContain("p=none");
    expect(text).toContain("p=quarantine");
    // The first-send day is in the sentence now (lane N2), and the step says
    // where the reports are: the mailbox named in the DMARC record in Cloudflare.
    expect(text).toContain("since 6 Oct or earlier");
    expect(text).toMatch(/1\. Read healdesk\.io's DMARC aggregate reports from 6 Oct on, in the mailbox named after rua= in the DMARC record in Cloudflare\./);
    // An ops alert names no clinic and no address but our own.
    expect(`${text}\n${String(payload.html)}`).not.toContain("example-clinic.test");

    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: DMARC_REVIEW_EVENT,
      fields: { windowStart: "2026-10-06" },
      repeats: 0,
    });
    expect(rows[0]!.sent_at).not.toBeNull();
    expect((await getJob(JOB_DMARC_REVIEW))?.lastRunStatus).toBe("ok");
  });

  test("is silent once it has fired, however often it runs and whatever it would find", async () => {
    const first = await seedClinic("dmarc-first");
    const second = await seedClinic("dmarc-second");
    await recordLedgerSend(first.clinicId, daysBefore(15));
    await recordLedgerSend(second.clinicId, daysBefore(14));
    await runDmarcReviewJob({ now: NOW });
    expect(send).toHaveBeenCalledTimes(1);

    // The same day, the next day and a month on.
    for (const now of [
      NOW,
      new Date(NOW.getTime() + DAY_MS),
      new Date(NOW.getTime() + 30 * DAY_MS),
    ]) {
      const outcome = await runDmarcReviewJob({ now });
      expect(outcome.status).toBe("ok");
      expect(outcome).toMatchObject({
        note: expect.stringMatching(
          /^The DMARC review alert was raised on \d{4}-\d{2}-\d{2}; nothing more to do\.$/,
        ),
      });
    }

    // The earliest send leaves the records (its clinic's rows went), so the
    // first-send day a fresh look would find has moved, and with it the
    // alert's fields. Still nothing: once is the ops log's, by event.
    await inTenant(first.clinicId, (c) =>
      c.query(`delete from report_deliveries where clinic_id = $1`, [first.clinicId]),
    );
    expect(await resendFirstSendingDay()).toBe("2026-10-06");
    await runDmarcReviewJob({ now: new Date(NOW.getTime() + 2 * DAY_MS) });

    expect(send).toHaveBeenCalledTimes(1);
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    // Not even a repeat: a run that finds the alert stops before raising.
    expect(rows[0]).toMatchObject({ fields: { windowStart: "2026-10-05" }, repeats: 0 });
  });

  test("takes the earlier of its two records: the quota day counts apps/web's mail too", async () => {
    // apps/app's ledger shows a send 10 days ago; Resend's count shows mail
    // on the account 14 days ago, apps/web's or apps/app's own unledgered
    // mail (an ops alert, a sign-in link). The count decides.
    const { clinicId } = await seedClinic("dmarc-quota");
    await recordLedgerSend(clinicId, daysBefore(10));
    await recordQuotaDay(daysBefore(14), 3);
    expect(await resendFirstSendingDay()).toBe("2026-10-06");

    await runDmarcReviewJob({ now: NOW });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await alerts())[0]).toMatchObject({ fields: { windowStart: "2026-10-06" } });
  });

  test("the ledger alone is enough: after a move to Pro, Resend sends no count", async () => {
    const { clinicId } = await seedClinic("dmarc-pro");
    await recordLedgerSend(clinicId, daysBefore(20));
    expect(await resendFirstSendingDay()).toBe("2026-09-30");
    await runDmarcReviewJob({ now: NOW });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("counts UTC calendar days, as Resend counts its quota day", async () => {
    // Sent at 23:30 UTC on 6 October: 7 October is day one, and 20 October
    // is day 14, though 13 days and 8 and a half hours have passed.
    const { clinicId } = await seedClinic("dmarc-utc");
    await recordLedgerSend(clinicId, new Date("2026-10-06T23:30:00Z"));

    expect(await runDmarcReviewJob({ now: new Date("2026-10-06T23:45:00Z") })).toMatchObject({
      note: "Resend first sent on 2026-10-06, today; the DMARC review is due on 2026-10-20.",
    });
    expect(await runDmarcReviewJob({ now: new Date("2026-10-19T23:59:00Z") })).toMatchObject({
      note: "Resend first sent on 2026-10-06, 13 days ago; the DMARC review is due on 2026-10-20.",
    });
    expect(send).not.toHaveBeenCalled();

    await runDmarcReviewJob({ now: new Date("2026-10-20T08:00:00Z") });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("says when the alert was raised but its email did not go, then and on every later run", async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    const admin = process.env.HEALDESK_ADMIN_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    try {
      const { clinicId } = await seedClinic("dmarc-unmailed");
      await recordLedgerSend(clinicId, daysBefore(14));
      expect(await runDmarcReviewJob({ now: NOW })).toEqual({
        status: "ok",
        note:
          "Resend first sent on 2026-10-06, 14 days ago: raised the DMARC review alert, " +
          "but its email did not go: HEALDESK_OPS_EMAIL is not set.",
      });
      expect(await runDmarcReviewJob({ now: NOW })).toMatchObject({
        note: expect.stringMatching(/, but its email did not go; nothing more to do\.$/),
      });
      expect(send).not.toHaveBeenCalled();
      expect(await alerts()).toHaveLength(1);
    } finally {
      if (admin !== undefined) process.env.HEALDESK_ADMIN_EMAIL = admin;
    }
  });

  test("says so when the ops log could not record the alert, which may then come again", async () => {
    // The runtime role loses INSERT on the ops log for this test only, so
    // notifyOpsOnce falls back to deduplicating in memory: the email still
    // goes, and no row is left to stop a fresh process raising it again.
    const { clinicId } = await seedClinic("dmarc-unrecorded");
    await recordLedgerSend(clinicId, daysBefore(14));
    await getMigratorPool().query(`revoke insert on ops_alerts from healdesk_app`);
    try {
      expect(await runDmarcReviewJob({ now: NOW })).toEqual({
        status: "ok",
        note:
          "Resend first sent on 2026-10-06, 14 days ago: raised the DMARC review alert, " +
          "but the ops log could not record it, so a later run may raise it again.",
      });
    } finally {
      await getMigratorPool().query(`grant insert on ops_alerts to healdesk_app`);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(await alerts()).toEqual([]);
  });

  test("ships seeded off, and does nothing while off", async () => {
    // Read the migration, not the table: truncateAll() reseeds scheduled_jobs
    // from tests/setup/db.ts, so a query alone would check the harness's copy.
    // Found by its tag, not its number, which is assigned when the branch
    // merges.
    const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_dmarc_review\.sql$/.test(name));
    expect(files).toHaveLength(1);
    const migration = readFileSync(`${drizzleDir}${files[0]!}`, "utf8");
    const insert = migration.match(
      /INSERT INTO scheduled_jobs[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/i,
    )?.[0];
    expect(insert, "the migration seeds scheduled_jobs").toBeDefined();
    // ('name', 'cadence, with '' escapes', enabled)
    const row = /\(\s*'([a-z-]+)'\s*,\s*'((?:[^']|'')*)'\s*,\s*(true|false)\s*\)/gi;
    const seeded = [...insert!.matchAll(row)].map((m) => ({
      name: m[1]!,
      cadence: m[2]!.replace(/''/g, "'"),
      enabled: m[3]!.toLowerCase(),
    }));
    // The name the code reads: a mismatch makes runJob throw "Unknown job".
    expect(seeded.map(({ name, enabled }) => [name, enabled])).toEqual([
      [JOB_DMARC_REVIEW, "false"],
    ]);
    expect(seeded[0]!.cadence).toMatch(/^Daily at 08 UTC;/);

    // And the harness reseeds it, off, with the migration's own cadence.
    await truncateAll();
    const job = await getJob(JOB_DMARC_REVIEW);
    expect(job?.enabled).toBe(false);
    expect(job?.cadence).toBe(seeded[0]!.cadence);

    const { clinicId } = await seedClinic("dmarc-off");
    await recordLedgerSend(clinicId, daysBefore(30));
    expect(await runDmarcReviewJob({ now: NOW })).toEqual({ status: "disabled" });
    expect(send).not.toHaveBeenCalled();
    expect(await alerts()).toEqual([]);
  });

  test("runs from the 08 UTC tick, and from no other hour's", async () => {
    const at = async (iso: string) =>
      (await runTick(new Date(iso))).find((outcome) => outcome.job === "dmarc-review");
    expect(await at("2026-10-20T08:00:00Z")).toMatchObject({
      status: "ok",
      note: "No email sent through Resend is on record yet; nothing to do.",
    });
    for (const hour of ["07", "09"]) {
      expect(await at(`2026-10-20T${hour}:00:00Z`), hour).toBeUndefined();
    }
  });
});

describeDb("app_first_email_sent_at", { timeout: TEST_MS }, () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, HOOK_MS);

  afterAll(async () => {
    await closePools();
  });

  test("walks every clinic for the earliest send, returns one timestamp and restores the caller's tenant", async () => {
    const a = await seedClinic("first-send-a");
    const b = await seedClinic("first-send-b");
    await recordLedgerSend(a.clinicId, new Date("2026-10-08T10:00:00Z"));
    await recordLedgerSend(b.clinicId, new Date("2026-10-07T09:00:00Z"));
    // Earlier, and not sends.
    await recordLedgerSend(a.clinicId, new Date("2026-10-01T09:00:00Z"), "failed");
    await recordLedgerSend(b.clinicId, new Date("2026-10-01T09:00:00Z"), "skipped");

    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      // Why it walks: the runtime role sees no ledger row without a tenant.
      const plain = await client.query<{ n: number }>(
        `select count(*)::int as n from report_deliveries`,
      );
      expect(plain.rows[0]!.n).toBe(0);

      await client.query(`select set_config('app.clinic_id', $1, true)`, [a.clinicId]);
      const { rows } = await client.query<Record<string, unknown>>(
        `select app_first_email_sent_at() as first_sent_at`,
      );
      expect(Object.keys(rows[0]!)).toEqual(["first_sent_at"]);
      expect((rows[0]!.first_sent_at as Date).toISOString()).toBe("2026-10-07T09:00:00.000Z");
      const tenant = await client.query<{ tenant: string }>(
        `select current_setting('app.clinic_id', true) as tenant`,
      );
      expect(tenant.rows[0]!.tenant).toBe(a.clinicId);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});
