import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { BACKUP_RETENTION_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identifierRef } from "@/lib/identifier-ref";
import { runOperation, type CareView, type Operator } from "@/lib/ops/api";
import { erasePersonFromShell, type ShellEraseOutcome } from "@/lib/ops/patient-entry";
import {
  ERASURE_VENDOR_STEPS,
  expireErasureRecords,
  reapplyErasures,
} from "@/lib/patient-rights/erasure";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { asApp as committedAsApp, insertHold } from "./setup/calendar-db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * Deletion on request (BAA 1.3.0 release gate 6; SL-06, PT-18).
 *
 * Clause 4(c) promises that a person's information is deleted from
 * healdesk's own records within ten business days, "including the raw copies
 * it keeps of what other services sent it about that person", that each
 * subcontractor deletes its copy, and that healdesk keeps "only a record of
 * the request, for no longer than it needs one to make sure the information
 * stays deleted". Until this gate nothing an operator could reach deleted
 * anyone, the raw call payloads, the Meta requests a person sent naming
 * another number and their messaging threads survived the deletion that
 * existed, and the deletion wrote the person's number into suppressions for
 * good. These tests hold the operator's erase path, through the ops
 * envelope's own dispatcher, to the clause.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "127.0.0.1" } };

/** The operator's deletion, as ops:erase-person runs it in apps/app's shell. */
function erase(
  args: Omit<Parameters<typeof erasePersonFromShell>[0], "operator">,
): Promise<ShellEraseOutcome> {
  return erasePersonFromShell({ ...args, operator: { label: "ops@healdesk.test" } });
}

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (outcome.status !== 200)
    throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { data: T }).data;
}

type Client = Parameters<Parameters<typeof inTenant>[1]>[0];

/** One booking request, written as the migrator inside the tenant. */
async function request(
  client: Client,
  clinicId: string,
  contactId: string,
  thread: { platform: "whatsapp" | "instagram" | "messenger"; senderId: string } | null,
  at: Date,
): Promise<string> {
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
}

async function draft(
  client: Client,
  clinicId: string,
  platform: string,
  senderId: string,
  phone: string | null,
  at: Date,
): Promise<void> {
  await client.query(
    `insert into meta_booking_drafts (clinic_id, platform, sender_id, external_id, first_name, phone, updated_at)
     values ($1, $2, $3, 'page_1', 'Sam', $4, $5)`,
    [clinicId, platform, senderId, phone, at],
  );
}

async function thread(
  client: Client,
  clinicId: string,
  channel: string,
  senderId: string,
  at: Date,
): Promise<void> {
  await client.query(
    `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
     values ($1, $2, $3, $4, $5, $5)`,
    [
      clinicId,
      channel,
      identifierRef("chat_party", clinicId, `${channel}:${senderId}`),
      randomUUID(),
      at,
    ],
  );
}

async function payload(
  client: Client,
  clinicId: string,
  provider: string,
  deliveryId: string,
  body: unknown,
  at: Date,
  processed: boolean,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into webhook_events (clinic_id, provider, delivery_id, signature_valid, raw_payload, processed_at, received_at)
     values ($1, $2, $3, true, $4, $5, $6) returning id`,
    [clinicId, provider, deliveryId, JSON.stringify(body), processed ? at : null, at],
  );
  return rows[0]!.id;
}

/** A payload stored as the vendor sent it, byte for byte: escaped JSON, or not JSON at all. */
async function rawPayload(client: Client, clinicId: string, deliveryId: string, body: string, at: Date): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into webhook_events (clinic_id, provider, delivery_id, signature_valid, raw_payload, processed_at, received_at)
     values ($1, 'mindbody', $2, true, $3, $4, $4) returning id`,
    [clinicId, deliveryId, body, at],
  );
  return rows[0]!.id;
}

async function evidence(client: Client, clinicId: string, phone: string, at: Date): Promise<void> {
  await client.query(
    `insert into suppressions (clinic_id, phone, channel, reason, requested_at) values ($1, $2, null, 'stop_reply', $3)`,
    [clinicId, phone, at],
  );
  await client.query(
    `insert into consent_records (clinic_id, phone, channel, consent_type, source, exact_wording, granted_at)
     values ($1, $2, 'voice', 'express', 'inbound_call', 'Yes, you can call me back.', $3)`,
    [clinicId, phone, at],
  );
  await client.query(
    `insert into contact_attempts (clinic_id, phone, channel, purpose, attempted_at)
     values ($1, $2, 'voice', 'transactional', $3)`,
    [clinicId, phone, at],
  );
}

type Seeded = {
  contactId: string;
  spouseContactId: string;
  /** Every request naming the person. */
  requests: string[];
  /** The spouse's request, sent from the household thread. */
  spouseRequest: string;
  household: string;
  payloads: string[];
};

/**
 * A person with a record in every table the erase path reaches: a booked
 * call (its contact, conversation and appointment), their own requests on a
 * call, on WhatsApp and on Instagram, a draft carrying their number on
 * Messenger and one on their Instagram thread carrying none, their three
 * messaging threads, a payload another service sent that was never processed
 * (the number written as a person would), another payload naming them, and
 * a stop, a consent and a contact attempt. And a household Instagram
 * account, with its own thread, that booked once for them and once for their
 * spouse: a thread that is not theirs alone.
 */
async function seedEverywhere(clinicId: string, digits: string, at: Date): Promise<Seeded> {
  const phone = `+1${digits}`;
  const contactId = await seedContact(clinicId, phone);
  const spouseContactId = await seedContact(clinicId, `+1${digits.slice(0, 9)}9`);
  const booked = await seedConversation(clinicId, { startedAt: at, booked: true, contactId });
  return inTenant(clinicId, async (client) => {
    await client.query(`update contacts set email = $2, created_at = $3 where id = $1`, [
      contactId,
      `p${digits}@example-patient.test`,
      at,
    ]);
    await client.query(`update conversations set external_call_id = $2 where id = $1`, [
      booked.conversationId,
      `call_${digits}`,
    ]);
    const requests = [
      await request(client, clinicId, contactId, null, at),
      await request(
        client,
        clinicId,
        contactId,
        { platform: "whatsapp", senderId: `1${digits}` },
        at,
      ),
      await request(
        client,
        clinicId,
        contactId,
        { platform: "instagram", senderId: `ig_${digits}` },
        at,
      ),
      // From the household's Instagram, for them.
      await request(
        client,
        clinicId,
        contactId,
        { platform: "instagram", senderId: `ig_household_${digits.slice(-4)}` },
        at,
      ),
    ];
    // From the household's Instagram, for their spouse: the spouse's record.
    const spouseRequest = await request(
      client,
      clinicId,
      spouseContactId,
      { platform: "instagram", senderId: `ig_household_${digits.slice(-4)}` },
      at,
    );
    await draft(client, clinicId, "messenger", `psid_${digits}`, phone, at);
    await draft(client, clinicId, "instagram", `ig_${digits}`, phone, at);
    await thread(client, clinicId, "whatsapp", `1${digits}`, at);
    await thread(client, clinicId, "instagram", `ig_${digits}`, at);
    await thread(client, clinicId, "messenger", `psid_${digits}`, at);
    await thread(client, clinicId, "instagram", `ig_household_${digits.slice(-4)}`, at);
    const payloads = [
      await payload(
        client,
        clinicId,
        "mindbody",
        `evt_${digits}_failed`,
        { client: { mobile: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` } },
        at,
        false,
      ),
      await payload(
        client,
        clinicId,
        "mindbody",
        `evt_${digits}`,
        { client: { mobile: phone } },
        at,
        true,
      ),
    ];
    await evidence(client, clinicId, phone, at);
    return {
      contactId,
      spouseContactId,
      requests,
      spouseRequest,
      household: `instagram:ig_household_${digits.slice(-4)}`,
      payloads,
    };
  });
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

/**
 * Move a deletion's record `ms` into the past, as the owner with the guard
 * off for the length of one transaction: the record's clock is the
 * database's, so a test cannot hand the expiry a later "now" and has to age
 * the record instead.
 */
async function backdateErasure(clinicId: string, erasureId: string, ms: number): Promise<void> {
  const owner = await getMigratorPool().connect();
  try {
    await owner.query("begin");
    await owner.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    await owner.query(`alter table erasure_requests disable trigger erasure_requests_guard`);
    await owner.query(
      `update erasure_requests
          set erased_at = erased_at - make_interval(secs => $2),
              received_at = received_at - make_interval(secs => $2),
              due_by = due_by - make_interval(secs => $2)
        where id = $1`,
      [erasureId, ms / 1000],
    );
    await owner.query(`alter table erasure_requests enable trigger erasure_requests_guard`);
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback").catch(() => {});
    throw error;
  } finally {
    owner.release();
  }
}

/** Rows in each table the erase path reaches, as the owner inside the tenant. */
async function tableCounts(clinicId: string): Promise<Record<string, number>> {
  return inTenant(clinicId, async (client) => {
    const out: Record<string, number> = {};
    for (const table of [
      "contacts",
      "conversations",
      "appointments",
      "booking_requests",
      "meta_booking_drafts",
      "chat_threads",
      "webhook_events",
      "suppressions",
      "consent_records",
      "contact_attempts",
    ]) {
      out[table] = (
        await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)
      ).rows[0]!.n;
    }
    return out;
  });
}

/** Every row of every table with a clinic_id, and every security event, that carries the digits anywhere. */
async function whereTheNumberIs(clinicId: string, digits: string): Promise<string[]> {
  const { rows: tables } = await getMigratorPool().query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'clinic_id' and not a.attisdropped)`,
  );
  const found: string[] = [];
  await inTenant(clinicId, async (client) => {
    for (const { relname } of tables) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from ${relname} t where t.clinic_id = $1 and t::text like $2`,
        [clinicId, `%${digits}%`],
      );
      if (rows[0]!.n > 0) found.push(relname);
    }
  });
  const { rows } = await getMigratorPool().query<{ n: number }>(
    `select count(*)::int as n from security_events where coalesce(metadata::text, '') like $1`,
    [`%${digits}%`],
  );
  if (rows[0]!.n > 0) found.push("security_events");
  return found;
}

describeDb("deletion on request", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the operator erase removes the person from every table it reaches, leaves another person and another clinic alone, and leaves their number nowhere", async () => {
    const c = await seedClinic("erase-everywhere");
    const elsewhere = await seedClinic("erase-everywhere-other");
    const at = new Date(Date.now() - 5 * DAY);
    const target = await seedEverywhere(c.clinicId, "5550130001", at);
    await seedEverywhere(c.clinicId, "5550130002", at);
    await seedEverywhere(elsewhere.clinicId, "5550130001", at);
    const before = await tableCounts(c.clinicId);
    const otherBefore = await tableCounts(elsewhere.clinicId);

    const outcome = await erase({
          clinicId: c.clinicId,
          // As an operator types it; the API matches it in E.164.
          phone: "(555) 013-0001",
          email: "P5550130001@Example-Patient.test",
          requestedBy: "practice",
          receivedAt: "2026-10-05T09:00:00Z",
        });
    expect(outcome.status).toBe("erased");
    if (outcome.status !== "erased") return;
    expect(outcome.deleted).toMatchObject({
      contacts: 1,
      bookingRequests: 4,
      appointments: 1,
      conversations: 1,
      drafts: 2,
      chatThreads: 3,
      webhookEvents: 2,
      suppressions: 1,
      consentRecords: 1,
      contactAttempts: 1,
    });
    // The household thread booked for the spouse too: it stays, with what it
    // sent for them, and the reply says so by count.
    expect(outcome.kept).toEqual({ sharedThreads: 1, requests: 1, drafts: 0, unthreaded: 0 });
    // Ten business days from a Monday morning: two weeks on, at the same hour.
    expect(outcome.dueBy).toBe("2026-10-19T09:00:00.000Z");

    // Exactly the person's rows went: the neighbour's, and the spouse's
    // request and the household thread that sent it, stay; so does all of
    // the other clinic.
    const after = await tableCounts(c.clinicId);
    expect(after).toEqual({
      contacts: before.contacts! - 1,
      conversations: before.conversations! - 1,
      appointments: before.appointments! - 1,
      booking_requests: before.booking_requests! - 4,
      meta_booking_drafts: before.meta_booking_drafts! - 2,
      chat_threads: before.chat_threads! - 3,
      webhook_events: before.webhook_events! - 2,
      suppressions: before.suppressions! - 1,
      consent_records: before.consent_records! - 1,
      contact_attempts: before.contact_attempts! - 1,
    });
    await inTenant(c.clinicId, async (client) => {
      const spouse = await client.query(`select 1 from contacts where id = $1`, [
        target.spouseContactId,
      ]);
      expect(spouse.rows).toHaveLength(1);
      const left = await client.query<{ id: string }>(
        `select id from booking_requests where id = any($1::uuid[])`,
        [target.requests],
      );
      expect(left.rows).toEqual([]);
      const spouseRequest = await client.query(`select 1 from booking_requests where id = $1`, [
        target.spouseRequest,
      ]);
      expect(spouseRequest.rows).toHaveLength(1);
      const household = await client.query(`select 1 from chat_threads where party_ref = $1`, [
        identifierRef("chat_party", c.clinicId, target.household),
      ]);
      expect(household.rows).toHaveLength(1);
    });
    expect(await tableCounts(elsewhere.clinicId)).toEqual(otherBefore);

    // No copy of the number anywhere at the clinic, in any form a table holds
    // it, the record of the request and the audit trail included.
    expect(await whereTheNumberIs(c.clinicId, "5550130001")).toEqual([]);
    expect(await whereTheNumberIs(c.clinicId, "p5550130001@example-patient.test")).toEqual([]);
    expect(await whereTheNumberIs(elsewhere.clinicId, "5550130001")).not.toEqual([]);

    // The record: who asked, the dates, the counts, and keyed references only.
    const record = await inTenant(
      c.clinicId,
      async (client) =>
        (
          await client.query<{
            requested_by: string;
            received_at: Date;
            erased_at: Date;
            restore_refs: string[];
            deleted: Record<string, number>;
          }>(
            `select requested_by, received_at, erased_at, restore_refs, deleted from erasure_requests`,
          )
        ).rows,
    );
    expect(record).toHaveLength(1);
    expect(record[0]!.requested_by).toBe("practice");
    expect(record[0]!.received_at.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(record[0]!.deleted.webhookEvents).toBe(2);
    expect(record[0]!.restore_refs.length).toBeGreaterThan(0);
    for (const ref of record[0]!.restore_refs) expect(ref).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(record[0]!.restore_refs).toContain(
      identifierRef("erasure", c.clinicId, "phone:+15550130001"),
    );
    // Their own thread, which sent only for them, is in the record; the
    // household's, which is not theirs alone, is not.
    expect(record[0]!.restore_refs).toContain(
      identifierRef("chat_party", c.clinicId, "instagram:ig_5550130001"),
    );
    expect(record[0]!.restore_refs).not.toContain(
      identifierRef("chat_party", c.clinicId, target.household),
    );
  });

  test("erasing a child a parent booked for leaves the parent's own requests, the sibling's and the parent's thread, now and after a restore", async () => {
    const c = await seedClinic("erase-household");
    const at = new Date(Date.now() - 2 * DAY);
    const child = await seedContact(c.clinicId, "+15550135001");
    const parent = await seedContact(c.clinicId, "+15550135002");
    const sibling = await seedContact(c.clinicId, "+15550135003");
    const mom = { platform: "instagram", senderId: "ig_parent" } as const;
    const ids = await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      const forChild = await request(client, c.clinicId, child, mom, at);
      const forParent = await request(client, c.clinicId, parent, mom, at);
      const forSibling = await request(client, c.clinicId, sibling, mom, at);
      await thread(client, c.clinicId, "instagram", "ig_parent", at);
      // The parent's half-collected request, for themselves.
      await draft(client, c.clinicId, "instagram", "ig_parent", "+15550135002", at);
      return { forChild, forParent, forSibling };
    });
    const parentThread = identifierRef("chat_party", c.clinicId, "instagram:ig_parent");

    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550135001", requestedBy: "person_via_practice" });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted).toMatchObject({
      contacts: 1,
      bookingRequests: 1,
      chatThreads: 0,
      drafts: 0,
    });
    expect(outcome.kept).toEqual({ sharedThreads: 1, requests: 2, drafts: 1, unthreaded: 0 });

    const left = async () =>
      inTenant(c.clinicId, async (client) => ({
        requests: (
          await client.query<{ id: string }>(`select id from booking_requests order by id`)
        ).rows.map((r) => r.id),
        threads: (await client.query(`select 1 from chat_threads where party_ref = $1`, [parentThread]))
          .rows.length,
        drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
        contacts: (
          await client.query<{ id: string }>(`select id from contacts order by id`)
        ).rows.map((r) => r.id),
        refsHoldParent: (
          await client.query<{ n: number }>(
            `select count(*)::int as n from erasure_requests where $1 = any(restore_refs)`,
            [parentThread],
          )
        ).rows[0]!.n,
      }));
    const expected = {
      requests: [ids.forParent, ids.forSibling].sort(),
      threads: 1,
      drafts: 1,
      contacts: [parent, sibling].sort(),
      refsHoldParent: 0,
    };
    expect(await left()).toEqual(expected);

    // A restore brings the child back, with the request the parent made for
    // them; applying the deletion again takes the child and that request,
    // and still nothing of the parent's or the sibling's.
    await inTenant(c.clinicId, async (client) => {
      await client.query(
        `insert into contacts (id, clinic_id, phone, created_at, updated_at) values ($1, $2, '+15550135001', $3, $3)`,
        [child, c.clinicId, at],
      );
      await request(client, c.clinicId, child, mom, at);
    });
    expect((await reapplyErasures()).failures).toBe(0);
    expect(await left()).toEqual(expected);
  });

  test("the person's deposits go with their appointments, with the Connect event that last touched each; another's stay", async () => {
    // The calendar session's re-audit (C19, 12 October 2026): no erase path
    // touched deposit_payments, the appointment's foreign key set the link to
    // NULL, and the amount, the payment time and the Checkout session, which
    // leads to the payer in the practice's Stripe, stayed.
    const c = await seedClinic("erase-deposits");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550136101");
    const other = await seedContact(c.clinicId, "+15550136109");
    const theirs = await seedConversation(c.clinicId, { startedAt: at, booked: true, contactId: person });
    const others = await seedConversation(c.clinicId, { startedAt: at, booked: true, contactId: other });
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      await client.query(
        `insert into deposit_payments
           (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, checkout_session_id,
            last_event_id, paid_at)
         values ($1, $2, 'web', 5000, 'acct_erase', 'paid', 'cs_erase_theirs', 'evt_erase_theirs_paid', $4),
                ($1, $3, 'web', 7000, 'acct_erase', 'paid', 'cs_erase_others', 'evt_erase_others_paid', $4)`,
        [c.clinicId, theirs.appointmentId, others.appointmentId, at],
      );
    });
    // The event that paid theirs, an earlier one for the same session (no
    // column links it to a deposit: it stays until destruction), and the
    // other person's.
    await getMigratorPool().query(
      `insert into stripe_connect_events (stripe_event_id, type, account, resolved_clinic_id)
       values ('evt_erase_theirs_paid', 'checkout.session.completed', 'acct_erase', $1),
              ('evt_erase_theirs_opened', 'checkout.session.async_payment_succeeded', 'acct_erase', $1),
              ('evt_erase_others_paid', 'checkout.session.completed', 'acct_erase', $1)`,
      [c.clinicId],
    );

    const outcome = await erase({ clinicId: c.clinicId, contactId: person, requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.deposits).toBe(1);
    expect(outcome.deleted.appointments).toBe(1);

    const deposits = await inTenant(c.clinicId, async (client) =>
      (
        await client.query<{ session: string }>(
          `select checkout_session_id as session from deposit_payments order by 1`,
        )
      ).rows.map((r) => r.session),
    );
    expect(deposits).toEqual(["cs_erase_others"]);
    const events = (
      await getMigratorPool().query<{ id: string }>(
        `select stripe_event_id as id from stripe_connect_events where stripe_event_id like 'evt_erase_%' order by 1`,
      )
    ).rows.map((r) => r.id);
    expect(events).toEqual(["evt_erase_others_paid", "evt_erase_theirs_opened"]);

    // The count is in the security event as well as the reply.
    const event = await getMigratorPool().query<{ deposits: number }>(
      `select (metadata->>'deposits')::int as deposits from security_events
        where event = 'person_erased' and metadata->>'erasureId' = $1`,
      [outcome.erasureId],
    );
    expect(event.rows).toEqual([{ deposits: 1 }]);
  });

  test("a Connect event not resolved to this clinic stays, even when one of the person's deposits names it", async () => {
    // Third review of 0067: last_event_id is the runtime role's to write, and
    // the erasure took any event a deposit named that was resolved to this
    // clinic or to none, so a deposit could be pointed at an event never
    // resolved and take it. Only an event resolved to this clinic goes now.
    const c = await seedClinic("erase-deposit-events");
    const elsewhere = await seedClinic("erase-deposit-events-other");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550136401");
    const first = await seedConversation(c.clinicId, { startedAt: at, booked: true, contactId: person });
    const second = await seedConversation(c.clinicId, { startedAt: at, booked: true, contactId: person });
    const third = await seedConversation(c.clinicId, { startedAt: at, booked: true, contactId: person });
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      await client.query(
        `insert into deposit_payments
           (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, last_event_id)
         values ($1, $2, 'web', 5000, 'acct_events', 'paid', 'evt_events_ours'),
                ($1, $3, 'web', 5000, 'acct_events', 'paid', 'evt_events_unresolved'),
                ($1, $4, 'web', 5000, 'acct_events', 'paid', 'evt_events_elsewhere')`,
        [c.clinicId, first.appointmentId, second.appointmentId, third.appointmentId],
      );
    });
    await getMigratorPool().query(
      `insert into stripe_connect_events (stripe_event_id, type, account, resolved_clinic_id)
       values ('evt_events_ours', 'checkout.session.completed', 'acct_events', $1),
              ('evt_events_unresolved', 'checkout.session.completed', 'acct_other', null),
              ('evt_events_elsewhere', 'checkout.session.completed', 'acct_other', $2)`,
      [c.clinicId, elsewhere.clinicId],
    );

    const outcome = await erase({ clinicId: c.clinicId, contactId: person, requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.deposits).toBe(3);
    const events = (
      await getMigratorPool().query<{ id: string }>(
        `select stripe_event_id as id from stripe_connect_events where stripe_event_id like 'evt_events_%' order by 1`,
      )
    ).rows.map((r) => r.id);
    expect(events).toEqual(["evt_events_elsewhere", "evt_events_unresolved"]);
  });

  test("a WhatsApp thread on the person's own number keeps what it sent for others, without the number, and loses its draft and its row", async () => {
    // The calendar session's re-audit (C19): a household thread that also
    // booked for someone else kept its requests and draft for them, each
    // carrying the thread's sender id, and on WhatsApp that is the erased
    // person's own number. The household thread in the other tests is
    // Instagram, whose sender id is the platform's, which is why they missed it.
    const c = await seedClinic("erase-whatsapp-household");
    const at = new Date(Date.now() - 2 * DAY);
    const parent = await seedContact(c.clinicId, "+15550136201");
    const child = await seedContact(c.clinicId, "+15550136202");
    const parentWhatsApp = { platform: "whatsapp", senderId: "15550136201" } as const;
    const ids = await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      const forParent = await request(client, c.clinicId, parent, parentWhatsApp, at);
      const forChild = await request(client, c.clinicId, child, parentWhatsApp, at);
      await thread(client, c.clinicId, "whatsapp", "15550136201", at);
      // Half-way through booking a sibling: a first name, no number yet.
      await draft(client, c.clinicId, "whatsapp", "15550136201", null, at);
      return { forParent, forChild };
    });

    const outcome = await erase({ clinicId: c.clinicId, contactId: parent, requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.kept).toEqual({ sharedThreads: 1, requests: 1, drafts: 0, unthreaded: 1 });
    expect(outcome.deleted).toMatchObject({ bookingRequests: 1, chatThreads: 1, drafts: 1 });

    const left = await inTenant(c.clinicId, async (client) => ({
      requests: (
        await client.query<{ id: string; platform: string; sender: string | null; external: string | null; contact: string; window: string }>(
          `select id, platform, sender_id as sender, external_id as external, contact_id as contact,
                  preferred_window as window
             from booking_requests order by id`,
        )
      ).rows,
      drafts: (await client.query(`select 1 from meta_booking_drafts`)).rows.length,
      threads: (await client.query(`select 1 from chat_threads`)).rows.length,
    }));
    // The child's request stays whole, but for the thread.
    expect(left.requests).toEqual([
      {
        id: ids.forChild,
        platform: "whatsapp",
        sender: null,
        external: null,
        contact: child,
        window: "Saturday morning",
      },
    ]);
    expect(left.drafts).toBe(0);
    expect(left.threads).toBe(0);
    // Nothing anywhere still carries the parent's number as a thread.
    const carrying = await inTenant(c.clinicId, async (client) =>
      (
        await client.query<{ n: number }>(
          `select (select count(*) from booking_requests where sender_id = '15550136201')::int
                + (select count(*) from meta_booking_drafts where sender_id = '15550136201')::int as n`,
        )
      ).rows[0]!.n,
    );
    expect(carrying).toBe(0);
    // The database did it, and said so.
    const audit = await inTenant(c.clinicId, async (client) =>
      (
        await client.query<{ n: number }>(
          `select result_count as n from audit_log
            where resource_type = 'booking_request_unthreaded' and resource_id = $1`,
          [outcome.erasureId],
        )
      ).rows,
    );
    expect(audit).toEqual([{ n: 1 }]);
    // And the runtime role cannot do it itself.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`update booking_requests set sender_id = null, external_id = null where id = $1`, [ids.forChild]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // It can insert a Meta request without a thread, as 0067's comment says:
    // the constraint takes both columns empty, and no grant forbids it. Never
    // one of the two alone.
    const inserted = await asApp(c.clinicId, (q) =>
      q.query(
        `insert into booking_requests (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window, token_hash, expires_at)
         values ($1, $2, 'meta', 'whatsapp', null, null, 'Monday', $3, now() + interval '7 days')
         returning id`,
        [c.clinicId, child, randomBytes(32)],
      ),
    );
    expect(inserted.rows).toHaveLength(1);
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(
          `insert into booking_requests (clinic_id, contact_id, channel, platform, external_id, sender_id, preferred_window, token_hash, expires_at)
           values ($1, $2, 'meta', 'whatsapp', 'page_1', null, 'Monday', $3, now() + interval '7 days')`,
          [c.clinicId, child, randomBytes(32)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_channel_shape" });
  });

  test("a call with no caller ID goes with the payload that named the person: its conversation and amendments, but not another's", async () => {
    // The calendar session's re-audit (C19): the payload naming the person
    // was deleted, but its conversation, with what was asked about and the
    // transcript's address, stayed until the record clock took it.
    const c = await seedClinic("erase-no-caller-id");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550136301");
    const someone = await seedContact(c.clinicId, "+15550136309");
    const ids = await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      const call = async (callId: string, contactId: string | null) =>
        (
          await client.query<{ id: string }>(
            `insert into conversations (clinic_id, channel, outcome, started_at, contact_id, external_call_id,
                                        treatment_interest, transcript_uri)
             values ($1, 'voice', 'qualified_no_booking', $2, $3, $4, 'Lip filler', 'https://vendor.test/t/' || $4)
             returning id`,
            [c.clinicId, at, contactId, callId],
          )
        ).rows[0]!.id;
      const unmatched = await call("call_nocid_theirs", null);
      const otherUnmatched = await call("call_nocid_other", null);
      // A call on someone's contact whose payload happened to name the person:
      // that someone's record, and it stays.
      const onSomeone = await call("call_nocid_someone", someone);
      await client.query(
        `insert into record_amendments (clinic_id, target_kind, conversation_id, amendment, requested_by, requested_at, recorded_by)
         values ($1, 'conversation', $2, 'The caller meant the Tuesday clinic.', 'practice', $3, 'ops@healdesk.test')`,
        [c.clinicId, unmatched, at],
      );
      const say = (callId: string, words: string) => ({ call_id: callId, start_time: at.toISOString(), transcript: words });
      await payload(client, c.clinicId, "retell", "call_nocid_theirs", say("call_nocid_theirs", "My number is 555 013 6301."), at, true);
      await payload(client, c.clinicId, "retell", "call_nocid_other", say("call_nocid_other", "Just asking about prices."), at, true);
      await payload(client, c.clinicId, "retell", "call_nocid_someone", say("call_nocid_someone", "Book my friend on 555-013-6301 too."), at, true);
      return { unmatched, otherUnmatched, onSomeone };
    });

    const outcome = await erase({ clinicId: c.clinicId, contactId: person, requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.webhookEvents).toBe(2);
    expect(outcome.deleted.conversations).toBe(1);
    expect(outcome.deleted.amendments).toBe(1);
    const left = await inTenant(c.clinicId, async (client) =>
      (await client.query<{ id: string }>(`select id from conversations order by id`)).rows.map((r) => r.id),
    );
    expect(left).toEqual([ids.otherUnmatched, ids.onSomeone].sort());
    // The database said so, with the request's id and the counts only.
    const audit = await inTenant(c.clinicId, async (client) =>
      (
        await client.query<{ n: number; metadata: Record<string, unknown> }>(
          `select result_count as n, metadata from audit_log
            where resource_type = 'person_erasure_unmatched_calls' and resource_id = $1`,
          [outcome.erasureId],
        )
      ).rows,
    );
    expect(audit).toEqual([
      { n: 2, metadata: { erasureId: outcome.erasureId, conversations: 1, amendments: 1 } },
    ]);
  });

  test("the person's slot holds go before their contacts do, live ones let go, and are counted", async () => {
    // A hold is found by its link to the person's contact; deleting the
    // contact first would null the link and leave the hold, a time tied to
    // nobody, past the deletion. So the erase path clears holds first
    // (clearHoldsForErasure, lib/booking/holds.ts).
    const c = await seedClinic("erase-holds");
    const person = await seedContact(c.clinicId, "+15550136301");
    const neighbour = await seedContact(c.clinicId, "+15550136302");
    const later = (days: number) => new Date(Date.now() + days * DAY);
    const holds = await committedAsApp(c.clinicId, async (client) => ({
      live: await insertHold(client, c.clinicId, { holder: "voice:call_p1", startsAt: later(3), contactId: person }),
      theirs: await insertHold(client, c.clinicId, { holder: "voice:call_n1", startsAt: later(4), contactId: neighbour }),
    }));
    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550136301", requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted.holds).toBe(1);
    const left = await inTenant(c.clinicId, (client) => client.query<{ id: string }>(`select id from slot_holds`));
    expect(left.rows.map((r) => r.id)).toEqual([holds.theirs]);
    expect(holds.live).toBeTruthy();
  });

  test("a thread holding a draft that names no one yet is not the person's alone, and stays", async () => {
    // The verifier's case: the parent's thread booked once, for the child P,
    // and the parent has since started a booking for a sibling, first name
    // given, no number yet. Erasing P took the parent's thread and draft.
    const c = await seedClinic("erase-numberless-draft");
    const at = new Date(Date.now() - 2 * DAY);
    const child = await seedContact(c.clinicId, "+15550136101");
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      await request(client, c.clinicId, child, { platform: "instagram", senderId: "ig_mom_1361" }, at);
      await thread(client, c.clinicId, "instagram", "ig_mom_1361", at);
      await client.query(
        `insert into meta_booking_drafts (clinic_id, platform, sender_id, external_id, first_name, phone, preferred_window, updated_at)
         values ($1, 'instagram', 'ig_mom_1361', 'page_1', 'Sibling', null, 'Friday 3pm', now() - interval '1 minute')`,
        [c.clinicId],
      );
    });
    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550136101", requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted).toMatchObject({ bookingRequests: 1, chatThreads: 0, drafts: 0 });
    expect(outcome.kept).toEqual({ sharedThreads: 1, requests: 0, drafts: 1, unthreaded: 0 });
    const momThread = identifierRef("chat_party", c.clinicId, "instagram:ig_mom_1361");
    await inTenant(c.clinicId, async (client) => {
      expect((await client.query(`select 1 from meta_booking_drafts where sender_id = 'ig_mom_1361'`)).rows).toHaveLength(1);
      expect((await client.query(`select 1 from chat_threads where party_ref = $1`, [momThread])).rows).toHaveLength(1);
      const refs = (
        await client.query<{ n: number }>(`select count(*)::int as n from erasure_requests where $1 = any(restore_refs)`, [
          momThread,
        ])
      ).rows[0]!.n;
      expect(refs).toBe(0);
    });
  });

  test("a thread that sent only for the person is theirs: it goes with what it sent, and its reference is kept for a restore", async () => {
    const c = await seedClinic("erase-own-thread");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550136001");
    const ids = await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      const own = { platform: "instagram", senderId: "ig_own_136" } as const;
      const first = await request(client, c.clinicId, person, own, at);
      const second = await request(client, c.clinicId, person, own, at);
      await thread(client, c.clinicId, "instagram", "ig_own_136", at);
      await draft(client, c.clinicId, "instagram", "ig_own_136", "+15550136001", at);
      return [first, second];
    });
    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550136001", requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted).toMatchObject({ bookingRequests: 2, chatThreads: 1, drafts: 1 });
    expect(outcome.kept).toEqual({ sharedThreads: 0, requests: 0, drafts: 0, unthreaded: 0 });
    await inTenant(c.clinicId, async (client) => {
      expect(
        (await client.query(`select 1 from booking_requests where id = any($1::uuid[])`, [ids])).rows,
      ).toEqual([]);
      const refs = (
        await client.query<{ restore_refs: string[] }>(`select restore_refs from erasure_requests`)
      ).rows[0]!.restore_refs;
      expect(refs).toContain(identifierRef("chat_party", c.clinicId, "instagram:ig_own_136"));
    });
  });

  test("the reply and the record name no one, and who asked is chosen from three, never typed", async () => {
    const c = await seedClinic("erase-reply");
    await seedEverywhere(c.clinicId, "5550131001", new Date(Date.now() - DAY));
    // Anything typed is refused: a number, and a name, which the first
    // version's screen let through into the record and the audit row.
    for (const requestedBy of ["Sam on +1 555 013 1001", "Sam Rhys, by phone", "the practice, ticket 1182"]) {
      const refused = await erase({ clinicId: c.clinicId, phone: "+15550131001", requestedBy });
      expect(refused.status, requestedBy).toBe("error");
    }
    expect(await tableCounts(c.clinicId)).toMatchObject({ contacts: 2 });
    // And the database refuses it too, whoever writes the row.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(
          `insert into erasure_requests (clinic_id, requested_by, received_at, due_by)
           values ($1, 'Sam Rhys', now(), now() + interval '14 days')`,
          [c.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "erasure_requests_requested_by_check" });

    const nothing = await erase({ clinicId: c.clinicId, requestedBy: "practice" });
    expect(nothing.status).toBe("error");

    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550131001", requestedBy: "practice" });
    expect(JSON.stringify(outcome)).not.toMatch(/5550131001|example-patient/);
    const view = data<CareView>(
      await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR),
    );
    expect(view.deletionRequests).toHaveLength(1);
    expect(view.deletionRequests[0]!.requestedBy).toBe("The practice");
    expect(JSON.stringify(view.deletionRequests)).not.toMatch(/5550131001|example-patient|v1:/);
  });

  test("each subcontractor step shows outstanding with the deadline until it is stamped, once", async () => {
    const c = await seedClinic("erase-vendor");
    await seedEverywhere(c.clinicId, "5550132001", new Date(Date.now() - DAY));
    const erased = await erase({ clinicId: c.clinicId, phone: "+15550132001", requestedBy: "practice" });
    if (erased.status !== "erased") throw new Error("not erased");

    let view = data<CareView>(
      await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR),
    );
    const listed = view.deletionRequests[0]!;
    expect(listed.id).toBe(erased.erasureId);
    expect(listed.dueBy).toBe(erased.dueBy);
    expect(listed.steps.map((s) => s.id)).toEqual(ERASURE_VENDOR_STEPS.map((s) => s.id));
    expect(listed.steps[0]).toMatchObject({ id: "retell", stampedAt: null, stampedBy: null });
    expect(listed.restoreRecordUntil).toBe(
      new Date(new Date(listed.erasedAt).getTime() + BACKUP_RETENTION_DAYS * DAY).toISOString(),
    );

    // How it went is chosen, never typed: a typed line could name the person.
    const typed = data<{ status: string }>(
      await runOperation(
        "markErasureVendorDeleted",
        {
          clinicId: c.clinicId,
          erasureId: erased.erasureId,
          step: "retell",
          how: "Deleted Sam's two calls in Retell's console",
        },
        OPERATOR,
      ),
    );
    expect(typed.status).toBe("error");
    const stamped = data<{ status: string }>(
      await runOperation(
        "markErasureVendorDeleted",
        { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "deleted" },
        OPERATOR,
      ),
    );
    expect(stamped.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.deletionRequests[0]!.steps[0]).toMatchObject({
      id: "retell",
      stampedBy: "ops@healdesk.test",
      how: "Deleted in the vendor's console",
    });
    expect(view.deletionRequests[0]!.steps[0]!.stampedAt).not.toBeNull();

    const twice = data<{ status: string; message?: string }>(
      await runOperation(
        "markErasureVendorDeleted",
        { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "nothing_held" },
        OPERATOR,
      ),
    );
    expect(twice.status).toBe("error");

    // A stamp stays stamped, for the runtime role and the owner alike.
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(
        app.query(`update erasure_requests set vendor_steps = '{}'::jsonb`),
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.query("rollback").catch(() => {});
      app.release();
    }
  });

  test("the record keeps its references for the backup window and no longer, and goes once its steps are stamped", async () => {
    const c = await seedClinic("erase-expiry");
    await seedEverywhere(c.clinicId, "5550133001", new Date(Date.now() - DAY));
    const erased = await erase({ clinicId: c.clinicId, phone: "+15550133001", requestedBy: "practice" });
    if (erased.status !== "erased") throw new Error("not erased");
    const row = async () =>
      inTenant(
        c.clinicId,
        async (client) =>
          (
            await client.query<{ erased_at: Date; refs: number }>(
              `select erased_at, cardinality(restore_refs) as refs from erasure_requests where id = $1`,
              [erased.erasureId],
            )
          ).rows[0],
      );
    const window = BACKUP_RETENTION_DAYS * DAY;
    const hour = 60 * 60 * 1000;

    // An hour inside the window: the references stay.
    await backdateErasure(c.clinicId, erased.erasureId, window - hour);
    await expireErasureRecords();
    expect((await row())!.refs).toBeGreaterThan(0);

    // Past the window's end: emptied, and the row stays only because
    // Retell's step is outstanding, holding nothing that points at the person.
    await backdateErasure(c.clinicId, erased.erasureId, 2 * hour);
    await expireErasureRecords();
    expect((await row())!.refs).toBe(0);
    let view = data<CareView>(
      await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR),
    );
    expect(view.deletionRequests[0]!.restoreRecordUntil).toBeNull();

    // References are only ever emptied: nothing can put them back.
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update erasure_requests set restore_refs = array['v1:00'] where id = $1`, [
          erased.erasureId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    data(
      await runOperation(
        "markErasureVendorDeleted",
        { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "nothing_held" },
        OPERATOR,
      ),
    );
    await expireErasureRecords();
    expect(await row()).toBeUndefined();
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.deletionRequests).toEqual([]);
  });

  test("the runtime role deletes a number's stop, consent and contact attempts only under the record of a deletion request", async () => {
    const c = await seedClinic("erase-evidence-floor");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await inTenant(c.clinicId, (client) => evidence(client, c.clinicId, "+15550137002", hourAgo));
    const evidenceLeft = () =>
      inTenant(c.clinicId, async (client) =>
        (
          await client.query<{ n: number }>(
            `select (select count(*) from suppressions)::int + (select count(*) from consent_records)::int
                    + (select count(*) from contact_attempts)::int as n`,
          )
        ).rows[0]!.n,
      );
    const eraseEvidence = `select * from app_erase_contact_evidence($1::uuid, array['+15550137002']::text[])`;

    // No deletion request: refused, whatever id is passed. The first version
    // took a bare cutoff, and now() let the runtime role delete any "stop".
    await expect(asApp(c.clinicId, (q) => q.query(eraseEvidence, [randomUUID()]))).rejects.toMatchObject({
      code: "42501",
    });

    // A request recorded earlier, whose references have expired: refused.
    const earlier = await erase({ clinicId: c.clinicId, phone: "+15550137001", requestedBy: "practice" });
    if (earlier.status !== "erased") throw new Error("not erased");
    await backdateErasure(c.clinicId, earlier.erasureId, (BACKUP_RETENTION_DAYS + 1) * DAY);
    await expireErasureRecords();
    await expect(
      asApp(c.clinicId, (q) => q.query(eraseEvidence, [earlier.erasureId])),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await evidenceLeft()).toBe(3);

    // A record the runtime role writes itself, in the same transaction, for a
    // number someone on file still carries: refused. Evidence goes only after
    // its person's contacts have (second review: it could write a record and
    // delete anyone's stop).
    const carried = await seedContact(c.clinicId, "+15550137003");
    await inTenant(c.clinicId, (client) => evidence(client, c.clinicId, "+15550137003", hourAgo));
    await expect(
      asApp(c.clinicId, async (q) => {
        const { rows } = await q.query<{ id: string }>(
          `insert into erasure_requests (clinic_id, requested_by, received_at, due_by)
           values ($1, 'practice', now(), now() + interval '14 days') returning id`,
          [c.clinicId],
        );
        return q.query(`select * from app_erase_contact_evidence($1::uuid, array['+15550137003']::text[])`, [
          rows[0]!.id,
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still carries/) });
    expect(carried).toBeTruthy();

    // A request recorded in the same transaction, for a number no one on
    // file carries: the deletion runs, up to the record's own time, and
    // leaves an audit row naming the request and the counts.
    const { deleted, audit } = await asApp(c.clinicId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into erasure_requests (clinic_id, requested_by, received_at, due_by)
         values ($1, 'practice', now(), now() + interval '14 days') returning id`,
        [c.clinicId],
      );
      const deleted = (await q.query(eraseEvidence, [rows[0]!.id])).rows[0];
      const audit = (
        await q.query<{ resource_id: string; result_count: number; metadata: Record<string, unknown> }>(
          `select resource_id, result_count, metadata from audit_log where resource_type = 'person_erasure_evidence'`,
        )
      ).rows;
      return { deleted, audit: audit.map((a) => ({ ...a, id: rows[0]!.id })) };
    });
    expect(deleted).toEqual({
      suppressions_deleted: 1,
      consent_records_deleted: 1,
      contact_attempts_deleted: 1,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.resource_id).toBe(audit[0]!.id);
    expect(audit[0]!.result_count).toBe(3);
    expect(audit[0]!.metadata).toMatchObject({
      erasureId: audit[0]!.id,
      path: "erasure",
      suppressions: 1,
      consentRecords: 1,
      contactAttempts: 1,
    });
    // The number, not "555": a uuid in the metadata can hold those three digits.
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/0137002|\+1555/);

    // And the record's counts are written in that transaction and no other.
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update erasure_requests set deleted = '{"contacts": 9}' where id = $1`, [
          earlier.erasureId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("against the runtime role the evidence function's checks are advisory, and its audit row is the bound", async () => {
    // Third review, 12 October 2026. The runtime role can blank a live
    // contact's phone for the length of one call, past "a contact still
    // carries it", and can mint its own record holding references, which
    // then stands as a restore record in later transactions. Neither gets
    // past the audit row, and the migration says so.
    const c = await seedClinic("erase-evidence-bypass");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const carried = await seedContact(c.clinicId, "+15550137101");
    await inTenant(c.clinicId, async (client) => {
      await evidence(client, c.clinicId, "+15550137101", hourAgo);
      await evidence(client, c.clinicId, "+15550137102", hourAgo);
    });

    const minted = await committedAsApp(c.clinicId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into erasure_requests (clinic_id, requested_by, received_at, due_by, restore_refs)
         values ($1, 'practice', now(), now() + interval '14 days', array['minted']) returning id`,
        [c.clinicId],
      );
      await q.query(`update contacts set phone = null where id = $1`, [carried]);
      const deleted = (
        await q.query<{ suppressions_deleted: number }>(
          `select * from app_erase_contact_evidence($1::uuid, array['+15550137101']::text[])`,
          [rows[0]!.id],
        )
      ).rows[0]!;
      await q.query(`update contacts set phone = '+15550137101' where id = $1`, [carried]);
      return { id: rows[0]!.id, deleted };
    });
    expect(minted.deleted.suppressions_deleted).toBe(1);

    const later = await committedAsApp(c.clinicId, (q) =>
      q.query<{ suppressions_deleted: number }>(
        `select * from app_erase_contact_evidence($1::uuid, array['+15550137102']::text[])`,
        [minted.id],
      ),
    );
    expect(later.rows[0]!.suppressions_deleted).toBe(1);

    const audit = await inTenant(c.clinicId, async (client) =>
      (
        await client.query<{ path: string; n: number }>(
          `select metadata->>'path' as path, result_count as n from audit_log
            where resource_type = 'person_erasure_evidence' and resource_id = $1
            order by occurred_at, id`,
          [minted.id],
        )
      ).rows,
    );
    expect(audit).toEqual([
      { path: "erasure", n: 3 },
      { path: "restore", n: 3 },
    ]);

    const { rows } = await getMigratorPool().query<{ comment: string }>(
      `select obj_description('app_erase_contact_evidence(uuid, text[])'::regprocedure, 'pg_proc') as comment`,
    );
    expect(rows[0]!.comment).toMatch(/advisory/);
    expect(rows[0]!.comment).toMatch(/blank a contact''?s phone for one call/);
    expect(rows[0]!.comment).toMatch(/insert a record with references/);
    expect(rows[0]!.comment).toMatch(/the audit row is the bound/);
  });

  test("a deletion by address alone erases every contact carrying the person's number too, whole", async () => {
    // C1 has the number and the address; C2, a call matched only by the
    // number, has a conversation. Asked by the address, the first version
    // erased C1 only, yet deleted C2's payloads, WhatsApp thread and stops by
    // the number, and left C2 and its call to a restore's re-application.
    const c = await seedClinic("erase-closure");
    const at = new Date(Date.now() - 2 * DAY);
    const synced = await seedContact(c.clinicId, "+15550138001");
    const caller = await seedContact(c.clinicId, "+15550138001");
    const stranger = await seedContact(c.clinicId, "+15550138009");
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      await client.query(`update contacts set email = 'dana@example-patient.test' where id = $1`, [
        synced,
      ]);
      await thread(client, c.clinicId, "whatsapp", "15550138001", at);
      await evidence(client, c.clinicId, "+15550138001", at);
    });
    await seedConversation(c.clinicId, { startedAt: at, contactId: caller });
    await seedConversation(c.clinicId, { startedAt: at, contactId: stranger });

    const outcome = await erase({
          clinicId: c.clinicId,
          email: "dana@example-patient.test",
          requestedBy: "practice",
        });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted).toMatchObject({
      contacts: 2,
      conversations: 1,
      chatThreads: 1,
      suppressions: 1,
    });
    // The reply says the rule by count: one number and one address taken.
    expect(outcome.identifiers).toEqual({ phones: 1, emails: 1 });
    await inTenant(c.clinicId, async (client) => {
      const left = await client.query<{ id: string }>(`select id from contacts`);
      expect(left.rows.map((r) => r.id)).toEqual([stranger]);
      const calls = await client.query<{ contact_id: string }>(`select contact_id from conversations`);
      expect(calls.rows.map((r) => r.contact_id)).toEqual([stranger]);
    });
    expect(await whereTheNumberIs(c.clinicId, "5550138001")).toEqual([]);
  });

  test("a raw payload goes only when it carries the person's address or number whole, written with or without the country code", async () => {
    const c = await seedClinic("erase-whole-token");
    const at = new Date(Date.now() - 2 * DAY);
    const ids = await inTenant(c.clinicId, async (client) => ({
      // Another person, whose address contains the one erased: stays. The
      // first version's substring test deleted it, possibly the only copy of
      // a call nothing had processed yet.
      joann: await payload(client, c.clinicId, "mindbody", "evt_joann", { client: { email: "joann@mail.test", mobile: "+15559990000" } }, at, false),
      ann: await payload(client, c.clinicId, "mindbody", "evt_ann", { client: { email: "Ann@Mail.test" } }, at, true),
      // The number as a person writes it, with no country code: goes.
      national: await payload(client, c.clinicId, "mindbody", "evt_national", { note: "call back on 555 013 9201 after five" }, at, true),
      bracketed: await payload(client, c.clinicId, "mindbody", "evt_bracketed", { note: "(555) 013-9201" }, at, true),
      // A longer number that contains it: stays.
      longer: await payload(client, c.clinicId, "mindbody", "evt_longer", { ref: "2555013920100" }, at, true),
      // The second review's cases, matched in each decoded string. After a
      // newline, a tab, or an escaped "<": goes (the raw-text match missed
      // them). Behind an apostrophe, which an address's local part may hold:
      // someone else's, stays. The same ten digits after +44: someone else's
      // number, stays. As a JSON number: goes. A body that is not JSON is
      // matched as text: goes.
      newline: await payload(client, c.clinicId, "mindbody", "evt_nl", { transcript: "user: my email is\nann@mail.test" }, at, true),
      tab: await payload(client, c.clinicId, "mindbody", "evt_tab", { note: "email:\tann@mail.test" }, at, true),
      escaped: await rawPayload(client, c.clinicId, "evt_go", '{"from":"Ann \\u003cann@mail.test\\u003e"}', at),
      apostrophe: await payload(client, c.clinicId, "mindbody", "evt_apos", { client: { email: "o'ann@mail.test" } }, at, true),
      foreign: await payload(client, c.clinicId, "mindbody", "evt_uk", { client: { mobile: "+44 555 013 9201" } }, at, true),
      jsonNumber: await rawPayload(client, c.clinicId, "evt_num", '{"client":{"mobile":15550139201}}', at),
      notJson: await rawPayload(client, c.clinicId, "evt_text", "From: Ann <ann@mail.test>\r\nSubject: booking", at),
    }));
    const outcome = await erase({ clinicId: c.clinicId, phone: "+15550139201", email: "ann@mail.test", requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error("not erased");
    expect(outcome.deleted.webhookEvents).toBe(8);
    const left = await inTenant(c.clinicId, async (client) =>
      (await client.query<{ id: string }>(`select id from webhook_events order by id`)).rows.map((r) => r.id),
    );
    expect(left).toEqual([ids.joann, ids.longer, ids.apostrophe, ids.foreign].sort());
  });

  test("no payload stops an erasure, whatever it holds: one the jsonb cast refuses, one nested too deep, one too large to walk", async () => {
    // IS JSON accepts bodies the jsonb cast refuses, and a body nested
    // 100,000 deep overflows the stack inside IS JSON itself. Matched inline,
    // any one of them failed the query, so every erasure at the clinic rolled
    // back for as long as the payload was kept (third review, 12 October
    // 2026). app_payload_names (drizzle/0063) matches such a body as text,
    // and one over 256 KiB too, with an escape before an address still
    // ending it.
    const c = await seedClinic("erase-odd-bodies");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550139301");
    await inTenant(c.clinicId, (client) =>
      client.query(`update contacts set email = 'ann.odd@mail.test', created_at = $2 where id = $1`, [
        person,
        at,
      ]),
    );
    const deep = (inner: string) => "[".repeat(100_000) + inner + "]".repeat(100_000);
    const large = (note: string) => JSON.stringify({ filler: "x".repeat(300_000), note });
    const ids = await inTenant(c.clinicId, async (client) => ({
      nul: await rawPayload(client, c.clinicId, "evt_nul", '{"a":"\\u0000","t":"ann.odd@mail.test"}', at),
      surrogate: await rawPayload(client, c.clinicId, "evt_surrogate", '{"a":"\\ud800","t":"ann.odd@mail.test"}', at),
      exponent: await rawPayload(client, c.clinicId, "evt_exponent", '{"a":1e1000000,"t":"ann.odd@mail.test"}', at),
      deep: await rawPayload(client, c.clinicId, "evt_deep", deep('"ann.odd@mail.test"'), at),
      // Over 256 KiB, so matched as text: "\\nann.odd@" as written, the
      // escape read as the newline it is.
      large: await rawPayload(client, c.clinicId, "evt_large", large("email:\nann.odd@mail.test"), at),
      // The same bodies about someone else: stay.
      otherNul: await rawPayload(client, c.clinicId, "evt_nul_other", '{"a":"\\u0000","t":"joann.odd@mail.test"}', at),
      otherDeep: await rawPayload(client, c.clinicId, "evt_deep_other", deep('"joann.odd@mail.test"'), at),
      otherLarge: await rawPayload(client, c.clinicId, "evt_large_other", large("joann.odd@mail.test, +44 555 013 9301"), at),
    }));
    const outcome = await erase({ clinicId: c.clinicId, contactId: person, requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.contacts).toBe(1);
    expect(outcome.deleted.webhookEvents).toBe(5);
    const left = await inTenant(c.clinicId, async (client) =>
      (await client.query<{ id: string }>(`select id from webhook_events order by id`)).rows.map((r) => r.id),
    );
    expect(left).toEqual([ids.otherNul, ids.otherDeep, ids.otherLarge].sort());
    expect([ids.nul, ids.surrogate, ids.exponent, ids.deep, ids.large].some((id) => left.includes(id))).toBe(false);
  }, 120_000);

  test("a deletion that finds more than two hundred references still completes, and records them all", async () => {
    // The first version capped restore_refs at 200 (a CHECK), and recorded
    // every reference the survey found, so a person past the cap could never
    // be deleted: every attempt rolled back, past the ten business days.
    const c = await seedClinic("erase-many-refs");
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into contacts (clinic_id, phone, email, created_at)
         select $1, '+1555015' || lpad(i::text, 4, '0'), 'shared@example-patient.test', now() - interval '1 day'
           from generate_series(1, 120) i`,
        [c.clinicId],
      ),
    );
    const outcome = await erase({ clinicId: c.clinicId, email: "shared@example-patient.test", requestedBy: "practice" });
    if (outcome.status !== "erased") throw new Error(JSON.stringify(outcome));
    expect(outcome.deleted.contacts).toBe(120);
    const refs = await inTenant(
      c.clinicId,
      async (client) =>
        (
          await client.query<{ n: number }>(
            `select cardinality(restore_refs) as n from erasure_requests where id = $1`,
            [outcome.erasureId],
          )
        ).rows[0]!.n,
    );
    // 120 numbers, one address, and the 120 WhatsApp ids the numbers are.
    expect(refs).toBe(241);
  });

  test("the record's clock is the database's: the runtime role can neither empty it early, delete it, nor fake a stamp", async () => {
    const c = await seedClinic("erase-clock-sql");
    const erased = await erase({ clinicId: c.clinicId, phone: "+15550139001", requestedBy: "practice" });
    if (erased.status !== "erased") throw new Error("not erased");
    const id = erased.erasureId;

    // The first version let the runtime role do each of these at once.
    for (const statement of [
      `update erasure_requests set restore_refs = '{}' where id = '${id}'`,
      `delete from erasure_requests where id = '${id}'`,
    ]) {
      await expect(asApp(c.clinicId, (q) => q.query(statement)), statement).rejects.toMatchObject({
        code: "42501",
      });
    }
    // A step "stamped" with something that is not a stamp counts for nothing.
    await expect(
      asApp(c.clinicId, (q) =>
        q.query(`update erasure_requests set vendor_steps = '{"retell": false}' where id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Not even the owner empties the references inside the backup window.
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update erasure_requests set restore_refs = '{}' where id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The expiry inside the window does nothing.
    expect(
      (await asApp(c.clinicId, (q) => q.query(`select * from app_expire_erasure_records()`))).rows[0],
    ).toEqual({ emptied: 0, deleted: 0 });

    // A real stamp is timestamped by the database, whatever the writer sent.
    await asApp(c.clinicId, async (q) => {
      await q.query(
        `update erasure_requests
            set vendor_steps = vendor_steps || '{"retell": {"at": "2020-01-01T00:00:00Z", "by": "ops@healdesk.test", "how": "deleted"}}'
          where id = $1`,
        [id],
      );
      const { rows } = await q.query<{ at: string }>(
        `select vendor_steps -> 'retell' ->> 'at' as at from erasure_requests where id = $1`,
        [id],
      );
      expect(Math.abs(new Date(rows[0]!.at).getTime() - Date.now())).toBeLessThan(60_000);
    });

    // The window in SQL is the catalog's.
    const { rows } = await getMigratorPool().query<{ src: string }>(
      `select prosrc as src from pg_proc where proname in ('app_expire_erasure_records', 'app_erasure_request_guard')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.src).toContain(`interval '${BACKUP_RETENTION_DAYS} days'`);
  });

  test("a destroyed clinic takes no new deletion record, whoever writes it", async () => {
    // expireErasureRecords skips destroyed clinics, so a record written after
    // destruction would keep its references for good. The ops envelope
    // checked destroyed_at outside the transaction, and nothing in the
    // database refused the insert.
    const c = await seedClinic("erase-destroyed");
    await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [
      c.clinicId,
    ]);
    const insert = `insert into erasure_requests (clinic_id, requested_by, received_at, due_by)
                    values ($1, 'practice', now(), now() + interval '14 days')`;
    await expect(asApp(c.clinicId, (q) => q.query(insert, [c.clinicId]))).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/destroyed/),
    });
    await expect(inTenant(c.clinicId, (q) => q.query(insert, [c.clinicId]))).rejects.toMatchObject({
      code: "42501",
    });
    const refused = await erase({ clinicId: c.clinicId, phone: "+15550139101", requestedBy: "practice" });
    expect(refused.status).toBe("error");
  });

  test("the runtime role cannot choose when the record's clock starts", async () => {
    const c = await seedClinic("erase-stamp");
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const { rows } = await app.query<{ erased_at: Date }>(
        `insert into erasure_requests (clinic_id, requested_by, received_at, due_by, erased_at)
         values ($1, 'practice', now() - interval '1 day', now() + interval '13 days', now() + interval '400 days')
         returning erased_at`,
        [c.clinicId],
      );
      expect(Math.abs(rows[0]!.erased_at.getTime() - Date.now())).toBeLessThan(60_000);
      await expect(
        app.query(`update erasure_requests set erased_at = now() + interval '400 days'`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.query("rollback").catch(() => {});
      app.release();
    }
  });

  test("after a restore, the deletion is applied again to what it found, and not to what the person gave afterwards", async () => {
    const c = await seedClinic("erase-restore");
    const at = new Date(Date.now() - 3 * DAY);
    const seeded = await seedEverywhere(c.clinicId, "5550134001", at);
    const erased = await erase({ clinicId: c.clinicId, phone: "+15550134001", requestedBy: "practice" });
    if (erased.status !== "erased") throw new Error("not erased");

    // A restore brings the person's old rows back (as a data-only load would,
    // under their old dates), and the person has since called again.
    const restored = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (id, clinic_id, phone, email, created_at, updated_at)
         values ($1, $2, '+15550134001', 'p5550134001@example-patient.test', $3, $3) returning id`,
        [seeded.contactId, c.clinicId, at],
      );
      await draft(client, c.clinicId, "instagram", "ig_5550134001", "+15550134001", at);
      await thread(client, c.clinicId, "whatsapp", "15550134001", at);
      await payload(
        client,
        c.clinicId,
        "mindbody",
        "evt_5550134001_restored",
        { client: { mobile: "+15550134001" } },
        at,
        true,
      );
      await evidence(client, c.clinicId, "+15550134001", at);
      return rows[0]!.id;
    });
    const later = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, '+15550134001') returning id`,
        [c.clinicId],
      );
      return rows[0]!.id;
    });

    const result = await reapplyErasures();
    expect(result.failures).toBe(0);
    expect(result.reapplied).toBeGreaterThanOrEqual(1);

    await inTenant(c.clinicId, async (client) => {
      const ids = (
        await client.query<{ id: string }>(`select id from contacts where phone = '+15550134001'`)
      ).rows.map((r) => r.id);
      expect(ids).toEqual([later]);
      expect(ids).not.toContain(restored);
      const left = async (table: string) =>
        (
          await client.query<{ n: number }>(
            `select count(*)::int as n from ${table} t where t::text like '%5550134001%'`,
          )
        ).rows[0]!.n;
      expect(await left("meta_booking_drafts")).toBe(0);
      // The person is on file again, under the contact they gave afterwards,
      // so the stop, consent and attempt the restore brought back stay with
      // that number: evidence goes only once no contact carries it (the
      // definer refuses otherwise).
      for (const table of ["suppressions", "consent_records", "contact_attempts"]) {
        expect(await left(table), table).toBe(1);
      }
      const threads = await client.query(`select 1 from chat_threads where party_ref = $1`, [
        identifierRef("chat_party", c.clinicId, "whatsapp:15550134001"),
      ]);
      expect(threads.rows).toEqual([]);
      const payloads = await client.query(
        `select 1 from webhook_events where delivery_id = 'evt_5550134001_restored'`,
      );
      expect(payloads.rows).toEqual([]);
    });
  });

  test("after a restore, a thread the restored data shows shared is kept, whatever the record names, and counted", async () => {
    // The verifier's case: the deletion took the person's own thread and kept
    // its reference; the backup restored shows the same thread also booking
    // for someone else. Re-applying deleted it by the stored reference.
    const c = await seedClinic("erase-reapply-shared");
    const at = new Date(Date.now() - 3 * DAY);
    const p = await seedContact(c.clinicId, "+15550136201");
    const q = await seedContact(c.clinicId, "+15550136202");
    const x = { platform: "instagram", senderId: "ig_x_1362" } as const;
    await inTenant(c.clinicId, async (client) => {
      await client.query(`update contacts set created_at = $1`, [at]);
      await request(client, c.clinicId, p, x, at);
      await thread(client, c.clinicId, "instagram", "ig_x_1362", at);
    });
    const erased = await erase({ clinicId: c.clinicId, phone: "+15550136201", requestedBy: "practice" });
    if (erased.status !== "erased") throw new Error("not erased");
    expect(erased.deleted.chatThreads).toBe(1);

    const xThread = identifierRef("chat_party", c.clinicId, "instagram:ig_x_1362");
    let qRequest = "";
    await inTenant(c.clinicId, async (client) => {
      await client.query(
        `insert into contacts (id, clinic_id, phone, created_at, updated_at) values ($1, $2, '+15550136201', $3, $3)`,
        [p, c.clinicId, at],
      );
      await request(client, c.clinicId, p, x, at);
      qRequest = await request(client, c.clinicId, q, x, at);
      await thread(client, c.clinicId, "instagram", "ig_x_1362", at);
    });
    const result = await reapplyErasures();
    expect(result.failures).toBe(0);
    expect(result.keptSharedThreads).toBeGreaterThanOrEqual(1);
    await inTenant(c.clinicId, async (client) => {
      expect((await client.query(`select 1 from booking_requests where id = $1`, [qRequest])).rows).toHaveLength(1);
      expect((await client.query(`select 1 from chat_threads where party_ref = $1`, [xThread])).rows).toHaveLength(1);
      expect((await client.query(`select 1 from contacts where id = $1`, [p])).rows).toEqual([]);
    });
  });

  test("the runbook runs a deletion per location, says nothing on AWS turns a number into a contact id before M5, and names every voice vendor that can hold a call", () => {
    // The calendar session's re-audit (C19, 12 October 2026): a deletion
    // reaches one clinic (one location); the runbook and run-task.sh said the
    // ops console shows a contact's id, which it does not; and a voice vendor
    // without a deletion step must be one that never carried a patient call.
    const repo = join(__dirname, "..", "..", "..");
    const handover = readFileSync(join(repo, "docs", "handover.md"), "utf8");
    const section = handover.slice(
      handover.indexOf("### Deletion requests"),
      handover.indexOf("### Amendments"),
    ).replace(/\s+/g, " ");
    expect(section).toMatch(/Run it for each location/);
    expect(section).toMatch(/run it once for every location the person may have used/);
    expect(section).toMatch(/Nothing on AWS turns a number into a contact id yet/);
    expect(section).toMatch(/waits for M5/);
    expect(section).toMatch(/Retell is the only voice vendor/);
    expect(section).toMatch(/never carried a patient call/);
    const runTask = readFileSync(join(repo, "infra", "aws", "scripts", "run-task.sh"), "utf8");
    expect(runTask).not.toMatch(/contact's uuid \(the ops console shows it\)/);
    // A practice never sees our contact ids, so no text may send an operator to
    // "the practice's own records" for one (healdesk-io-58, 12 October 2026).
    expect(runTask).toMatch(
      /until the M5 portal nothing on AWS turns a number, an address or a name into one/,
    );
    expect(runTask).not.toMatch(/practice's own records/);
    expect(handover.replace(/\s+/g, " ")).not.toMatch(/contact id from the practice's own records/);
    expect(handover.replace(/\s+/g, " ")).not.toMatch(/the ops console shows (it|a contact)/i);
    // And the jobs paragraph no longer says every job ships switched off:
    // heartbeat and incident-deadlines ship on, and two jobs widen.
    expect(handover).not.toMatch(/Every job ships switched off/);
    expect(handover.replace(/\s+/g, " ")).toMatch(
      /`retention-purge` and `offboarding-destroy` run for every clinic whose agreement states what they do, whatever their switch/,
    );
  });

  test("nothing reads the record to decide whether to contact anyone", () => {
    // The table and its model are touched in two places: the schema, and the
    // erase path that writes, expires and re-applies it. Destruction deletes
    // it through app_destroy_erasure_requests(). The console reads it only through
    // listErasureRequests, which returns no reference to anyone. A contact
    // decision (lib/compliance) reading it would have to be added here.
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const readers = files
      .filter((f) =>
        /\berasureRequests\b|\bErasureRequests\b|\b(from|join|update|into)\s+erasure_requests\b/i.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(root, f))
      .sort();
    expect(readers).toEqual(["db/schema.ts", "lib/patient-rights/erasure.ts"].sort());
  });
});
