import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { markNotified, openIncident } from "@/lib/incidents/incidents";
import { runIncidentDeadlinesJob } from "@/lib/scheduler/incident-deadlines";
import { JOB_INCIDENT_DEADLINES } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * A missed incident notice target raises an alert (BAA 1.3.0 release gate
 * 5): every open incident past healdesk's internal 24-hour notice target
 * (the agreements promise 60 calendar days) with no notice recorded raises
 * one ops alert, ever, with ids only; one notified, resolved or still inside
 * its 24 hours raises none.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "incident-deadlines-test" } as const;
const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 60 * 60 * 1000;

async function alerts() {
  const { rows } = await getMigratorPool().query<{
    fields: Record<string, unknown>;
    repeats: number;
  }>(
    `select fields, repeats from ops_alerts where event = 'incident_notice_overdue' order by raised_at`,
  );
  return rows;
}

describeDb("the incident-deadlines job", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    await getMigratorPool().query(`delete from ops_alerts where event = 'incident_notice_overdue'`);
  });

  afterAll(async () => {
    await closePools();
  });

  test("is seeded on by its migration, because it only alerts", () => {
    // truncateAll re-seeds every job off for the tests; the migration's own
    // row is what a fresh deployment gets.
    const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const seeds = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(`${dir}${name}`, "utf8"))
      .filter((text) => text.includes("('incident-deadlines'"));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatch(/\('incident-deadlines', '[^']+', true\)/);
  });

  test("alerts once per overdue incident, with ids only, and never for one notified, resolved or still in time", async () => {
    const clinic = await seedClinic("incident-overdue");
    const opened = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => ({
      overdue: await openIncident(tx, {
        class: "security_incident",
        summary: "Synthetic: a credential exposed in a log line",
        openedBy: "test",
        isCoveredEntity: true,
        discoveredAt: new Date(NOW.getTime() - 30 * HOUR),
      }),
      notified: await openIncident(tx, {
        class: "breach",
        summary: "Synthetic: notified in time",
        openedBy: "test",
        isCoveredEntity: true,
        discoveredAt: new Date(NOW.getTime() - 30 * HOUR),
      }),
      inTime: await openIncident(tx, {
        class: "breach",
        summary: "Synthetic: still inside its 24 hours",
        openedBy: "test",
        isCoveredEntity: true,
        discoveredAt: new Date(NOW.getTime() - 2 * HOUR),
      }),
    }));
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      markNotified(tx, opened.notified.id, "Emailed the notice address."),
    );

    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [
      JOB_INCIDENT_DEADLINES,
    ]);
    expect(await runIncidentDeadlinesJob({ now: NOW })).toMatchObject({ status: "ok" });
    expect(await alerts()).toEqual([
      {
        fields: { clinicId: clinic.clinicId, incidentId: opened.overdue.id },
        repeats: 0,
      },
    ]);
    // Nothing from the incident itself reaches the alert.
    expect(JSON.stringify(await alerts())).not.toMatch(/credential|Synthetic/);

    // Every later hour: still one alert, ever.
    await runIncidentDeadlinesJob({ now: new Date(NOW.getTime() + HOUR) });
    expect(await alerts()).toHaveLength(1);

    // Switched off, it does nothing.
    await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = $1`, [
      JOB_INCIDENT_DEADLINES,
    ]);
    expect(await runIncidentDeadlinesJob({ now: NOW })).toEqual({ status: "disabled" });
    expect(opened.inTime.id).toBeTruthy();
  });
});
