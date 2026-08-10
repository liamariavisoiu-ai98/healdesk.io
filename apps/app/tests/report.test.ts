import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildMonthlyReport } from "@/lib/attribution/report";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedClinic,
  seedConversation,
  setAverageTreatmentValue,
} from "./setup/factories";

/**
 * The monthly report, end to end against a real database.
 *
 * The important assertions are about honesty rather than arithmetic: only
 * recovered conversations are counted, activity outside the period is excluded,
 * and reading conversations — even just counting them — writes an audit row.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Mid-July 2026, comfortably inside the month in any US timezone. */
const IN_JULY = new Date("2026-07-15T16:00:00Z");
const IN_JUNE = new Date("2026-06-15T16:00:00Z");

describeDb("monthly report", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("counts only recovered bookings, and states the estimate basis", async () => {
    const clinic = await seedClinic("report-a");
    await setAverageTreatmentValue(clinic.clinicId, 550);

    // Two recovered calls that booked — these are the ones we claim credit for.
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: true,
    });
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: true,
    });
    // A recovered call that did not book.
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: false,
    });
    // A booking from a call the clinic would have answered anyway — handled,
    // but not recovered, so it must not appear in recovered revenue.
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: false,
      booked: true,
    });

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: IN_JULY,
    });

    expect(report.period.key).toBe("2026-07");
    expect(report.attribution.conversationsHandled).toBe(4);
    expect(report.attribution.conversationsRecovered).toBe(3);
    expect(report.attribution.recoveredBookings).toBe(2);
    expect(report.attribution.revenueUsd).toBe(1_100);
    expect(report.attribution.mode).toBe("estimated");
    expect(report.attribution.basis).toContain("2 recovered bookings");
  });

  test("excludes activity from other months", async () => {
    const clinic = await seedClinic("report-b");
    await setAverageTreatmentValue(clinic.clinicId, 1_000);

    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: true,
    });
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JUNE,
      recovered: true,
      booked: true,
    });

    const july = await buildMonthlyReport(clinic.clinicId, { within: IN_JULY });
    expect(july.attribution.recoveredBookings).toBe(1);
    expect(july.attribution.revenueUsd).toBe(1_000);
  });

  test("compares against the previous month", async () => {
    const clinic = await seedClinic("report-c");
    await setAverageTreatmentValue(clinic.clinicId, 500);

    // June: one recovered booking. July: three.
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JUNE,
      recovered: true,
      booked: true,
    });
    for (let i = 0; i < 3; i += 1) {
      await seedConversation(clinic.clinicId, {
        startedAt: IN_JULY,
        recovered: true,
        booked: true,
      });
    }

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: IN_JULY,
    });

    expect(report.attribution.revenueUsd).toBe(1_500);
    expect(report.trend).toEqual({ deltaUsd: 1_000, percent: 200 });
  });

  test("reports no revenue figure when the clinic has no average value", async () => {
    const clinic = await seedClinic("report-d");
    await setAverageTreatmentValue(clinic.clinicId, null);

    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: true,
    });

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: IN_JULY,
    });

    // Null, not zero. "$0 recovered" is a different and false claim from
    // "we can't work this out yet".
    expect(report.attribution.revenueUsd).toBeNull();
    expect(report.attribution.recoveredBookings).toBe(1);
  });

  test("a clinic with no activity gets zeroes, not an error", async () => {
    const clinic = await seedClinic("report-e");
    await setAverageTreatmentValue(clinic.clinicId, 550);

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: IN_JULY,
    });

    expect(report.attribution.conversationsHandled).toBe(0);
    expect(report.attribution.revenueUsd).toBe(0);
    expect(report.attribution.caveats.join(" ")).toMatch(
      /nothing to attribute/i,
    );
    expect(report.trend).toEqual({ deltaUsd: 0, percent: null });
  });

  test("one clinic's report never sees another clinic's activity", async () => {
    const mine = await seedClinic("report-mine");
    const theirs = await seedClinic("report-theirs");
    await setAverageTreatmentValue(mine.clinicId, 100);

    for (let i = 0; i < 5; i += 1) {
      await seedConversation(theirs.clinicId, {
        startedAt: IN_JULY,
        recovered: true,
        booked: true,
      });
    }

    const report = await buildMonthlyReport(mine.clinicId, { within: IN_JULY });
    expect(report.attribution.conversationsHandled).toBe(0);
    expect(report.attribution.revenueUsd).toBe(0);
  });

  test("counting conversations is recorded as a PHI access", async () => {
    const clinic = await seedClinic("report-audit");
    await setAverageTreatmentValue(clinic.clinicId, 550);
    await seedConversation(clinic.clinicId, {
      startedAt: IN_JULY,
      recovered: true,
      booked: true,
    });

    await buildMonthlyReport(clinic.clinicId, { within: IN_JULY });

    // Read inside a tenant: audit_log is FORCE ROW LEVEL SECURITY, so even the
    // table owner sees nothing without one. Querying as the migrator with no
    // tenant returns zero rows — which is the isolation working, and an easy
    // way to write a test that passes for the wrong reason.
    const rows = await inTenant(clinic.clinicId, async (client) => {
      const result = await client.query<{
        action: string;
        resource_type: string;
        actor_type: string;
        actor_label: string;
        metadata: { period?: string } | null;
      }>(
        `select action, resource_type, actor_type, actor_label, metadata
           from audit_log where clinic_id = $1 order by occurred_at desc limit 1`,
        [clinic.clinicId],
      );
      return result.rows;
    });

    // Reading is an access even when only counting — §164.312(b) covers reads,
    // which is the requirement people skip.
    expect(rows[0]).toMatchObject({
      action: "read",
      resource_type: "conversation",
      actor_type: "service",
      actor_label: "monthly-report",
    });
    expect(rows[0]!.metadata?.period).toBe("2026-07");
  });
});
