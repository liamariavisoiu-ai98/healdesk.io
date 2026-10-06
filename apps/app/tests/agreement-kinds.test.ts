import { randomUUID } from "node:crypto";

import {
  agreementKindFor,
  agreementKindOfVersion,
  COVERED_ANSWERS,
  CURRENT_BAA_VERSION,
  currentDpaTemplate,
  getBaaTemplate,
  prepareBaa,
  prepareDpa,
  regimeFor,
  specialties,
  type CoveredAnswer,
  type DpaVariables,
} from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { agreementKindSufficient, supersedeAgreement, SupersedeError } from "@/lib/agreements/kind";
import {
  DESTROY_AFTER_DAYS,
  DESTROY_WITHOUT_EXPORT_AFTER_DAYS,
  dueForDestruction,
} from "@/lib/offboarding/offboarding";
import { ProvisioningError, provisionClinic, type ProvisionRequest } from "@/lib/provisioning";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic, seedContact } from "./setup/factories";

/**
 * Agreement kinds (plan Part L; drizzle/0048): the generated kind on every
 * acceptance, the two gate columns on clinics, the sufficiency rule in SQL and
 * its TypeScript mirror, the PHI gate's new condition, the supersede function,
 * and provisioning's part.
 *
 * The DPA template is unreleased, as it must be until the owner releases it.
 * To exercise provisioning as it will run after the release, this file can
 * flip the flag `getDpaTemplate` reports, and only that, through `release`.
 */
const release = vi.hoisted(() => ({ dpa: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    getDpaTemplate: (version: string) => {
      const template = actual.getDpaTemplate(version);
      return template && release.dpa ? { ...template, approvedByCounsel: true } : template;
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;

const REGIMES = ["hipaa", "hipaa-if-covered", "non-hipaa", null, "bogus", ""];
const KINDS = ["baa", "dpa", null, "BAA", "bogus"];
const COVERED = [true, false, null];

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block on the runtime role, optionally inside a tenant, always rolled back. */
async function asApp<T>(clinicId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** A signed acceptance, inserted as the migrator. Unbound unless an organisation is given. */
async function seedAcceptance(input: {
  version: string;
  organizationId?: string | null;
  acceptedAt?: Date;
  variables?: Record<string, unknown>;
  text?: string;
}): Promise<string> {
  const id = randomUUID();
  const text = input.text ?? `AGREEMENT ${input.version} (test)`;
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2::text, $3, repeat('a', 64), $4, $5::jsonb, 'I agree', 'Alex Chen',
             'alex@practice.test', $6::timestamptz,
             case when $2::text is null then null else $6::timestamptz end)`,
    [
      id,
      input.organizationId ?? null,
      input.version,
      text,
      JSON.stringify(input.variables ?? { clinicLegalName: "Practice LLC" }),
      input.acceptedAt ?? new Date(),
    ],
  );
  return id;
}

/** A clinic under an agreement, as provisioning and go-live would leave it, set up as the owner. */
async function seedUnder(
  label: string,
  input: {
    regime: string | null;
    kind: "baa" | "dpa" | null;
    covered: boolean | null;
    production?: boolean;
    agreementVersion?: string;
    specialty?: string;
  },
) {
  const clinic = await seedClinic(label);
  const acceptedAt = new Date(Date.now() - 86_400_000);
  const agreementId = input.agreementVersion
    ? await seedAcceptance({
        version: input.agreementVersion,
        organizationId: clinic.organizationId,
        acceptedAt,
      })
    : null;
  await getMigratorPool().query(
    `update clinics
        set regulatory_regime = $2, agreement_kind = $3, is_covered_entity = $4,
            specialty = coalesce($6, specialty),
            data_classification = case when $5 then 'production'::data_classification else 'synthetic'::data_classification end,
            baa_signed_at = case when $5 then $7::timestamptz else null end
      where id = $1`,
    [
      clinic.clinicId,
      input.regime,
      input.kind,
      input.covered,
      input.production ?? false,
      input.specialty ?? null,
      acceptedAt,
    ],
  );
  return { ...clinic, agreementId, acceptedAt };
}

describe("the sufficiency rule, in TypeScript", () => {
  test("whatever agreementKindFor chooses covers the practice it chose it for", () => {
    for (const s of specialties) {
      for (const covered of [...COVERED_ANSWERS, null] as (CoveredAnswer | null)[]) {
        for (const dpaReleased of [false, true]) {
          const choice = agreementKindFor({ specialty: s.id, covered, dpaReleased });
          if (!choice.ok) continue;
          expect(
            agreementKindSufficient(regimeFor(s.id), choice.kind, choice.isCoveredEntity),
            `${s.id} ${covered} released=${dpaReleased}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a DPA stops covering a practice the moment it is covered or not sure; a BAA never covers a vet", () => {
    expect(agreementKindSufficient("hipaa-if-covered", "dpa", false)).toBe(true);
    expect(agreementKindSufficient("hipaa-if-covered", "dpa", true)).toBe(false);
    expect(agreementKindSufficient("hipaa-if-covered", "dpa", null)).toBe(false);
    expect(agreementKindSufficient("hipaa", "dpa", false)).toBe(false);
    expect(agreementKindSufficient("non-hipaa", "dpa", null)).toBe(true);
    expect(agreementKindSufficient("non-hipaa", "baa", false)).toBe(false);
    expect(agreementKindSufficient("hipaa-if-covered", "baa", false)).toBe(true);
    expect(agreementKindSufficient(null, "baa", true)).toBe(false);
  });
});

describe("the DPA's Term clause is the offboarding clock in this app", () => {
  test("the numbers the text states are the code's", () => {
    expect(DESTROY_AFTER_DAYS).toBe(30);
    expect(DESTROY_WITHOUT_EXPORT_AFTER_DAYS).toBe(90);
    const text = prepareDpa(currentDpaTemplate(), {
      clinicLegalName: "Glow Med Spa LLC",
      signatoryName: "Alex Chen",
      signatoryEmail: "alex@glow.test",
      effectiveDate: "2026-10-06",
      specialty: "med-spa",
      bookingSystem: "mindbody",
      calendarAccount: "personal",
    } satisfies DpaVariables).text.replace(/\s+/g, " ");
    expect(text).toContain(
      "at the first run once thirty days have passed since the Services ended, if the export has been delivered by then",
    );
    expect(text).toContain("otherwise at the first run after the export is delivered");
    expect(text).toContain(
      "in any case at the first run once ninety days have passed since the Services ended, whether or not the export has been delivered",
    );
  });

  test("and dueForDestruction does what the text says", () => {
    const day = 86_400_000;
    const ended = new Date("2026-11-01T15:00:00Z");
    const at = (days: number) => new Date(ended.getTime() + days * day);
    const clinic = (exportDays: number | null) => ({
      offboardingStartedAt: ended,
      destroyAfter: at(DESTROY_AFTER_DAYS),
      exportDeliveredAt: exportDays === null ? null : at(exportDays),
      destroyedAt: null,
    });
    // Delivered within thirty days: destroyed once thirty days have passed, not before.
    expect(dueForDestruction(clinic(10), at(29.9))).toBe(false);
    expect(dueForDestruction(clinic(10), at(30))).toBe(true);
    // Delivered later: destroyed at the run after delivery.
    expect(dueForDestruction({ ...clinic(null) }, at(40))).toBe(false);
    expect(dueForDestruction(clinic(45), at(45))).toBe(true);
    // Never delivered: destroyed once ninety days have passed.
    expect(dueForDestruction(clinic(null), at(89.9))).toBe(false);
    expect(dueForDestruction(clinic(null), at(90))).toBe(true);
  });
});

describeDb("agreement kinds in the database (0048)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    release.dpa = false;
    await closePools();
  });

  test("every acceptance says which kind it is, from its version, as agreementKindOfVersion does", async () => {
    const versions = [
      "1.2.1",
      "1.3.0",
      "1.0.0",
      "0.1.0-draft",
      "1.1.0-draft",
      "dpa/1.0.0",
      "dpa/2.0.0",
    ];
    for (const version of versions) {
      const id = await seedAcceptance({ version });
      const { rows } = await getMigratorPool().query<{ agreement_kind: string }>(
        `select agreement_kind from baa_acceptances where id = $1`,
        [id],
      );
      expect(rows[0]!.agreement_kind, version).toBe(agreementKindOfVersion(version));
    }
    // No other namespace may be stored, so the kind can never call an unknown document a BAA.
    await expect(seedAcceptance({ version: "calendar-election/1.0.0" })).rejects.toMatchObject({
      code: "23514",
    });
    // And nobody writes the kind: it is generated.
    await expect(
      getMigratorPool().query(
        `insert into baa_acceptances (document_version, document_hash, rendered_text, variables, assent_label,
           accepted_by_name, accepted_by_email, agreement_kind)
         values ('1.2.1', repeat('a', 64), 'x', '{}'::jsonb, 'I agree', 'A', 'a@b.test', 'dpa')`,
      ),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  test("app_agreement_kind_sufficient and its TypeScript mirror agree on every combination", async () => {
    const combos = REGIMES.flatMap((regime) =>
      KINDS.flatMap((kind) => COVERED.map((covered) => ({ regime, kind, covered }))),
    );
    const { rows } = await getAppPool().query<{ i: number; ok: boolean }>(
      `select c.i::int as i, app_agreement_kind_sufficient(c.regime, c.kind, c.covered) as ok
         from jsonb_to_recordset($1::jsonb) as c(i int, regime text, kind text, covered boolean)
        order by c.i`,
      [JSON.stringify(combos.map((c, i) => ({ i, ...c })))],
    );
    expect(rows).toHaveLength(combos.length);
    for (const row of rows) {
      const c = combos[row.i]!;
      expect(row.ok, JSON.stringify(c)).toBe(agreementKindSufficient(c.regime, c.kind, c.covered));
      // Never NULL.
      expect(typeof row.ok, JSON.stringify(c)).toBe("boolean");
    }
  });

  test("the regime and the kind are gate columns: the runtime role cannot update them", async () => {
    const { clinicId } = await seedUnder("gatecols", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: false,
    });
    for (const column of ["regulatory_regime", "agreement_kind"]) {
      await asApp(clinicId, async (c) => {
        await expect(
          c.query(`update clinics set ${column} = null where id = $1`, [clinicId]),
        ).rejects.toMatchObject({
          code: "42501",
        });
      });
    }
    // The covered-entity answer stays writable: that write is what closes the gate on a DPA clinic.
    await asApp(clinicId, async (c) => {
      const { rows } = await c.query(
        `update clinics set is_covered_entity = true where id = $1 returning id`,
        [clinicId],
      );
      expect(rows).toHaveLength(1);
    });
    // A specialty HIPAA always reaches never holds a DPA.
    await expect(
      getMigratorPool().query(`update clinics set regulatory_regime = 'hipaa' where id = $1`, [
        clinicId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("the PHI gate refuses a DPA clinic's data from the moment it is covered, and only then", async () => {
    const dpa = await seedUnder("dpagate", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: false,
      production: true,
      agreementVersion: "dpa/1.0.0",
    });
    await expect(seedContact(dpa.clinicId, "+15550190001")).resolves.toBeTruthy();

    // The practice says it now bills insurance electronically; the runtime role records it.
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [dpa.clinicId]);
      await client.query(`update clinics set is_covered_entity = true where id = $1`, [
        dpa.clinicId,
      ]);
      await client.query("commit");
    } finally {
      client.release();
    }
    await expect(seedContact(dpa.clinicId, "+15550190002")).rejects.toMatchObject({
      code: "23514",
    });
    await getMigratorPool().query(`update clinics set is_covered_entity = null where id = $1`, [
      dpa.clinicId,
    ]);
    await expect(seedContact(dpa.clinicId, "+15550190003")).rejects.toMatchObject({
      code: "23514",
    });

    // A BAA clinic whose answer moves is still covered.
    const baa = await seedUnder("baagate", {
      regime: "hipaa-if-covered",
      kind: "baa",
      covered: false,
      production: true,
      agreementVersion: "1.2.1",
    });
    await getMigratorPool().query(`update clinics set is_covered_entity = true where id = $1`, [
      baa.clinicId,
    ]);
    await expect(seedContact(baa.clinicId, "+15550190004")).resolves.toBeTruthy();

    // A veterinary practice under a BAA holds the wrong paper.
    const vet = await seedUnder("vetbaa", {
      regime: "non-hipaa",
      kind: "baa",
      covered: false,
      production: true,
      specialty: "veterinary",
      agreementVersion: "1.2.1",
    });
    await expect(seedContact(vet.clinicId, "+15550190005")).rejects.toMatchObject({
      code: "23514",
    });

    // An unrecorded kind keeps 0001's rule, and a synthetic clinic is never refused.
    const legacy = await seedUnder("legacy", {
      regime: "hipaa-if-covered",
      kind: null,
      covered: null,
      production: true,
    });
    await expect(seedContact(legacy.clinicId, "+15550190006")).resolves.toBeTruthy();
    const synthetic = await seedUnder("synthdpa", { regime: "hipaa", kind: "baa", covered: null });
    await getMigratorPool().query(
      `update clinics set agreement_kind = 'baa', regulatory_regime = 'non-hipaa' where id = $1`,
      [synthetic.clinicId],
    );
    await expect(seedContact(synthetic.clinicId, "+15550190007")).resolves.toBeTruthy();
  });

  test("a DPA is superseded by a later BAA: the old one ends today, the new one binds, every location moves, and it is recorded", async () => {
    const dpa = await seedUnder("supersede", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: true,
      production: true,
      agreementVersion: "dpa/1.0.0",
    });
    // A second location of the same organisation.
    const second = randomUUID();
    await getMigratorPool().query(
      `insert into clinics (id, organization_id, slug, name, specialty, regulatory_regime, agreement_kind, is_covered_entity)
       values ($1, $2, $3, 'Second location', 'med-spa', 'hipaa-if-covered', 'dpa', false)`,
      [second, dpa.organizationId, `second-${second.slice(0, 6)}`],
    );
    await expect(seedContact(dpa.clinicId, "+15550190101")).rejects.toMatchObject({
      code: "23514",
    });

    const baa = await seedAcceptance({ version: CURRENT_BAA_VERSION });
    const { rows } = await getAppPool().query<{ result: Record<string, string> }>(
      `select app_supersede_agreement($1::uuid, $2::uuid, 'ops@healdesk.test') as result`,
      [dpa.clinicId, baa],
    );
    const result = rows[0]!.result;
    expect(result).toMatchObject({
      supersededAgreementId: dpa.agreementId,
      supersededKind: "dpa",
      supersedingAgreementId: baa,
      supersedingKind: "baa",
    });

    const agreements = await getMigratorPool().query<{
      id: string;
      organization_id: string | null;
      terminated_at: Date | null;
      accepted_at: Date;
    }>(
      `select id, organization_id, terminated_at, accepted_at from baa_acceptances where id = any($1::uuid[])`,
      [[dpa.agreementId, baa]],
    );
    const old = agreements.rows.find((r) => r.id === dpa.agreementId)!;
    const fresh = agreements.rows.find((r) => r.id === baa)!;
    const endOfToday = `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`;
    expect(old.terminated_at?.toISOString()).toBe(endOfToday);
    expect(fresh.organization_id).toBe(dpa.organizationId);

    const clinicRows = await getMigratorPool().query<{
      id: string;
      agreement_kind: string;
      baa_signed_at: Date | null;
    }>(
      `select id, agreement_kind, baa_signed_at from clinics where organization_id = $1 order by created_at`,
      [dpa.organizationId],
    );
    expect(clinicRows.rows.map((r) => r.agreement_kind)).toEqual(["baa", "baa"]);
    expect(clinicRows.rows.find((r) => r.id === dpa.clinicId)!.baa_signed_at?.getTime()).toBe(
      fresh.accepted_at.getTime(),
    );
    expect(clinicRows.rows.find((r) => r.id === second)!.baa_signed_at).toBeNull();

    const events = await getMigratorPool().query<{
      actor_label: string;
      metadata: Record<string, string>;
    }>(
      `select actor_label, metadata from security_events where event = 'agreement_superseded' and organization_id = $1`,
      [dpa.organizationId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.actor_label).toBe("ops@healdesk.test");
    expect(events.rows[0]!.metadata).toMatchObject({
      supersededKind: "dpa",
      supersedingKind: "baa",
      supersededVersion: "dpa/1.0.0",
      supersedingVersion: CURRENT_BAA_VERSION,
    });

    // Under the BAA, the covered practice's data is accepted again.
    await expect(seedContact(dpa.clinicId, "+15550190102")).resolves.toBeTruthy();
  });

  test("a BAA may be replaced by a later BAA, and never by a DPA; a DPA is not replaced by a DPA", async () => {
    const baaClinic = await seedUnder("reaccept", {
      regime: "hipaa",
      kind: "baa",
      covered: true,
      agreementVersion: "1.2.1",
    });
    const dpaOffer = await seedAcceptance({ version: "dpa/1.0.0" });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        baaClinic.clinicId,
        dpaOffer,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const later = await seedAcceptance({ version: CURRENT_BAA_VERSION });
    const { rows } = await getAppPool().query<{ result: Record<string, string> }>(
      `select app_supersede_agreement($1::uuid, $2::uuid, 'ops') as result`,
      [baaClinic.clinicId, later],
    );
    expect(rows[0]!.result).toMatchObject({ supersededKind: "baa", supersedingKind: "baa" });

    const dpaClinic = await seedUnder("dpadpa", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: false,
      agreementVersion: "dpa/1.0.0",
    });
    const anotherDpa = await seedAcceptance({ version: "dpa/1.0.0" });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        dpaClinic.clinicId,
        anotherDpa,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("the supersede refuses what it must not do", async () => {
    const vet = await seedUnder("vetsup", {
      regime: "non-hipaa",
      kind: "dpa",
      covered: false,
      specialty: "veterinary",
      agreementVersion: "dpa/1.0.0",
    });
    // A BAA would not cover a veterinary practice.
    const baa = await seedAcceptance({ version: CURRENT_BAA_VERSION });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        vet.clinicId,
        baa,
      ]),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/would not cover/) });

    const dpa = await seedUnder("refusals", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: true,
      agreementVersion: "dpa/1.0.0",
    });
    // Signed before the agreement it would replace.
    const older = await seedAcceptance({
      version: CURRENT_BAA_VERSION,
      acceptedAt: new Date(dpa.acceptedAt.getTime() - 60_000),
    });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        dpa.clinicId,
        older,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    // Already bound to someone.
    const other = await seedClinic("otherorg");
    const bound = await seedAcceptance({
      version: CURRENT_BAA_VERSION,
      organizationId: other.organizationId,
    });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        dpa.clinicId,
        bound,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    // No actor, no clinic, no agreement in effect.
    const fresh = await seedAcceptance({ version: CURRENT_BAA_VERSION });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, ' ')`, [
        dpa.clinicId,
        fresh,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        randomUUID(),
        fresh,
      ]),
    ).rejects.toMatchObject({ code: "P0002" });
    const nothing = await seedUnder("noagreement", { regime: "hipaa", kind: null, covered: true });
    await expect(
      getAppPool().query(`select app_supersede_agreement($1::uuid, $2::uuid, 'ops')`, [
        nothing.clinicId,
        fresh,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    // Nothing moved.
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from security_events where event = 'agreement_superseded' and organization_id = $1`,
      [dpa.organizationId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("the TypeScript wrapper puts nothing in force under an unreleased template", async () => {
    const dpa = await seedUnder("wrapper", {
      regime: "hipaa-if-covered",
      kind: "dpa",
      covered: true,
      agreementVersion: "dpa/1.0.0",
    });
    const draft = await seedAcceptance({ version: "1.3.0" });
    expect(getBaaTemplate("1.3.0")!.approvedByCounsel).toBe(false);
    await expect(supersedeAgreement(dpa.clinicId, draft, "ops")).rejects.toBeInstanceOf(
      SupersedeError,
    );
    await expect(supersedeAgreement("not-a-clinic", draft, "ops")).rejects.toBeInstanceOf(
      SupersedeError,
    );
    const released = await seedAcceptance({ version: CURRENT_BAA_VERSION });
    const result = await supersedeAgreement(dpa.clinicId, released, "ops");
    expect(result).toMatchObject({
      supersededKind: "dpa",
      supersedingKind: "baa",
      supersedingAgreementId: released,
    });
    expect(result.terminatedAt.toISOString().endsWith("T23:59:59.999Z")).toBe(true);
  });
});

describeDb("provisioning records the regime and the kind (0048)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    release.dpa = false;
    await closePools();
  });

  function request(overrides: Partial<ProvisionRequest>): ProvisionRequest {
    return {
      clinicName: "Kind Clinic",
      specialty: "med-spa",
      platform: "none",
      plan: "web-voice",
      contactName: "Alex Chen",
      contactEmail: `alex-${randomUUID().slice(0, 8)}@kind.test`,
      agreementId: randomUUID(),
      idempotencyKey: `test_${randomUUID()}`,
      ...overrides,
    };
  }

  /** A DPA signed as the signing path is to sign one: the rendered text, its hash and its variables. */
  async function signDpa(variables: Partial<DpaVariables>): Promise<string> {
    const full: DpaVariables = {
      clinicLegalName: "Kind Clinic",
      signatoryName: "Alex Chen",
      signatoryEmail: "alex@kind.test",
      effectiveDate: new Date().toISOString().slice(0, 10),
      specialty: "med-spa",
      bookingSystem: "none",
      calendarAccount: "personal",
      ...variables,
    };
    const prepared = prepareDpa(currentDpaTemplate(), full);
    return seedAcceptance({
      version: prepared.version,
      variables: { ...full, appliedClauses: prepared.clauseIds },
      text: prepared.text,
    });
  }

  async function readClinic(clinicId: string) {
    const { rows } = await getMigratorPool().query<{
      regulatory_regime: string | null;
      agreement_kind: string | null;
      is_covered_entity: boolean | null;
      onboarding: Record<string, string | null>;
    }>(
      `select regulatory_regime, agreement_kind, is_covered_entity, onboarding from clinics where id = $1`,
      [clinicId],
    );
    return rows[0]!;
  }

  test("a BAA clinic is stored with its regime, its kind and the answer it signed", async () => {
    const baa = prepareBaa(getBaaTemplate(CURRENT_BAA_VERSION)!, {
      clinicLegalName: "Kind Clinic",
      specialty: "Med Spas, Dermatology & Aesthetics",
      signatoryName: "Alex Chen",
      signatoryEmail: "alex@kind.test",
      effectiveDate: "2026-10-06",
      isCoveredEntity: false,
      attributionMode: "estimated",
      connectedPlatform: null,
      outboundMessaging: false,
    });
    const agreementId = await seedAcceptance({
      version: baa.version,
      variables: { isCoveredEntity: false },
      text: baa.text,
    });
    const result = await provisionClinic(request({ agreementId }));
    const clinic = await readClinic(result.clinicId);
    expect(clinic).toMatchObject({
      regulatory_regime: "hipaa-if-covered",
      agreement_kind: "baa",
      is_covered_entity: false,
    });
    const { rows } = await getMigratorPool().query<{ metadata: Record<string, string> }>(
      `select metadata from security_events where event = 'clinic_provisioned' and organization_id = $1`,
      [result.organizationId],
    );
    expect(rows[0]!.metadata).toMatchObject({
      agreementKind: "baa",
      regulatoryRegime: "hipaa-if-covered",
    });
  });

  test("a veterinary practice is never provisioned under a BAA", async () => {
    const agreementId = await seedAcceptance({
      version: CURRENT_BAA_VERSION,
      variables: { isCoveredEntity: false },
    });
    await expect(
      provisionClinic(request({ agreementId, specialty: "veterinary" })),
    ).rejects.toThrow(/veterinary practice signs the data protection agreement/);
  });

  test("an unreleased DPA provisions nothing", async () => {
    release.dpa = false;
    const agreementId = await signDpa({});
    const req = request({ agreementId, clinicName: "Unreleased Clinic" });
    await expect(provisionClinic(req)).rejects.toThrow(/not released/);
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select (select count(*) from clinics where name = 'Unreleased Clinic')::int
            + (select count(*) from provisioning_attempts where idempotency_key = $1)::int as n`,
      [req.idempotencyKey],
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("a released DPA provisions a practice outside HIPAA, stored as not covered", async () => {
    release.dpa = true;
    try {
      const noAgreement = await signDpa({ clinicLegalName: "No Clinic" });
      const result = await provisionClinic(
        request({ agreementId: noAgreement, clinicName: "No Clinic" }),
      );
      const clinic = await readClinic(result.clinicId);
      expect(clinic).toMatchObject({
        regulatory_regime: "hipaa-if-covered",
        agreement_kind: "dpa",
        is_covered_entity: false,
      });
      expect(clinic.onboarding.covered_entity_confirmed).toBeTruthy();

      const vetAgreement = await signDpa({
        clinicLegalName: "Paws Clinic",
        specialty: "veterinary",
      });
      const vet = await provisionClinic(
        request({ agreementId: vetAgreement, clinicName: "Paws Clinic", specialty: "veterinary" }),
      );
      expect(await readClinic(vet.clinicId)).toMatchObject({
        regulatory_regime: "non-hipaa",
        agreement_kind: "dpa",
        is_covered_entity: false,
      });
    } finally {
      release.dpa = false;
    }
  });

  test("a released DPA still refuses a practice it was not written for", async () => {
    release.dpa = true;
    try {
      const forVet = await signDpa({ specialty: "veterinary" });
      await expect(
        provisionClinic(request({ agreementId: forVet, specialty: "med-spa" })),
      ).rejects.toBeInstanceOf(ProvisioningError);
      // A practice HIPAA always reaches, with a DPA row that names it (no signing path renders one).
      const dental = await seedAcceptance({
        version: "dpa/1.0.0",
        variables: { specialty: "dental" },
      });
      await expect(
        provisionClinic(request({ agreementId: dental, specialty: "dental" })),
      ).rejects.toThrow(/signs the business associate agreement/);
      // A DPA row that records a covered answer is not one anyone may sign.
      const covered = await seedAcceptance({
        version: "dpa/1.0.0",
        variables: { specialty: "med-spa", isCoveredEntity: true },
      });
      await expect(provisionClinic(request({ agreementId: covered }))).rejects.toBeInstanceOf(
        ProvisioningError,
      );
    } finally {
      release.dpa = false;
    }
  });
});
