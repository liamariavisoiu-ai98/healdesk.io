import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BAA_TEMPLATES, DPA_TEMPLATES, DPA_VERSION_PREFIX } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
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
  NINETY_DAY_LIMIT_DUE_DAYS,
  OFFBOARDING_BACKDATE_LIMIT_DAYS,
  startOffboarding,
  THIRTY_DAY_LIMIT_DUE_DAYS,
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
import { sessionReach, setLocalZone, zoneShrinking, zoneStretching } from "./setup/time-zones";

/**
 * The destruction clock follows the clinic's own agreement (drizzle's
 * destruction_clock migration; lib/offboarding).
 *
 * BAA 1.2.2, the version every practice signs today, says "Within thirty
 * days of termination healdesk will return or destroy all PHI it holds for
 * Practice and retain no copies", as 1.2.1, 1.2.0 and 1.1.0-draft do, and 1.0.0 and
 * 0.1.0-draft destroy "on termination". Until this change every clinic ran
 * on the DPA's rule, which waits up to ninety days for an export that has not
 * been delivered, so a 1.2.1 practice's patients could be held sixty days
 * past the date it signed for. BAA 1.3.0 destroys "thirty days after the
 * Services end if the export has been delivered by then; otherwise as soon as
 * the export is delivered; and in any case no later than ninety days", and a
 * once-a-day run could pass each of those by up to a day; the hourly job now
 * meets each limit a day early, for 1.3.0 and the DPA alike. These tests hold
 * each version to its own rule and its boundaries, the database's floor to
 * the same rule, the clock's start to the week's clamp, and destruction to
 * every row the agreements reach: suppressions, consent records and contact
 * attempts included.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

/**
 * Every BAA version before 1.3.0, the drafts included: 1.1.0-draft to 1.2.2
 * say "within thirty days", and 1.0.0 and 0.1.0-draft "on termination".
 */
const THIRTY_DAY_VERSIONS = ["1.2.2", "1.2.1", "1.2.0", "1.1.0-draft", "1.0.0", "0.1.0-draft"];
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

  test("1.2.2 and every earlier version keep the thirty days; 1.3.0 and the DPA the export rule; the namespaces are kept apart", () => {
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
      expect(dueForDestruction(clinic, at(THIRTY_DAY_LIMIT_DUE_DAYS)), version).toBe(true);
      expect(dueForDestruction(clinic, at(DESTROY_AFTER_DAYS)), version).toBe(true);
      const plan = planOf(clinic);
      expect(plan).toMatchObject({ rule: "thirty_days", basis: "agreement" });
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

  test("BAA 1.3.0 and DPA 1.0.0: day 29 with the export delivered by then; at a later delivery; day 89 without, so neither limit is passed", () => {
    const hour = 1 / 24;
    for (const version of EXPORT_RULE_VERSIONS) {
      // Delivered by day 30: due a day before the thirty days are up, so the
      // next hourly run has it gone inside them, and not a moment earlier.
      expect(dueForDestruction(clinicOn(version, 10), at(28)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version, 10), at(29 - hour)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version, 10), at(THIRTY_DAY_LIMIT_DUE_DAYS)), version).toBe(
        true,
      );
      expect(planOf(clinicOn(version, 10)).destroyDueAt, version).toEqual(at(29));
      // Delivered after day 30: due at the delivery, for the next hourly run.
      expect(dueForDestruction(clinicOn(version, 40), at(40 - hour)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version, 40), at(40)), version).toBe(true);
      expect(planOf(clinicOn(version, 40)).destroyDueAt, version).toEqual(at(40));
      // Delivered on day 29 itself: due at the delivery, never before it.
      expect(planOf(clinicOn(version, 29.5)).destroyDueAt, version).toEqual(at(29.5));
      // None delivered: held past day 30, still held at day 88 h 23, due at
      // day 89, so the next hourly run never passes ninety days.
      expect(dueForDestruction(clinicOn(version), at(31)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version), at(89 - hour)), version).toBe(false);
      expect(dueForDestruction(clinicOn(version), at(NINETY_DAY_LIMIT_DUE_DAYS)), version).toBe(
        true,
      );
      // A delivery the ninety days already passed does not hold it longer.
      expect(planOf(clinicOn(version, 95)).destroyDueAt, version).toEqual(at(89));
      const plan = planOf(clinicOn(version));
      expect(plan).toMatchObject({ rule: "export_or_ninety", basis: "agreement" });
      expect(plan.exportDueBy).toEqual(at(29));
      expect(plan.destroyDueAt).toEqual(at(89));
      expect(plan.latestDestroyAt).toEqual(at(89));
    }
    // The limits the agreements state, met a day early.
    expect(THIRTY_DAY_LIMIT_DUE_DAYS).toBe(DESTROY_AFTER_DAYS - 1);
    expect(NINETY_DAY_LIMIT_DUE_DAYS).toBe(DESTROY_WITHOUT_EXPORT_AFTER_DAYS - 1);
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
    // Either rule: an hourly run may reach the clinic from day 29, so the
    // last whole day to download is the day before; and the data is gone by
    // the day its limit ends, thirty days or ninety.
    expect(planOf(clinicOn("1.2.1"))).toMatchObject({
      exportByOn: "2026-11-29",
      destroyByOn: "2026-12-01",
    });
    for (const version of EXPORT_RULE_VERSIONS) {
      expect(planOf(clinicOn(version)), version).toMatchObject({
        exportByOn: "2026-11-29",
        destroyByOn: "2027-01-30",
      });
    }
    // And at any hour of the day: no run can destroy the data before
    // exportByOn has ended, a run may on the day after it, and the run after
    // the latest due moment comes before destroyByOn has ended.
    const HOUR = 60 * 60 * 1000;
    const startOf = (day: string) => new Date(`${day}T00:00:00Z`).getTime();
    for (const time of ["00:00", "00:30", "02:00", "12:00", "23:00", "23:59"]) {
      const end = new Date(`2026-11-01T${time}:00Z`);
      for (const version of ["1.2.1", ...EXPORT_RULE_VERSIONS]) {
        const plan = planOf({
          ...clinicOn(version),
          offboardingStartedAt: end,
          destroyAfter: new Date(end.getTime() + DESTROY_AFTER_DAYS * DAY),
        });
        const earliest = end.getTime() + THIRTY_DAY_LIMIT_DUE_DAYS * DAY;
        const label = `${version} ended ${time}`;
        expect(startOf(plan.exportByOn) + DAY, label).toBeLessThanOrEqual(earliest);
        expect(startOf(plan.exportByOn) + 2 * DAY, label).toBeGreaterThan(earliest);
        expect(plan.latestDestroyAt.getTime() + HOUR, label).toBeLessThanOrEqual(
          startOf(plan.destroyByOn) + DAY,
        );
      }
    }
  });
});

describe("the export is owed to every leaving practice, asked for or not", () => {
  // BAA 1.2.2 and 1.2.1 give the export "on request", but Terms §7 promises every
  // practice one within thirty days of the end, and the canceled email tells
  // it one is coming, so a practice has no reason to ask. Under the thirty
  // days the data goes at day 29 whatever the export, so a runbook that said
  // to deliver "any export the practice asked for" let one that was told to
  // expect its records lose them for good. The ops alert's wording is held in
  // tests/email-templates.test.ts, the care page's in apps/web.
  test("the handover's runbook tells the operator to deliver it before day 29, unasked", () => {
    const handover = readFileSync(
      fileURLToPath(new URL("../../../docs/handover.md", import.meta.url)),
      "utf8",
    );
    const from = handover.indexOf("- BAA 1.2.2 and earlier, or no agreement on file");
    expect(from).toBeGreaterThan(-1);
    const bullet = handover.slice(from, handover.indexOf("\n- ", from + 1)).replace(/\s+/g, " ");
    expect(bullet).toContain("whether or not it asks");
    expect(bullet).toContain("Terms §7");
    expect(bullet).not.toMatch(/asked for/);
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
 * moves the database's stamps back as the hours would, the export's delivery
 * with them, so an export delivered on day 10 stays delivered on day 10.
 */
async function moveBack(clinicId: string, hours: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(hours => $2),
            destroy_after = destroy_after - make_interval(hours => $2),
            export_delivered_at = export_delivered_at - make_interval(hours => $2)
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

/**
 * Each of the six functions that refuse a clinic that is not due, called as
 * the runtime role: the five deletes (the calendar's providers since 0057,
 * the records of deletion requests since 0063, the amendments since 0064)
 * and the destroyed stamp.
 */
const GUARDED = [
  `select app_destroy_booking_requests($1::uuid)`,
  `select * from app_destroy_contact_evidence($1::uuid)`,
  `select app_destroy_clinic_providers($1::uuid)`,
  `select app_destroy_erasure_requests($1::uuid)`,
  `select app_destroy_record_amendments($1::uuid)`,
  `select app_mark_clinic_destroyed($1::uuid)`,
];

/**
 * Every function that counts days for the destruction clock, its floor or the
 * record clock (0054), and the definers that refuse on them: each must count
 * in UTC, whatever zone its caller's session set.
 */
const DAY_COUNTING_FUNCTIONS = [
  "app_start_offboarding(uuid, timestamptz)",
  "app_destruction_due(uuid)",
  "app_destroy_booking_requests(uuid)",
  "app_destroy_contact_evidence(uuid)",
  "app_destroy_clinic_providers(uuid)",
  "app_mark_clinic_destroyed(uuid)",
  "app_record_days_in_force(integer, integer, timestamptz)",
  "app_record_cutoff()",
  "app_purge_booking_requests(timestamptz)",
  // 0063: the deletion records' own clock, and their delete at destruction.
  "app_expire_erasure_records()",
  "app_destroy_erasure_requests(uuid)",
  // 0064: the amendments' delete at destruction, and at the purge.
  "app_destroy_record_amendments(uuid)",
  "app_purge_amended_appointments(timestamptz)",
  "app_purge_amended_conversations(timestamptz)",
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
    let results = await destroyDueClinics(new Date());
    expect(results.map((r) => r.clinicId)).not.toContain(c.clinicId);

    // An hour later it is day 29, and an ordinary hourly run destroys it
    // with no export delivered.
    await moveBack(c.clinicId, 1);
    results = await destroyDueClinics(new Date());
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
      results = await destroyDueClinics(new Date());
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
      results = await destroyDueClinics(new Date());
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

  /** Held, by the job and by the database's floor under all four of its functions. */
  async function expectHeld(clinicId: string, label: string): Promise<void> {
    expect(dueForDestruction(await overviewOf(clinicId), new Date()), label).toBe(false);
    for (const text of GUARDED) {
      await expect(
        asApp(clinicId, (q) => q.query(text, [clinicId])),
        `${label}: ${text}`,
      ).rejects.toMatchObject(notDue);
    }
    const results = await destroyDueClinics(new Date());
    expect(
      results.map((r) => r.clinicId),
      label,
    ).not.toContain(clinicId);
  }

  /** Due by the job and the database, and destroyed by an ordinary hourly run, at whatever hour. */
  async function expectDestroyed(clinicId: string, label: string): Promise<void> {
    expect(dueForDestruction(await overviewOf(clinicId), new Date()), label).toBe(true);
    const allowed = await asApp(clinicId, (q) =>
      q.query<{ n: number }>(`select app_destroy_booking_requests($1::uuid) as n`, [clinicId]),
    );
    expect(allowed.rows[0]!.n, label).toBeGreaterThanOrEqual(0);
    const results = await destroyDueClinics(new Date());
    expect(
      results.map((r) => r.clinicId),
      label,
    ).toContain(clinicId);
    expect(await evidenceCounts(clinicId), label).toEqual({
      suppressions: 0,
      consent_records: 0,
      contact_attempts: 0,
      contacts: 0,
    });
  }

  test("a clinic on BAA 1.3.0 or the DPA with an export delivered by day 30 is held at day 28 h 23 and destroyed at day 29, by any hourly run", async () => {
    for (const version of EXPORT_RULE_VERSIONS) {
      const label = `${version}, delivered at day 10`;
      const c = await offboard(`clock-early-${WORD[version]}`, version);
      await seedPersonAndEvidence(c.clinicId, "+15550130101");
      await moveBack(c.clinicId, 10 * 24);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "bundle by SFTP to the practice manager"),
      );
      // Day 28, then day 28 and twenty-three hours: delivered, and still held.
      await moveBack(c.clinicId, 18 * 24);
      await expectHeld(c.clinicId, `${label}, day 28`);
      await moveBack(c.clinicId, 23);
      await expectHeld(c.clinicId, `${label}, day 28 h 23`);
      // An hour later it is day 29: due, a day before the thirty days are up.
      await moveBack(c.clinicId, 1);
      await expectDestroyed(c.clinicId, `${label}, day 29`);
      const after = await stamps(c.clinicId);
      expect(after.destroyed_at!.getTime() - after.offboarding_started_at!.getTime()).toBeLessThan(
        DESTROY_AFTER_DAYS * DAY,
      );
    }
  }, 120_000);

  test("a clinic on BAA 1.3.0 or the DPA whose export is delivered after day 30 is destroyed at its delivery", async () => {
    for (const version of EXPORT_RULE_VERSIONS) {
      const label = `${version}, delivered at day 40`;
      const c = await offboard(`clock-later-${WORD[version]}`, version);
      await seedPersonAndEvidence(c.clinicId, "+15550130151");
      // Day 40 with no export delivered: held.
      await moveBack(c.clinicId, 40 * 24);
      await expectHeld(c.clinicId, `${label}, before it`);
      // Delivered at day 40: due at once, and the next hourly run destroys it.
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "bundle by SFTP to the practice manager"),
      );
      await expectDestroyed(c.clinicId, label);
    }
  }, 120_000);

  test("a clinic on BAA 1.3.0 or the DPA with no export delivered is held at day 88 h 23 and destroyed at day 89, so ninety days are never passed", async () => {
    for (const version of EXPORT_RULE_VERSIONS) {
      const label = `${version}, never delivered`;
      const c = await offboard(`clock-never-${WORD[version]}`, version);
      await seedPersonAndEvidence(c.clinicId, "+15550130171");
      await moveBack(c.clinicId, 31 * 24);
      await expectHeld(c.clinicId, `${label}, day 31`);
      await moveBack(c.clinicId, (NINETY_DAY_LIMIT_DUE_DAYS - 31) * 24 - 1);
      await expectHeld(c.clinicId, `${label}, day 88 h 23`);
      await moveBack(c.clinicId, 1);
      await expectDestroyed(c.clinicId, `${label}, day 89`);
      const after = await stamps(c.clinicId);
      expect(after.export_delivered_at, label).toBeNull();
      expect(after.destroyed_at!.getTime() - after.offboarding_started_at!.getTime()).toBeLessThan(
        DESTROY_WITHOUT_EXPORT_AFTER_DAYS * DAY,
      );
    }
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
    await destroyDueClinics(new Date());
    await destroyDueClinics(new Date());
    await destroyDueClinics(new Date());

    for (const c of [flat, none]) {
      const started = (await stamps(c.clinicId)).offboarding_started_at!;
      expect(await alertsFor("export_undelivered_before_destruction", c.clinicId)).toEqual([
        {
          clinicId: c.clinicId,
          destroyAt: new Date(started.getTime() + THIRTY_DAY_LIMIT_DUE_DAYS * DAY).toISOString(),
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

    const results = await destroyDueClinics(new Date());
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
    // export was delivered. On the DPA's rule that is not due before day 89,
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

  test("every hourly tick reaches both rules: a tick at any hour destroys whatever is due under each, the old once-a-day hour no different", async () => {
    const admin = await seedClinic("clock-tick-admin");
    const tomorrow = new Date(Date.now() + DAY);
    const destroyed = async (clinicId: string) => (await stamps(clinicId)).destroyed_at !== null;
    // Words, not digits, in the labels (see WORD above). 04 is the hour the
    // DPA's rule used to wait for, and 03 and 05 are either side of it.
    const HOURS: [number, string][] = [
      [0, "midnight"],
      [3, "three"],
      [4, "four"],
      [5, "five"],
      [13, "afternoon"],
      [23, "late"],
    ];

    await setJobEnabled(JOB_OFFBOARDING_DESTROY, true, admin.staffUserId);
    try {
      for (const [h, word] of HOURS) {
        // Due under every branch of both rules: the thirty days at day 29,
        // 1.3.0 with its export delivered at day 10 now at day 29, and the
        // DPA with none at day 89. And a 1.3.0 clinic with none at day 31,
        // which no tick may touch.
        const flat = await offboard(`clock-tick-${word}-flat`, "1.2.1");
        const v130 = await offboard(`clock-tick-${word}-next`, "1.3.0");
        const dpa = await offboard(`clock-tick-${word}-dpa`, "dpa/1.0.0");
        const held = await offboard(`clock-tick-${word}-held`, "1.3.0");
        await moveBack(flat.clinicId, 29 * 24 + 1);
        await moveBack(v130.clinicId, 10 * 24);
        await withTenant({ clinicId: v130.clinicId, actor: ACTOR }, (tx) =>
          markExportDelivered(tx, "bundle by SFTP to the practice manager"),
        );
        await moveBack(v130.clinicId, 19 * 24 + 1);
        await moveBack(dpa.clinicId, 89 * 24 + 1);
        await moveBack(held.clinicId, 31 * 24);

        const at = new Date(
          Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), h),
        );
        const outcomes = await runTick(at);
        expect(outcomes.find((o) => o.job === "offboarding-destroy")?.status, word).toBe("ok");
        expect(await destroyed(flat.clinicId), `${word}: 1.2.1`).toBe(true);
        expect(await destroyed(v130.clinicId), `${word}: 1.3.0, delivered`).toBe(true);
        expect(await destroyed(dpa.clinicId), `${word}: DPA, none`).toBe(true);
        expect(await destroyed(held.clinicId), `${word}: 1.3.0, none at day 31`).toBe(false);
      }
    } finally {
      await setJobEnabled(JOB_OFFBOARDING_DESTROY, false, admin.staffUserId);
    }
  }, 180_000);

  // ---------------------------------------------------------------------------
  // The caller's time zone (review of 7 October)
  // ---------------------------------------------------------------------------
  // Any role may set its own session's TimeZone, and Postgres counts
  // `interval 'N days'` in it, so a POSIX zone with offsets 334 hours apart
  // stretched the week's clamp to nearly three and shrank the floor's
  // twenty-nine days to fifteen: enough for the runtime role to start a live
  // clinic's clock and destroy its data in one transaction. Every function
  // that counts days for the clock or the floor now counts them in UTC.

  test("every function that counts days for the clock, the floor or the record clock pins its time zone to UTC", async () => {
    for (const fn of DAY_COUNTING_FUNCTIONS) {
      const { rows } = await getMigratorPool().query<{ proconfig: string[] | null }>(
        `select proconfig from pg_proc where oid = $1::regprocedure`,
        [fn],
      );
      expect(rows[0]?.proconfig ?? [], fn).toContain("TimeZone=UTC");
    }
  });

  test("a time zone the runtime role sets for itself cannot stretch the week's clamp, push the start past the call, or change the thirty days after it", async () => {
    const c = await seedClinic("clock-zone-clamp");
    const week = OFFBOARDING_BACKDATE_LIMIT_DAYS * DAY;
    // One zone puts the session's "a week ago" nearly three weeks back, the
    // other days ahead of now.
    for (const hostile of [await zoneStretching("7 days"), await zoneShrinking("7 days")]) {
      const start = await asApp(c.clinicId, async (q) => {
        await setLocalZone(q, hostile.zone);
        const reach = await sessionReach(q, "7 days");
        // Measured in SQL: a timestamp the session prints in a zone 167 hours
        // off UTC is one node-pg cannot parse back.
        const { rows } = await q.query<{ back_ms: number; span_ms: number }>(
          `select extract(epoch from clock_timestamp() - s.started_at)::float8 * 1000 as back_ms,
                  extract(epoch from s.due_at - s.started_at)::float8 * 1000 as span_ms
             from app_start_offboarding($1::uuid, '-infinity') s`,
          [c.clinicId],
        );
        return { reach, ...rows[0]! };
      });
      expect(Math.abs(start.reach - OFFBOARDING_BACKDATE_LIMIT_DAYS), hostile.zone).toBeGreaterThan(
        5,
      );
      expect(start.back_ms, hostile.zone).toBeGreaterThanOrEqual(week);
      expect(start.back_ms, hostile.zone).toBeLessThan(week + 60_000);
      expect(start.span_ms, hostile.zone).toBe(DESTROY_AFTER_DAYS * DAY);
    }
  }, 120_000);

  test("a time zone the runtime role sets for itself brings no destruction forward: the floor's days are twenty-four hours", async () => {
    // Two hours short of due by each rule: a 1.2.1 clinic at day 29, a 1.3.0
    // clinic with its export delivered at day 29, and a DPA clinic with none
    // at day 89.
    const flat = await offboard("clock-zone-flat", "1.2.1");
    const next = await offboard("clock-zone-next", "1.3.0");
    const dpa = await offboard("clock-zone-dpa", "dpa/1.0.0");
    await withTenant({ clinicId: next.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle by SFTP to the practice manager"),
    );
    await moveBack(flat.clinicId, THIRTY_DAY_LIMIT_DUE_DAYS * 24 - 2);
    await moveBack(next.clinicId, THIRTY_DAY_LIMIT_DUE_DAYS * 24 - 2);
    await moveBack(dpa.clinicId, NINETY_DAY_LIMIT_DUE_DAYS * 24 - 2);

    for (const [c, days] of [
      [flat, THIRTY_DAY_LIMIT_DUE_DAYS],
      [next, THIRTY_DAY_LIMIT_DUE_DAYS],
      [dpa, NINETY_DAY_LIMIT_DUE_DAYS],
    ] as const) {
      // A zone in which the session's own count of those days falls weeks short.
      const { zone } = await zoneShrinking(`${days} days`);
      const reach = await asApp(c.clinicId, async (q) => {
        await setLocalZone(q, zone);
        return sessionReach(q, `${days} days`);
      });
      expect(reach, zone).toBeLessThan(days - 10);
      for (const text of GUARDED) {
        await expect(
          asApp(c.clinicId, async (q) => {
            await setLocalZone(q, zone);
            return q.query(text, [c.clinicId]);
          }),
          `${days} days, ${text}`,
        ).rejects.toMatchObject(notDue);
      }
    }
  }, 120_000);

  test("the runtime role cannot start a live clinic's clock and destroy its data in one transaction, whatever zones it sets", async () => {
    const c = await seedClinic("clock-zone-chain");
    await bindAgreement(c.organizationId, "1.2.1");
    await seedPersonAndEvidence(c.clinicId, "+15550130501");
    const back = await zoneStretching("7 days");
    const short = await zoneShrinking(`${THIRTY_DAY_LIMIT_DUE_DAYS} days`);
    for (const text of GUARDED) {
      await expect(
        asApp(c.clinicId, async (q) => {
          await setLocalZone(q, back.zone);
          await q.query(`select * from app_start_offboarding($1::uuid, '-infinity')`, [
            c.clinicId,
          ]);
          await setLocalZone(q, short.zone);
          return q.query(text, [c.clinicId]);
        }),
        text,
      ).rejects.toMatchObject(notDue);
    }
    expect(await evidenceCounts(c.clinicId)).toEqual({
      suppressions: 1,
      consent_records: 1,
      contact_attempts: 1,
      contacts: 1,
    });
    expect((await stamps(c.clinicId)).offboarding_started_at).toBeNull();
  }, 120_000);
});
