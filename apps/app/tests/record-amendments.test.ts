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
  targetKind: "booking_request" | "conversation" | "appointment",
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
        targetKind: "contact",
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

  test("the desk's view of a booking request says it was amended, and never what the amendment says", async () => {
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
    expect((await resolveBookingRequest(token))!.amendmentCount).toBe(0);
    await amendOp(
      c.clinicId,
      "booking_request",
      requestId,
      "The caller can only do weekday evenings.",
    );
    // The link opens with the emailed token alone, no passkey: a count, and
    // the words nowhere in what it resolves.
    const opened = await resolveBookingRequest(token);
    expect(opened!.preferredWindow).toBe("Saturday morning");
    expect(opened!.amendmentCount).toBe(1);
    expect(JSON.stringify(opened)).not.toContain("weekday evenings");
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
    // The spouse's request is the spouse's record, whoever sent it: it stays,
    // and its amendment with it.
    const kept = [
      await amendOp(c.clinicId, "booking_request", forSpouse, "c"),
      await amendOp(c.clinicId, "booking_request", neighbours, "d"),
      await amendOp(c.clinicId, "conversation", neighbourCall.conversationId, "e"),
    ].sort();

    const outcome = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550144001", requestedBy: "practice" },
        OPERATOR,
      ),
    );
    expect(outcome.status).toBe("erased");
    if (outcome.status !== "erased") return;
    expect(outcome.deleted).toMatchObject({ amendments: 2, bookingRequests: 2 });
    expect(outcome.kept).toMatchObject({ sharedThreads: 1, requests: 1 });
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
      asApp(c.clinicId, (q) => q.query(`select app_purge_amended_conversations(now())`)),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });
  });

  test("the runtime role cannot delete a live conversation's amendment and keep the conversation", async () => {
    const c = await seedClinic("amend-backdate");
    const contactId = await seedContact(c.clinicId, "+15550148001");
    const live = await seedConversation(c.clinicId, { startedAt: new Date(), contactId });
    const id = await amendOp(c.clinicId, "conversation", live.conversationId, "kept");

    // Backdate, purge, restore: the backdate is refused, so the purge finds
    // nothing past the clock, and the amendment stays with its conversation.
    // Until the review of 12 October 2026 the runtime role could write
    // started_at, and the amendments' purge went on its own.
    await asApp(c.clinicId, async (q) => {
      await q.query("savepoint backdate");
      await expect(
        q.query(`update conversations set started_at = now() - interval '400 days' where id = $1`, [
          live.conversationId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await q.query("rollback to savepoint backdate");
      const purged = await q.query<{ n: number }>(
        `select app_purge_amended_conversations(app_record_cutoff()) as n`,
      );
      expect(purged.rows[0]!.n).toBe(0);
      const still = await q.query(`select 1 from record_amendments where id = $1`, [id]);
      expect(still.rows).toHaveLength(1);
      // The old split purge, amendments first and conversations after, is gone.
      await expect(
        q.query(`select app_purge_conversation_amendments(app_record_cutoff())`),
      ).rejects.toMatchObject({ code: "42883" });
    });

    // Neither date the purge's floor reads can be written by the runtime role.
    const { rows } = await getMigratorPool().query<{ started: boolean; created: boolean }>(
      `select has_column_privilege('healdesk_app', 'conversations', 'started_at', 'UPDATE') as started,
              has_column_privilege('healdesk_app', 'booking_requests', 'created_at', 'UPDATE') as created`,
    );
    expect(rows[0]).toEqual({ started: false, created: false });

    // An amended conversation past the clock goes, with its amendments, in
    // the one call; never the amendment alone.
    const old = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 120 * DAY),
      contactId,
    });
    const oldAmendment = await amendOp(c.clinicId, "conversation", old.conversationId, "old");
    await asApp(c.clinicId, async (q) => {
      const purged = await q.query<{ n: number }>(
        `select app_purge_amended_conversations(app_record_cutoff()) as n`,
      );
      expect(purged.rows[0]!.n).toBe(1);
      const gone = await q.query(
        `select (select count(*)::int from conversations where id = $1) as conversations,
                (select count(*)::int from record_amendments where id = $2) as amendments`,
        [old.conversationId, oldAmendment],
      );
      expect(gone.rows[0]).toEqual({ conversations: 0, amendments: 0 });
    });
    expect(await amendmentIds(c.clinicId)).toEqual([id, oldAmendment].sort());
  });

  test("an appointment takes an amendment, every export carries it, and it leaves only with the appointment", async () => {
    const c = await seedClinic("amend-appointment");
    const contactId = await seedContact(c.clinicId, "+15550149001");
    const fresh = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - DAY),
      booked: true,
      contactId,
    });
    const old = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 120 * DAY),
      booked: true,
      contactId,
    });
    const onFresh = await amendOp(
      c.clinicId,
      "appointment",
      fresh.appointmentId!,
      "The treatment was a consultation, with Dr Okafor, at 10:30.",
    );
    const onOld = await amendOp(c.clinicId, "appointment", old.appointmentId!, "Moved a week later.");

    // Both exports carry it beside the appointment.
    const patient = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { phone: "+15550149001", requestedBy: "the practice" }),
    );
    expect(
      Object.fromEntries(patient.appointments.map((a) => [a.id, a.amendments.map((x) => x.id)])),
    ).toEqual({ [fresh.appointmentId!]: [onFresh], [old.appointmentId!]: [onOld] });
    const clinic = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportClinic(tx, "the practice"),
    );
    expect(clinic.appointments.find((a) => a.id === fresh.appointmentId)!.amendments[0]!.amendment).toBe(
      "The treatment was a consultation, with Dr Okafor, at 10:30.",
    );

    // The runtime role cannot delete it around its amendment, even with its
    // time moved back a year: the appointment and the amendment leave together
    // or not at all.
    await expect(
      asApp(c.clinicId, (q) => q.query(`delete from appointments where id = $1`, [fresh.appointmentId])),
    ).rejects.toMatchObject({ code: "23503" });

    // The purge takes the old one with its amendment, and leaves the fresh one.
    const purged = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx));
    expect(purged.appointmentsDeleted).toBe(1);
    expect(await amendmentIds(c.clinicId)).toEqual([onFresh]);
    await expect(
      asApp(c.clinicId, (q) => q.query(`select app_purge_amended_appointments(now())`)),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });

    // An erasure takes it with the person's appointment.
    const erased = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550149001", requestedBy: "practice" },
        OPERATOR,
      ),
    );
    if (erased.status !== "erased") throw new Error("not erased");
    expect(erased.deleted).toMatchObject({ appointments: 1, amendments: 1 });
    expect(await amendmentIds(c.clinicId)).toEqual([]);
  });

  test("a contact's field is cleared only when the practice names it, never by an empty value", async () => {
    const c = await seedClinic("amend-clear");
    const contactId = await seedContact(c.clinicId, "+15550149101");
    await inTenant(c.clinicId, (client) =>
      client.query(`update contacts set email = 'wrong@example-patient.test', full_name = 'Sam' where id = $1`, [
        contactId,
      ]),
    );
    const read = () =>
      inTenant(c.clinicId, async (client) =>
        (
          await client.query<{ email: string | null; full_name: string | null; phone: string | null }>(
            `select email, full_name, phone from contacts where id = $1`,
            [contactId],
          )
        ).rows[0],
      );

    // An empty value is dropped: nothing to change, and nothing changes.
    const empty = data<{ status: string }>(
      await runOperation(
        "amendContact",
        { clinicId: c.clinicId, contactId, email: "  ", requestedBy: "the practice" },
        OPERATOR,
      ),
    );
    expect(empty.status).toBe("error");
    // Both at once is refused.
    const both = data<{ status: string }>(
      await runOperation(
        "amendContact",
        {
          clinicId: c.clinicId,
          contactId,
          email: "right@example-patient.test",
          clear: ["email"],
          requestedBy: "the practice",
        },
        OPERATOR,
      ),
    );
    expect(both.status).toBe("error");
    expect(await read()).toEqual({
      email: "wrong@example-patient.test",
      full_name: "Sam",
      phone: "+15550149101",
    });

    const cleared = data<{ status: string }>(
      await runOperation(
        "amendContact",
        { clinicId: c.clinicId, contactId, clear: ["email", "fullName"], requestedBy: "the practice" },
        OPERATOR,
      ),
    );
    expect(cleared.status).toBe("corrected");
    expect(await read()).toEqual({ email: null, full_name: null, phone: "+15550149101" });
  });

  test("destruction takes every amendment, and the destruction is not recorded while one remains", async () => {
    const c = await seedClinic("amend-destroy");
    const contactId = await seedContact(c.clinicId, "+15550146001");
    const call = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 40 * DAY),
      contactId,
    });
    const requestId = await request(c.clinicId, contactId, new Date(Date.now() - 40 * DAY));
    const booked = await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 40 * DAY),
      booked: true,
      contactId,
    });
    await amendOp(c.clinicId, "conversation", call.conversationId, "x");
    await amendOp(c.clinicId, "booking_request", requestId, "y");
    await amendOp(c.clinicId, "appointment", booked.appointmentId!, "z");

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
      await owner.query(
        `alter table record_amendments drop constraint record_amendments_appointment_fk`,
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
      record_amendments: 3,
      booking_requests: 1,
      conversations: 2,
      appointments: 1,
    });
    expect(await amendmentIds(c.clinicId)).toEqual([]);
  });
});
