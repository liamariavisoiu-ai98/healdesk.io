import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { MAX_WRITE_ATTEMPTS } from "@/lib/booking/calendar";
import { ALERT_LOOKBACK_DAYS, alertStuckCalendarWrites, SUMMARY_ABOVE } from "@/lib/ops/calendar-write-alerts";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Calendar writes that need a person (design E3, "Calendar writes alert
 * nobody"). A booking still on whose Google write ended `failed`, or
 * `unknown` at its five attempts, or whose slot started before it settled,
 * or a claim stuck `writing` the sweep can no longer take, raises
 * calendar_write_stuck once per write and state; a write still waiting for
 * its next attempt on the ladder (however old: the sweep keeps trying until
 * the slot starts), an attempt in flight, a written one, a cancelled booking
 * and one older than the alert's own look-back raise nothing, and every
 * rerun is a no-op.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const NOW = new Date("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;

describeDb("calendar write alerts", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  let phone = 0;
  async function write(
    clinicId: string,
    input: {
      write: string;
      attempts: number;
      error?: string | null;
      updatedAt: Date;
      status?: string;
      scheduledFor?: Date;
      nextAt?: Date | null;
    },
  ): Promise<string> {
    phone += 1;
    return inTenant(clinicId, async (c) => {
      const { rows: contact } = await c.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
        [clinicId, `+1555020${String(1000 + phone)}`],
      );
      const { rows } = await c.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, status,
                                   calendar_write_status, calendar_write_attempts, calendar_write_error)
         values ($1, $2, $3, $4::appointment_status, $5, $6, $7) returning id`,
        [
          clinicId,
          contact[0]!.id,
          input.scheduledFor ?? new Date(NOW.getTime() + 4 * 24 * HOUR),
          input.status ?? "scheduled",
          input.write,
          input.attempts,
          input.error ?? null,
        ],
      );
      await c.query(
        `update appointments set updated_at = $2, calendar_write_next_at = $3 where id = $1`,
        [rows[0]!.id, input.updatedAt, input.nextAt ?? null],
      );
      return rows[0]!.id;
    });
  }

  /** The calendar watch's switch: the desk sweep, the only automatic retry, runs only while it is on. */
  async function sweep(enabled: boolean) {
    await getMigratorPool().query(`update scheduled_jobs set enabled = $1 where name = 'calendar-watch'`, [enabled]);
  }

  async function alerts() {
    const { rows } = await getMigratorPool().query<{ event: string; fields: Record<string, unknown> }>(
      `select event, fields from ops_alerts where event = 'calendar_write_stuck'`,
    );
    return rows;
  }

  test("each stuck write is told once; the rest are left alone (the sweep switched on)", async () => {
    await sweep(true);
    const clinic = await seedClinic("calwrites");
    const recent = new Date(NOW.getTime() - HOUR);
    const days = (n: number) => new Date(NOW.getTime() + n * 24 * HOUR);
    const ancient = new Date(NOW.getTime() - (ALERT_LOOKBACK_DAYS * 24 + 1) * HOUR);

    const failed = await write(clinic.clinicId, { write: "failed", attempts: 1, error: "event_id_taken", updatedAt: recent });
    const outOfAttempts = await write(clinic.clinicId, {
      write: "unknown",
      attempts: MAX_WRITE_ATTEMPTS,
      error: "timeout",
      updatedAt: recent,
    });
    // Its slot started before Google ever answered: the sweep stopped.
    const abandoned = await write(clinic.clinicId, {
      write: "unknown",
      attempts: 2,
      error: "network",
      updatedAt: days(-3),
      scheduledFor: new Date(NOW.getTime() - HOUR),
    });
    // Unknown, but with a reason the sweep never retries: nobody will.
    const settled = await write(clinic.clinicId, {
      write: "unknown",
      attempts: 1,
      error: "deleted_in_calendar",
      updatedAt: recent,
    });
    // Still waiting on the ladder (even three days on, the slot ahead),
    // written, cancelled, or too old: nothing. (A claim stuck `writing`
    // cannot be seeded here: the write guard of drizzle/0060 refuses one
    // without a calendar healdesk may write to; tests/calendar-write-backoff
    // covers it against the fake Google.)
    await write(clinic.clinicId, { write: "unknown", attempts: 2, error: "timeout", updatedAt: recent, nextAt: days(0.01) });
    await write(clinic.clinicId, { write: "unknown", attempts: 3, error: "network", updatedAt: days(-3) });
    await write(clinic.clinicId, { write: "written", attempts: 1, updatedAt: recent });
    await write(clinic.clinicId, { write: "failed", attempts: 1, error: "not_ours", updatedAt: recent, status: "cancelled" });
    await write(clinic.clinicId, { write: "failed", attempts: 1, error: "event_id_taken", updatedAt: ancient });

    const result = await alertStuckCalendarWrites(NOW);
    expect(result).toMatchObject({ found: 4, failures: 0 });
    const raised = await alerts();
    expect(raised.map((a) => a.fields.appointmentId).sort()).toEqual(
      [failed, outOfAttempts, abandoned, settled].sort(),
    );
    expect(raised.find((a) => a.fields.appointmentId === failed)!.fields).toEqual({
      clinicId: clinic.clinicId,
      appointmentId: failed,
      status: "failed",
      code: "event_id_taken",
      attemptCount: 1,
    });

    // The next hour, and the one after: no new alert.
    await alertStuckCalendarWrites(new Date(NOW.getTime() + HOUR));
    await alertStuckCalendarWrites(new Date(NOW.getTime() + 2 * HOUR));
    expect(await alerts()).toHaveLength(4);
  });

  test("a write that moves from unknown to failed is told again, once", async () => {
    const clinic = await seedClinic("calwrites-move");
    const id = await write(clinic.clinicId, {
      write: "unknown",
      attempts: MAX_WRITE_ATTEMPTS,
      error: "timeout",
      updatedAt: new Date(NOW.getTime() - HOUR),
    });
    await alertStuckCalendarWrites(NOW);
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update appointments set calendar_write_status = 'failed', calendar_write_error = 'not_ours' where id = $1`, [id]),
    );
    await alertStuckCalendarWrites(new Date(NOW.getTime() + HOUR));
    await alertStuckCalendarWrites(new Date(NOW.getTime() + 2 * HOUR));
    expect((await alerts()).map((a) => a.fields.status).sort()).toEqual(["failed", "unknown"]);
  });

  test("a failed write retried by an operator that fails again, same code, is told again; one failure seen twice is told once", async () => {
    const clinic = await seedClinic("calwrites-retry");
    const id = await write(clinic.clinicId, {
      write: "failed",
      attempts: 1,
      error: "event_id_taken",
      updatedAt: new Date(NOW.getTime() - HOUR),
    });
    await alertStuckCalendarWrites(NOW);
    await alertStuckCalendarWrites(new Date(NOW.getTime() + HOUR));
    expect(await alerts()).toHaveLength(1);
    // The operator's retry claims a second attempt, and Google refuses it the same way.
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update appointments set calendar_write_attempts = 2 where id = $1`, [id]),
    );
    await alertStuckCalendarWrites(new Date(NOW.getTime() + 2 * HOUR));
    await alertStuckCalendarWrites(new Date(NOW.getTime() + 3 * HOUR));
    expect((await alerts()).map((a) => a.fields.attemptCount).sort()).toEqual([1, 2]);
  });

  test("more than five new stuck writes in one run are one summary, and each is recorded as told", async () => {
    const clinic = await seedClinic("calwrites-flood");
    const recent = new Date(NOW.getTime() - HOUR);
    for (let i = 0; i < SUMMARY_ABOVE + 2; i += 1) {
      await write(clinic.clinicId, { write: "failed", attempts: 1, error: "not_ours", updatedAt: recent });
    }
    const result = await alertStuckCalendarWrites(NOW);
    expect(result).toMatchObject({ found: SUMMARY_ABOVE + 2, covered: SUMMARY_ABOVE + 2 });
    const { rows: summary } = await getMigratorPool().query<{ fields: Record<string, unknown>; sent_at: Date | null }>(
      `select fields, sent_at from ops_alerts where event = 'calendar_writes_stuck_many'`,
    );
    expect(summary).toHaveLength(1);
    expect(summary[0]!.fields.count).toBe(SUMMARY_ABOVE + 2);
    // Each write is on the ops log as told: never emailed, never posted to Slack.
    const { rows: covered } = await getMigratorPool().query<{
      last_error: string;
      slack_next_at: Date | string;
    }>(`select last_error, slack_next_at::text as slack_next_at from ops_alerts where event = 'calendar_write_stuck'`);
    expect(covered).toHaveLength(SUMMARY_ABOVE + 2);
    for (const row of covered) {
      expect(row.last_error).toMatch(/summary/);
      expect(row.slack_next_at).toBe("infinity");
    }

    // The next run tells nothing more; a new failure after it is told on its own.
    await alertStuckCalendarWrites(new Date(NOW.getTime() + HOUR));
    await write(clinic.clinicId, { write: "failed", attempts: 1, error: "event_id_taken", updatedAt: NOW });
    await alertStuckCalendarWrites(new Date(NOW.getTime() + 2 * HOUR));
    expect(await alerts()).toHaveLength(SUMMARY_ABOVE + 3);
    const { rows: told } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts where event = 'calendar_write_stuck' and last_error is distinct from 'Covered by a summary alert.'`,
    );
    expect(told[0]!.n).toBe(1);
    const { rows: summaries } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts where event = 'calendar_writes_stuck_many'`,
    );
    expect(summaries[0]!.n).toBe(1);
  });

  test("with the sweep switched off nothing retries, so an unknown write untouched for a day is stuck; with it on it waits", async () => {
    const clinic = await seedClinic("calwrites-off");
    const stale = await write(clinic.clinicId, {
      write: "unknown",
      attempts: 2,
      error: "network",
      updatedAt: new Date(NOW.getTime() - 25 * HOUR),
      nextAt: new Date(NOW.getTime() - 24 * HOUR),
    });
    // Touched an hour ago: not yet, either way.
    await write(clinic.clinicId, { write: "unknown", attempts: 1, error: "timeout", updatedAt: new Date(NOW.getTime() - HOUR) });

    await sweep(true);
    expect(await alertStuckCalendarWrites(NOW)).toMatchObject({ found: 0 });
    expect(await alerts()).toHaveLength(0);

    await sweep(false);
    expect(await alertStuckCalendarWrites(NOW)).toMatchObject({ found: 1 });
    expect((await alerts()).map((a) => a.fields.appointmentId)).toEqual([stale]);
  });
});
