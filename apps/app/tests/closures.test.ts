import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { clinicLocalDate, closedOn } from "@/lib/clinic/closures";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Closures are clinic-local days (lib/clinic/closures.ts). The date helper is
 * where a fixed UTC offset would go wrong, so it is tested on both sides of a
 * daylight-saving change, at the instants a fixed offset would misfile.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "closures-test" } as const;

describe("the clinic-local date", () => {
  const newYork = (iso: string) => clinicLocalDate(new Date(iso), "America/New_York");
  const sydney = (iso: string) => clinicLocalDate(new Date(iso), "Australia/Sydney");

  test("follows New York across the end of daylight saving", () => {
    // 1 November 2026, 02:00 EDT becomes 01:00 EST: UTC-4 before, UTC-5 after.
    expect(newYork("2026-11-01T03:59:00Z")).toBe("2026-10-31");
    expect(newYork("2026-11-01T04:00:00Z")).toBe("2026-11-01");
    // 23:30 on the 1st is 04:30 UTC on the 2nd; a fixed UTC-4 would call it the 2nd.
    expect(newYork("2026-11-02T04:30:00Z")).toBe("2026-11-01");
    expect(newYork("2026-11-02T05:00:00Z")).toBe("2026-11-02");
  });

  test("follows New York across the start of daylight saving", () => {
    // 8 March 2026, 02:00 EST becomes 03:00 EDT: UTC-5 before, UTC-4 after.
    expect(newYork("2026-03-08T04:59:00Z")).toBe("2026-03-07");
    expect(newYork("2026-03-08T05:00:00Z")).toBe("2026-03-08");
    // 00:30 on the 9th is 04:30 UTC; a fixed UTC-5 would still call it the 8th.
    expect(newYork("2026-03-09T03:59:00Z")).toBe("2026-03-08");
    expect(newYork("2026-03-09T04:30:00Z")).toBe("2026-03-09");
  });

  test("follows a zone whose clocks go forward in October", () => {
    // Sydney, 4 October 2026: 02:00 AEST becomes 03:00 AEDT, UTC+10 to UTC+11.
    expect(sydney("2026-10-03T13:30:00Z")).toBe("2026-10-03");
    // 00:30 on the 5th is 13:30 UTC on the 4th; a fixed UTC+10 would call it the 4th.
    expect(sydney("2026-10-04T13:30:00Z")).toBe("2026-10-05");
  });
});

describeDb("closedOn", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  const read = (tenant: string, clinicId: string, localDate: string) =>
    withTenant({ clinicId: tenant, actor }, (tx) => closedOn(tx.db, clinicId, localDate));

  test("is true on the stored date only, and only for that clinic", async () => {
    const a = await seedClinic("closures-a");
    const b = await seedClinic("closures-b");
    await inTenant(a.clinicId, (c) =>
      c.query(
        `insert into clinic_closures (clinic_id, closed_on, label) values ($1, '2026-12-25', 'Christmas Day')`,
        [a.clinicId],
      ),
    );
    expect(await read(a.clinicId, a.clinicId, "2026-12-25")).toBe(true);
    expect(await read(a.clinicId, a.clinicId, "2026-12-24")).toBe(false);
    expect(await read(a.clinicId, a.clinicId, "2026-12-26")).toBe(false);
    expect(await read(b.clinicId, b.clinicId, "2026-12-25")).toBe(false);
    // Asked from another clinic's tenant, the row is not there to find.
    expect(await read(b.clinicId, a.clinicId, "2026-12-25")).toBe(false);
  });

  test("answers for the clinic's own day, not UTC's", async () => {
    const { clinicId } = await seedClinic("closures-local");
    await inTenant(clinicId, (c) =>
      c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-25')`, [
        clinicId,
      ]),
    );
    // 03:00 UTC on 26 December is still the evening of the 25th in Los Angeles.
    const lateOnChristmas = new Date("2026-12-26T03:00:00Z");
    const closedIn = (timeZone: string) =>
      read(clinicId, clinicId, clinicLocalDate(lateOnChristmas, timeZone));
    expect(await closedIn("America/Los_Angeles")).toBe(true);
    expect(await closedIn("Europe/London")).toBe(false);
  });

  test("refuses anything but a YYYY-MM-DD date", async () => {
    const { clinicId } = await seedClinic("closures-format");
    await expect(read(clinicId, clinicId, "25/12/2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});
