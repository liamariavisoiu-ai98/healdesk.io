import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { clinicHasLeft } from "@/lib/clinic/leaving";
import { sendMetaReply } from "@/lib/meta/channels";
import { answerFrontDoor } from "@/lib/meta/front-door";
import { appendAmendment } from "@/lib/patient-rights/amendments";
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

  test("a terminated practice's record still takes an amendment while offboarding, and none once destroyed (R4)", async () => {
    // BAA 1.3.0 keeps healdesk's duties while it holds the PHI, and clause
    // 14(b)'s amendments run while it does: a new row, but not new patient data.
    const c = await liveClinic("left-amend");
    const requestId = await inTenant(c.clinicId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, token_hash, expires_at)
         values ($1, $2, 'voice', 'Saturday morning', $3, now() + interval '7 days') returning id`,
        [c.clinicId, c.contactId, randomBytes(32)],
      );
      return rows[0]!.id;
    });
    await getMigratorPool().query(
      `update baa_acceptances set terminated_at = now(), termination_reason = 'change_in_law'
        where organization_id = $1`,
      [c.organizationId],
    );
    await startOffboarding(c.clinicId);
    const amend = () =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        appendAmendment(tx, {
          target: { kind: "booking_request", id: requestId },
          amendment: "The practice notes the preferred time was Sunday.",
          requestedBy: "practice",
          recordedBy: "ops@healdesk.test",
        }),
      );
    expect(await amend()).toMatchObject({ status: "appended" });
    // Nor does the amendment open the gate to anything else.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`insert into contacts (clinic_id, phone) values ($1, '+14155550143')`, [
          c.clinicId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Destroyed: nothing left to amend, and the database says so first.
    await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [
      c.clinicId,
    ]);
    await expect(amend()).rejects.toMatchObject({
      cause: {
        code: "23514",
        message: expect.stringMatching(/refusing to write PHI to record_amendments/),
      },
    });
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

  test("the front door holds no lock on the clinic while the model runs, and writes nothing if the clinic left meanwhile", async () => {
    // The verification of 3a6de11: clinicHasLeft's FOR SHARE was taken
    // before the model call and held across it, so app_start_offboarding's
    // FOR UPDATE, and every portal save, waited for the model.
    const c = await liveClinic("left-model");
    let blocked: unknown = null;
    const responder = async () => {
      // While the model runs, the clinic's offboarding starts and commits.
      const other = await getMigratorPool().connect();
      try {
        await other.query("begin");
        await other.query(`set local lock_timeout = '1s'`);
        await other.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
        await other.query(`select * from app_start_offboarding($1::uuid, null)`, [c.clinicId]);
        await other.query("commit");
      } catch (error) {
        blocked = error;
        await other.query("rollback");
      } finally {
        other.release();
      }
      return JSON.stringify({ reply: "We're open weekdays 9 to 5.", booking: { wants: false } });
    };
    const answer = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, {
        platform: "instagram",
        text: "When are you open?",
        responder,
        thread: {
          platform: "instagram",
          externalId: "ig_page_left_model",
          senderId: "ig_user_left_model",
          connectionId: randomUUID(),
        },
      }),
    );
    // The offboarding didn't wait for the model, and the answer, seeing it,
    // wrote nothing: no conversation opened for the message.
    expect(blocked).toBeNull();
    expect(answer).toBeNull();
    const { rows } = await getMigratorPool().query(
      `select 1 from chat_threads where clinic_id = $1`,
      [c.clinicId],
    );
    expect(rows).toEqual([]);
  });

  test("nothing more is sent on a Meta thread once the clinic has left, the desk's follow-up included", async () => {
    // The desk's decision and its reschedule line reach the person through
    // sendMetaReply; a clinic that has left sends neither.
    const c = await liveClinic("left-follow-up");
    await startOffboarding(c.clinicId);
    const send = vi.fn(async () => {});
    const outcome = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      sendMetaReply(
        tx,
        {
          clinicId: c.clinicId,
          connectionId: randomUUID(),
          platform: "messenger",
          enabled: true,
          platformEnabled: true,
        },
        "page_left",
        "user_left",
        "The practice has reviewed your request and will call you.",
        send,
        { lastInboundAt: new Date() },
      ),
    );
    expect(outcome).toEqual({ status: "withheld", reason: "clinic_left" });
    expect(send).not.toHaveBeenCalled();
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
