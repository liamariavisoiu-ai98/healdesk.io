import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { getBaaTemplate, type BaaVariables } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  DESTROY_AFTER_DAYS,
  destroyDueClinics,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { KEPT_FOR_GOOD, KEPT_IN_PART } from "@/lib/offboarding/account-closure";
import { exportClinic } from "@/lib/patient-rights/export";
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
import { sessionReach, setLocalZone, zoneShrinking, zoneStretching } from "./setup/time-zones";

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
 *
 * Live use includes the delete functions themselves. The runtime role keeps
 * INSERT on booking_requests and the no-rewrite trigger is BEFORE UPDATE
 * only, so a request it could delete at will it could put back with another
 * decision. Two reviews of 7 October found that open, through all three
 * functions and through the contact's cascade; the tests below hold erasure
 * to the people's own requests and the people with them, destruction and the
 * purge to dates and a clock the runtime role cannot move past what they
 * allow, and every request to being written once, so that nothing deleted
 * comes back.
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

/** The same, committed: a write the runtime role makes and keeps, as a practice's setting is. */
async function asAppCommitted<T>(clinicId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const result = await fn(client as unknown as Client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
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

/**
 * Time passing, for the offboarding clock. The runtime role cannot write the
 * dates app_start_offboarding() stamps, so the migrator, which owns clinics,
 * moves them back as the days would.
 */
async function backdateOffboarding(clinicId: string, days: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(days => $2),
            destroy_after = destroy_after - make_interval(days => $2)
      where id = $1`,
    [clinicId, days],
  );
}

/**
 * What happens to every table with a clinic_id when a clinic leaves, three
 * ways. Destruction deletes the patient rows (destroyClinicData), and
 * app_mark_clinic_destroyed() refuses to record it while any is left. The
 * account's closure, once the pass-through has ended, deletes the sign-in,
 * the setup and our notes (app_close_clinic_account, drizzle/0096). Every
 * other table is KEPT_FOR_GOOD (lib/offboarding/account-closure.ts), each
 * for a reason the agreements or the law give: the spec keeps "only the
 * signed agreement and the billing records the law requires". Until 19
 * October 2026 this file kept its own list, which held agent_configs, the
 * settings, the memberships and the website reads for good. A new table with
 * a clinic_id fails the catalog test below until it is put on one of the
 * three, so it cannot slip past a destruction record that says nothing of
 * the clinic's patients remains, or a closure that says the account is gone.
 */

/** The tables app_close_clinic_account() deletes a clinic's rows from, read from its source. */
async function deletedAtClosure(): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ prosrc: string }>(
    `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'app_close_clinic_account'`,
  );
  expect(rows).toHaveLength(1);
  return [
    ...new Set(
      [
        ...rows[0]!.prosrc.matchAll(
          /delete\s+from\s+([a-z_]+)\s+[a-z]+\s+where\s+[a-z]+\.clinic_id\s*=\s*target_clinic/gi,
        ),
      ].map((m) => m[1]!),
    ),
  ].sort();
}

/** Every table with a clinic_id column, from the catalog. */
async function clinicTables(): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'clinic_id'
                       and a.attnum > 0 and not a.attisdropped)
      order by c.relname`,
  );
  return rows.map((r) => r.relname);
}

/** The tables app_mark_clinic_destroyed() requires to be empty, read from its source. */
async function checkedBeforeDestroyed(): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ prosrc: string }>(
    `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'app_mark_clinic_destroyed'`,
  );
  expect(rows).toHaveLength(1);
  return [
    ...rows[0]!.prosrc.matchAll(
      /exists\s*\(\s*select\s+1\s+from\s+([a-z_]+)\s+[a-z]+\s+where\s+[a-z]+\.clinic_id\s*=\s*target_clinic\s*\)/gi,
    ),
  ]
    .map((m) => m[1]!)
    .sort();
}

/** One row in each of the two tables 0043 added that point at whoever messaged the clinic. */
async function seedMessagingRefs(
  clinicId: string,
  which: { thread?: boolean; inbound?: boolean } = { thread: true, inbound: true },
): Promise<void> {
  await inTenant(clinicId, async (client) => {
    if (which.thread) {
      await client.query(
        `insert into chat_threads
           (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
         values ($1, 'whatsapp', $2, $3, now() - interval '40 days', now() - interval '40 days')`,
        [clinicId, `v1:${randomBytes(32).toString("hex")}`, randomUUID()],
      );
    }
    if (which.inbound) {
      await client.query(
        `insert into meta_inbound_messages (clinic_id, platform, message_ref, received_at)
         values ($1, 'whatsapp', $2, now() - interval '40 days')`,
        [clinicId, `v1:${randomBytes(32).toString("hex")}`],
      );
    }
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
    const leaving = await seedClinic("destroy-br");
    const staying = await seedClinic("destroy-br-stay");
    const gone = await seedPerson(
      leaving.clinicId,
      "+15550106001",
      new Date("2026-05-20T15:00:00Z"),
    );
    await seedPerson(staying.clinicId, "+15550106001", new Date("2026-05-20T15:00:00Z"));
    // A paid deposit on the confirmed booking, and the Connect event that
    // reported it: both go with the clinic (drizzle/0065). The other clinic's
    // event stays.
    await inTenant(leaving.clinicId, (client) =>
      client.query(
        `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status)
         values ($1, $2, 'web', 5000, 'acct_test_destroy', 'paid')`,
        [leaving.clinicId, gone.appointmentId],
      ),
    );
    await getMigratorPool().query(
      `insert into stripe_connect_events (stripe_event_id, type, account, resolved_clinic_id)
       values ('evt_destroy_leaving', 'checkout.session.completed', 'acct_test_destroy', $1),
              ('evt_destroy_staying', 'checkout.session.completed', 'acct_test_stay', $2)`,
      [leaving.clinicId, staying.clinicId],
    );

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "customer.subscription.deleted"),
    );
    // Thirty-one days on, by the database's own stamps.
    await backdateOffboarding(leaving.clinicId, 31);
    // The return bundle is the practice's copy of its deposits, since
    // destruction takes them: the amount, the status and the Stripe session
    // it can find each by, never the Stripe account id or event id.
    const bundle = await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      exportClinic(tx, "practice"),
    );
    expect(bundle.depositPayments).toEqual([
      expect.objectContaining({ appointmentId: gone.appointmentId, amountCents: 5000, status: "paid", channel: "web" }),
    ]);
    expect(Object.keys(bundle.depositPayments[0]!).sort()).toEqual([
      "amountCents", "appointmentId", "channel", "checkoutSessionId", "createdAt", "currency", "id", "paidAt", "status",
    ]);
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );

    const results = await destroyDueClinics();
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
    // Gone with the rest (drizzle/0065): its Stripe session finds the patient
    // in the clinic's Stripe account, and clause 17 lets two records survive.
    expect(after.deposits).toEqual([]);
    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]!.metadata.booking_requests).toBe(3);
    expect(after.audit[0]!.metadata.deposit_payments).toBe(1);
    expect(after.audit[0]!.metadata.stripe_connect_events).toBe(1);
    const { rows: events } = await getMigratorPool().query<{ stripe_event_id: string }>(
      `select stripe_event_id from stripe_connect_events where stripe_event_id like 'evt_destroy_%' order by 1`,
    );
    expect(events.map((e) => e.stripe_event_id)).toEqual(["evt_destroy_staying"]);
    // The record that it ran is the database's, stamped in the same transaction.
    const { rows: stamped } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
      `select destroyed_at from clinics where id = $1`,
      [leaving.clinicId],
    );
    expect(stamped[0]!.destroyed_at).not.toBeNull();
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
      // No copy of the number is kept as the record of the request (gate 6).
      suppressed: [],
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

  test("the delete functions reach only their own tenant, and only what destruction, erasure or the clock already requires", async () => {
    const live = await seedClinic("guard-br");
    const other = await seedClinic("guard-br-other");
    const person = await seedPerson(live.clinicId, "+15550109001", new Date());
    const theirs = await seedPerson(other.clinicId, "+15550109002", new Date());

    // No tenant: no delete, and no date stamped.
    for (const [text, values] of [
      [`select app_destroy_booking_requests($1::uuid)`, [live.clinicId]],
      [`select * from app_erase_contacts(array[$1]::uuid[])`, [person.contactId]],
      [`select app_purge_booking_requests(now() - interval '1 year')`, []],
      [`select app_start_offboarding($1::uuid)`, [live.clinicId]],
      [`select app_mark_clinic_destroyed($1::uuid)`, [live.clinicId]],
      [`select app_record_cutoff()`, []],
    ] as const) {
      await expect(asApp(null, (c) => c.query(text, [...values]))).rejects.toMatchObject({
        code: "42501",
      });
    }

    // Destruction: never another clinic's from inside this tenant, never a
    // customer's, and never before its agreement's rule allows, by the
    // database's clock. This clinic holds no agreement, so the rule is the
    // thirty days, due at day 29 (drizzle/0058).
    for (const fn of [
      "app_destroy_booking_requests",
      "app_start_offboarding",
      "app_mark_clinic_destroyed",
    ]) {
      await expect(
        asApp(live.clinicId, (c) => c.query(`select ${fn}($1::uuid)`, [other.clinicId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const notDue = { code: "23514", message: expect.stringMatching(/not due for destruction/) };
    const destroy = () =>
      asApp(live.clinicId, (c) =>
        c.query<{ n: number }>(`select app_destroy_booking_requests($1::uuid) as n`, [
          live.clinicId,
        ]),
      );
    const markDestroyed = () =>
      asApp(live.clinicId, (c) =>
        c.query(`select app_mark_clinic_destroyed($1::uuid)`, [live.clinicId]),
      );
    await expect(destroy()).rejects.toMatchObject(notDue);
    await expect(markDestroyed()).rejects.toMatchObject(notDue);
    await withTenant({ clinicId: live.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await expect(destroy()).rejects.toMatchObject(notDue);
    await backdateOffboarding(live.clinicId, 28);
    await expect(destroy()).rejects.toMatchObject(notDue);
    // A destroy_after moved into the past on its own does not shorten the
    // wait: the start is read too.
    await getMigratorPool().query(
      `update clinics set destroy_after = now() - interval '1 day' where id = $1`,
      [live.clinicId],
    );
    await expect(destroy()).rejects.toMatchObject(notDue);
    await expect(markDestroyed()).rejects.toMatchObject(notDue);
    await backdateOffboarding(live.clinicId, 1);
    expect((await destroy()).rows[0]!.n).toBe(3);

    // Erasure: another clinic's person is invisible, so nothing goes.
    const erased = await asApp(live.clinicId, (c) =>
      c.query(`select * from app_erase_contacts(array[$1]::uuid[])`, [theirs.contactId]),
    );
    expect(erased.rows[0]).toEqual({
      requests_deleted: 0,
      appointments_deleted: 0,
      conversations_deleted: 0,
      contacts_deleted: 0,
      amendments_deleted: 0,
      deposits_deleted: 0,
      connect_events_deleted: 0,
    });

    // The purge: never ahead of the clinic's own record clock, and inside it
    // nothing of today's goes.
    await expect(
      asApp(live.clinicId, (c) => c.query(`select app_purge_booking_requests(now())`)),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });
    const purged = await asApp(live.clinicId, (c) =>
      c.query<{ n: number }>(`select app_purge_booking_requests(now() - interval '90 days') as n`),
    );
    expect(purged.rows[0]!.n).toBe(0);

    // Every call above ran as the runtime role and rolled back.
    expect(await counts(live.clinicId)).toEqual(ONE_PERSON);
    expect(await counts(other.clinicId)).toEqual(ONE_PERSON);
  });

  test("an erasure takes the person with their requests: the runtime role cannot remove a confirmed request and keep its person", async () => {
    const c = await seedClinic("erase-whole");
    const person = await seedPerson(c.clinicId, "+15550111001", new Date());
    const neighbour = await seedPerson(c.clinicId, "+15550111002", new Date());
    const erase = `select * from app_erase_contacts(array[$1]::uuid[])`;

    // Something else still refers to the person, here a sale: the call fails
    // with nothing removed, so no request leaves while its person stays.
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into transactions (clinic_id, contact_id, amount_usd, collected_at)
         values ($1, $2, 120, now())`,
        [c.clinicId, person.contactId],
      ),
    );
    await expect(
      asApp(c.clinicId, (q) => q.query(erase, [person.contactId])),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "transactions_contact_id_contacts_id_fk",
    });
    expect((await counts(c.clinicId)).booking_requests).toBe(6);

    // Once nothing else does, the person goes with the requests, in the one
    // call: the contact, the booking, the call and all three requests, and
    // nothing of the neighbour's.
    const after = await asApp(c.clinicId, async (q) => {
      await q.query(`delete from transactions where contact_id = $1`, [person.contactId]);
      const erased = (await q.query(erase, [person.contactId])).rows[0];
      const left = async (table: string, column: string) =>
        (
          await q.query<{ n: number }>(
            `select count(*)::int as n from ${table} where ${column} = $1`,
            [person.contactId],
          )
        ).rows[0]!.n;
      return {
        erased,
        left: {
          contacts: await left("contacts", "id"),
          booking_requests: await left("booking_requests", "contact_id"),
          appointments: await left("appointments", "contact_id"),
          conversations: await left("conversations", "contact_id"),
        },
        requests: (
          await q.query<{ id: string }>(`select id from booking_requests order by id`)
        ).rows.map((r) => r.id),
      };
    });
    expect(after.erased).toEqual({
      requests_deleted: 3,
      appointments_deleted: 1,
      conversations_deleted: 1,
      contacts_deleted: 1,
      amendments_deleted: 0,
      deposits_deleted: 0,
      connect_events_deleted: 0,
    });
    expect(after.left).toEqual({
      contacts: 0,
      booking_requests: 0,
      appointments: 0,
      conversations: 0,
    });
    expect(after.requests).toEqual(
      [neighbour.confirmed, neighbour.pending, neighbour.declined].sort(),
    );

    // And no other function takes a request ahead of its person: the only
    // definers that delete booking requests are these three, each bound to
    // state the runtime role cannot write. Gate 6's first version added a
    // fourth, app_erase_thread_requests, which took every request a
    // messaging thread had sent, whoever each named: erasing a child took the
    // requests their parent had made for themselves. It is gone (drizzle/0063),
    // and a person's deletion reaches only the requests that name them.
    const { rows } = await getMigratorPool().query<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and p.prosrc ~* 'delete\\s+from\\s+(public\\.)?booking_requests'
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "app_destroy_booking_requests",
      "app_erase_contacts",
      "app_purge_booking_requests",
    ]);
  });

  test("in live use the runtime role cannot stamp a clinic due for destruction, nor set its record clock below a day", async () => {
    const c = await seedClinic("live-clock");
    await seedPerson(c.clinicId, "+15550112001", new Date());

    // The dates the destroy function reads are the database's alone: stamping
    // them, emptying the clinic's requests and putting them back is shut.
    for (const column of [
      "offboarding_started_at",
      "destroy_after",
      "destroyed_at",
      "export_delivered_at",
    ]) {
      await expect(
        asApp(c.clinicId, (q) =>
          q.query(`update clinics set ${column} = now() - interval '31 days' where id = $1`, [
            c.clinicId,
          ]),
        ),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied/),
      });
    }
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`select app_destroy_booking_requests($1::uuid)`, [c.clinicId]),
      ),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/not due/) });

    // Starting offboarding stamps both from the database's clock, thirty days
    // apart, and starting again moves neither.
    const stamps = async () =>
      (
        await getMigratorPool().query<{ started: Date; due: Date; now: Date }>(
          `select offboarding_started_at as started, destroy_after as due, now() as now
             from clinics where id = $1`,
          [c.clinicId],
        )
      ).rows[0]!;
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    const first = await stamps();
    expect(first.due.getTime() - first.started.getTime()).toBe(DESTROY_AFTER_DAYS * DAY);
    expect(first.now.getTime() - first.started.getTime()).toBeLessThan(60_000);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "customer.subscription.deleted"),
    );
    expect(await stamps()).toMatchObject({ started: first.started, due: first.due });

    // The record clock is the practice's to shorten, never below a day, so
    // the purge's cutoff never passes now(), whatever the clock says.
    for (const days of [0, -100_000]) {
      await expect(
        asApp(c.clinicId, (q) =>
          q.query(`update clinics set retention_record_days = $2 where id = $1`, [
            c.clinicId,
            days,
          ]),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "clinics_retention_record_days_positive",
      });
    }
    await expect(
      asApp(c.clinicId, async (q) => {
        await q.query(`update clinics set retention_record_days = 1 where id = $1`, [c.clinicId]);
        return q.query(`select app_purge_booking_requests(now() + interval '1 minute')`);
      }),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/record clock/) });
    expect(await counts(c.clinicId)).toEqual(ONE_PERSON);
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
    // or by the owner: the request has to go first, and only the functions
    // above may take it.
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

  // The second review of 7 October. Each test below fails against the
  // version of this migration before it, where the runtime role could do
  // what the test now sees refused.

  test("an erasure takes only the people's own requests: a booking re-pointed at someone else stops the call with nothing removed", async () => {
    const c = await seedClinic("erase-repoint");
    const person = await seedPerson(c.clinicId, "+15550113001", new Date());
    const throwaway = await seedContact(c.clinicId, "+15550113002");

    // The runtime role may write appointments.contact_id. Pointing the
    // person's confirmed booking at a throwaway contact and erasing that
    // contact must not take the person's request while the person stays: the
    // request still holds the booking, so the booking's delete fails the call.
    await expect(
      asApp(c.clinicId, async (q) => {
        await q.query(
          `update appointments set contact_id = $2, conversation_id = null where id = $1`,
          [person.appointmentId, throwaway],
        );
        return q.query(`select * from app_erase_contacts(array[$1]::uuid[])`, [throwaway]);
      }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "booking_requests_appointment_id_appointments_id_fk",
    });
    expect(await counts(c.clinicId)).toEqual({ ...ONE_PERSON, contacts: 2 });
  });

  test("the purge judges a request by its own frozen dates, so moving its booking back reaches nothing, and a booking moved earlier stays with it", async () => {
    const c = await seedClinic("purge-frozen");
    const contact = await seedContact(c.clinicId, "+15550114001");
    // Asked for two hundred days ago, confirmed for a slot a week ahead.
    const booked = await inTenant(c.clinicId, async (client) => {
      const { rows: appt } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for)
         values ($1, $2, now() + interval '7 days') returning id`,
        [c.clinicId, contact],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at,
            decided_at, decided_by_label, confirmed_for, appointment_id, created_at)
         values ($1, $2, 'voice', 'in the spring', 'confirmed', $3, now() - interval '193 days',
                 now() - interval '199 days', 'Front desk', now() + interval '7 days', $4,
                 now() - interval '200 days')
         returning id`,
        [c.clinicId, contact, randomBytes(32), appt[0]!.id],
      );
      return { appointmentId: appt[0]!.id, requestId: rows[0]!.id };
    });

    // The runtime role can write appointments.scheduled_for. Moving the
    // booking four hundred days back and purging at the clinic's own clock
    // reaches nothing: the slot the request was confirmed for is still ahead.
    const purged = await asApp(c.clinicId, async (q) => {
      await q.query(
        `update appointments set scheduled_for = now() - interval '400 days' where id = $1`,
        [booked.appointmentId],
      );
      return (
        await q.query<{ n: number }>(
          `select app_purge_booking_requests(now() - interval '90 days') as n`,
        )
      ).rows[0]!.n;
    });
    expect(purged).toBe(0);

    // A booking moved earlier for real (a sync from the clinic's own system
    // writes scheduled_for, lib/sync/upsert.ts) keeps its request, and the
    // nightly purge leaves the booking for the night its request goes rather
    // than fail on the foreign key and purge nothing at all.
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update appointments set scheduled_for = now() - interval '200 days' where id = $1`,
        [booked.appointmentId],
      ),
    );
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      purgeClinic(tx, new Date()),
    );
    expect(result).toMatchObject({
      skipped: null,
      bookingRequestsDeleted: 0,
      appointmentsDeleted: 0,
    });
    const left = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query<{ id: string }>(`select id from booking_requests`)).rows.map(
        (r) => r.id,
      ),
      appointments: (await client.query<{ id: string }>(`select id from appointments`)).rows.map(
        (r) => r.id,
      ),
    }));
    expect(left).toEqual({ requests: [booked.requestId], appointments: [booked.appointmentId] });
  });

  test("the record clock cannot be shortened, used and put back in one go: a shorter clock reaches the requests a day later", async () => {
    const c = await seedClinic("purge-clock");
    await seedPerson(c.clinicId, "+15550115001", new Date(Date.now() - 3 * DAY));
    const tooLate = { code: "23514", message: expect.stringMatching(/record clock/) };

    // Shortened to a day in the transaction that purges, and put back after:
    // the purge still runs on the clock that was in force, ninety days.
    for (const cutoff of ["now()", "now() - interval '1 day'"]) {
      await expect(
        asApp(c.clinicId, async (q) => {
          await q.query(`update clinics set retention_record_days = 1 where id = $1`, [c.clinicId]);
          const purged = await q.query(`select app_purge_booking_requests(${cutoff})`);
          await q.query(`update clinics set retention_record_days = 90 where id = $1`, [
            c.clinicId,
          ]);
          return purged;
        }),
      ).rejects.toMatchObject(tooLate);
    }
    expect(await counts(c.clinicId)).toEqual(ONE_PERSON);

    // Shortened by the practice and kept: the requests follow it a day later.
    // Time passing is the migrator moving the change back, as the day would.
    await asAppCommitted(c.clinicId, (q) =>
      q.query(`update clinics set retention_record_days = 2 where id = $1`, [c.clinicId]),
    );
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`select app_purge_booking_requests(now() - interval '2 days')`),
      ),
    ).rejects.toMatchObject(tooLate);
    await getMigratorPool().query(
      `update clinics
          set retention_record_days_shortened_at = retention_record_days_shortened_at - interval '1 day'
        where id = $1`,
      [c.clinicId],
    );
    const purged = await asApp(
      c.clinicId,
      async (q) =>
        (
          await q.query<{ n: number }>(
            `select app_purge_booking_requests(now() - interval '2 days') as n`,
          )
        ).rows[0]!.n,
    );
    expect(purged).toBe(3);

    // The nightly purge takes the requests' cutoff from the database, so a
    // job clock running ahead of the database's is not refused for it.
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        purgeClinic(tx, new Date(Date.now() + 2 * DAY)),
      ),
    ).resolves.toMatchObject({ skipped: null, bookingRequestsDeleted: 3 });
  });

  // Any role may set its own session's TimeZone, and Postgres counts
  // `interval '1 day'` and `make_interval(days => n)` in it. A POSIX zone with
  // offsets 334 hours apart put "a day ago" days ahead of now, so a clock
  // shortened in the transaction that purged bound at once (review of 7
  // October). The record clock now counts its days in UTC (drizzle/0058).
  test("a time zone the runtime role sets for itself cannot cut the record clock's day short, or move its cutoff", async () => {
    const c = await seedClinic("purge-zone");
    await seedPerson(c.clinicId, "+15550115101", new Date(Date.now() - 3 * DAY));
    const tooLate = { code: "23514", message: expect.stringMatching(/record clock/) };

    // A zone in which the session's "a day ago" lies ahead of now.
    const ahead = await zoneShrinking("1 day");
    const reach = await asApp(c.clinicId, async (q) => {
      await setLocalZone(q, ahead.zone);
      return sessionReach(q, "1 day");
    });
    expect(reach, ahead.zone).toBeLessThan(0);
    await expect(
      asApp(c.clinicId, async (q) => {
        await setLocalZone(q, ahead.zone);
        await q.query(`update clinics set retention_record_days = 1 where id = $1`, [c.clinicId]);
        return q.query(`select app_purge_booking_requests(now())`);
      }),
    ).rejects.toMatchObject(tooLate);
    expect(await counts(c.clinicId)).toEqual(ONE_PERSON);

    // The cutoff is the clock in force, ninety days of twenty-four hours, a
    // day early (drizzle/0067: the purge runs twice a day, and a row must be
    // gone before its period ends), in a zone that stretches the session's
    // ninety days and in one that shrinks them.
    for (const hostile of [await zoneStretching("90 days"), await zoneShrinking("90 days")]) {
      const { rows } = await asApp(c.clinicId, async (q) => {
        await setLocalZone(q, hostile.zone);
        return q.query<{ exact: boolean; reach: number }>(
          `select app_record_cutoff() = now() - interval '2136 hours' as exact,
                  extract(epoch from now() - (now() - interval '90 days'))::float8 / 86400 as reach`,
        );
      });
      expect(Math.abs(rows[0]!.reach - 90), hostile.zone).toBeGreaterThan(10);
      expect(rows[0]!.exact, hostile.zone).toBe(true);
    }
  });

  test("a clinic is never born offboarding, destroyed or part-way through a record-clock change", async () => {
    const insertClinic = (column: string | null, value: string | null) => {
      const id = randomUUID();
      return asApp(id, async (q) => {
        await q.query(
          `insert into organization (id, name, slug, created_at) values ($1, 'Born', $1, now())`,
          [`org_${id}`],
        );
        return q.query(
          `insert into clinics (id, organization_id, slug, name, specialty${column ? `, ${column}` : ""})
           values ($1, $2, $3, 'Born', 'med-spa'${value ? `, ${value}` : ""}) returning id`,
          [id, `org_${id}`, `born-${id.slice(0, 8)}`],
        );
      });
    };
    // Provisioning's insert names none of them, and still works.
    expect((await insertClinic(null, null)).rows).toHaveLength(1);
    for (const [column, value] of [
      ["offboarding_started_at", "now() - interval '400 days'"],
      ["destroy_after", "now() - interval '370 days'"],
      ["destroyed_at", "now()"],
      ["export_delivered_at", "now()"],
      ["retention_record_days_previous", "3650"],
      ["retention_record_days_shortened_at", "now()"],
    ] as const) {
      await expect(insertClinic(column, value), column).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/new clinic/),
      });
    }
  });

  test("the database records a destruction only once the clinic's patient rows are gone", async () => {
    const c = await seedClinic("mark-early");
    await seedPerson(c.clinicId, "+15550116001", new Date(Date.now() - DAY));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await backdateOffboarding(c.clinicId, 31);

    // Due, and nothing destroyed: a stamp now would make the hourly job pass
    // the clinic over for good while the ops console called it destroyed.
    await expect(
      asApp(c.clinicId, (q) => q.query(`select app_mark_clinic_destroyed($1::uuid)`, [c.clinicId])),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });

    // destroyClinicData stamps it, once the rows are gone, in the same transaction.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );
    const results = await destroyDueClinics();
    expect(results.map((r) => r.clinicId)).toContain(c.clinicId);
    expect(await counts(c.clinicId)).toEqual(NOTHING);
    const { rows } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
      `select destroyed_at from clinics where id = $1`,
      [c.clinicId],
    );
    expect(rows[0]!.destroyed_at).not.toBeNull();
  });

  test("a person with a request cannot be deleted from under it, and a deleted request never comes back under its id or its token, not even racing the delete", async () => {
    const c = await seedClinic("written-once");
    const person = await seedPerson(c.clinicId, "+15550117001", new Date());
    const throwaway = await seedContact(c.clinicId, "+15550117002");

    // No definer at all: re-home the booking and the call, then delete the
    // person, which the contact's cascade used to answer by deleting the
    // person's requests with it.
    await expect(
      asApp(c.clinicId, async (q) => {
        await q.query(`update appointments set contact_id = $2 where id = $1`, [
          person.appointmentId,
          throwaway,
        ]);
        await q.query(`update conversations set contact_id = $2 where id = $1`, [
          person.conversationId,
          throwaway,
        ]);
        return q.query(`delete from contacts where id = $1`, [person.contactId]);
      }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "booking_requests_contact_id_contacts_id_fk",
    });

    // Through the definer: erase the person whole, then put the person back
    // and the confirmed request with it, declined, under its id, its token,
    // or both.
    const token = await inTenant(
      c.clinicId,
      async (client) =>
        (
          await client.query<{ token_hash: Buffer }>(
            `select token_hash from booking_requests where id = $1`,
            [person.confirmed],
          )
        ).rows[0]!.token_hash,
    );
    const putBack = (q: Client, id: string, contactId: string, tokenHash: Buffer) =>
      q.query(
        `insert into booking_requests
           (id, clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at, decided_at, created_at)
         values ($1, $2, $3, 'voice', 'weekday mornings', 'declined', $4, now() + interval '6 days', now(),
                 now() - interval '1 day')`,
        [id, c.clinicId, contactId, tokenHash],
      );
    const writtenBefore = { code: "42501", message: expect.stringMatching(/written before/) };
    for (const [id, tokenHash] of [
      [person.confirmed, token],
      [person.confirmed, randomBytes(32)],
      [randomUUID(), token],
    ] as const) {
      await expect(
        asApp(c.clinicId, async (q) => {
          await q.query(`select * from app_erase_contacts(array[$1]::uuid[])`, [person.contactId]);
          await q.query(`insert into contacts (id, clinic_id, phone) values ($1, $2, $3)`, [
            person.contactId,
            c.clinicId,
            person.phone,
          ]);
          return putBack(q, id, person.contactId, tokenHash);
        }),
      ).rejects.toMatchObject(writtenBefore);
    }

    // Racing the delete: a second transaction puts the confirmed request back
    // while the erasure is still open. A record of deletions made at delete
    // time would be invisible to it, and its insert would wait on the primary
    // key for the erasure to commit and then go through. The id was taken
    // when the request was first written, so it is refused all the same.
    const eraser = await getAppPool().connect();
    const racer = await getAppPool().connect();
    try {
      await eraser.query("begin");
      await eraser.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await eraser.query(`select * from app_erase_contacts(array[$1]::uuid[])`, [person.contactId]);
      await racer.query("begin");
      await racer.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const { rows: backend } = await racer.query<{ pid: number }>(
        `select pg_backend_pid() as pid`,
      );
      let settled = false;
      const raced = putBack(
        racer as unknown as Client,
        person.confirmed,
        throwaway,
        randomBytes(32),
      ).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      raced.catch(() => {});
      // Commit the erasure only once the racing insert has either finished or
      // is blocked behind it, so the race is real rather than a matter of
      // which statement the server happened to see first.
      for (let polls = 0; !settled; polls++) {
        const { rows } = await getMigratorPool().query<{ blocked: boolean }>(
          `select cardinality(pg_blocking_pids($1)) > 0 as blocked`,
          [backend[0]!.pid],
        );
        if (rows[0]?.blocked) break;
        if (polls > 2_000) throw new Error("the racing insert neither finished nor waited");
      }
      await eraser.query("commit");
      await expect(raced).rejects.toMatchObject(writtenBefore);
    } finally {
      await racer.query("rollback").catch(() => {});
      await eraser.query("rollback").catch(() => {});
      racer.release();
      eraser.release();
    }

    // The erasure above committed. The person's other requests stay gone
    // too, whatever id and contact they come back with.
    expect((await counts(c.clinicId)).booking_requests).toBe(0);
    await expect(
      asApp(c.clinicId, (q) => putBack(q, person.declined, throwaway, randomBytes(32))),
    ).rejects.toMatchObject(writtenBefore);

    // The record is the migrator's: the runtime role can neither read it nor
    // remove it.
    for (const text of [
      `select * from booking_request_keys`,
      `delete from booking_request_keys`,
      `truncate booking_request_keys`,
    ]) {
      await expect(
        asApp(c.clinicId, (q) => q.query(text)),
        text,
      ).rejects.toMatchObject({
        code: "42501",
      });
    }
  });

  // The third review of 7 October. Each test below fails without the change
  // it pins (to this migration, to destroyClinicData, or to clause 11 of BAA
  // 1.3.0), except the last, which runs the restore steps docs/handover.md
  // gives so they cannot quietly stop working.

  test("every table with a clinic_id is destroyed and checked before the destruction is recorded, deleted when the account closes, or kept on purpose", async () => {
    const tables = await clinicTables();
    const checked = await checkedBeforeDestroyed();
    const closed = await deletedAtClosure();
    const kept = Object.keys(KEPT_FOR_GOOD);
    // Guard against any query matching nothing and the test passing vacuously.
    expect(tables.length).toBeGreaterThan(20);
    expect(checked).toContain("booking_requests");
    expect(closed).toContain("agent_configs");

    for (const list of [checked, closed, kept]) expect(list.filter((t) => !tables.includes(t))).toEqual([]);
    // One fate each: nothing destruction deletes is kept or left for the
    // closure, and the closure keeps only the part KEPT_IN_PART names.
    expect(checked.filter((t) => closed.includes(t) || kept.includes(t))).toEqual([]);
    expect(closed.filter((t) => kept.includes(t))).toEqual([...KEPT_IN_PART].sort());
    // The one that matters: a clinic table on none of the three would outlive
    // a destruction recorded as complete, or a closed account.
    expect(
      tables.filter((t) => !checked.includes(t) && !closed.includes(t) && !kept.includes(t)),
    ).toEqual([]);
  });

  test("destruction takes the hashes of who messaged the clinic, and the database records it only once they are gone", async () => {
    const both = await seedClinic("destroy-refs");
    const threadOnly = await seedClinic("destroy-refs-thread");
    const inboundOnly = await seedClinic("destroy-refs-inbound");
    await seedPerson(both.clinicId, "+15550118001", new Date(Date.now() - 40 * DAY));
    await seedMessagingRefs(both.clinicId);
    await seedMessagingRefs(threadOnly.clinicId, { thread: true });
    await seedMessagingRefs(inboundOnly.clinicId, { inbound: true });
    for (const c of [both, threadOnly, inboundOnly]) {
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        startOffboarding(tx, "operator"),
      );
      await backdateOffboarding(c.clinicId, 31);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "bundle handed to the practice manager"),
      );
    }

    // Due, and holding nothing but a WhatsApp sender's thread, or a handled
    // message's reference: no record of destruction yet, or the hourly job
    // would pass the clinic over for good with the row still there.
    for (const c of [threadOnly, inboundOnly]) {
      await expect(
        asApp(c.clinicId, (q) =>
          q.query(`select app_mark_clinic_destroyed($1::uuid)`, [c.clinicId]),
        ),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });
    }

    const results = (await destroyDueClinics()).filter((r) =>
      [both.clinicId, threadOnly.clinicId, inboundOnly.clinicId].includes(r.clinicId),
    );
    expect(results.map((r) => r.clinicId).sort()).toEqual(
      [both.clinicId, threadOnly.clinicId, inboundOnly.clinicId].sort(),
    );
    const mine = results.find((r) => r.clinicId === both.clinicId)!;
    expect(mine.deleted).toMatchObject({
      chat_threads: 1,
      meta_inbound_messages: 1,
      booking_requests: 3,
    });
    // destroyClinicData deletes exactly the tables the database checks.
    const checked = await checkedBeforeDestroyed();
    for (const r of results) expect(Object.keys(r.deleted).sort()).toEqual(checked);

    for (const c of [both, threadOnly, inboundOnly]) {
      const left = await inTenant(c.clinicId, async (client) => ({
        threads: (await client.query(`select 1 from chat_threads`)).rows.length,
        inbound: (await client.query(`select 1 from meta_inbound_messages`)).rows.length,
      }));
      expect(left).toEqual({ threads: 0, inbound: 0 });
      const { rows } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
        `select destroyed_at from clinics where id = $1`,
        [c.clinicId],
      );
      expect(rows[0]!.destroyed_at).not.toBeNull();
    }
  });

  // drizzle/0106: the Retell call alerts (0105) hold a call id, times and our
  // own reason, never content, but each ties a call to the clinic. All of a
  // clinic's go at its destruction, open or resolved; the purge takes a
  // resolved one thirty days after it was resolved and never an open one.

  /** A Retell call alert, resolved `resolvedDaysAgo` days ago, or open when null. */
  async function seedRecordingAlert(clinicId: string, resolvedDaysAgo: number | null): Promise<string> {
    const callId = `call_${randomBytes(8).toString("hex")}`;
    await inTenant(clinicId, (client) =>
      client.query(
        `insert into retell_recording_alerts (clinic_id, retell_call_id, detected_at, resolved_at)
         values ($1, $2, now() - interval '60 days',
                 case when $3::int is null then null else now() - make_interval(days => $3::int) end)`,
        [clinicId, callId, resolvedDaysAgo],
      ),
    );
    return callId;
  }

  async function recordingAlertCalls(clinicId: string): Promise<string[]> {
    return inTenant(clinicId, async (client) =>
      (
        await client.query<{ retell_call_id: string }>(
          `select retell_call_id from retell_recording_alerts where clinic_id = $1 order by retell_call_id`,
          [clinicId],
        )
      ).rows.map((r) => r.retell_call_id),
    );
  }

  test("destruction takes every Retell call alert of the clinic, open or resolved, is recorded only once they are gone, and touches no other clinic's", async () => {
    const leaving = await seedClinic("destroy-alerts");
    const staying = await seedClinic("destroy-alerts-stay");
    await seedRecordingAlert(leaving.clinicId, null);
    await seedRecordingAlert(leaving.clinicId, 2);
    const theirs = [await seedRecordingAlert(staying.clinicId, null), await seedRecordingAlert(staying.clinicId, 45)].sort();
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    await backdateOffboarding(leaving.clinicId, 31);
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );

    // Due, and holding nothing but the alerts: the database will not record
    // a destruction that left them.
    await expect(
      asApp(leaving.clinicId, (q) => q.query(`select app_mark_clinic_destroyed($1::uuid)`, [leaving.clinicId])),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });

    const results = (await destroyDueClinics()).filter((r) => r.clinicId === leaving.clinicId);
    expect(results).toHaveLength(1);
    expect(results[0]!.deleted).toMatchObject({ retell_recording_alerts: 2 });
    expect(await recordingAlertCalls(leaving.clinicId)).toEqual([]);
    expect(await recordingAlertCalls(staying.clinicId)).toEqual(theirs);
    const { rows } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
      `select destroyed_at from clinics where id = $1`,
      [leaving.clinicId],
    );
    expect(rows[0]!.destroyed_at).not.toBeNull();
  });

  test("the purge takes a Retell call alert thirty days after it was resolved, never an open one however old, and no other clinic's", async () => {
    const c = await seedClinic("purge-alerts");
    const other = await seedClinic("purge-alerts-other");
    const open = await seedRecordingAlert(c.clinicId, null);
    const recent = await seedRecordingAlert(c.clinicId, 29);
    await seedRecordingAlert(c.clinicId, 31);
    const others = [await seedRecordingAlert(other.clinicId, null), await seedRecordingAlert(other.clinicId, 31)].sort();

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, new Date()));
    expect(result.recordingAlertsDeleted).toBe(1);
    expect(await recordingAlertCalls(c.clinicId)).toEqual([open, recent].sort());
    expect(await recordingAlertCalls(other.clinicId)).toEqual(others);
  });

  test("the database stamps a change when it is written, not when its transaction began", async () => {
    const c = await seedClinic("stamp-at-write");
    // A transaction that waited before writing, as one opened a day or thirty
    // days before would: the record clock's day and offboarding's thirty run
    // from the write, so the wait cannot be spent before anyone sees it.
    const stamps = await asApp(c.clinicId, async (q) => {
      await q.query(`select pg_sleep(1.2)`);
      await q.query(`update clinics set retention_record_days = 30 where id = $1`, [c.clinicId]);
      await q.query(`select app_start_offboarding($1::uuid)`, [c.clinicId]);
      return (
        await q.query<{ shortened: number; started: number; due: number }>(
          `select extract(epoch from retention_record_days_shortened_at - now())::float8
                    as shortened,
                  extract(epoch from offboarding_started_at - now())::float8 as started,
                  extract(epoch from destroy_after - offboarding_started_at)::float8 as due
             from clinics where id = $1`,
          [c.clinicId],
        )
      ).rows[0]!;
    });
    expect(stamps.shortened).toBeGreaterThanOrEqual(1.2);
    expect(stamps.started).toBeGreaterThanOrEqual(1.2);
    expect(stamps.due * 1000).toBe(DESTROY_AFTER_DAYS * DAY);
  });

  test("saving the record clock's current value again starts no new day; a shorter clock does", async () => {
    const c = await seedClinic("clock-resave");
    await seedPerson(c.clinicId, "+15550119001", new Date(Date.now() - 40 * DAY));
    const setClock = (days: number) =>
      asAppCommitted(c.clinicId, (q) =>
        q.query(`update clinics set retention_record_days = $2 where id = $1`, [c.clinicId, days]),
      );
    const moveBack = (hours: number) =>
      getMigratorPool().query(
        `update clinics
            set retention_record_days_shortened_at =
                  retention_record_days_shortened_at - make_interval(hours => $2)
          where id = $1`,
        [c.clinicId, hours],
      );
    const history = async () =>
      (
        await getMigratorPool().query<{ previous: number | null; hours: number }>(
          `select retention_record_days_previous as previous,
                  extract(epoch from now() - retention_record_days_shortened_at)::float8 / 3600
                    as hours
             from clinics where id = $1`,
          [c.clinicId],
        )
      ).rows[0]!;
    const purgeAt = (days: number) =>
      asApp(
        c.clinicId,
        async (q) =>
          (
            await q.query<{ n: number }>(
              `select app_purge_booking_requests(now() - make_interval(days => $1)) as n`,
              [days],
            )
          ).rows[0]!.n,
      );

    // Shortened by the practice from ninety days to thirty, twenty-three hours
    // ago; then the Settings card is saved again with the clock unchanged.
    await setClock(30);
    await moveBack(23);
    await setClock(30);
    const resaved = await history();
    expect(resaved.previous).toBe(90);
    expect(resaved.hours).toBeGreaterThan(22.9);
    // So an hour on, the day is up and the shorter clock reaches the requests.
    await moveBack(1);
    expect(await purgeAt(30)).toBe(3);

    // A shorter clock still starts a day of its own, and a longer one applies
    // at once without moving it.
    await setClock(10);
    expect((await history()).previous).toBe(30);
    expect((await history()).hours).toBeLessThan(1);
    await expect(purgeAt(10)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringMatching(/record clock/),
    });
    await setClock(60);
    expect((await history()).previous).toBe(30);
    await expect(purgeAt(30)).rejects.toMatchObject({ code: "23514" });
    expect(await purgeAt(60)).toBe(0);
  });

  test("the purge keeps a booking request for its own period, and a person while any record of theirs is kept, as clause 11 of BAA 1.3.0 says", async () => {
    // The sentences the purge is held to.
    const clause = getBaaTemplate("1.3.0")!
      .clauses.find((k) => k.id === "minimum-necessary")!
      .body({} as BaaVariables)
      .replace(/\s+/g, " ");
    expect(clause).toContain(
      "It keeps each booking request for 90 days after the latest of when it was made, the time it was confirmed for and its appointment's time.",
    );
    expect(clause).toContain(
      "A person's contact details are kept while any conversation, appointment record or booking request of theirs is kept, and in any case until 90 days after the last time those details were recorded or changed.",
    );

    const c = await seedClinic("purge-clause");
    const old = new Date(Date.now() - 200 * DAY);
    const declined = (client: Client, contactId: string) =>
      client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at,
            decided_at, created_at)
         values ($1, $2, 'voice', 'any evening', 'declined', $3, now() - interval '93 days',
                 now() - interval '99 days', now() - interval '100 days')
         returning id`,
        [c.clinicId, contactId, randomBytes(32)],
      );
    // Asked a hundred days ago and declined, and called again ten days ago.
    const called = await seedContact(c.clinicId, "+15550120001");
    // Asked on WhatsApp yesterday, with nothing else on record for months.
    const asked = await seedContact(c.clinicId, "+15550120002");
    // Asked a hundred days ago and declined, and nothing since.
    const gone = await seedContact(c.clinicId, "+15550120003");
    const fresh = await inTenant(c.clinicId, async (client) => {
      for (const id of [called, asked, gone]) {
        await client.query(`update contacts set updated_at = $2 where id = $1`, [id, old]);
      }
      await declined(client as unknown as Client, called);
      await declined(client as unknown as Client, gone);
      const { rows } = await client.query<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window,
            token_hash, expires_at, created_at)
         values ($1, $2, 'meta', 'whatsapp', 'waba_1', 'wa_asked', 'Saturday', $3,
                 now() + interval '6 days', now() - interval '1 day')
         returning id`,
        [c.clinicId, asked, randomBytes(32)],
      );
      return rows[0]!.id;
    });
    await seedConversation(c.clinicId, {
      startedAt: new Date(Date.now() - 10 * DAY),
      contactId: called,
    });

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      purgeClinic(tx, new Date()),
    );
    expect(result).toMatchObject({
      bookingRequestsDeleted: 2,
      contactsDeleted: 1,
      conversationsDeleted: 0,
    });
    const left = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query<{ id: string }>(`select id from booking_requests`)).rows.map(
        (r) => r.id,
      ),
      contacts: (
        await client.query<{ id: string }>(`select id from contacts order by phone`)
      ).rows.map((r) => r.id),
    }));
    // The declined requests went at the end of their own ninety days, though
    // one person called since; that person stays with their call, the one
    // who asked yesterday stays with the request, and the one with nothing
    // left went with their last record.
    expect(left).toEqual({ requests: [fresh], contacts: [called, asked] });
  });

  test("a data-only restore loads an offboarded clinic, its location and its requests once the insert triggers are off, as docs/handover.md says, and every key comes back", async () => {
    const client = await getMigratorPool().connect();
    const q = <T = Record<string, unknown>>(text: string, values?: unknown[]) =>
      client.query(text, values) as unknown as Promise<{ rows: T[] }>;
    const enabled = async () =>
      (
        await q<{ tgname: string; tgenabled: string }>(
          `select tgname, tgenabled from pg_trigger
            where not tgisinternal
              and tgname in ('clinics_insert_guard', 'clinics_record_clock',
                             'booking_requests_keys_once', 'clinics_main_location',
                             'clinic_locations_guard', 'location_acknowledgements_guard')
            order by tgname`,
        )
      ).rows;
    const refused = (pattern: RegExp) => ({
      code: "42501",
      message: expect.stringMatching(pattern),
    });
    try {
      await q("begin");
      // A clinic that offboarded, with a person and a decided request, as a
      // dump of the database holds them.
      const clinicId = randomUUID();
      await q(
        `insert into organization (id, name, slug, created_at) values ($1, 'Restored', $1, now())`,
        [`org_${clinicId}`],
      );
      await q(
        `insert into clinics (id, organization_id, slug, name, specialty)
         values ($1, $2, $3, 'Restored', 'med-spa')`,
        [clinicId, `org_${clinicId}`, `restored-${clinicId.slice(0, 8)}`],
      );
      await q(
        `update clinics
            set offboarding_started_at = now() - interval '40 days',
                destroy_after = now() - interval '10 days'
          where id = $1`,
        [clinicId],
      );
      await q(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
      const { rows: contact } = await q<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, '+15550121001') returning id`,
        [clinicId],
      );
      const contactId = contact[0]!.id;
      const { rows: request } = await q<{ id: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at,
            decided_at, created_at)
         values ($1, $2, 'voice', 'any evening', 'declined', $3, now() + interval '6 days',
                 now(), now() - interval '1 day')
         returning id`,
        [clinicId, contactId, randomBytes(32)],
      );
      const requestId = request[0]!.id;
      const dump = (
        await q<{
          clinic: unknown;
          location: { id: string; created_at: string; activated_at: string };
          contact: unknown;
          request: unknown;
          key: unknown;
        }>(
          `select (select to_jsonb(c) from clinics c where c.id = $1) as clinic,
                  (select to_jsonb(l) from clinic_locations l where l.clinic_id = $1) as location,
                  (select to_jsonb(p) from contacts p where p.id = $2) as contact,
                  (select to_jsonb(r) from booking_requests r where r.id = $3) as request,
                  (select to_jsonb(k) from booking_request_keys k where k.id = $3) as key`,
          [clinicId, contactId, requestId],
        )
      ).rows[0]!;
      expect(dump.key).not.toBeNull();
      expect(dump.location).not.toBeNull();

      // The empty, migrated database a data-only restore loads into.
      await q(`delete from booking_requests where id = $1`, [requestId]);
      await q(`delete from booking_request_keys where id = $1`, [requestId]);
      await q(`delete from contacts where id = $1`, [contactId]);
      await q(`delete from clinics where id = $1`, [clinicId]);

      const load = (table: string, row: unknown) =>
        q(`insert into ${table} select * from jsonb_populate_record(null::${table}, $1)`, [row]);
      const loadAll = async () => {
        await load("booking_request_keys", dump.key);
        await load("clinics", dump.clinic);
        await load("clinic_locations", dump.location);
        await load("contacts", dump.contact);
        await load("booking_requests", dump.request);
      };

      // With the triggers on, the load fails twice over: the clinic carries
      // its offboarding dates, and the request's key, which sorts first in a
      // dump, is already there.
      await q("savepoint plain");
      await load("booking_request_keys", dump.key);
      await expect(load("clinics", dump.clinic)).rejects.toMatchObject(refused(/new clinic/));
      await q("rollback to savepoint plain");
      await q(`alter table clinics disable trigger clinics_insert_guard`);
      await load("booking_request_keys", dump.key);
      await load("clinics", dump.clinic);
      await load("contacts", dump.contact);
      await expect(load("booking_requests", dump.request)).rejects.toMatchObject(
        refused(/written before/),
      );
      await q("rollback to savepoint plain");
      // And the clinic, loaded with 0108's trigger on, makes a main location
      // of its own, which the dump's then meets (one per account).
      await q(`alter table clinics disable trigger clinics_insert_guard`);
      await load("clinics", dump.clinic);
      await expect(load("clinic_locations", dump.location)).rejects.toMatchObject({ code: "23505" });
      await q("rollback to savepoint plain");

      // The steps the handover gives: each off by name, every table loaded,
      // the keys and the location included, each on again, and the triggers
      // checked.
      const steps = [
        ["clinics", "clinics_insert_guard"],
        ["booking_requests", "booking_requests_keys_once"],
        ["clinics", "clinics_main_location"],
        ["clinic_locations", "clinic_locations_guard"],
        ["location_acknowledgements", "location_acknowledgements_guard"],
      ] as const;
      for (const [table, trigger] of steps) await q(`alter table ${table} disable trigger ${trigger}`);
      await loadAll();
      for (const [table, trigger] of steps) await q(`alter table ${table} enable trigger ${trigger}`);
      expect(await enabled()).toEqual([
        { tgname: "booking_requests_keys_once", tgenabled: "O" },
        { tgname: "clinic_locations_guard", tgenabled: "O" },
        { tgname: "clinics_insert_guard", tgenabled: "O" },
        { tgname: "clinics_main_location", tgenabled: "O" },
        { tgname: "clinics_record_clock", tgenabled: "O" },
        { tgname: "location_acknowledgements_guard", tgenabled: "O" },
      ]);
      // The location came back as it was, its dates included (the guard,
      // left on, would have stamped them with the moment of the load).
      const location = (
        await q<{ id: string; created_at: Date; activated_at: Date; mains: number }>(
          `select l.id, l.created_at, l.activated_at,
                  (select count(*)::int from clinic_locations m where m.clinic_id = $1 and m.position = 1) as mains
             from clinic_locations l where l.clinic_id = $1`,
          [clinicId],
        )
      ).rows;
      expect(location).toHaveLength(1);
      expect(location[0]).toMatchObject({ id: dump.location.id, mains: 1 });
      expect(location[0]!.created_at.getTime()).toBe(new Date(dump.location.created_at).getTime());
      expect(location[0]!.activated_at.getTime()).toBe(
        new Date(dump.location.activated_at).getTime(),
      );
      const restored = (
        await q<{ started: Date | null; status: string; keys: number }>(
          `select (select offboarding_started_at from clinics where id = $1) as started,
                  (select status from booking_requests where id = $2) as status,
                  (select count(*)::int from booking_request_keys where id = $2) as keys`,
          [clinicId, requestId],
        )
      ).rows[0]!;
      expect(restored).toMatchObject({ status: "declined", keys: 1 });
      expect(restored.started).not.toBeNull();

      // And the restored request is still written once: deleted, it cannot
      // come back.
      await q(`delete from booking_requests where id = $1`, [requestId]);
      await expect(load("booking_requests", dump.request)).rejects.toMatchObject(
        refused(/written before/),
      );
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
    // Rolled back, the triggers included.
    const { rows } = await getMigratorPool().query(
      `select 1 from pg_trigger where tgname = 'clinics_insert_guard' and tgenabled = 'O'`,
    );
    expect(rows).toHaveLength(1);
  });
});

// The review's N5, older than the account closure: an audit row whose actor
// is a connector names its provider connection (audit_log.actor_connection_id,
// ON DELETE SET NULL), and audit_log_actor_shape needs that id for a
// connector. Destruction deletes every connection, so a clinic with one such
// row could never be destroyed: the delete would fail and roll the whole
// destruction back. Nothing writes one today. These two hold it there: the
// first fails the moment code builds a connector actor, and the second shows
// why, so whoever lifts the first makes destruction handle the row first.
describe("connector actors in the audit log", () => {
  test("no code builds an audit actor of type connector, which destruction cannot yet survive", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/type:\s*["'`]connector["'`]/.test(line)) {
                hits.push(`${relative(root, path)}:${i + 1}`);
              }
            });
        }
      }
    };
    walk(join(root, "src"));
    walk(join(root, "scripts"));
    // The one allowed: the ActorContext member itself, in lib/audit.ts.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^src\/lib\/audit\.ts:\d+$/);
  });
});

describeDb("a connector actor's audit row against destruction", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("deleting the connection a connector-actor audit row names is refused, so destruction would roll back", async () => {
    const c = await seedClinic("connector-actor");
    await expect(
      inTenant(c.clinicId, async (q) => {
        const { rows } = await q.query<{ id: string }>(
          `insert into provider_connections (clinic_id, provider, ciphertext, iv, auth_tag, wrapped_dek, key_version)
           values ($1, 'mindbody', 'x', 'x', 'x', 'x', 'test') returning id`,
          [c.clinicId],
        );
        await q.query(
          `insert into audit_log (clinic_id, actor_type, actor_label, actor_connection_id, action, resource_type)
           values ($1, 'connector', 'sync', $2, 'read', 'appointment')`,
          [c.clinicId, rows[0]!.id],
        );
        await q.query(`delete from provider_connections where id = $1`, [rows[0]!.id]);
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "audit_log_actor_shape" });
  });
});
