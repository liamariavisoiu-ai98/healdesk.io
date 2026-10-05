import { getPlan } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  addMonthsUtc,
  allowanceWindow,
  recordFirstInvoice,
  rollAllowancePeriod,
  seedEntitlements,
  setGrace,
} from "@/lib/billing/entitlements";
import { transition } from "@/lib/billing/state-machine";
import { runBillingSweepJob, sweepBilling } from "@/lib/scheduler/billing-sweep";
import { JOB_BILLING_SWEEP, getJob, setJobEnabled } from "@/lib/scheduler/jobs";
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
 * The two clocks Stripe does not run: grace expiry and the annual clinic's
 * monthly allowance. Both are asserted at a chosen `now`, never the wall
 * clock, so the tests say exactly which boundary they are on.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describe("allowance window arithmetic", () => {
  test("addMonthsUtc clamps to the last day of the target month", () => {
    expect(addMonthsUtc(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addMonthsUtc(new Date("2026-03-31T00:00:00Z"), 1).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
    expect(addMonthsUtc(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
    expect(addMonthsUtc(new Date("2026-05-10T00:00:00Z"), 12).toISOString()).toBe(
      "2027-05-10T00:00:00.000Z",
    );
  });

  test("a monthly clinic's window is the invoiced period; an annual one's is its first month", () => {
    const start = new Date("2026-09-12T00:00:00Z");
    const month = { start, end: new Date("2026-10-12T00:00:00Z") };
    const year = { start, end: new Date("2027-09-12T00:00:00Z") };

    expect(allowanceWindow("month", month)).toEqual(month);
    expect(allowanceWindow("year", year)).toEqual({
      start,
      end: new Date("2026-10-12T00:00:00Z"),
    });
    // Never past the invoiced end, whatever the interval says.
    expect(allowanceWindow("year", month)).toEqual(month);
  });
});

describeDb("billing sweep", () => {
  let lapsed: string;
  let annual: string;
  const yearStart = new Date("2026-09-01T00:00:00Z");

  async function seedOpsUser(): Promise<string> {
    const id = `usr_ops_${Math.random().toString(36).slice(2, 10)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Ops', $2, true, now(), now())`,
      [id, `${id}@healdesk.test`],
    );
    return id;
  }

  async function row(clinicId: string): Promise<{
    status: string;
    grace_ends_at: Date | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    used_voice_minutes: string;
    used_chat_conversations: number;
  }> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query(`select * from entitlements where clinic_id = $1`, [clinicId]),
    );
    return rows[0] as never;
  }

  async function reasons(clinicId: string): Promise<string[]> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ reason: string }>(
        `select reason from billing_transitions where clinic_id = $1 order by created_at`,
        [clinicId],
      ),
    );
    return rows.map((r) => r.reason);
  }

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();

    // A monthly clinic whose renewal failed: past_due with a grace window
    // that closed the day before the pinned `yearStart` every sweep below
    // runs at or after.
    lapsed = (await seedClinic("lapsed")).clinicId;
    await withTenant({ clinicId: lapsed, actor: { type: "system" } }, async (tx) => {
      await seedEntitlements(tx.db, lapsed, {
        plan: getPlan("chat-voice")!,
        interval: "month",
        stripeCustomerId: "cus_lapsed",
        stripeSubscriptionId: "sub_lapsed",
      });
      await transition(tx, "active", { actor: "system", reason: "test" });
      await transition(tx, "past_due", { actor: "system", reason: "test" });
      await setGrace(tx.db, lapsed, new Date(yearStart.getTime() - DAY_MS));
    });

    // An annual clinic on its first invoice: a year paid, a month's window.
    annual = (await seedClinic("annual")).clinicId;
    await withTenant({ clinicId: annual, actor: { type: "system" } }, async (tx) => {
      await seedEntitlements(tx.db, annual, {
        plan: getPlan("complete")!,
        interval: "year",
        stripeCustomerId: "cus_annual",
        stripeSubscriptionId: "sub_annual",
      });
      await recordFirstInvoice(tx.db, annual, {
        periodStart: yearStart,
        periodEnd: addMonthsUtc(yearStart, 12),
        setupFeePaidUsd: 997,
      });
      await transition(tx, "active", { actor: "system", reason: "test" });
    });
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("an annual clinic's first invoice opens a one-month window, not a year", async () => {
    const r = await row(annual);
    expect(r.current_period_start?.toISOString()).toBe(yearStart.toISOString());
    expect(r.current_period_end?.toISOString()).toBe(
      addMonthsUtc(yearStart, 1).toISOString(),
    );
  });

  test("one sweep, ten days in: grace has expired, the annual window has not", async () => {
    const result = await sweepBilling(new Date(yearStart.getTime() + 10 * DAY_MS));
    expect(result.clinicsConsidered).toBe(2);
    expect(result.suspended).toEqual([lapsed]);
    expect(result.rolled).toEqual([]);
    expect(result.failures).toEqual([]);
    expect((await row(annual)).current_period_start?.toISOString()).toBe(
      yearStart.toISOString(),
    );
  });

  test("past_due with an expired grace window is suspended, once", async () => {
    // Suspended by the previous run (its `now` is after the grace ended).
    expect((await row(lapsed)).status).toBe("suspended");
    expect(await reasons(lapsed)).toEqual(["provisioned", "test", "test", "grace_expired"]);

    // A second sweep finds nothing to do for it: not past_due any more. At a
    // pinned `now`, like every other sweep here: run at the wall clock, this
    // sweep rolled the annual clinic's window once the real date passed
    // 1 October 2026, and the next test then found nothing left to roll.
    const again = await sweepBilling(new Date(yearStart.getTime() + 11 * DAY_MS));
    expect(again.suspended).toEqual([]);
    expect((await row(lapsed)).status).toBe("suspended");
  });

  test("an annual clinic's counters reset a month in, with no invoice at all", async () => {
    await inTenant(annual, (client) =>
      client.query(
        `update entitlements set used_voice_minutes = 640.25, used_chat_conversations = 900
          where clinic_id = $1`,
        [annual],
      ),
    );

    // Forty-five days in: the first month has passed, the second has not.
    const now = new Date(yearStart.getTime() + 45 * DAY_MS);
    const result = await sweepBilling(now);
    expect(result.rolled).toEqual([annual]);
    expect(result.failures).toEqual([]);

    const r = await row(annual);
    expect(Number(r.used_voice_minutes)).toBe(0);
    expect(r.used_chat_conversations).toBe(0);
    expect(r.current_period_start?.toISOString()).toBe(addMonthsUtc(yearStart, 1).toISOString());
    expect(r.current_period_end?.toISOString()).toBe(addMonthsUtc(yearStart, 2).toISOString());
    expect(r.status).toBe("active");
    expect(await reasons(annual)).toContain("allowance_rolled");

    // Same moment again: nothing rolls, counters are left alone.
    await inTenant(annual, (client) =>
      client.query(`update entitlements set used_chat_conversations = 5 where clinic_id = $1`, [annual]),
    );
    expect((await sweepBilling(now)).rolled).toEqual([]);
    expect((await row(annual)).used_chat_conversations).toBe(5);
  });

  test("a sweep that was off for months lands on the current month", async () => {
    const result = await withTenant({ clinicId: annual, actor: { type: "system" } }, (tx) =>
      rollAllowancePeriod(tx.db, annual, new Date(yearStart.getTime() + 200 * DAY_MS)),
    );
    // Window was month 2 (from the test above); 200 days in is month 7.
    expect(result).toEqual({
      rolled: 5,
      periodStart: addMonthsUtc(yearStart, 6),
      periodEnd: addMonthsUtc(yearStart, 7),
    });
  });

  test("a monthly clinic never rolls: its invoices own the window", async () => {
    const result = await withTenant({ clinicId: lapsed, actor: { type: "system" } }, (tx) =>
      rollAllowancePeriod(tx.db, lapsed, new Date(Date.now() + 400 * DAY_MS)),
    );
    expect(result).toEqual({ rolled: 0 });
  });

  test("the job ships off, and runs through the scheduler once enabled", async () => {
    expect(await runBillingSweepJob()).toEqual({ status: "disabled" });

    await setJobEnabled(JOB_BILLING_SWEEP, true, await seedOpsUser());
    const outcome = await runBillingSweepJob({ now: new Date() });
    expect(outcome.status).toBe("ok");

    const job = await getJob(JOB_BILLING_SWEEP);
    expect(job?.lastRunStatus).toBe("ok");
    expect(job?.lastRunNote).toMatch(/^Swept 2 clinics: 0 suspended, \d+ allowances rolled\.$/);
    expect(job?.runningSince).toBeNull();
  });
});
