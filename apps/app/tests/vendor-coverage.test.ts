import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { unsafeDb } from "@/db";
import { recordPlatformAttestation, utcDay } from "@/lib/compliance/platform";
import { COVERAGE_VENDORS, watchVendorAgreements } from "@/lib/compliance/vendor-coverage";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { attestPlatform } from "./setup/platform";

/**
 * The vendors' agreements, watched (lib/compliance/vendor-coverage.ts; the
 * owner's decision of 19 October 2026): ops warned 30 and 7 days before a
 * recorded expiry, told once when one passes or is withdrawn, which stops
 * AYA where that vendor serves and asks for an incident. The answer gate's
 * half is in tests/answer-gate.test.ts. The watch is given its clock, so no
 * test here races the real one.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** A UTC day `days` from `from`, as YYYY-MM-DD. */
function dayFrom(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function alerts(event: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1 order by raised_at, id`,
    [event],
  );
  return rows.map((r) => ({ code: r.fields.code, phase: r.fields.phase, expiresOn: r.fields.expiresOn ?? null }));
}

describeDb("the vendors' agreements, watched", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    // The ops log is shared and outlives truncateAll; these alerts are once
    // ever, so a file's earlier run must not answer for this one.
    await getMigratorPool().query(`delete from ops_alerts where event like 'vendor_agreement_%'`);
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
  });

  afterAll(async () => {
    await closePools();
  });

  test("30 and 7 days before a recorded expiry, once each; a renewal with a new expiry warns again", async () => {
    const today = utcDay(new Date());
    const expiresOn = dayFrom(today, 30);
    await attestPlatform(["anthropic"], { expiresOn });
    await attestPlatform(["aws", "database_host", "retell"]);

    const at = (daysFromToday: number) => new Date(Date.parse(`${dayFrom(today, daysFromToday)}T12:00:00Z`));
    // 31 days out: nothing.
    expect(await watchVendorAgreements(unsafeDb, at(-1))).toEqual({ expiring: 0, lapsed: 0 });
    expect(await alerts("vendor_agreement_expiring")).toEqual([]);
    // 30 days out, and every run after it in the window: one warning.
    expect(await watchVendorAgreements(unsafeDb, at(0))).toEqual({ expiring: 1, lapsed: 0 });
    await watchVendorAgreements(unsafeDb, at(10));
    expect(await alerts("vendor_agreement_expiring")).toEqual([
      { code: "anthropic", phase: "30_days", expiresOn },
    ]);
    // 7 days out: the second.
    await watchVendorAgreements(unsafeDb, at(23));
    await watchVendorAgreements(unsafeDb, at(29));
    expect(await alerts("vendor_agreement_expiring")).toEqual([
      { code: "anthropic", phase: "30_days", expiresOn },
      { code: "anthropic", phase: "7_days", expiresOn },
    ]);
    // On its last day it still counts and nothing lapses.
    expect((await watchVendorAgreements(unsafeDb, at(30))).lapsed).toBe(0);

    // Renewed a year on: the warnings are armed again for the new day.
    const renewed = dayFrom(today, 365);
    await attestPlatform(["anthropic"], { expiresOn: renewed });
    await watchVendorAgreements(unsafeDb, at(335));
    expect((await alerts("vendor_agreement_expiring")).at(-1)).toEqual({
      code: "anthropic",
      phase: "30_days",
      expiresOn: renewed,
    });
  });

  test("an expiry passed with no renewal is told once, as the stop that asks for an incident", async () => {
    const today = utcDay(new Date());
    const expiresOn = dayFrom(today, 5);
    await attestPlatform(["retell"], { expiresOn });
    const past = new Date(Date.parse(`${dayFrom(today, 6)}T00:30:00Z`));
    expect(await watchVendorAgreements(unsafeDb, past)).toEqual({ expiring: 0, lapsed: 1 });
    await watchVendorAgreements(unsafeDb, new Date(past.getTime() + 3_600_000));
    expect(await alerts("vendor_agreement_lapsed")).toEqual([
      { code: "retell", phase: "expired", expiresOn },
    ]);
    // A vendor never attested is a platform not yet launched: not watched.
    expect(await alerts("vendor_agreement_expiring")).toEqual([]);
  });

  test("withdrawing a vendor's agreement tells ops at once; withdrawing a readiness flag does not", async () => {
    const now = new Date();
    const today = utcDay(now);
    for (const subject of [...COVERAGE_VENDORS, "runtime_web"] as const) {
      await recordPlatformAttestation(unsafeDb, {
        subject,
        action: "attested",
        documentRef: "Test: the agreement's folder",
        effectiveOn: today,
        actorLabel: "ops@healdesk.test",
        now,
      });
    }
    await recordPlatformAttestation(unsafeDb, {
      subject: "runtime_web",
      action: "withdrawn",
      documentRef: "Test: redeploying",
      effectiveOn: today,
      actorLabel: "ops@healdesk.test",
      now,
    });
    expect(await alerts("vendor_agreement_lapsed")).toEqual([]);

    await recordPlatformAttestation(unsafeDb, {
      subject: "database_host",
      action: "withdrawn",
      documentRef: "Test: the provider ended its agreement",
      effectiveOn: today,
      actorLabel: "ops@healdesk.test",
      now,
    });
    expect(await alerts("vendor_agreement_lapsed")).toEqual([
      { code: "database_host", phase: "withdrawn", expiresOn: null },
    ]);
  });
});
