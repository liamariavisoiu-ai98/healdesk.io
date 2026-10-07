import { BAA_TEMPLATES, DPA_TEMPLATES, DPA_VERSION_PREFIX } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  DAILY_DESTRUCTION_HOUR_UTC,
  DESTROY_AFTER_DAYS,
  DESTROY_WITHOUT_EXPORT_AFTER_DAYS,
  DESTRUCTION_RULES,
  destroyDueClinics,
  destroyEverythingDue,
  destructionPlan,
  destructionPlanIn,
  destructionRuleFor,
  dueForDestruction,
  markExportDelivered,
  OFFBOARDING_BACKDATE_LIMIT_DAYS,
  startOffboarding,
  THIRTY_DAY_RULE_DUE_DAYS,
  type DestructionInput,
} from "@/lib/offboarding/offboarding";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { JOB_OFFBOARDING_DESTROY, setJobEnabled } from "@/lib/scheduler/jobs";
import { runTick } from "@/lib/scheduler/tick";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * The destruction clock follows the clinic's own agreement (drizzle's
 * destruction_clock migration; lib/offboarding).
 *
 * BAA 1.2.1, the version every practice signs today, says "Within thirty
 * days of termination healdesk will return or destroy all PHI it holds for
 * Practice and retain no copies", as 1.2.0 and 1.1.0-draft do, and 1.0.0 and
 * 0.1.0-draft destroy "on termination". Until this change every clinic ran
 * on the DPA's rule, which waits up to ninety days for an export that has not
 * been delivered, so a 1.2.1 practice's patients could be held sixty days
 * past the date it signed for. These tests hold each version to its own rule,
 * the database's floor to the same rule, the clock's start to the week's
 * clamp, and destruction to every row the agreements reach: suppressions,
 * consent records and contact attempts included.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

/**
 * Every BAA version before 1.3.0, the drafts included: 1.1.0-draft to 1.2.1
 * say "within thirty days", and 1.0.0 and 0.1.0-draft "on termination".
 */
const THIRTY_DAY_VERSIONS = ["1.2.1", "1.2.0", "1.1.0-draft", "1.0.0", "0.1.0-draft"];
const EXPORT_RULE_VERSIONS = ["1.3.0", "dpa/1.0.0"];
/**
 * A word for each version, for the labels clinics are seeded under. A label
 * of digits can give a slug the audit's PHI scan reads as a telephone number
 * once a random suffix of digits follows it, and destruction's security event
 * carries the slug.
 */
const WORD: Record<string, string> = { "1.2.1": "flat", "1.3.0": "next", "dpa/1.0.0": "dpa" };

// -----------------------------------------------------------------------------
// The rule, as a pure function of the agreement's version and the dates
// -----------------------------------------------------------------------------

const ended = new Date("2026-11-01T15:00:00Z");
const at = (days: number) => new Date(ended.getTime() + days * DAY);

function clinicOn(version: string | null, exportDays: number | null = null) {
  return {
    offboardingStartedAt: ended,
    destroyAfter: at(DESTROY_AFTER_DAYS),
    exportDeliveredAt: exportDays === null ? null : at(exportDays),
    destroyedAt: null,
    destructionAgreementVersion: version,
  };
}

function planOf(input: DestructionInput) {
  const plan = destructionPlan(input);
  if (!plan) throw new Error("no plan");
  return plan;
}

describe("the version-to-rule map", () => {
  test("every agreement version in the catalog has a rule, so a new one cannot ship without one", () => {
    for (const template of BAA_TEMPLATES) {
      expect(destructionRuleFor(template.version).basis, template.version).toBe("agreement");
    }
    for (const template of DPA_TEMPLATES) {
      expect(destructionRuleFor(template.version).basis, template.version).toBe("agreement");
    }
    // And the map names nothing the catalog does not, in either namespace.
    const catalog = new Set([...BAA_TEMPLATES, ...DPA_TEMPLATES].map((t) => t.version));
    for (const [kind, rules] of Object.entries(DESTRUCTION_RULES)) {
      for (const bare of Object.keys(rules)) {
        const version = kind === "dpa" ? `${DPA_VERSION_PREFIX}${bare}` : bare;
        expect(catalog.has(version), version).toBe(true);
      }
    }
  });

  test("1.2.1 and every earlier version keep the thirty days; 1.3.0 and the DPA the export rule; the namespaces are kept apart", () => {
    for (const version of THIRTY_DAY_VERSIONS) {
      expect(destructionRuleFor(version), version).toEqual({
        rule: "thirty_days",
        basis: "agreement",
      });
    }
    for (const version of EXPORT_RULE_VERSIONS) {
      expect(destructionRuleFor(version), version).toEqual({
        rule: "export_or_ninety",
        basis: "agreement",
      });
    }
    // The DPA's 1.0.0 and the BAA's 1.0.0 are different agreements.
    expect(destructionRuleFor("1.0.0").rule).toBe("thirty_days");
    expect(destructionRuleFor("dpa/1.0.0").rule).toBe("export_or_ninety");
  });

  test("no agreement, and a version the map does not know, get the strictest rule, marked as such", () => {
    expect(destructionRuleFor(null)).toEqual({ rule: "thirty_days", basis: "no_agreement" });
    for (const version of ["9.9.9", "dpa/9.9.9", "dpa/1.3.0", "1.3.0-draft", "", "constructor"]) {
      expect(destructionRuleFor(version), version).toEqual({
        rule: "thirty_days",
        basis: "unknown_version",
      });
    }
  });
});

describe("the dates each rule gives", () => {
  test("BAA 1.2.1 and earlier, no export delivered: due at day 29, before the thirty days are up, never as late as day 90", () => {
    for (const version of THIRTY_DAY_VERSIONS) {
      const clinic = clinicOn(version);
      expect(dueForDestruction(clinic, at(28.99)), version).toBe(false);
      expect(dueForDestruction(clinic, at(THIRTY_DAY_RULE_DUE_DAYS)), version).toBe(true);
      expect(dueForDestruction(clinic, at(DESTROY_AFTER_DAYS)), version).toBe(true);
      const plan = planOf(clinic);
      expect(plan).toMatchObject({ rule: "thirty_days", basis: "agreement", dailyRunOnly: false });
      expect(plan.destroyDueAt).toEqual(at(29));
      expect(plan.latestDestroyAt).toEqual(at(29));
      expect(plan.exportDueBy).toEqual(at(29));
    }
  });

  test("BAA 1.2.1 with an export delivered: the same day 29", () => {
    for (const exportDays of [5, 28]) {
      const clinic = clinicOn("1.2.1", exportDays);
      expect(dueForDestruction(clinic, at(28.99))).toBe(false);
      expect(dueForDestruction(clinic, at(29))).toBe(true);
      expect(planOf(clinic).destroyDueAt).toEqual(at(29));
    }
  });

  test("BAA 1.3.0 and DPA 1.0.0: day 30 with the export delivered; without one, not at day 31 or 89, at its delivery, and at day 90", () => {
    for (const version of EXPORT_RULE_VERSIONS) {
      // Delivered by day 30: destroyed once thirty days have passed, not before.
      expect(dueForDestruction(clinicOn(version, 10), at(29.99)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version, 10), at(30)), version).toBe(true);
      // None delivered: held.
      expect(dueForDestruction(clinicOn(version), at(31)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version), at(89)), version).toBe(false);
      // Delivered later: the first run after the delivery.
      expect(dueForDestruction(clinicOn(version, 45), at(44.99)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version, 45), at(45)), version).toBe(true);
      // Never delivered: day 90 regardless.
      expect(
        dueForDestruction(clinicOn(version), at(DESTROY_WITHOUT_EXPORT_AFTER_DAYS)),
        version,
      ).toBe(true);
      const plan = planOf(clinicOn(version));
      expect(plan).toMatchObject({ rule: "export_or_ninety", dailyRunOnly: true });
      expect(plan.exportDueBy).toEqual(at(30));
      expect(plan.destroyDueAt).toEqual(at(90));
      expect(plan.latestDestroyAt).toEqual(at(90));
      expect(planOf(clinicOn(version, 10)).destroyDueAt).toEqual(at(30));
      expect(planOf(clinicOn(version, 45)).destroyDueAt).toEqual(at(45));
    }
  });

  test("no agreement: the thirty days; an unknown version: the thirty days too, so it is held no longer than any agreement allows", () => {
    for (const version of [null, "9.9.9"]) {
      const clinic = clinicOn(version);
      expect(dueForDestruction(clinic, at(28.99))).toBe(false);
      expect(dueForDestruction(clinic, at(29))).toBe(true);
      expect(planOf(clinic).basis).toBe(version === null ? "no_agreement" : "unknown_version");
    }
  });

  test("never for a clinic not offboarding, nor one already destroyed", () => {
    expect(
      dueForDestruction(
        { ...clinicOn("1.2.1"), offboardingStartedAt: null, destroyAfter: null },
        at(400),
      ),
    ).toBe(false);
    expect(dueForDestruction({ ...clinicOn("1.2.1"), destroyedAt: at(29) }, at(400))).toBe(false);
    expect(destructionPlan({ ...clinicOn("1.2.1"), offboardingStartedAt: null })).toBeNull();
  });

  test("the days a notice states are true whatever the hour the service ended", () => {
    // The thirty days: the hourly run reaches it the moment it is due, so the
    // last whole day to download is the day before, and the data is gone by
    // the day the thirty days end.
    expect(planOf(clinicOn("1.2.1"))).toMatchObject({
      exportByOn: "2026-11-29",
      destroyByOn: "2026-12-01",
    });
    // The DPA's rule: the 04 UTC run. Ended at 15:00, the run after day 30 is
    // the next morning's and the one after day 90 the next morning's too.
    expect(planOf(clinicOn("dpa/1.0.0"))).toMatchObject({
      exportByOn: "2026-12-01",
      destroyByOn: "2027-01-31",
    });
    // Ended at 02:00, that day's own 04 UTC run reaches both marks.
    const early = new Date("2026-11-01T02:00:00Z");
    expect(
      planOf({
        ...clinicOn("1.3.0"),
        offboardingStartedAt: early,
        destroyAfter: new Date(early.getTime() + 30 * DAY),
      }),
    ).toMatchObject({ exportByOn: "2026-11-30", destroyByOn: "2027-01-30" });
  });
});

// -----------------------------------------------------------------------------
// In the database
// -----------------------------------------------------------------------------

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block as the runtime role, inside a tenant, always rolled back. */
async function asApp<T>(clinicId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** An agreement bound to the organisation, signed (and bound) `ago` before now, as the migrator. */
async function bindAgreement(
  organizationId: string,
  version: string,
  ago = "1 year",
): Promise<void> {
  await getMigratorPool().query(
    `insert into baa_acceptances
       (organization_id, document_version, document_hash, rendered_text, variables, assent_label,
        accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, repeat('c', 64), 'AGREEMENT (test)', '{}'::jsonb, 'I agree', 'Alex Chen',
             'alex@clock.test', now() - $3::interval, now() - $3::interval)`,
    [organizationId, version, ago],
  );
}

/**
 * Time passing for the offboarding clock: the migrator, which owns clinics,
 * moves the database's stamps back as the hours would.
 */
async function moveBack(clinicId: string, hours: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(hours => $2),
            destroy_after = destroy_after - make_interval(hours => $2)
      where id = $1`,
    [clinicId, hours],
  );
}

async function stamps(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    offboarding_started_at: Date | null;
    destroy_after: Date | null;
    export_delivered_at: Date | null;
    destroyed_at: Date | null;
  }>(
    `select offboarding_started_at, destroy_after, export_delivered_at, destroyed_at
       from clinics where id = $1`,
    [clinicId],
  );
  return rows[0]!;
}

async function overviewOf(clinicId: string): Promise<ClinicOverview> {
  const found = (await listClinics()).find((c) => c.id === clinicId);
  if (!found) throw new Error(`no clinic ${clinicId}`);
  return found;
}

/** A person with a booked call, and the three kinds of contact evidence for their number. */
async function seedPersonAndEvidence(clinicId: string, phone: string): Promise<void> {
  const contactId = await seedContact(clinicId, phone);
  await seedConversation(clinicId, {
    startedAt: new Date(Date.now() - 40 * DAY),
    booked: true,
    contactId,
  });
  await seedEvidence(clinicId, phone, { suppression: true, consent: true, attempt: true });
}

async function seedEvidence(
  clinicId: string,
  phone: string,
  which: { suppression?: boolean; consent?: boolean; attempt?: boolean },
): Promise<void> {
  await inTenant(clinicId, async (client) => {
    if (which.suppression) {
      await client.query(
        `insert into suppressions (clinic_id, phone, reason) values ($1, $2, 'stop_reply')`,
        [clinicId, phone],
      );
    }
    if (which.consent) {
      await client.query(
        `insert into consent_records (clinic_id, phone, channel, consent_type, source, exact_wording)
         values ($1, $2, 'voice', 'express', 'inbound_call', 'Yes, you may call me back.')`,
        [clinicId, phone],
      );
    }
    if (which.attempt) {
      await client.query(
        `insert into contact_attempts (clinic_id, phone, channel, purpose) values ($1, $2, 'voice', 'booking')`,
        [clinicId, phone],
      );
    }
  });
}

async function evidenceCounts(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const n = async (table: string) =>
      (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
    return {
      suppressions: await n("suppressions"),
      consent_records: await n("consent_records"),
      contact_attempts: await n("contact_attempts"),
      contacts: await n("contacts"),
    };
  });
}

async function alertsFor(event: string, clinicId: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1 and fields->>'clinicId' = $2`,
    [event, clinicId],
  );
  return rows.map((r) => r.fields);
}

const notDue = { code: "23514", message: expect.stringMatching(/not due for destruction/) };

/** Each of the three functions that refuse a clinic that is not due, called as the runtime role. */
const GUARDED = [
  `select app_destroy_booking_requests($1::uuid)`,
  `select * from app_destroy_contact_evidence($1::uuid)`,
  `select app_mark_clinic_destroyed($1::uuid)`,
];

async function offboard(
  label: string,
  version: string | null,
): Promise<{ clinicId: string; organizationId: string }> {
  const c = await seedClinic(label);
  if (version) await bindAgreement(c.organizationId, version);
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
    startOffboarding(tx, "operator"),
  );
  return { clinicId: c.clinicId, organizationId: c.organizationId };
}

describeDb("the destruction clock in the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("app_destruction_rule is the map, version for version", async () => {
    const versions = [
      ...BAA_TEMPLATES.map((t) => t.version),
      ...DPA_TEMPLATES.map((t) => t.version),
      "9.9.9",
      "dpa/9.9.9",
      "dpa/1.3.0",
      "1.3.0-draft",
      "",
    ];
    for (const version of versions) {
      const { rows } = await getMigratorPool().query<{ rule: string }>(
        `select app_destruction_rule($1) as rule`,
        [version],
      );
      expect(rows[0]!.rule, version).toBe(destructionRuleFor(version).rule);
    }
    const { rows } = await getMigratorPool().query<{ rule: string }>(
      `select app_destruction_rule(null) as rule`,
    );
    expect(rows[0]!.rule).toBe(destructionRuleFor(null).rule);
  }, 120_000);

  test("the rule is read from the agreement the service ended under, whether or not it has been terminated since", async () => {
    const clinics: { clinicId: string; organizationId: string; version: string }[] = [];
    for (const version of ["1.2.1", "1.3.0", "dpa/1.0.0"]) {
      clinics.push({
        ...(await offboard(`clock-read-${WORD[version]}`, version)),
        version,
      });
    }

    // Not terminated: the agreement in effect and the one the service ended under agree.
    for (const c of clinics) {
      const overview = await overviewOf(c.clinicId);
      expect(overview.destructionAgreementVersion, c.version).toBe(c.version);
      expect(overview.baaVersion, c.version).toBe(c.version);
    }

    // Terminated, as an operator records it when they get to it: the agreement
    // in effect reads none, and the rule does not change.
    await getMigratorPool().query(
      `update baa_acceptances set terminated_at = now() where organization_id = any($1::text[])`,
      [clinics.map((c) => c.organizationId)],
    );
    for (const c of clinics) {
      const overview = await overviewOf(c.clinicId);
      expect(overview.baaVersion, c.version).toBeNull();
      expect(overview.destructionAgreementVersion, c.version).toBe(c.version);
      expect(destructionPlan(overview)?.rule, c.version).toBe(destructionRuleFor(c.version).rule);
      // The same read inside the clinic's own transaction, as the canceled email makes it.
      const inside = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        destructionPlanIn(tx),
      );
      expect(inside?.agreementVersion, c.version).toBe(c.version);
    }

    // An agreement signed after the service ended is not the one it ended under.
    const flat = clinics[0]!;
    await moveBack(flat.clinicId, 48);
    await bindAgreement(flat.organizationId, "1.3.0", "1 hour");
    expect((await overviewOf(flat.clinicId)).destructionAgreementVersion).toBe("1.2.1");

    // And a clinic that is not offboarding has no rule yet.
    const live = await seedClinic("clock-read-live");
    await bindAgreement(live.organizationId, "1.2.1");
    expect((await overviewOf(live.clinicId)).destructionAgreementVersion).toBeNull();
  }, 120_000);

  test("a 1.2.1 clinic is destroyed by the hourly run before thirty days have passed, export or not, and the database refuses it any earlier than day 29", async () => {
    const c = await offboard("clock-flat", "1.2.1");
    await seedPersonAndEvidence(c.clinicId, "+15550130001");

    // Twenty-eight days and twenty-three hours on: not yet, by the job or the database.
    await moveBack(c.clinicId, 29 * 24 - 1);
    for (const text of GUARDED) {
      await expect(
        asApp(c.clinicId, (q) => q.query(text, [c.clinicId])),
        text,
      ).rejects.toMatchObject(notDue);
    }
    let results = await destroyDueClinics(new Date(), { dailyRun: false });
    expect(results.map((r) => r.clinicId)).not.toContain(c.clinicId);

    // An hour later it is day 29, and an hourly run, not the daily one,
    // destroys it with no export delivered.
    await moveBack(c.clinicId, 1);
    results = await destroyDueClinics(new Date(), { dailyRun: false });
    expect(results.map((r) => r.clinicId)).toContain(c.clinicId);
    const after = await stamps(c.clinicId);
    expect(after.export_delivered_at).toBeNull();
    expect(after.destroyed_at).not.toBeNull();
    expect(after.destroyed_at!.getTime() - after.offboarding_started_at!.getTime()).toBeLessThan(
      DESTROY_AFTER_DAYS * DAY,
    );
    expect(await evidenceCounts(c.clinicId)).toEqual({
      suppressions: 0,
      consent_records: 0,
      contact_attempts: 0,
      contacts: 0,
    });
  }, 120_000);

  test("a clinic with no agreement on file, or on a version the map does not know, is held to the same thirty days, and the unknown version is logged", async () => {
    const none = await offboard("clock-none", null);
    const unknown = await offboard("clock-unknown", "9.9.9");
    for (const c of [none, unknown]) {
      await moveBack(c.clinicId, 29 * 24 - 1);
      await expect(
        asApp(c.clinicId, (q) => q.query(GUARDED[0]!, [c.clinicId])),
      ).rejects.toMatchObject(notDue);
      await moveBack(c.clinicId, 1);
    }
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    let results: Awaited<ReturnType<typeof destroyDueClinics>>;
    try {
      results = await destroyDueClinics(new Date(), { dailyRun: false });
    } finally {
      spy.mockRestore();
    }
    expect(results.map((r) => r.clinicId)).toEqual(
      expect.arrayContaining([none.clinicId, unknown.clinicId]),
    );
    // Not a throw, which would hold the clinic for ever: the strictest rule,
    // and a line naming the clinic and the version on every run.
    const unknownLines = lines.filter((l) => l.includes("destruction rule unknown"));
    expect(unknownLines).toHaveLength(1);
    expect(unknownLines[0]).toContain(unknown.clinicId);
    expect(unknownLines[0]).toContain("9.9.9");
  }, 120_000);

  test("a destruction whose security event is refused is still reported as run, and still writes its line", async () => {
    const c = await offboard("clock-slug", "1.2.1");
    // A slug the audit's PHI scan reads as a telephone number, as a clinic
    // named for its year could be given on a slug collision.
    const digits = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    await getMigratorPool().query(`update clinics set slug = $2 where id = $1`, [
      c.clinicId,
      `spa-2024-${digits}`,
    ]);
    await moveBack(c.clinicId, 29 * 24 + 1);

    const info: string[] = [];
    const errors: string[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      info.push(String(line));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    let results: Awaited<ReturnType<typeof destroyDueClinics>>;
    try {
      results = await destroyDueClinics(new Date(), { dailyRun: false });
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(results.map((r) => r.clinicId)).toContain(c.clinicId);
    expect((await stamps(c.clinicId)).destroyed_at).not.toBeNull();
    const mine = (lines: string[], text: string) =>
      lines.filter((line) => line.includes(text) && line.includes(c.clinicId));
    expect(mine(info, "clinic data destroyed")).toHaveLength(1);
    expect(mine(errors, "its security event was not recorded")).toHaveLength(1);
    expect(mine(errors, "destruction failed")).toEqual([]);
  }, 120_000);

  test("a clinic on BAA 1.3.0 or the DPA waits for its export and for the daily run, and the database holds it to the same rule", async () => {
    for (const version of EXPORT_RULE_VERSIONS) {
      const c = await offboard(`clock-export-${WORD[version]}`, version);
      await seedPersonAndEvidence(c.clinicId, "+15550130101");
      await moveBack(c.clinicId, 31 * 24);

      // Day 31 with no export delivered: held, by the job and by the database.
      expect(dueForDestruction(await overviewOf(c.clinicId), new Date()), version).toBe(false);
      for (const text of GUARDED) {
        await expect(
          asApp(c.clinicId, (q) => q.query(text, [c.clinicId])),
          text,
        ).rejects.toMatchObject(notDue);
      }
      let results = await destroyDueClinics(new Date(), { dailyRun: true });
      expect(
        results.map((r) => r.clinicId),
        version,
      ).not.toContain(c.clinicId);

      // Delivered: due at once, but only the once-a-day run destroys it.
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "bundle by SFTP to the practice manager"),
      );
      expect(dueForDestruction(await overviewOf(c.clinicId), new Date()), version).toBe(true);
      results = await destroyDueClinics(new Date(), { dailyRun: false });
      expect(
        results.map((r) => r.clinicId),
        version,
      ).not.toContain(c.clinicId);
      results = await destroyDueClinics(new Date(), { dailyRun: true });
      expect(
        results.map((r) => r.clinicId),
        version,
      ).toContain(c.clinicId);
      expect((await evidenceCounts(c.clinicId)).suppressions, version).toBe(0);
    }

    // Never delivered: held at day 89, and due at day 90 by the database too.
    const late = await offboard("clock-export-late", "dpa/1.0.0");
    await moveBack(late.clinicId, 89 * 24);
    expect(dueForDestruction(await overviewOf(late.clinicId), new Date())).toBe(false);
    await expect(
      asApp(late.clinicId, (q) => q.query(GUARDED[0]!, [late.clinicId])),
    ).rejects.toMatchObject(notDue);
    await moveBack(late.clinicId, 24);
    expect(dueForDestruction(await overviewOf(late.clinicId), new Date())).toBe(true);
    const allowed = await asApp(late.clinicId, (q) =>
      q.query<{ n: number }>(`select app_destroy_booking_requests($1::uuid) as n`, [late.clinicId]),
    );
    expect(allowed.rows[0]!.n).toBe(0);
    const results = await destroyDueClinics(new Date(), { dailyRun: true });
    expect(results.map((r) => r.clinicId)).toContain(late.clinicId);
  }, 120_000);

  test("from day 21 ops is told once, for a clinic on the thirty days with no export delivered, and never otherwise", async () => {
    const flat = await offboard("clock-alert-flat", "1.2.1");
    const none = await offboard("clock-alert-none", null);
    const delivered = await offboard("clock-alert-delivered", "1.2.1");
    await withTenant({ clinicId: delivered.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle by SFTP to the practice manager"),
    );
    const early = await offboard("clock-alert-early", "1.2.1");
    const v130 = await offboard("clock-alert-next", "1.3.0");
    const dpa = await offboard("clock-alert-dpa", "dpa/1.0.0");
    for (const c of [flat, none, delivered, v130, dpa]) await moveBack(c.clinicId, 21 * 24 + 1);
    await moveBack(early.clinicId, 20 * 24);

    // Every hour from day 21 the job looks; ops hears once.
    await destroyDueClinics(new Date(), { dailyRun: false });
    await destroyDueClinics(new Date(), { dailyRun: false });
    await destroyDueClinics(new Date(), { dailyRun: true });

    for (const c of [flat, none]) {
      const started = (await stamps(c.clinicId)).offboarding_started_at!;
      expect(await alertsFor("export_undelivered_before_destruction", c.clinicId)).toEqual([
        {
          clinicId: c.clinicId,
          destroyAt: new Date(started.getTime() + THIRTY_DAY_RULE_DUE_DAYS * DAY).toISOString(),
        },
      ]);
    }
    for (const c of [delivered, early, v130, dpa]) {
      expect(await alertsFor("export_undelivered_before_destruction", c.clinicId)).toEqual([]);
    }
    // One row, one email: the repeats are counted on it, not sent.
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts
        where event = 'export_undelivered_before_destruction' and fields->>'clinicId' = $1`,
      [flat.clinicId],
    );
    expect(rows[0]!.n).toBe(1);
  }, 120_000);

  test("the runtime role can start the clock a week back at most, never ahead, and never move it once stamped", async () => {
    const c = await seedClinic("clock-clamp");
    type Start = {
      started_at: Date;
      due_at: Date;
      first_start: boolean;
      asked_for: Date;
      clock: Date;
      exact: boolean;
    };
    const start = (q: Client, ended: string) =>
      q
        .query<Start>(
          `select s.*, clock_timestamp() as clock, s.started_at = ${ended} as exact
             from app_start_offboarding($1::uuid, ${ended}) s`,
          [c.clinicId],
        )
        .then((r) => r.rows[0]!);

    // Inside the week: exactly the end it was given, and thirty days to destroy_after.
    const within = await asApp(c.clinicId, (q) => start(q, "now() - interval '3 days'"));
    expect(within).toMatchObject({ exact: true, first_start: true });
    expect(within.due_at.getTime() - within.started_at.getTime()).toBe(DESTROY_AFTER_DAYS * DAY);

    // A month back: a week back and no further.
    const month = await asApp(c.clinicId, async (q) => {
      const first = await start(q, "now() - interval '30 days'");
      const again = await start(q, "now() - interval '3 days'");
      return { first, again };
    });
    const week = OFFBOARDING_BACKDATE_LIMIT_DAYS * DAY;
    expect(month.first.exact).toBe(false);
    expect(month.first.clock.getTime() - month.first.started_at.getTime()).toBeGreaterThanOrEqual(
      week,
    );
    expect(month.first.clock.getTime() - month.first.started_at.getTime()).toBeLessThan(
      week + 60_000,
    );
    expect(month.first.started_at.getTime() - month.first.asked_for.getTime()).toBeGreaterThan(
      22 * DAY,
    );
    // Stamped once: a second start moves nothing.
    expect(month.again.first_start).toBe(false);
    expect(month.again.started_at).toEqual(month.first.started_at);
    expect(month.again.due_at).toEqual(month.first.due_at);

    // Ahead of now: now.
    const ahead = await asApp(c.clinicId, (q) => start(q, "now() + interval '5 days'"));
    expect(ahead.exact).toBe(false);
    expect(Math.abs(ahead.clock.getTime() - ahead.started_at.getTime())).toBeLessThan(60_000);

    // Nor can it write the stamps, or the export's, any other way.
    for (const column of ["offboarding_started_at", "destroy_after", "export_delivered_at"]) {
      await expect(
        asApp(c.clinicId, (q) =>
          q.query(`update clinics set ${column} = now() - interval '100 days' where id = $1`, [
            c.clinicId,
          ]),
        ),
        column,
      ).rejects.toMatchObject({ code: "42501" });
    }
    // The export's stamp waits for offboarding, and belongs to the tenant's own clinic.
    await expect(
      asApp(c.clinicId, (q) => q.query(`select app_mark_export_delivered($1::uuid)`, [c.clinicId])),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/not offboarding/) });
    const other = await seedClinic("clock-clamp-other");
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`select app_mark_export_delivered($1::uuid)`, [other.clinicId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  }, 120_000);

  test("destruction removes the clinic's suppressions, consent records and contact attempts, refuses to record itself while any is left, and leaves another clinic's alone", async () => {
    const c = await offboard("clock-evidence", "1.2.1");
    const other = await seedClinic("clock-evidence-other");
    await seedPersonAndEvidence(c.clinicId, "+15550130201");
    await seedPersonAndEvidence(other.clinicId, "+15550130201");
    await moveBack(c.clinicId, 29 * 24 + 1);

    // The runtime role still cannot delete any of them itself.
    for (const table of ["suppressions", "consent_records", "contact_attempts"]) {
      await expect(
        asApp(c.clinicId, (q) => q.query(`delete from ${table}`)),
        table,
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied/),
      });
    }
    // Nor through the function, for anyone but the tenant.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`select * from app_destroy_contact_evidence($1::uuid)`, [other.clinicId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const results = await destroyDueClinics(new Date(), { dailyRun: false });
    const mine = results.find((r) => r.clinicId === c.clinicId);
    expect(mine?.deleted).toMatchObject({
      suppressions: 1,
      consent_records: 1,
      contact_attempts: 1,
    });
    expect(await evidenceCounts(c.clinicId)).toEqual({
      suppressions: 0,
      consent_records: 0,
      contact_attempts: 0,
      contacts: 0,
    });
    expect(await evidenceCounts(other.clinicId)).toEqual({
      suppressions: 1,
      consent_records: 1,
      contact_attempts: 1,
      contacts: 1,
    });

    // Due, and holding nothing but one of the three: the database will not
    // record the destruction while it is there.
    for (const which of ["suppression", "consent", "attempt"] as const) {
      const holding = await offboard(`clock-evidence-${which}`, "1.2.1");
      await seedEvidence(holding.clinicId, "+15550130301", { [which]: true });
      await moveBack(holding.clinicId, 29 * 24 + 1);
      await expect(
        asApp(holding.clinicId, (q) =>
          q.query(`select app_mark_clinic_destroyed($1::uuid)`, [holding.clinicId]),
        ),
        which,
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });
    }
  }, 120_000);

  test("after a restore, the dates on the destruction's log line make a clinic due again, and the check destroys it again", async () => {
    const c = await offboard("clock-restore", "dpa/1.0.0");
    await seedPersonAndEvidence(c.clinicId, "+15550130401");
    await moveBack(c.clinicId, 31 * 24);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle by SFTP to the practice manager"),
    );
    const destroyedOn = await stamps(c.clinicId);

    // The check destroys it, and the line it writes carries the dates it was
    // destroyed on.
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    let first: Awaited<ReturnType<typeof destroyEverythingDue>>;
    try {
      first = await destroyEverythingDue();
    } finally {
      spy.mockRestore();
    }
    expect(first.destroyed.map((r) => r.clinicId)).toContain(c.clinicId);
    expect(first.stillDue).not.toContain(c.clinicId);
    const line = lines.find((l) => l.includes("clinic data destroyed") && l.includes(c.clinicId));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!.slice(line!.indexOf("{"))) as Record<string, unknown>;
    expect(fields).toMatchObject({
      clinicId: c.clinicId,
      serviceEndedAt: destroyedOn.offboarding_started_at!.toISOString(),
      exportDeliveredAt: destroyedOn.export_delivered_at!.toISOString(),
    });

    // A restore from a backup taken before the export was recorded: the
    // patient is back, the clinic is not destroyed, and nothing says the
    // export was delivered. On the DPA's rule that is not due before day 90,
    // so the check alone passes it over.
    await getMigratorPool().query(
      `update clinics set destroyed_at = null, export_delivered_at = null where id = $1`,
      [c.clinicId],
    );
    await seedPersonAndEvidence(c.clinicId, "+15550130402");
    const blind = await destroyEverythingDue();
    expect(blind.destroyed.map((r) => r.clinicId)).not.toContain(c.clinicId);
    expect((await evidenceCounts(c.clinicId)).contacts).toBe(1);

    // The step before it puts the line's dates back (docs/handover.md,
    // "Restoring"), and the check destroys the clinic again.
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = $2::timestamptz,
              destroy_after = $2::timestamptz + interval '30 days',
              export_delivered_at = $3::timestamptz
        where id = $1`,
      [c.clinicId, fields.serviceEndedAt, fields.exportDeliveredAt],
    );
    const again = await destroyEverythingDue();
    expect(again.destroyed.map((r) => r.clinicId)).toContain(c.clinicId);
    expect(again.stillDue).not.toContain(c.clinicId);
    expect(await evidenceCounts(c.clinicId)).toEqual({
      suppressions: 0,
      consent_records: 0,
      contact_attempts: 0,
      contacts: 0,
    });
  }, 120_000);

  test("the hourly tick destroys a clinic on the thirty days at whatever hour it is due, and one on BAA 1.3.0 or the DPA only at the daily run", async () => {
    const admin = await seedClinic("clock-tick-admin");
    const flat = await offboard("clock-tick-flat", "1.2.1");
    const v130 = await offboard("clock-tick-next", "1.3.0");
    const dpa = await offboard("clock-tick-dpa", "dpa/1.0.0");
    await moveBack(flat.clinicId, 29 * 24 + 1);
    for (const c of [v130, dpa]) {
      await moveBack(c.clinicId, 31 * 24);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "bundle by SFTP to the practice manager"),
      );
    }
    // Ticks on tomorrow's clock, when all three are due: the hour before the
    // daily run, then the daily run's.
    const tomorrow = new Date(Date.now() + DAY);
    const hour = (h: number) =>
      new Date(
        Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), h),
      );
    const destroyed = async (clinicId: string) => (await stamps(clinicId)).destroyed_at !== null;

    await setJobEnabled(JOB_OFFBOARDING_DESTROY, true, admin.staffUserId);
    try {
      const before = await runTick(hour(DAILY_DESTRUCTION_HOUR_UTC - 1));
      expect(before.find((o) => o.job === "offboarding-destroy")?.status).toBe("ok");
      expect(await destroyed(flat.clinicId)).toBe(true);
      expect(await destroyed(v130.clinicId)).toBe(false);
      expect(await destroyed(dpa.clinicId)).toBe(false);

      const daily = await runTick(hour(DAILY_DESTRUCTION_HOUR_UTC));
      expect(daily.find((o) => o.job === "offboarding-destroy")?.status).toBe("ok");
      expect(await destroyed(v130.clinicId)).toBe(true);
      expect(await destroyed(dpa.clinicId)).toBe(true);
    } finally {
      await setJobEnabled(JOB_OFFBOARDING_DESTROY, false, admin.staffUserId);
    }
  }, 120_000);
});
