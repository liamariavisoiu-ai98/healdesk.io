import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  destroyDueClinics,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { eraseContact, purgeClinic } from "@/lib/retention/purge";
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
 * Destruction, erasure and the purge, for a clinic whose desk confirmed a
 * booking request (drizzle's booking_request_destruction migration).
 *
 * A confirmed request must keep its appointment (booking_requests_confirmed_shape,
 * 0039), and a decided request cannot be rewritten (app_booking_request_no_rewrite,
 * 0037, redefined in 0041). The appointment's foreign key was ON DELETE SET
 * NULL until that migration, which Postgres runs as an UPDATE of the request,
 * so deleting the appointment of a confirmed request failed, and destruction,
 * erasure and the purge all aborted for any clinic whose desk had ever
 * confirmed one. The BAA and the draft DPA promise that data is destroyed on
 * the clock and deleted on request; these tests hold the three deletes to
 * that, for every shape a request ends in, and hold live use to the rule that
 * a decided request stays decided.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One statement as the runtime role, inside a tenant or none, always rolled back. */
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

type Person = {
  contactId: string;
  phone: string;
  conversationId: string;
  appointmentId: string;
  confirmed: string;
  pending: string;
  declined: string;
};

/**
 * One person with the three shapes a request ends in: confirmed to a slot
 * (with the appointment it produced and the call it was taken on), still
 * waiting on the desk (a WhatsApp thread), and declined. Plus the person's
 * half-collected Meta draft. Everything is stamped `at`, so the purge can be
 * pointed past it.
 */
async function seedPerson(clinicId: string, phone: string, at: Date): Promise<Person> {
  const contactId = await seedContact(clinicId, phone);
  const booked = await seedConversation(clinicId, { startedAt: at, booked: true, contactId });
  const conversationId = booked.conversationId;
  const appointmentId = booked.appointmentId!;
  return inTenant(clinicId, async (client) => {
    await client.query(`update contacts set updated_at = $2 where id = $1`, [contactId, at]);
    const insert = async (text: string, values: unknown[]) =>
      (await client.query<{ id: string }>(text, values)).rows[0]!.id;
    const confirmed = await insert(
      `insert into booking_requests
         (clinic_id, contact_id, channel, conversation_id, preferred_window, status, token_hash, expires_at,
          decided_at, decided_by_label, confirmed_for, appointment_id, created_at)
       values ($1, $2, 'voice', $3, 'weekday mornings', 'confirmed', $4, $5::timestamptz + interval '7 days',
               $5, 'Front desk', $5, $6, $5::timestamptz - interval '1 day')
       returning id`,
      [clinicId, contactId, conversationId, randomBytes(32), at, appointmentId],
    );
    const pending = await insert(
      `insert into booking_requests
         (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window, status, token_hash,
          expires_at, created_at)
       values ($1, $2, 'meta', 'whatsapp', 'waba_1', $3, 'Saturday morning', 'requested', $4,
               $5::timestamptz + interval '7 days', $5)
       returning id`,
      [clinicId, contactId, `wa_${phone}`, randomBytes(32), at],
    );
    const declined = await insert(
      `insert into booking_requests
         (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at, decided_at, created_at)
       values ($1, $2, 'voice', 'any evening', 'declined', $3, $4::timestamptz + interval '7 days', $4, $4)
       returning id`,
      [clinicId, contactId, randomBytes(32), at],
    );
    await client.query(
      `insert into meta_booking_drafts
         (clinic_id, platform, sender_id, external_id, first_name, phone, preferred_window, updated_at)
       values ($1, 'whatsapp', $2, 'waba_1', 'Sam', $3, 'Saturday morning', $4)`,
      [clinicId, `wa_draft_${phone}`, phone, at],
    );
    return { contactId, phone, conversationId, appointmentId, confirmed, pending, declined };
  });
}

type Counts = {
  booking_requests: number;
  appointments: number;
  conversations: number;
  contacts: number;
  meta_booking_drafts: number;
};

/** Every row of the clinic in the five tables a booking touches, read as the owner inside its tenant. */
async function counts(clinicId: string): Promise<Counts> {
  return inTenant(clinicId, async (client) => {
    const n = async (table: string) =>
      (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;
    return {
      booking_requests: await n("booking_requests"),
      appointments: await n("appointments"),
      conversations: await n("conversations"),
      contacts: await n("contacts"),
      meta_booking_drafts: await n("meta_booking_drafts"),
    };
  });
}

/** What one seeded person leaves in a clinic. */
const ONE_PERSON: Counts = {
  booking_requests: 3,
  appointments: 1,
  conversations: 1,
  contacts: 1,
  meta_booking_drafts: 1,
};
const NOTHING: Counts = {
  booking_requests: 0,
  appointments: 0,
  conversations: 0,
  contacts: 0,
  meta_booking_drafts: 0,
};

describeDb("booking requests at destruction, erasure and purge", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("destruction removes a clinic's confirmed, pending and declined requests with everything else, and nothing of another clinic", async () => {
    const started = new Date("2026-06-01T00:00:00Z");
    const leaving = await seedClinic("destroy-br");
    const staying = await seedClinic("destroy-br-stay");
    const gone = await seedPerson(
      leaving.clinicId,
      "+15550106001",
      new Date("2026-05-20T15:00:00Z"),
    );
    await seedPerson(staying.clinicId, "+15550106001", new Date("2026-05-20T15:00:00Z"));
    // A paid deposit on the confirmed booking: a money record, kept, but it
    // must not hold the destroyed appointment.
    await inTenant(leaving.clinicId, (client) =>
      client.query(
        `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status)
         values ($1, $2, 'web', 5000, 'acct_test_destroy', 'paid')`,
        [leaving.clinicId, gone.appointmentId],
      ),
    );

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "customer.subscription.deleted", started),
    );
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(
        tx,
        "bundle handed to the practice manager",
        new Date(started.getTime() + 5 * DAY),
      ),
    );

    const results = await destroyDueClinics(new Date(started.getTime() + 31 * DAY));
    expect(results.map((r) => r.clinicId)).toEqual([leaving.clinicId]);
    expect(results[0]!.deleted).toMatchObject({
      booking_requests: 3,
      appointments: 1,
      conversations: 1,
      contacts: 1,
      meta_booking_drafts: 1,
    });

    expect(await counts(leaving.clinicId)).toEqual(NOTHING);
    expect(await counts(staying.clinicId)).toEqual(ONE_PERSON);

    const after = await inTenant(leaving.clinicId, async (client) => ({
      deposits: (
        await client.query<{ appointment_id: string | null }>(
          `select appointment_id from deposit_payments`,
        )
      ).rows,
      audit: (
        await client.query<{ metadata: Record<string, number> }>(
          `select metadata from audit_log where resource_type = 'clinic_destruction'`,
        )
      ).rows,
    }));
    expect(after.deposits).toEqual([{ appointment_id: null }]);
    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]!.metadata.booking_requests).toBe(3);
  });

  test("erasure removes one person's confirmed, pending and declined requests, their appointment and their draft, and nobody else's", async () => {
    const c = await seedClinic("erase-br");
    const elsewhere = await seedClinic("erase-br-elsewhere");
    const at = new Date(Date.now() - 3 * DAY);
    const target = await seedPerson(c.clinicId, "+15550107001", at);
    const neighbour = await seedPerson(c.clinicId, "+15550107002", at);
    // The same number at another clinic is another clinic's patient record.
    await seedPerson(elsewhere.clinicId, "+15550107001", at);

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      eraseContact(tx, { phone: target.phone, requestedBy: "patient" }),
    );
    expect(result).toMatchObject({
      contactsMatched: 1,
      bookingRequestsDeleted: 3,
      appointmentsDeleted: 1,
      conversationsDeleted: 1,
      draftsDeleted: 1,
      suppressed: true,
    });

    const left = await inTenant(c.clinicId, async (client) => ({
      requests: (
        await client.query<{ id: string }>(`select id from booking_requests order by id`)
      ).rows.map((r) => r.id),
      appointments: (await client.query<{ id: string }>(`select id from appointments`)).rows.map(
        (r) => r.id,
      ),
      contacts: (await client.query<{ id: string }>(`select id from contacts`)).rows.map(
        (r) => r.id,
      ),
      drafts: (
        await client.query<{ phone: string }>(`select phone from meta_booking_drafts`)
      ).rows.map((r) => r.phone),
      suppressed: (
        await client.query<{ phone: string }>(`select phone from suppressions`)
      ).rows.map((r) => r.phone),
    }));
    expect(left).toEqual({
      requests: [neighbour.confirmed, neighbour.pending, neighbour.declined].sort(),
      appointments: [neighbour.appointmentId],
      contacts: [neighbour.contactId],
      drafts: [neighbour.phone],
      suppressed: [target.phone],
    });
    expect(await counts(elsewhere.clinicId)).toEqual(ONE_PERSON);
  });

  test("an erasure asked for by email finds the person's draft by the number on their record", async () => {
    const c = await seedClinic("erase-br-email");
    const person = await seedPerson(c.clinicId, "+15550107101", new Date(Date.now() - DAY));
    await inTenant(c.clinicId, (client) =>
      client.query(`update contacts set email = 'sam@example-patient.test' where id = $1`, [
        person.contactId,
      ]),
    );

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      eraseContact(tx, { email: "sam@example-patient.test", requestedBy: "clinic" }),
    );
    expect(result).toMatchObject({
      contactsMatched: 1,
      bookingRequestsDeleted: 3,
      draftsDeleted: 1,
      suppressed: true,
    });
    expect(await counts(c.clinicId)).toEqual(NOTHING);
  });

  test("erasure takes a payment matched to their appointment, whoever it was matched to, rather than abort on it", async () => {
    const c = await seedClinic("erase-br-paid");
    const at = new Date(Date.now() - 2 * DAY);
    const target = await seedPerson(c.clinicId, "+15550107201", at);
    const neighbour = await seedPerson(c.clinicId, "+15550107202", at);
    // A sale read back with no contact of its own, which the reconciler
    // (lib/sync/reconcile-store.ts) matched to the target's appointment, and
    // the neighbour's own sale. transactions.appointment_id has no delete
    // action, so the first, left behind, would stop the appointment's delete.
    const kept = await inTenant(c.clinicId, async (client) => {
      await client.query(
        `insert into transactions (clinic_id, contact_id, appointment_id, amount_usd, collected_at)
         values ($1, null, $2, 250, $3)`,
        [c.clinicId, target.appointmentId, at],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into transactions (clinic_id, contact_id, appointment_id, amount_usd, collected_at)
         values ($1, $2, $3, 300, $4) returning id`,
        [c.clinicId, neighbour.contactId, neighbour.appointmentId, at],
      );
      return rows[0]!.id;
    });

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      eraseContact(tx, { phone: target.phone, requestedBy: "patient" }),
    );
    expect(result).toMatchObject({
      contactsMatched: 1,
      transactionsDeleted: 1,
      bookingRequestsDeleted: 3,
      appointmentsDeleted: 1,
    });
    const left = await inTenant(c.clinicId, async (client) => ({
      transactions: (await client.query<{ id: string }>(`select id from transactions`)).rows.map(
        (r) => r.id,
      ),
      appointments: (await client.query<{ id: string }>(`select id from appointments`)).rows.map(
        (r) => r.id,
      ),
    }));
    expect(left).toEqual({ transactions: [kept], appointments: [neighbour.appointmentId] });
  });

  test("the purge removes requests past the record clock with their appointments, keeps one that is not, and leaves another clinic alone", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 200 * DAY);
    const c = await seedClinic("purge-br");
    const other = await seedClinic("purge-br-other");
    await seedPerson(c.clinicId, "+15550108001", old);
    await seedPerson(other.clinicId, "+15550108001", old);

    // Last seen long ago, asked again yesterday on WhatsApp: the request is
    // inside the clock, so neither it nor its person may go with the rest.
    const returning = await seedContact(c.clinicId, "+15550108002");
    const fresh = await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set updated_at = $2 where id = $1`, [returning, old]);
      const { rows } = await client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window, token_hash, expires_at, created_at)
         values ($1, $2, 'meta', 'messenger', 'page_1', 'psid_returning', 'Friday', $3, now() + interval '6 days', now() - interval '1 day')
         returning id`,
        [c.clinicId, returning, randomBytes(32)],
      );
      return rows[0]!.id;
    });

    // Booked long ago for a slot still ahead: the request stays with its
    // appointment, though the call it was taken on is past the clock.
    const ahead = await seedContact(c.clinicId, "+15550108003");
    const { conversationId: oldCall } = await seedConversation(c.clinicId, {
      startedAt: old,
      contactId: ahead,
    });
    const booked = await inTenant(c.clinicId, async (client) => {
      const { rows: appt } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, conversation_id, scheduled_for)
         values ($1, $2, $3, now() + interval '10 days') returning id`,
        [c.clinicId, ahead, oldCall],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, conversation_id, preferred_window, status, token_hash, expires_at,
            decided_at, confirmed_for, appointment_id, created_at)
         values ($1, $2, 'voice', $3, 'in the autumn', 'confirmed', $4, $5::timestamptz + interval '7 days',
                 $5, now() + interval '10 days', $6, $5)
         returning id`,
        [c.clinicId, ahead, oldCall, randomBytes(32), old, appt[0]!.id],
      );
      return { appointmentId: appt[0]!.id, requestId: rows[0]!.id };
    });

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      purgeClinic(tx, now),
    );
    expect(result).toMatchObject({
      skipped: null,
      bookingRequestsDeleted: 3,
      appointmentsDeleted: 1,
      conversationsDeleted: 2,
      contactsDeleted: 1,
      draftsDeleted: 1,
    });

    const left = await inTenant(c.clinicId, async (client) => ({
      requests: (
        await client.query<{ id: string; conversation_id: string | null }>(
          `select id, conversation_id from booking_requests order by created_at`,
        )
      ).rows,
      appointments: (await client.query<{ id: string }>(`select id from appointments`)).rows.map(
        (r) => r.id,
      ),
      contacts: (
        await client.query<{ id: string }>(`select id from contacts order by phone`)
      ).rows.map((r) => r.id),
      conversations: (await client.query(`select id from conversations`)).rows.length,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
    }));
    expect(left).toEqual({
      // The far-ahead booking lost the purged call, not its appointment.
      requests: [
        { id: booked.requestId, conversation_id: null },
        { id: fresh, conversation_id: null },
      ],
      appointments: [booked.appointmentId],
      contacts: [returning, ahead],
      conversations: 0,
      drafts: 0,
    });
    expect(await counts(other.clinicId)).toEqual(ONE_PERSON);

    // The audit row counts the requests, never names a person.
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'retention_purge'`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata.bookingRequests).toBe(3);
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/\+1555/);
  });

  test("the three delete functions reach only their own tenant, and only what destruction, erasure or the clock already requires", async () => {
    const live = await seedClinic("guard-br");
    const other = await seedClinic("guard-br-other");
    const person = await seedPerson(live.clinicId, "+15550109001", new Date());
    const theirs = await seedPerson(other.clinicId, "+15550109002", new Date());

    // No tenant, no delete.
    for (const [text, values] of [
      [`select app_destroy_booking_requests($1::uuid)`, [live.clinicId]],
      [`select app_erase_booking_requests($1::uuid)`, [person.contactId]],
      [`select app_purge_booking_requests(now() - interval '1 year')`, []],
    ] as const) {
      await expect(asApp(null, (c) => c.query(text, [...values]))).rejects.toMatchObject({
        code: "42501",
      });
    }

    // Destruction: never another clinic's from inside this tenant, never a
    // customer's, and never before the clinic's own destroy_after.
    await expect(
      asApp(live.clinicId, (c) =>
        c.query(`select app_destroy_booking_requests($1::uuid)`, [other.clinicId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(live.clinicId, (c) =>
        c.query(`select app_destroy_booking_requests($1::uuid)`, [live.clinicId]),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringMatching(/not due for destruction/),
    });
    await withTenant({ clinicId: live.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await expect(
      asApp(live.clinicId, (c) =>
        c.query(`select app_destroy_booking_requests($1::uuid)`, [live.clinicId]),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringMatching(/not due for destruction/),
    });

    // Erasure: another clinic's person is invisible, so nothing goes.
    const erased = await asApp(live.clinicId, (c) =>
      c.query<{ n: number }>(`select app_erase_booking_requests($1::uuid) as n`, [
        theirs.contactId,
      ]),
    );
    expect(erased.rows[0]!.n).toBe(0);

    // The purge: never ahead of the clinic's own record clock, and inside it
    // nothing of today's goes.
    await expect(
      asApp(live.clinicId, (c) => c.query(`select app_purge_booking_requests(now())`)),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });
    const purged = await asApp(live.clinicId, (c) =>
      c.query<{ n: number }>(`select app_purge_booking_requests(now() - interval '90 days') as n`),
    );
    expect(purged.rows[0]!.n).toBe(0);

    expect(await counts(live.clinicId)).toEqual(ONE_PERSON);
    expect(await counts(other.clinicId)).toEqual(ONE_PERSON);
  });

  test("live use is unchanged: a confirmed request is never re-decided, rewritten, deleted, or left without its appointment", async () => {
    const c = await seedClinic("live-br");
    const person = await seedPerson(c.clinicId, "+15550110001", new Date());

    await expect(
      asApp(c.clinicId, (q) =>
        q.query(
          `update booking_requests set status = 'declined', decided_at = now(), confirmed_for = null, appointment_id = null where id = $1`,
          [person.confirmed],
        ),
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/not a permitted transition/),
    });
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`update booking_requests set appointment_id = null where id = $1`, [
          person.confirmed,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/already decided/) });
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`delete from booking_requests where id = $1`, [person.confirmed]),
      ),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });

    // Its appointment cannot be deleted out from under it, by the runtime role
    // or by the owner: the request has to go first, and only the three
    // functions above may take it.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`delete from appointments where id = $1`, [person.appointmentId]),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "booking_requests_appointment_id_appointments_id_fk",
    });
    await expect(
      inTenant(c.clinicId, (q) =>
        q.query(`delete from appointments where id = $1`, [person.appointmentId]),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "booking_requests_appointment_id_appointments_id_fk",
    });

    // An open request still moves as it always did.
    const decided = await asApp(c.clinicId, (q) =>
      q.query<{ status: string }>(
        `update booking_requests set status = 'declined', decided_at = now() where id = $1 returning status`,
        [person.pending],
      ),
    );
    expect(decided.rows).toEqual([{ status: "declined" }]);

    expect(await counts(c.clinicId)).toEqual(ONE_PERSON);
    const { rows } = await getMigratorPool().query<{ deletable: boolean }>(
      `select has_table_privilege('healdesk_app', 'booking_requests', 'DELETE') as deletable`,
    );
    expect(rows[0]!.deletable).toBe(false);
  });
});
