import { ONBOARDING_STEPS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { blockersFor, listClinics, type ClinicOverview } from "@/lib/ops/clinics";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;

const clinic = (over: Partial<ClinicOverview> = {}): ClinicOverview => ({
  id: "c1",
  slug: "radiance",
  name: "Radiance",
  timezone: "America/New_York",
  specialty: "med-spa",
  plan: "core",
  attributionMode: "estimated",
  dataClassification: "synthetic",
  isCoveredEntity: true,
  baaSignedAt: new Date(),
  createdAt: new Date(),
  phoneSystemType: "landline",
  callRouting: "conditional",
  callRoutingConfirmedAt: new Date(),
  carrier: "verizon",
  synthflowNumberE164: "+14155550100",
  openingHoursPresent: true,
  onboarding: Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, "2026-09-13T00:00:00.000Z"])),
  agentApprovedAt: new Date(),
  wentLiveAt: null,
  offboardingStartedAt: null,
  exportDeliveredAt: null,
  destroyAfter: null,
  destroyedAt: null,
  ...over,
});

describe("clinic blockers", () => {
  test("flags production with no signed BAA as blocked", () => {
    // The database is already refusing patient data in this state. The console
    // should say so rather than let it surface as a failed insert.
    const blockers = blockersFor(
      clinic({ dataClassification: "production", baaSignedAt: null }),
    );

    expect(blockers[0]!.level).toBe("blocked");
    expect(blockers[0]!.message).toMatch(/refusing all patient data/i);
  });

  test("flags undetermined covered-entity status", () => {
    // Cash-pay med spas often are not covered entities, which removes the
    // exemptions in MHMDA, TDPSA, SB 370 and the FTC breach rule at once. It
    // has to be determined, not assumed.
    const blockers = blockersFor(clinic({ isCoveredEntity: null }));
    expect(blockers.some((b) => b.message.match(/covered-entity/i))).toBe(true);
  });

  test("notes a synthetic clinic without treating it as broken", () => {
    const blockers = blockersFor(clinic({ dataClassification: "synthetic" }));
    expect(blockers.every((b) => b.level === "attention")).toBe(true);
  });

  test("a fully configured production clinic has nothing outstanding", () => {
    const blockers = blockersFor(
      clinic({
        dataClassification: "production",
        baaSignedAt: new Date(),
        isCoveredEntity: true,
      }),
    );
    expect(blockers).toEqual([]);
  });
});

describeDb("ops clinic listing", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("lists clinics the runtime role cannot select directly", async () => {
    const seeded = await seedClinic("ops-list");

    const clinics = await listClinics();
    expect(clinics.map((c) => c.id)).toContain(seeded.clinicId);

    // Proves the SECURITY DEFINER function is doing real work — a plain SELECT
    // as the app role with no tenant set returns nothing.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      const direct = await app.query(`select id from clinics`);
      expect(direct.rows).toHaveLength(0);
    } finally {
      await app.end();
    }
  });

  test("returns configuration only, never patient data", async () => {
    await seedClinic("ops-shape");
    const [first] = await listClinics();

    // This projection is the entire privileged surface. If a patient-adjacent
    // column ever appears here, it bypasses RLS for every caller.
    expect(Object.keys(first!).sort()).toEqual(
      [
        "agentApprovedAt",
        "attributionMode",
        "baaSignedAt",
        "callRouting",
        "callRoutingConfirmedAt",
        "carrier",
        "createdAt",
        "dataClassification",
        "destroyAfter",
        "destroyedAt",
        "exportDeliveredAt",
        "id",
        "isCoveredEntity",
        "offboardingStartedAt",
        "name",
        "onboarding",
        "openingHoursPresent",
        "phoneSystemType",
        "plan",
        "slug",
        "synthflowNumberE164",
        "specialty",
        "timezone",
        "wentLiveAt",
      ].sort(),
    );
  });

  test("reflects BAA and covered-entity state from the database", async () => {
    const seeded = await seedClinic("ops-state");
    await getMigratorPool().query(
      `update clinics
          set is_covered_entity = true, baa_signed_at = now(),
              data_classification = 'production'
        where id = $1`,
      [seeded.clinicId],
    );

    const found = (await listClinics()).find((c) => c.id === seeded.clinicId);
    expect(found?.isCoveredEntity).toBe(true);
    expect(found?.baaSignedAt).toBeInstanceOf(Date);
    expect(found?.dataClassification).toBe("production");
    expect(blockersFor(found!)).toEqual([]);
  });
});
