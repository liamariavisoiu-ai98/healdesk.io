import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { readWeekSchedule } from "@/lib/portal/week-schedule";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { contact, liveClinic, ZONE } from "./setup/summary-fixtures";

/**
 * Home's week at a glance against the database (portal redesign, owner,
 * 1 November 2026): appointments counted on the clinic's own calendar day,
 * Monday to Sunday, cancelled ones left out, another clinic's never counted.
 * The first build grouped by an expression whose time-zone parameter Postgres
 * saw as different from the one selected, and every Home after go-live fell
 * back to "We could not load Home just now"; this file would have caught it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "week-schedule-test" } as const;

/** Wednesday 4 November 2026, 10 am in New York: the week runs 2 to 8 November. */
const NOW = new Date("2026-11-04T15:00:00Z");

async function appointment(clinicId: string, contactId: string, at: string, status = "scheduled") {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, status, booking_origin)
       values ($1, $2, $3, 'Peel', $4, 'assistant')`,
      [clinicId, contactId, at, status],
    ),
  );
}

describeDb("readWeekSchedule", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("counts each day's appointments on the clinic's own calendar, Monday to Sunday", async () => {
    const c = await liveClinic("Week Clinic", new Date("2026-10-01T12:00:00Z"));
    const other = await liveClinic("Other Clinic", new Date("2026-10-01T12:00:00Z"));
    const p = await contact(c.clinicId, "Sample Person", "+15555550101");
    const q = await contact(other.clinicId, "Other Person", "+15555550102");

    // Monday 2 Nov, 9 am New York.
    await appointment(c.clinicId, p, "2026-11-02T14:00:00Z");
    // Wednesday 4 Nov twice.
    await appointment(c.clinicId, p, "2026-11-04T15:00:00Z");
    await appointment(c.clinicId, p, "2026-11-04T20:30:00Z");
    // 11:30 pm Saturday 7 Nov in New York is already Sunday in UTC: it counts on Saturday.
    await appointment(c.clinicId, p, "2026-11-08T04:30:00Z");
    // Cancelled: not counted.
    await appointment(c.clinicId, p, "2026-11-05T15:00:00Z", "cancelled");
    // Outside the week, either side.
    await appointment(c.clinicId, p, "2026-11-01T15:00:00Z");
    await appointment(c.clinicId, p, "2026-11-09T15:00:00Z");
    // Another clinic's Thursday.
    await appointment(other.clinicId, q, "2026-11-05T15:00:00Z");

    const days = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readWeekSchedule(tx, NOW, ZONE),
    );
    expect(days.map((d) => [d.label, d.count])).toEqual([
      ["Mon", 1],
      ["Tue", 0],
      ["Wed", 2],
      ["Thu", 0],
      ["Fri", 0],
      ["Sat", 1],
      ["Sun", 0],
    ]);
    expect(days.find((d) => d.isToday)?.date).toBe("2026-11-04");
  });

  test("an empty week is seven zeros, not an error", async () => {
    const c = await liveClinic("Quiet Clinic", new Date("2026-10-01T12:00:00Z"));
    const days = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readWeekSchedule(tx, NOW, ZONE),
    );
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.count === 0)).toBe(true);
  });
});
