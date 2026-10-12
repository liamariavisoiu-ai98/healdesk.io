import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { clinicHasLeft } from "@/lib/clinic/leaving";
import { answerFrontDoor } from "@/lib/meta/front-door";
import { ingestWebhook } from "@/lib/sync/webhooks";
import { withTenant } from "@/lib/tenant";

import { asApp } from "./setup/calendar-db";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic } from "./setup/factories";

/**
 * No patient data after leaving (the branch review's R11). A clinic whose
 * offboarding has started keeps nothing new: the database refuses a new
 * patient row for a production clinic whatever its agreement says, every
 * route that writes asks clinicHasLeft in the transaction that would write,
 * and that read holds the clinic's row so an offboarding can't start
 * underneath it.
 */

const parseWebhook = vi.hoisted(() => vi.fn());
vi.mock("@healdesk/connectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/connectors")>();
  return {
    ...actual,
    getAdapter: (provider: string) =>
      provider === "test-platform" ? { parseWebhook } : actual.getAdapter(provider),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "clinic-left-test" } as const;

/** A production clinic under an agreement in effect, with one patient row held. */
async function liveClinic(label: string) {
  const c = await seedClinic(label);
  await bindAgreementInEffect(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() - interval '30 days',
            meta_front_door_enabled = true
      where id = $1`,
    [c.clinicId],
  );
  const contactId = await asApp(c.clinicId, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into contacts (clinic_id, phone) values ($1, '+14155550140') returning id`,
      [c.clinicId],
    );
    return rows[0]!.id;
  });
  return { ...c, contactId };
}

/** Offboarding started, as a cancellation or a setup closure starts it, with the agreement still in effect. */
async function startOffboarding(clinicId: string) {
  await inTenant(clinicId, (q) =>
    q.query(`select * from app_start_offboarding($1::uuid, null)`, [clinicId]),
  );
}

describeDb("a clinic that has left keeps nothing new", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("the database refuses a new patient row once offboarding has started, and still lets a held row change", async () => {
    const c = await liveClinic("left-gate");
    await startOffboarding(c.clinicId);
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`insert into contacts (clinic_id, phone) values ($1, '+14155550141')`, [
          c.clinicId,
        ]),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringMatching(/refusing to write PHI to contacts/),
    });
    await asApp(c.clinicId, (q) =>
      q.query(`update contacts set phone = '+14155550142' where id = $1`, [c.contactId]),
    );
  });

  test("clinicHasLeft holds the clinic's row: an offboarding can't start until the write it guards commits", async () => {
    const c = await liveClinic("left-lock");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      expect(await clinicHasLeft(tx)).toBe(false);
      const other = await getMigratorPool().connect();
      try {
        await other.query(`set lock_timeout = '300ms'`);
        await expect(
          other.query(`update clinics set name = name where id = $1`, [c.clinicId]),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await other.query(`reset lock_timeout`);
        other.release();
      }
    });
  });

  test("the Meta front door answers nothing for a clinic that has left, in the transaction that would write", async () => {
    const c = await liveClinic("left-meta");
    await startOffboarding(c.clinicId);
    const answer = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, {
        platform: "instagram",
        text: "Are you open on Saturday?",
        responder: null,
      }),
    );
    expect(answer).toBeNull();
  });

  test("a booking platform's webhook for a clinic that has left is stored nowhere", async () => {
    const c = await liveClinic("left-webhook");
    await startOffboarding(c.clinicId);
    parseWebhook.mockReset();
    expect(
      await ingestWebhook({
        clinicId: c.clinicId,
        provider: "test-platform",
        raw: JSON.stringify({ id: randomUUID() }),
        headers: {},
      }),
    ).toEqual({ status: "left" });
    expect(parseWebhook).not.toHaveBeenCalled();
    const { rows } = await getMigratorPool().query(
      `select 1 from webhook_events where clinic_id = $1`,
      [c.clinicId],
    );
    expect(rows).toEqual([]);
  });
});
