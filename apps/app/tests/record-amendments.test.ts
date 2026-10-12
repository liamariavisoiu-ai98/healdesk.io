import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveBookingRequest } from "@/lib/meta/booking-requests";
import {
  runOperation,
  type AmendRecordOutcome,
  type ErasePersonOutcome,
  type Operator,
} from "@/lib/ops/api";
import { destroyDueClinics, startOffboarding } from "@/lib/offboarding/offboarding";
import { exportClinic, exportPatient } from "@/lib/patient-rights/export";
import { purgeClinic } from "@/lib/retention/purge";
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
 * The amendment record (BAA 1.3.0 release gate 8; PT-17).
 *
 * Clause 14(b): where a record must stay as it was made, "such as a booking
 * request or the record of a conversation, healdesk appends the amendment to
 * it and links the two ... Every later use and export of that record then
 * carries the amendment." Until this gate nothing could hold one. These tests
 * hold the table, its writers, both exports and every path that deletes a
 * record to the clause: an amendment is appended, never changed, only ever
 * beside a record of its own clinic, and it leaves with that record and at no
 * other time.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "127.0.0.1" } };

type Client = Parameters<Parameters<typeof inTenant>[1]>[0];

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (outcome.status !== 200)
    throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { data: T }).data;
}

/** A transaction as the runtime role inside the tenant, always rolled back. */
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

/** One booking request, written as the migrator inside the tenant, made `at`. */
async function request(
  clinicId: string,
  contactId: string,
  at: Date,
  thread: { platform: "whatsapp" | "instagram"; senderId: string } | null = null,
): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into booking_requests
         (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window, token_hash,
          expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6, 'Saturday morning', $7, $8::timestamptz + interval '7 days', $8)
       returning id`,
      [
        clinicId,
        contactId,
        thread ? "meta" : "voice",
        thread?.platform ?? null,
        thread ? "page_1" : null,
        thread?.senderId ?? null,
        randomBytes(32),
        at,
      ],
    );
    return rows[0]!.id;
  });
}

/** Append through the operator's path, as the console does, and return the amendment's id. */
async function amendOp(
  clinicId: string,
  targetKind: "booking_request" | "conversation",
  targetId: string,
  amendment: string,
): Promise<string> {
  const outcome = data<AmendRecordOutcome>(
    await runOperation(
      "amendRecord",
      { clinicId, targetKind, targetId, amendment, requestedBy: "the practice, ticket 2201" },
      OPERATOR,
    ),
  );
  if (outcome.status !== "amended") throw new Error(`not amended: ${JSON.stringify(outcome)}`);
  return outcome.amendmentId;
}

async function amendmentIds(clinicId: string): Promise<string[]> {
  return inTenant(clinicId, async (client) =>
    (await client.query<{ id: string }>(`select id from record_amendments order by id`)).rows.map(
      (r) => r.id,
    ),
  );
}

async function backdateOffboarding(clinicId: string, days: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(days => $2),
            destroy_after = destroy_after - make_interval(days => $2)
      where id = $1`,
    [clinicId, days],
  );
}

describeDb("the amendment record", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the operator appends an amendment beside a booking request or a conversation, and nothing it sends back or records names it", async () => {
    const c = await seedClinic("amend-op");
    const contactId = await seedContact(c.clinicId, "+15550140001");
    const { conversationId } = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - DAY),
      contactId,
    });
    const requestId = await request(c.clinicId, contactId, new Date(Date.now() - DAY));

    const words = "Preferred window should read Tuesday evenings, not Saturday mornings.";
    const outcome = await runOperation(
      "amendRecord",
      {
        clinicId: c.clinicId,
        targetKind: "booking_request",
        targetId: requestId,
        amendment: words,
        requestedBy: "the practice, ticket 2201",
        requestedAt: "2026-10-05T09:00:00Z",
      },
      OPERATOR,
    );
    const amended = data<AmendRecordOutcome>(outcome);
    expect(amended.status).toBe("amended");
    expect(JSON.stringify(outcome.body)).not.toContain("Tuesday");
    await amendOp(
      c.clinicId,
      "conversation",
      conversationId,
      "The caller's surname is spelled Rhys.",
    );

    const rows = await inTenant(
      c.clinicId,
      async (client) =>
        (
          await client.query<{
            target_kind: string;
            booking_request_id: string | null;
            conversation_id: string | null;
            amendment: string;
            requested_by: string;
            requested_at: Date;
            recorded_by: string;
          }>(`select * from record_amendments order by recorded_at`)
        ).rows,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      target_kind: "booking_request",
      booking_request_id: requestId,
      conversation_id: null,
      amendment: words,
      requested_by: "the practice, ticket 2201",
      recorded_by: "ops@healdesk.test",
    });
    expect(rows[0]!.requested_at.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(rows[1]).toMatchObject({ target_kind: "conversation", conversation_id: conversationId });

    // The words are in the amendment and nowhere else: not the audit trail,
    // not the operator's security events.
    const audit = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from audit_log where metadata::text like '%Tuesday%' or metadata::text like '%Rhys%'`,
    );
    expect(audit.rows[0]!.n).toBe(0);
    const events = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from security_events where metadata::text like '%Tuesday%' or metadata::text like '%Rhys%'`,
    );
    expect(events.rows[0]!.n).toBe(0);

    // Who asked is refused when it names someone; an empty amendment, an
    // unknown kind and a record that does not exist are refused too.
    for (const args of [
      {
        targetKind: "booking_request",
        targetId: requestId,
        amendment: words,
        requestedBy: "Sam on +1 555 014 0001",
      },
      {
        targetKind: "booking_request",
        targetId: requestId,
        amendment: "  ",
        requestedBy: "the practice",
      },
      {
        targetKind: "appointment",
        targetId: requestId,
        amendment: words,
        requestedBy: "the practice",
      },
      {
        targetKind: "conversation",
        targetId: randomUUID(),
        amendment: words,
        requestedBy: "the practice",
      },
      {
        targetKind: "conversation",
        targetId: conversationId,
        amendment: "x".repeat(4001),
        requestedBy: "the practice",
      },
    ]) {
      const refused = data<AmendRecordOutcome>(
        await runOperation("amendRecord", { clinicId: c.clinicId, ...args }, OPERATOR),
      );
      expect(refused.status, JSON.stringify(args).slice(0, 80)).toBe("error");
    }
    expect(await amendmentIds(c.clinicId)).toHaveLength(2);
  });

  test("append-only: the runtime role may add and read an amendment, and no role may change or delete one", async () => {
    const c = await seedClinic("amend-append-only");
    const contactId = await seedContact(c.clinicId, "+15550141001");
    const requestId = await request(c.clinicId, contactId, new Date(Date.now() - DAY));
    const id = await amendOp(c.clinicId, "booking_request", requestId, "First amendment.");

    await asApp(c.clinicId, async (q) => {
      const { rows } = await q.query<{ id: string; recorded_at: Date }>(
        `insert into record_amendments
           (clinic_id, target_kind, booking_request_id, amendment, requested_by, requested_at, recorded_by, recorded_at)
         values ($1, 'booking_request', $2, 'Second amendment.', 'the practice', now(), 'ops@healdesk.test',
                 now() + interval '400 days')
         returning id, recorded_at`,
        [c.clinicId, requestId],
      );
      // The database's clock, whatever the writer sent.
      expect(Math.abs(rows[0]!.recorded_at.getTime() - Date.now())).toBeLessThan(60_000);
      const read = await q.query(`select id from record_amendments`);
      expect(read.rows).toHaveLength(2);
    });

    for (const statement of [
      `update record_amendments set amendment = 'Rewritten.' where id = '${id}'`,
      `update record_amendments set recorded_at = now() - interval '1 year' where id = '${id}'`,
      `delete from record_amendments where id = '${id}'`,
      `truncate record_amendments`,
    ]) {
      await expect(
        asApp(c.clinicId, (q) => q.query(statement)),
        statement,
      ).rejects.toMatchObject({
        code: "42501",
      });
    }

    // The owner cannot change one either: the guard binds every role.
    const owner = await getMigratorPool().connect();
    try {
      await owner.query("begin");
      await owner.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(
        owner.query(`update record_amendments set amendment = 'Rewritten.' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await owner.query("rollback").catch(() => {});
      owner.release();
    }
    expect(await amendmentIds(c.clinicId)).toEqual([id]);

    // Nor can its record be deleted around it.
    const conversation = await seedConversation(c.clinicId, { startedAt: new Date(), contactId });
    await amendOp(c.clinicId, "conversation", conversation.conversationId, "Amended.");
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`delete from conversations where id = $1`, [conversation.conversationId]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("an amendment points only at a record of its own clinic", async () => {
    const a = await seedClinic("amend-own-a");
    const b = await seedClinic("amend-own-b");
    const theirs = await request(
      b.clinicId,
      await seedContact(b.clinicId, "+15550142002"),
      new Date(),
    );
    const theirCall = await seedConversation(b.clinicId, { startedAt: new Date() });

    // Through the operator's path: the other clinic's record is not found.
    for (const [kind, id] of [
      ["booking_request", theirs],
      ["conversation", theirCall.conversationId],
    ] as const) {
      const refused = data<AmendRecordOutcome>(
        await runOperation(
          "amendRecord",
          {
            clinicId: a.clinicId,
            targetKind: kind,
            targetId: id,
            amendment: "x",
            requestedBy: "the practice",
          },
          OPERATOR,
        ),
      );
      expect(refused).toMatchObject({ status: "error", message: expect.stringMatching(/No such/) });
    }

    // Written directly, by the runtime role and by the owner alike: the
    // foreign key carries the clinic, so it finds no such record.
    const insert = `insert into record_amendments
        (clinic_id, target_kind, booking_request_id, amendment, requested_by, requested_at, recorded_by)
      values ($1, 'booking_request', $2, 'x', 'the practice', now(), 'ops@healdesk.test')`;
    await expect(
      asApp(a.clinicId, (q) => q.query(insert, [a.clinicId, theirs])),
    ).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      inTenant(a.clinicId, (q) => q.query(insert, [a.clinicId, theirs])),
    ).rejects.toMatchObject({
      code: "23503",
    });
    // And the tenant cannot write a row as the other clinic.
    await expect(
      asApp(a.clinicId, (q) => q.query(insert, [b.clinicId, theirs])),
    ).rejects.toMatchObject({
      code: "42501",
    });
    // One kind, one target.
    await expect(
      inTenant(b.clinicId, (q) =>
        q.query(
          `insert into record_amendments
             (clinic_id, target_kind, booking_request_id, conversation_id, amendment, requested_by, requested_at, recorded_by)
           values ($1, 'conversation', $2, $3, 'x', 'the practice', now(), 'ops@healdesk.test')`,
          [b.clinicId, theirs, theirCall.conversationId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await amendmentIds(a.clinicId)).toEqual([]);
    expect(await amendmentIds(b.clinicId)).toEqual([]);
  });

  test("both exports carry each amendment beside the record it amends", async () => {
    const c = await seedClinic("amend-export");
    const contactId = await seedContact(c.clinicId, "+15550143001");
    const otherId = await seedContact(c.clinicId, "+15550143002");
    const { conversationId } = await seedConversation(c.clinicId, {
      startedAt: new Date(),
      contactId,
    });
    const theirRequest = await request(c.clinicId, contactId, new Date());
    const untouched = await request(c.clinicId, contactId, new Date());
    const otherRequest = await request(c.clinicId, otherId, new Date());
    const onRequest = await amendOp(
      c.clinicId,
      "booking_request",
      theirRequest,
      "Wants a consultation, not a treatment.",
    );
    const second = await amendOp(c.clinicId, "booking_request", theirRequest, "And on a weekday.");
    const onCall = await amendOp(
      c.clinicId,
      "conversation",
      conversationId,
      "The caller is a returning patient.",
    );
    const onOther = await amendOp(c.clinicId, "booking_request", otherRequest, "Someone else's.");

    const patient = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { phone: "+15550143001", requestedBy: "the practice, ticket 2202" }),
    );
    const byId = Object.fromEntries(
      patient.bookingRequests.map((r) => [r.id, r.amendments.map((a) => a.id)]),
    );
    expect(byId).toEqual({ [theirRequest]: [onRequest, second], [untouched]: [] });
    expect(
      patient.bookingRequests.find((r) => r.id === theirRequest)!.amendments[0]!.amendment,
    ).toBe("Wants a consultation, not a treatment.");
    expect(patient.conversations.map((v) => [v.id, v.amendments.map((a) => a.id)])).toEqual([
      [conversationId, [onCall]],
    ]);
    // The accounting of disclosures shows each amendment being written.
    expect(
      patient.accountingOfDisclosures
        .filter((a) => a.resourceType === "record_amendment")
        .map((a) => a.resourceId)
        .sort(),
    ).toEqual([onRequest, second, onCall].sort());

    const clinic = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportClinic(tx, "offboarding, the practice's notice"),
    );
    const all = Object.fromEntries(
      clinic.bookingRequests.map((r) => [r.id, r.amendments.map((a) => a.id)]),
    );
    expect(all).toEqual({
      [theirRequest]: [onRequest, second],
      [untouched]: [],
      [otherRequest]: [onOther],
    });
    expect(
      clinic.conversations.find((v) => v.id === conversationId)!.amendments.map((a) => a.id),
    ).toEqual([onCall]);
  });

  test("the desk's view of a booking request carries its amendments too", async () => {
    const c = await seedClinic("amend-desk");
    const contactId = await seedContact(c.clinicId, "+15550147001");
    const token = randomBytes(32).toString("base64url");
    const requestId = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, preferred_window, token_hash, expires_at)
         values ($1, $2, 'voice', 'Saturday morning', $3, now() + interval '7 days')
         returning id`,
        [c.clinicId, contactId, createHash("sha256").update(token, "utf8").digest()],
      );
      return rows[0]!.id;
    });
    expect((await resolveBookingRequest(token))!.amendments).toEqual([]);
    await amendOp(
      c.clinicId,
      "booking_request",
      requestId,
      "The caller can only do weekday evenings.",
    );
    const opened = await resolveBookingRequest(token);
    expect(opened!.preferredWindow).toBe("Saturday morning");
    expect(opened!.amendments.map((a) => a.text)).toEqual([
      "The caller can only do weekday evenings.",
    ]);
  });

  test("an erasure takes the person's amendments with their records, and leaves everyone else's", async () => {
    const c = await seedClinic("amend-erase");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550144001");
    const spouse = await seedContact(c.clinicId, "+15550144009");
    const neighbour = await seedContact(c.clinicId, "+15550144002");
    const call = await seedConversation(c.clinicId, {
      startedAt: at,
      booked: true,
      contactId: person,
    });
    const own = await request(c.clinicId, person, at);
    // Sent from the person's Instagram thread, for their spouse's number.
    await request(c.clinicId, person, at, { platform: "instagram", senderId: "ig_144001" });
    const forSpouse = await request(c.clinicId, spouse, at, {
      platform: "instagram",
      senderId: "ig_144001",
    });
    const neighbours = await request(c.clinicId, neighbour, at);
    const neighbourCall = await seedConversation(c.clinicId, {
      startedAt: at,
      contactId: neighbour,
    });
    await amendOp(c.clinicId, "booking_request", own, "a");
    await amendOp(c.clinicId, "conversation", call.conversationId, "b");
    await amendOp(c.clinicId, "booking_request", forSpouse, "c");
    const kept = [
      await amendOp(c.clinicId, "booking_request", neighbours, "d"),
      await amendOp(c.clinicId, "conversation", neighbourCall.conversationId, "e"),
    ].sort();

    const outcome = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550144001", requestedBy: "the practice, ticket 2203" },
        OPERATOR,
      ),
    );
    expect(outcome.status).toBe("erased");
    if (outcome.status !== "erased") return;
    expect(outcome.deleted).toMatchObject({ amendments: 3, threadRequests: 1, bookingRequests: 2 });
    expect(await amendmentIds(c.clinicId)).toEqual(kept);
  });

  test("the purge takes an amendment the night its record goes, and not before", async () => {
    const c = await seedClinic("amend-purge");
    const old = new Date(Date.now() - 120 * DAY);
    const fresh = new Date(Date.now() - DAY);
    const contactId = await seedContact(c.clinicId, "+15550145001");
    const oldCall = await seedConversation(c.clinicId, { startedAt: old, contactId });
    const freshCall = await seedConversation(c.clinicId, { startedAt: fresh, contactId });
    const oldRequest = await request(c.clinicId, contactId, old);
    const freshRequest = await request(c.clinicId, contactId, fresh);
    await amendOp(c.clinicId, "conversation", oldCall.conversationId, "old call");
    await amendOp(c.clinicId, "booking_request", oldRequest, "old request");
    const kept = [
      await amendOp(c.clinicId, "conversation", freshCall.conversationId, "fresh call"),
      await amendOp(c.clinicId, "booking_request", freshRequest, "fresh request"),
    ].sort();

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      purgeClinic(tx),
    );
    expect(result).toMatchObject({ bookingRequestsDeleted: 1, conversationsDeleted: 1 });
    expect(await amendmentIds(c.clinicId)).toEqual(kept);
    const left = await inTenant(c.clinicId, async (q) => ({
      conversations: (await q.query<{ id: string }>(`select id from conversations`)).rows.map(
        (r) => r.id,
      ),
      requests: (await q.query<{ id: string }>(`select id from booking_requests`)).rows.map(
        (r) => r.id,
      ),
    }));
    expect(left).toEqual({ conversations: [freshCall.conversationId], requests: [freshRequest] });

    // The runtime role cannot reach ahead of the clinic's record clock for one.
    await expect(
      asApp(c.clinicId, (q) => q.query(`select app_purge_conversation_amendments(now())`)),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });
  });

  test("destruction takes every amendment, and the destruction is not recorded while one remains", async () => {
    const c = await seedClinic("amend-destroy");
    const contactId = await seedContact(c.clinicId, "+15550146001");
    const call = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 40 * DAY),
      contactId,
    });
    const requestId = await request(c.clinicId, contactId, new Date(Date.now() - 40 * DAY));
    await amendOp(c.clinicId, "conversation", call.conversationId, "x");
    await amendOp(c.clinicId, "booking_request", requestId, "y");

    // Not due: the definer refuses, for the runtime role as for anyone.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`select app_destroy_record_amendments($1::uuid)`, [c.clinicId]),
      ),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/not due/) });

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await backdateOffboarding(c.clinicId, 31);

    // Due, and holding nothing but one amendment (its foreign key dropped for
    // the length of the transaction, which is rolled back): the database
    // refuses to record the destruction.
    const owner = await getMigratorPool().connect();
    try {
      await owner.query("begin");
      await owner.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await owner.query(
        `alter table record_amendments drop constraint record_amendments_booking_request_fk`,
      );
      await owner.query(
        `alter table record_amendments drop constraint record_amendments_conversation_fk`,
      );
      await owner.query(`select app_destroy_record_amendments($1::uuid)`, [c.clinicId]);
      await owner.query(`select app_destroy_booking_requests($1::uuid)`, [c.clinicId]);
      await owner.query(`delete from appointments`);
      await owner.query(`delete from conversations`);
      await owner.query(`delete from contacts`);
      await owner.query(
        `insert into record_amendments
           (clinic_id, target_kind, booking_request_id, amendment, requested_by, requested_at, recorded_by)
         values ($1, 'booking_request', $2, 'orphan', 'the practice', now(), 'ops@healdesk.test')`,
        [c.clinicId, randomUUID()],
      );
      await owner.query("savepoint refused");
      await expect(
        owner.query(`select app_mark_clinic_destroyed($1::uuid)`, [c.clinicId]),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });
      await owner.query("rollback to savepoint refused");
      await owner.query(`select app_destroy_record_amendments($1::uuid)`, [c.clinicId]);
      const stamped = await owner.query<{ at: Date | null }>(
        `select app_mark_clinic_destroyed($1::uuid) as at`,
        [c.clinicId],
      );
      expect(stamped.rows[0]!.at).not.toBeNull();
    } finally {
      await owner.query("rollback").catch(() => {});
      owner.release();
    }

    const results = (await destroyDueClinics()).filter((r) => r.clinicId === c.clinicId);
    expect(results).toHaveLength(1);
    expect(results[0]!.deleted).toMatchObject({
      record_amendments: 2,
      booking_requests: 1,
      conversations: 1,
    });
    expect(await amendmentIds(c.clinicId)).toEqual([]);
  });
});
