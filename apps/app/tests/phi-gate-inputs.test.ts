import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { asApp } from "./setup/calendar-db";
import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, seedClinic } from "./setup/factories";

/**
 * The patient-data gate reads a clinic's organisation and whether that
 * organisation has an agreement in effect (drizzle/0066). The runtime role
 * must not be able to write either input, or it could reopen the gate a
 * termination closed (the review's R1, proved in exploit1.sql): it may not
 * insert an agreement already bound or terminated, move a clinic to another
 * organisation, or create a clinic that is already live.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

async function terminatedPractice(label: string) {
  const c = await seedClinic(label);
  const agreementId = await bindAgreementInEffect(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() - interval '30 days' where id = $1`,
    [c.clinicId],
  );
  await getMigratorPool().query(
    `update baa_acceptances set terminated_at = now(), termination_reason = 'change_in_law' where id = $1`,
    [agreementId],
  );
  return c;
}

function insertContact(clinicId: string, phone: string) {
  return asApp(clinicId, (q) =>
    q.query(`insert into contacts (clinic_id, phone) values ($1, $2) returning id`, [
      clinicId,
      phone,
    ]),
  );
}

describeDb("the PHI gate's inputs, as the runtime role", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("a terminated practice cannot bind itself a new agreement and so reopen the gate", async () => {
    const c = await terminatedPractice("gate-input-bind");
    await expect(insertContact(c.clinicId, "+14155550111")).rejects.toMatchObject({
      code: "23514",
    });

    // An agreement row already bound to its own organisation: refused by grant.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(
          `insert into baa_acceptances (id, organization_id, document_version, document_hash, rendered_text, variables,
             assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
           values ($1, $2, '1.2.1', repeat('b', 64), 'T', '{}'::jsonb, 'I agree', 'A', 'a@x.test', now(), now())`,
          [randomUUID(), c.organizationId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Nor terminated, nor with a reason: those are the termination's.
    for (const column of ["terminated_at", "bound_at"]) {
      await expect(
        asApp(c.clinicId, (q) =>
          q.query(
            `insert into baa_acceptances (document_version, document_hash, rendered_text, variables, assent_label,
               accepted_by_name, accepted_by_email, ${column})
             values ('1.2.1', repeat('c', 64), 'T', '{}'::jsonb, 'I agree', 'A', 'a@x.test', now())`,
          ),
        ),
        column,
      ).rejects.toMatchObject({ code: "42501" });
    }
    // An unbound signature, as signAgreement records one (service context, no
    // tenant), is still the runtime role's to write.
    await getAppPool().query(
      `insert into baa_acceptances (document_version, document_hash, rendered_text, variables, assent_label,
         accepted_by_name, accepted_by_email)
       values ('1.2.1', repeat('d', 64), 'T', '{}'::jsonb, 'I agree', 'A', 'a@x.test')`,
    );
    // And in service context the bound columns are refused just the same.
    await expect(
      getAppPool().query(
        `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables,
           assent_label, accepted_by_name, accepted_by_email, bound_at)
         values ($1, '1.2.1', repeat('e', 64), 'T', '{}'::jsonb, 'I agree', 'A', 'a@x.test', now())`,
        [c.organizationId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(insertContact(c.clinicId, "+14155550112")).rejects.toMatchObject({
      code: "23514",
    });
  });

  test("a terminated practice cannot move its clinic under another practice's agreement", async () => {
    const c = await terminatedPractice("gate-input-move");
    const other = await seedClinic("gate-input-other");
    await bindAgreementInEffect(other.clinicId);
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`update clinics set organization_id = $2 where id = $1`, [
          c.clinicId,
          other.organizationId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(insertContact(c.clinicId, "+14155550113")).rejects.toMatchObject({
      code: "23514",
    });
  });

  test("a terminated practice cannot delete its clinic and insert it again as synthetic", async () => {
    // The verification of 3a6de11 (r1-probe.sql, section 7): the delete took
    // the clinic's patient rows with it, and the synthetic clinic born in its
    // place took new ones under the old id.
    const c = await terminatedPractice("gate-input-delete");
    await expect(
      asApp(c.clinicId, (q) => q.query(`delete from clinics where id = $1`, [c.clinicId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(insertContact(c.clinicId, "+14155550114")).rejects.toMatchObject({
      code: "23514",
    });
  });

  test("a clinic cannot be created already live", async () => {
    const other = await seedClinic("gate-input-live-org");
    await bindAgreementInEffect(other.clinicId);
    const id = randomUUID();
    for (const [column, value] of [
      ["data_classification", "production"],
      ["baa_signed_at", new Date().toISOString()],
    ] as const) {
      await expect(
        asApp(id, (q) =>
          q.query(
            `insert into clinics (id, organization_id, slug, name, specialty, ${column})
             values ($1, $2, $3, 'Live Clinic', 'med-spa', $4)`,
            [id, other.organizationId, `live-${randomUUID().slice(0, 6)}`, value],
          ),
        ),
        column,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
