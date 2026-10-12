import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { BACKUP_RETENTION_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identifierRef } from "@/lib/identifier-ref";
import { runOperation, type CareView, type ErasePersonOutcome, type Operator } from "@/lib/ops/api";
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

function voicePayload(callId: string, phone: string, at: Date) {
  return {
    call_id: callId,
    start_time: at.toISOString(),
    duration: 120,
    lead: { name: "Sam", phone_number: phone },
    transcript: "Caller asked about a consultation.",
    collected_variables: { outcome: "booked" },
  };
}

type Seeded = {
  contactId: string;
  spouseContactId: string;
  requests: string[];
  payloads: string[];
};

/**
 * A person with a record in every table the erase path reaches: a booked
 * call (its contact, conversation, appointment and voice payload), their own
 * requests on a call, on WhatsApp and on Instagram, a request they sent from
 * Instagram for someone else's number, a draft carrying their number on
 * Messenger and one on their Instagram thread carrying none, their three
 * messaging threads, a payload the voice vendor sent that ingestion never
 * processed (the number written as a person would), another service's
 * payload naming them, and a stop, a consent and a contact attempt.
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
      // Sent from their Instagram thread, for their spouse's number.
      await request(
        client,
        clinicId,
        spouseContactId,
        { platform: "instagram", senderId: `ig_${digits}` },
        at,
      ),
    ];
    await draft(client, clinicId, "messenger", `psid_${digits}`, phone, at);
    await draft(client, clinicId, "instagram", `ig_${digits}`, null, at);
    await thread(client, clinicId, "whatsapp", `1${digits}`, at);
    await thread(client, clinicId, "instagram", `ig_${digits}`, at);
    await thread(client, clinicId, "messenger", `psid_${digits}`, at);
    const payloads = [
      await payload(
        client,
        clinicId,
        "synthflow",
        `call_${digits}`,
        voicePayload(`call_${digits}`, phone, at),
        at,
        true,
      ),
      await payload(
        client,
        clinicId,
        "synthflow",
        `call_${digits}_failed`,
        voicePayload(
          `call_${digits}_failed`,
          `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
          at,
        ),
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
    return { contactId, spouseContactId, requests, payloads };
  });
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

    const outcome = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        {
          clinicId: c.clinicId,
          // As an operator types it; the API matches it in E.164.
          phone: "(555) 013-0001",
          email: "P5550130001@Example-Patient.test",
          requestedBy: "the practice, ticket 1182",
          receivedAt: "2026-10-05T09:00:00Z",
        },
        OPERATOR,
      ),
    );
    expect(outcome.status).toBe("erased");
    if (outcome.status !== "erased") return;
    expect(outcome.deleted).toMatchObject({
      contacts: 1,
      bookingRequests: 3,
      threadRequests: 1,
      appointments: 1,
      conversations: 1,
      drafts: 2,
      chatThreads: 3,
      webhookEvents: 3,
      suppressions: 1,
      consentRecords: 1,
      contactAttempts: 1,
    });
    // Ten business days from a Monday morning: two weeks on, at the same hour.
    expect(outcome.dueBy).toBe("2026-10-19T09:00:00.000Z");

    // Exactly the person's rows went: the neighbour's, and the spouse the
    // person booked for, stay; so does all of the other clinic.
    const after = await tableCounts(c.clinicId);
    expect(after).toEqual({
      contacts: before.contacts! - 1,
      conversations: before.conversations! - 1,
      appointments: before.appointments! - 1,
      booking_requests: before.booking_requests! - 4,
      meta_booking_drafts: before.meta_booking_drafts! - 2,
      chat_threads: before.chat_threads! - 3,
      webhook_events: before.webhook_events! - 3,
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
    expect(record[0]!.requested_by).toBe("the practice, ticket 1182");
    expect(record[0]!.received_at.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(record[0]!.deleted.webhookEvents).toBe(3);
    expect(record[0]!.restore_refs.length).toBeGreaterThan(0);
    for (const ref of record[0]!.restore_refs) expect(ref).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(record[0]!.restore_refs).toContain(
      identifierRef("erasure", c.clinicId, "phone:+15550130001"),
    );
    expect(record[0]!.restore_refs).toContain(
      identifierRef("chat_party", c.clinicId, "instagram:ig_5550130001"),
    );
  });

  test("the reply and the record name no one, and who asked is refused when it carries a number", async () => {
    const c = await seedClinic("erase-reply");
    await seedEverywhere(c.clinicId, "5550131001", new Date(Date.now() - DAY));
    const refused = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550131001", requestedBy: "Sam on +1 555 013 1001" },
        OPERATOR,
      ),
    );
    expect(refused.status).toBe("error");
    expect(await tableCounts(c.clinicId)).toMatchObject({ contacts: 2 });

    const nothing = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, requestedBy: "the practice" },
        OPERATOR,
      ),
    );
    expect(nothing.status).toBe("error");

    const outcome = await runOperation(
      "erasePerson",
      { clinicId: c.clinicId, phone: "+15550131001", requestedBy: "the practice" },
      OPERATOR,
    );
    expect(JSON.stringify(outcome.body)).not.toMatch(/5550131001|example-patient/);
    const view = data<CareView>(
      await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR),
    );
    expect(view.deletionRequests).toHaveLength(1);
    expect(JSON.stringify(view.deletionRequests)).not.toMatch(/5550131001|example-patient|v1:/);
  });

  test("each subcontractor step shows outstanding with the deadline until it is stamped, once", async () => {
    const c = await seedClinic("erase-vendor");
    await seedEverywhere(c.clinicId, "5550132001", new Date(Date.now() - DAY));
    const erased = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550132001", requestedBy: "the practice, by email" },
        OPERATOR,
      ),
    );
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

    const stamped = data<{ status: string }>(
      await runOperation(
        "markErasureVendorDeleted",
        {
          clinicId: c.clinicId,
          erasureId: erased.erasureId,
          step: "retell",
          how: "Two calls deleted in Retell's console",
        },
        OPERATOR,
      ),
    );
    expect(stamped.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.deletionRequests[0]!.steps[0]).toMatchObject({
      id: "retell",
      stampedBy: "ops@healdesk.test",
      how: "Two calls deleted in Retell's console",
    });
    expect(view.deletionRequests[0]!.steps[0]!.stampedAt).not.toBeNull();

    const twice = data<{ status: string; message?: string }>(
      await runOperation(
        "markErasureVendorDeleted",
        { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "again" },
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
    const erased = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550133001", requestedBy: "the practice" },
        OPERATOR,
      ),
    );
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
    const erasedAt = (await row())!.erased_at;
    const window = BACKUP_RETENTION_DAYS * DAY;

    // An hour inside the window: the references stay.
    await expireErasureRecords(new Date(erasedAt.getTime() + window - 60 * 60 * 1000));
    expect((await row())!.refs).toBeGreaterThan(0);

    // At the window's end (the database keeps microseconds, a Date only
    // milliseconds, so one more): emptied, and the row stays only because
    // Retell's step is outstanding, holding nothing that points at the person.
    await expireErasureRecords(new Date(erasedAt.getTime() + window + 1));
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
        { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "No calls held" },
        OPERATOR,
      ),
    );
    await expireErasureRecords(new Date(erasedAt.getTime() + window + 1));
    expect(await row()).toBeUndefined();
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.deletionRequests).toEqual([]);
  });

  test("the runtime role cannot choose when the record's clock starts", async () => {
    const c = await seedClinic("erase-stamp");
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const { rows } = await app.query<{ erased_at: Date }>(
        `insert into erasure_requests (clinic_id, requested_by, received_at, due_by, erased_at)
         values ($1, 'the practice', now() - interval '1 day', now() + interval '13 days', now() + interval '400 days')
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
    const erased = data<ErasePersonOutcome>(
      await runOperation(
        "erasePerson",
        { clinicId: c.clinicId, phone: "+15550134001", requestedBy: "the practice" },
        OPERATOR,
      ),
    );
    if (erased.status !== "erased") throw new Error("not erased");

    // A restore brings the person's old rows back (as a data-only load would,
    // under their old dates), and the person has since called again.
    const restored = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (id, clinic_id, phone, email, created_at, updated_at)
         values ($1, $2, '+15550134001', 'p5550134001@example-patient.test', $3, $3) returning id`,
        [seeded.contactId, c.clinicId, at],
      );
      await draft(client, c.clinicId, "instagram", "ig_5550134001", null, at);
      await thread(client, c.clinicId, "whatsapp", "15550134001", at);
      await payload(
        client,
        c.clinicId,
        "synthflow",
        "call_5550134001_restored",
        voicePayload("call_5550134001_restored", "+15550134001", at),
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
      for (const table of [
        "meta_booking_drafts",
        "suppressions",
        "consent_records",
        "contact_attempts",
      ]) {
        const n = (
          await client.query<{ n: number }>(
            `select count(*)::int as n from ${table} t where t::text like '%5550134001%'`,
          )
        ).rows[0]!.n;
        expect(n, table).toBe(0);
      }
      const threads = await client.query(`select 1 from chat_threads where party_ref = $1`, [
        identifierRef("chat_party", c.clinicId, "whatsapp:15550134001"),
      ]);
      expect(threads.rows).toEqual([]);
      const payloads = await client.query(
        `select 1 from webhook_events where delivery_id = 'call_5550134001_restored'`,
      );
      expect(payloads.rows).toEqual([]);
    });
  });

  test("nothing reads the record to decide whether to contact anyone", () => {
    // The table and its model are touched in three places: the schema, the
    // erase path that writes, expires and re-applies it, and destruction,
    // which deletes it. The console reads it only through
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
    expect(readers).toEqual(
      ["db/schema.ts", "lib/offboarding/offboarding.ts", "lib/patient-rights/erasure.ts"].sort(),
    );
  });
});
