import { fixtureAdapter } from "@healdesk/connectors";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  appointments,
  contacts,
  providerConnections,
  reconciliationExceptions,
  syncRuns,
  transactions,
} from "@/db/schema";
import { month_ } from "@/lib/attribution/period";
import { buildMonthlyReport } from "@/lib/attribution/report";
import { saveConnection } from "@/lib/connections/store";
import { reconcilePeriod } from "@/lib/sync/reconcile-store";
import { syncConnection } from "@/lib/sync/run";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * The sync engine end to end, against the fixture adapter.
 *
 * The fixture is deliberately awkward — no-shows, unknown arrivals, orphan
 * sales, deposits paid weeks early — because an adapter that behaves perfectly
 * teaches the engine nothing. Everything asserted here is a property that would
 * silently corrupt a monthly figure if it broke:
 *
 *   - running the same sync twice must not duplicate a single row
 *   - the cursor must advance, or every run re-reads from the beginning
 *   - a sync must never write into another clinic
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service" as const, serviceName: "test" };

/**
 * Pinned, not `new Date()`.
 *
 * The sync window and the reporting month are both derived from this instant,
 * and the fixture spreads its data across that window. With a live clock the
 * suite asserted that fixture rows land inside the CURRENT calendar month —
 * which is nearly empty on the 1st and thinly populated for the first week, so
 * these tests failed on early-month days and passed the rest of the time. A
 * test that depends on the date you run it is not a test.
 *
 * The 20th is chosen so the reporting month is well populated in every
 * timezone, and the sync lookback still reaches back into the prior month,
 * which is what exercises the deposit-before-appointment path.
 */
const NOW = new Date("2026-05-20T12:00:00Z");

async function connectFixture(clinicId: string): Promise<string> {
  const connectionId = await withTenant({ clinicId, actor }, (tx) =>
    saveConnection(tx.db, {
      clinicId,
      provider: fixtureAdapter.id,
      credentials: { token: "not-a-real-token" },
    }),
  );

  await withTenant({ clinicId, actor }, async (tx) => {
    await tx.db
      .update(providerConnections)
      .set({ status: "active" })
      .where(eq(providerConnections.id, connectionId));
  });

  return connectionId;
}

async function counts(clinicId: string) {
  return withTenant({ clinicId, actor }, async (tx) => {
    const one = async (table: typeof contacts | typeof appointments | typeof transactions) => {
      const [row] = await tx.db
        .select({ value: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.clinicId, clinicId));
      return row?.value ?? 0;
    };

    return {
      contacts: await one(contacts),
      appointments: await one(appointments),
      transactions: await one(transactions),
    };
  });
}

describeDb("sync engine", () => {
  let clinic: SeededClinic;
  let other: SeededClinic;
  let connectionId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    clinic = await seedClinic("sync");
    other = await seedClinic("other");
    connectionId = await connectFixture(clinic.clinicId);
  });

  afterAll(async () => {
    await closePools();
  });

  test("a first run writes contacts, appointments and sales", async () => {
    const summary = await syncConnection({
      clinicId: clinic.clinicId,
      connectionId,
      now: NOW,
    });

    expect(summary.provider).toBe("fixture");
    for (const outcome of summary.resources) {
      expect(outcome.status, `${outcome.resource}: ${outcome.error}`).toBe("ok");
    }

    const after = await counts(clinic.clinicId);
    expect(after.contacts).toBeGreaterThan(0);
    expect(after.appointments).toBeGreaterThan(0);
    expect(after.transactions).toBeGreaterThan(0);
  });

  test("running twice changes nothing — every write is an upsert", async () => {
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });
    const first = await counts(clinic.clinicId);

    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });
    const second = await counts(clinic.clinicId);

    // The single most important property in the file. A missing `targetWhere`
    // on the partial unique index makes this fail by exactly doubling.
    expect(second).toEqual(first);
  });

  test("the cursor advances, so the next run reads a narrower window", async () => {
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });

    const runs = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      tx.db
        .select({
          resource: syncRuns.resource,
          status: syncRuns.status,
          cursorAt: syncRuns.cursorAt,
          itemsSeen: syncRuns.itemsSeen,
        })
        .from(syncRuns)
        .where(eq(syncRuns.clinicId, clinic.clinicId)),
    );

    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.status).toBe("ok");
      expect(run.cursorAt, `${run.resource} has no cursor`).not.toBeNull();
    }
  });

  test("a sync writes into its own clinic and nowhere else", async () => {
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });

    const strangerRows = await counts(other.clinicId);

    expect(strangerRows).toEqual({
      contacts: 0,
      appointments: 0,
      transactions: 0,
    });
  });

  test("appointments land with a real contact, never a fabricated one", async () => {
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });

    const orphans = await inTenant(clinic.clinicId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `select count(*) as count
           from appointments a
           left join contacts c on c.id = a.contact_id
          where a.clinic_id = $1 and c.id is null`,
        [clinic.clinicId],
      );
      return Number(rows[0]!.count);
    });

    expect(orphans).toBe(0);
  });

  test("the fixture's declared limitations reach the run notes verbatim", async () => {
    const summary = await syncConnection({
      clinicId: clinic.clinicId,
      connectionId,
      now: NOW,
    });

    // The fixture declares itself partial on arrival and backfill on purpose.
    // Those sentences must survive to somewhere a human reads them.
    const allNotes = summary.resources.flatMap((r) => r.notes);
    expect(allNotes.length).toBeGreaterThan(0);
    for (const note of allNotes) {
      expect(note).toMatch(/[.!]$/);
    }
  });
});

describeDb("reconciliation against synced data", () => {
  let clinic: SeededClinic;
  let connectionId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    clinic = await seedClinic("recon");
    connectionId = await connectFixture(clinic.clinicId);
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });
  });

  afterAll(async () => {
    await closePools();
  });

  const thisMonth = () =>
    month_(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, "UTC");

  test("the fixture's orphan sales become exceptions with money attached", async () => {
    const result = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      reconcilePeriod(tx.db, clinic.clinicId, thisMonth(), { now: NOW }),
    );

    // The fixture emits walk-in sales with no appointment on purpose.
    expect(result.exceptions.length).toBeGreaterThan(0);
    expect(Number(result.unmatchedUsd)).toBeGreaterThan(0);
  });

  test("exceptions are stored once, however many times the matcher runs", async () => {
    const period = thisMonth();

    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      reconcilePeriod(tx.db, clinic.clinicId, period, { now: NOW }),
    );
    const first = await openExceptions(clinic.clinicId);

    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      reconcilePeriod(tx.db, clinic.clinicId, period, { now: NOW }),
    );
    const second = await openExceptions(clinic.clinicId);

    expect(second).toBe(first);
    expect(second).toBeGreaterThan(0);
  });

  test("matched sales get their appointment link written back", async () => {
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      reconcilePeriod(tx.db, clinic.clinicId, thisMonth(), { now: NOW }),
    );

    const linked = await withTenant({ clinicId: clinic.clinicId, actor }, async (tx) => {
      const [row] = await tx.db
        .select({ value: sql<number>`count(*)::int` })
        .from(transactions)
        .where(
          and(
            eq(transactions.clinicId, clinic.clinicId),
            sql`${transactions.appointmentId} is not null`,
          ),
        );
      return row?.value ?? 0;
    });

    expect(linked).toBeGreaterThan(0);
  });
});

describeDb("verified attribution", () => {
  let clinic: SeededClinic;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    clinic = await seedClinic("verified");
  });

  afterAll(async () => {
    await closePools();
  });

  test("a verified clinic with no connected source gets null revenue, not zero", async () => {
    await setVerified(clinic.clinicId);

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: NOW,
      now: NOW,
    });

    expect(report.attribution.mode).toBe("verified");
    // Zero would read as "the agent earned you nothing". Null is the truth.
    expect(report.attribution.revenueUsd).toBeNull();
    expect(report.attribution.basis).toMatch(/can't show verified revenue/i);
  });

  test("once a source is synced, the report reads real money out of it", async () => {
    await setVerified(clinic.clinicId);
    const connectionId = await connectFixture(clinic.clinicId);
    await syncConnection({ clinicId: clinic.clinicId, connectionId, now: NOW });

    const report = await buildMonthlyReport(clinic.clinicId, {
      within: NOW,
      now: NOW,
    });

    expect(report.attribution.mode).toBe("verified");
    expect(report.attribution.revenueUsd).not.toBeNull();
    expect(report.attribution.basis).toContain("fixture");
    // The fixture's orphan sales must be declared, not quietly dropped.
    expect(report.unmatched).not.toBeNull();
    expect(report.unmatched!.count).toBeGreaterThan(0);
    expect(
      report.attribution.caveats.some((c) => /could not be matched/i.test(c)),
    ).toBe(true);
  });
});

async function setVerified(clinicId: string): Promise<void> {
  await inTenant(clinicId, async (client) => {
    await client.query(
      `update clinics set attribution_mode = 'verified' where id = $1`,
      [clinicId],
    );
  });
}

async function openExceptions(clinicId: string): Promise<number> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ value: sql<number>`count(*)::int` })
      .from(reconciliationExceptions)
      .where(
        and(
          eq(reconciliationExceptions.clinicId, clinicId),
          sql`${reconciliationExceptions.resolvedAt} is null`,
        ),
      );
    return row?.value ?? 0;
  });
}
