import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildAllReports } from "@/lib/scheduler/monthly-report";
import {
  JOB_MONTHLY_REPORT,
  JOB_WEEKLY_RECAP,
  getJob,
  listJobs,
  runJob,
  setJobEnabled,
} from "@/lib/scheduler/jobs";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  seedClinic,
  seedConversation,
  setAverageTreatmentValue,
} from "./setup/factories";

/**
 * The scheduler.
 *
 * The assertion that matters most is the first one: a freshly migrated system
 * has every job switched OFF. A report job that starts running the moment it
 * deploys would mail whatever half-configured clinics happen to exist.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** A user row for the "who turned this on" column. */
async function seedOpsUser(): Promise<string> {
  const id = `usr_ops_${Math.random().toString(36).slice(2, 10)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'Ops', $2, true, now(), now())`,
    [id, `${id}@healdesk.test`],
  );
  return id;
}

describeDb("scheduler", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("every job ships switched off", async () => {
    const jobs = await listJobs();
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      // The heartbeat is the liveness signal, not a job an operator enables.
      if (job.name === "heartbeat") continue;
      expect(job.enabled, `${job.name} is enabled by default`).toBe(false);
    }
  });

  test("a disabled job does no work, and says why", async () => {
    let ran = false;
    const outcome = await runJob(JOB_WEEKLY_RECAP, async () => {
      ran = true;
      return "should not happen";
    });

    expect(outcome).toEqual({ status: "disabled" });
    expect(ran).toBe(false);

    // Recorded rather than silent: "it didn't run because it's off" is a
    // different answer from "it didn't run" and ops needs to tell them apart.
    const job = await getJob(JOB_WEEKLY_RECAP);
    expect(job?.lastRunStatus).toBe("disabled");
  });

  test("an enabled job runs and records its outcome", async () => {
    const opsUser = await seedOpsUser();
    await setJobEnabled(JOB_WEEKLY_RECAP, true, opsUser);

    const outcome = await runJob(JOB_WEEKLY_RECAP, async () => "did 3 things");

    expect(outcome).toEqual({ status: "ok", note: "did 3 things" });

    const job = await getJob(JOB_WEEKLY_RECAP);
    expect(job?.lastRunStatus).toBe("ok");
    expect(job?.lastRunNote).toBe("did 3 things");
    // The lock is released whatever happened.
    expect(job?.runningSince).toBeNull();
    expect(job?.updatedBy).toBe(opsUser);
  });

  test("a failing job records the failure and releases the lock", async () => {
    const opsUser = await seedOpsUser();
    await setJobEnabled(JOB_WEEKLY_RECAP, true, opsUser);

    const outcome = await runJob(JOB_WEEKLY_RECAP, async () => {
      throw new Error("connector unreachable");
    });

    expect(outcome.status).toBe("failed");

    const job = await getJob(JOB_WEEKLY_RECAP);
    expect(job?.lastRunStatus).toBe("failed");
    expect(job?.lastRunNote).toContain("connector unreachable");
    // A crashed run that leaves the lock set blocks the job forever, and the
    // first symptom is a customer asking where their report went.
    expect(job?.runningSince).toBeNull();
  });

  test("two runners starting together do not both proceed", async () => {
    const opsUser = await seedOpsUser();
    await setJobEnabled(JOB_WEEKLY_RECAP, true, opsUser);

    let started = 0;
    // Long enough that the second runner asks for the lock while the first
    // still holds it. At 60ms a loaded test machine sometimes let the first
    // run finish before the second asked, and both ran one after the other:
    // a correct result that failed the test.
    const work = async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return "done";
    };

    const [first, second] = await Promise.all([
      runJob(JOB_WEEKLY_RECAP, work),
      runJob(JOB_WEEKLY_RECAP, work),
    ]);

    expect(started).toBe(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["already-running", "ok"]);
  });

  test("a stale lock from a crashed run is reclaimed", async () => {
    const opsUser = await seedOpsUser();
    await setJobEnabled(JOB_WEEKLY_RECAP, true, opsUser);

    // Simulate a process that died mid-run two hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await getMigratorPool().query(
      `update scheduled_jobs set running_since = $2 where name = $1`,
      [JOB_WEEKLY_RECAP, twoHoursAgo],
    );

    const outcome = await runJob(JOB_WEEKLY_RECAP, async () => "recovered");
    expect(outcome).toEqual({ status: "ok", note: "recovered" });
  });

  test("a phase-two job does nothing in v1, even switched on, and says why", async () => {
    const opsUser = await seedOpsUser();
    delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    await setJobEnabled(JOB_MONTHLY_REPORT, true, opsUser);
    let ran = false;
    const outcome = await runJob(JOB_MONTHLY_REPORT, async () => {
      ran = true;
      return "should not happen";
    });
    expect(outcome).toEqual({ status: "disabled" });
    expect(ran).toBe(false);
    const job = await getJob(JOB_MONTHLY_REPORT);
    expect(job?.lastRunStatus).toBe("disabled");
    expect(job?.lastRunNote).toMatch(/^Phase two/);
    await setJobEnabled(JOB_MONTHLY_REPORT, false, opsUser);
  });

  test("the runtime role cannot create or drop jobs", async () => {
    // The set of jobs is defined by migrations. An application that can invent
    // its own scheduled work is an application that can surprise you.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      await expect(
        app.query(
          `insert into scheduled_jobs (name, cadence) values ('rogue', 'hourly')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query(`delete from scheduled_jobs`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });
});

describeDb("monthly report job", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("builds one report per clinic, in each clinic's own timezone", async () => {
    const ny = await seedClinic("sched-ny");
    const phx = await seedClinic("sched-phx");
    await getMigratorPool().query(
      `update clinics set timezone = 'America/Phoenix' where id = $1`,
      [phx.clinicId],
    );
    await setAverageTreatmentValue(ny.clinicId, 500);
    await setAverageTreatmentValue(phx.clinicId, 500);

    await seedConversation(ny.clinicId, {
      startedAt: new Date("2026-07-15T16:00:00Z"),
      recovered: true,
      booked: true,
    });

    // 1 August, so "the month that just ended" is July for both.
    const result = await buildAllReports(new Date("2026-08-01T12:00:00Z"));

    expect(result.clinicsConsidered).toBe(2);
    expect(result.reportsBuilt).toBe(2);
    expect(result.failures).toEqual([]);

    const nyReport = result.reports.find((r) => r.clinicId === ny.clinicId);
    expect(nyReport?.period.key).toBe("2026-07");
    expect(nyReport?.attribution.revenueUsd).toBe(500);

    const phxReport = result.reports.find((r) => r.clinicId === phx.clinicId);
    expect(phxReport?.attribution.revenueUsd).toBe(0);
  });

  test("enumerates clinics the runtime role cannot list directly", async () => {
    // Proves the SECURITY DEFINER function is doing real work: a plain SELECT
    // as the app role with no tenant set returns nothing at all.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      const direct = await app.query(`select id from clinics`);
      expect(direct.rows).toHaveLength(0);

      const viaFunction = await app.query(
        `select id from app_clinics_overview()`,
      );
      expect(viaFunction.rows.length).toBeGreaterThan(0);
    } finally {
      await app.end();
    }
  });
});
