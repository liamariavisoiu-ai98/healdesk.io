import { TRANSCRIPT_RETENTION_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { eraseContact, purgeClinic } from "@/lib/retention/purge";
import { JOB_RETENTION_PURGE, getJob, setJobEnabled } from "@/lib/scheduler/jobs";
import { runRetentionPurgeJob, sweepRetention } from "@/lib/scheduler/retention-purge";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { asApp, insertBookingRequest, insertHold } from "./setup/calendar-db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * Retention: the promise in the BAA, tested at a chosen `now`.
 *
 * The tests here are about the two things that make a purge safe rather
 * than merely present: it stays inside its tenant, and it cannot run at all
 * without one.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

async function count(clinicId: string, table: string): Promise<number> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return rows[0]!.n;
  });
}

describeDb("retention purge", () => {
  const now = new Date("2026-09-13T03:00:00Z");

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("clears media past the media clock, deletes rows past the record clock, and leaves the other clinic alone", async () => {
    const a = await seedClinic("purgeA");
    const b = await seedClinic("purgeB");
    // Both clocks default to 90 days, so clinic A shortens its media clock to
    // leave a span that is past one clock and inside the other. The record
    // clock stays at its default: the one the agreement states.
    await getMigratorPool().query(`update clinics set retention_media_days = 30 where id = $1`, [a.clinicId]);

    // Clinic A: one ancient booked conversation (past both clocks), one past
    // the 90-day record clock (kept for two years until 0048), one middle-aged
    // (past media, inside records), one fresh.
    const ancient = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 800 * DAY), booked: true });
    await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 120 * DAY) });
    const middle = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 60 * DAY) });
    const fresh = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 10 * DAY) });
    await inTenant(a.clinicId, async (client) => {
      await client.query(
        `update conversations set transcript_uri = 's3://t/' || id`,
      );
      // The factory stamps contacts with now(); an 800-day-old booking's
      // contact was last touched 800 days ago.
      await client.query(`update contacts set updated_at = $1`, [new Date(now.getTime() - 800 * DAY)]);
      await client.query(
        `insert into transactions (clinic_id, contact_id, appointment_id, amount_usd, collected_at)
         select clinic_id, contact_id, id, 250, scheduled_for from appointments where id = $1`,
        [ancient.appointmentId],
      );
    });
    // Clinic B: an equally ancient conversation that must survive A's purge.
    await seedConversation(b.clinicId, { startedAt: new Date(now.getTime() - 800 * DAY), booked: true });

    const result = await withTenant({ clinicId: a.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));

    expect(result.skipped).toBeNull();
    expect(result.mediaCleared).toBe(3); // every one but fresh, which keeps its media
    expect(result.conversationsDeleted).toBe(2); // ancient, and the 120-day one
    expect(result.appointmentsDeleted).toBe(1);
    expect(result.transactionsDeleted).toBe(1);
    expect(result.contactsDeleted).toBe(1);

    const left = await inTenant(a.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string; transcript_uri: string | null }>(
        `select id, transcript_uri from conversations order by started_at`,
      );
      return rows;
    });
    expect(left.map((r) => r.id)).toEqual([middle.conversationId, fresh.conversationId]);
    expect(left[0]!.transcript_uri).toBeNull();
    expect(left[1]!.transcript_uri).not.toBeNull();

    // Clinic B untouched: conversation, appointment, contact all still there.
    expect(await count(b.clinicId, "conversations")).toBe(1);
    expect(await count(b.clinicId, "appointments")).toBe(1);
    expect(await count(b.clinicId, "contacts")).toBe(1);

    // And the purge wrote an audit row with counts, never a person.
    const audit = await inTenant(a.clinicId, async (client) => {
      const { rows } = await client.query<{ result_count: number; metadata: Record<string, unknown> }>(
        `select result_count, metadata from audit_log where resource_type = 'retention_purge'`,
      );
      return rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result_count).toBe(8);
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/\+1555/);
  });

  test("both clocks default to the 90 days the agreement states", async () => {
    // BAA 1.2.1 and 1.3.0: "healdesk keeps transcripts and conversation
    // records for 90 days". The record clock defaulted to 730 until 0048, so
    // a clinic that never changed it kept its records eight times as long.
    const c = await seedClinic("purgeDefaults");
    const { rows } = await getMigratorPool().query<{ media: number; records: number }>(
      `select retention_media_days as media, retention_record_days as records from clinics where id = $1`,
      [c.clinicId],
    );
    expect(rows[0]).toEqual({ media: TRANSCRIPT_RETENTION_DAYS, records: TRANSCRIPT_RETENTION_DAYS });
  });

  test("the per-clinic window is honoured", async () => {
    const c = await seedClinic("purgeShort");
    await getMigratorPool().query(
      `update clinics set retention_media_days = 7, retention_record_days = 30 where id = $1`,
      [c.clinicId],
    );
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 45 * DAY) });
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 20 * DAY) });
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));
    expect(result.conversationsDeleted).toBe(1);
    expect(await count(c.clinicId, "conversations")).toBe(1);
  });

  test("a clinic mid-sync is skipped, not half-purged", async () => {
    const c = await seedClinic("purgeSync");
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 800 * DAY) });
    await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'fixture', 'active', 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
        [c.clinicId],
      );
      await client.query(
        `insert into sync_runs (clinic_id, connection_id, resource, status, started_at)
         values ($1, $2, 'appointments', 'running', now())`,
        [c.clinicId, rows[0]!.id],
      );
    });
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));
    expect(result.skipped).toBe("sync_running");
    expect(await count(c.clinicId, "conversations")).toBe(1);
  });

  test("with no tenant set, the same statements delete nothing", async () => {
    const c = await seedClinic("purgeNoTenant");
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 800 * DAY), booked: true });
    const app = getAppPool();
    const { rows } = await app.query<{ n: number }>(
      `with gone as (delete from conversations where started_at < now() - interval '2 years' returning id)
       select count(*)::int as n from gone`,
    );
    expect(rows[0]!.n).toBe(0);
    expect(await count(c.clinicId, "conversations")).toBe(1);
  });

  test("erasure removes one person's rows and leaves a do-not-contact row behind", async () => {
    const c = await seedClinic("erase");
    const target = await seedContact(c.clinicId, "+15550100001");
    const other = await seedContact(c.clinicId, "+15550100002");
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 3 * DAY), booked: true, contactId: target });
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 2 * DAY), booked: true, contactId: other });

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      eraseContact(tx, { phone: "+15550100001", requestedBy: "patient" }),
    );
    expect(result.contactsMatched).toBe(1);
    expect(result.conversationsDeleted).toBe(1);
    expect(result.appointmentsDeleted).toBe(1);
    expect(result.suppressed).toBe(true);

    const rows = await inTenant(c.clinicId, async (client) => {
      const contacts = await client.query<{ phone: string }>(`select phone from contacts order by phone`);
      const suppressed = await client.query<{ phone: string; reason: string }>(`select phone, reason from suppressions`);
      return { contacts: contacts.rows, suppressed: suppressed.rows };
    });
    expect(rows.contacts.map((r) => r.phone)).toEqual(["+15550100002"]);
    expect(rows.suppressed).toEqual([{ phone: "+15550100001", reason: "erasure_request" }]);
    expect(await count(c.clinicId, "conversations")).toBe(1);
  });

  test("slot holds: spent ones go after a week, or sooner on a shorter record clock, before anything they name; a final hold whose contact or appointment goes is cleared, not refused; a live one stays", async () => {
    // Holds run on the database clock, so this purge runs at the real now.
    const at = new Date();
    const c = await seedClinic("purgeHolds");
    await getMigratorPool().query(`update clinics set retention_record_days = 1 where id = $1`, [c.clinicId]);
    const gone = await seedContact(c.clinicId, "+15550100031");
    const kept = await seedContact(c.clinicId, "+15550100032");
    const later = (days: number) => new Date(at.getTime() + days * DAY);

    const ids = await asApp(c.clinicId, async (client) => {
      // A spent hold placed eight days ago: past the week.
      const old = await insertHold(client, c.clinicId, { holder: "voice:old", startsAt: later(3), placedSecondsAgo: 8 * 86_400 });
      // A hold released a moment ago, naming a contact the purge deletes.
      const released = await insertHold(client, c.clinicId, { holder: "voice:released", startsAt: later(4), contactId: gone });
      await client.query(`update slot_holds set status = 'released', outcome_reason = 'superseded', released_at = clock_timestamp() where id = $1`, [released]);
      // A reservation that became a booking whose appointment the purge deletes.
      const requestId = await insertBookingRequest(client, c.clinicId, kept);
      const converted = await insertHold(client, c.clinicId, { holder: "voice:converted", startsAt: later(5), contactId: kept });
      await client.query(
        `update slot_holds set status = 'reserved', booking_request_id = $2, blocks_until = clock_timestamp() + interval '30 minutes' where id = $1`,
        [converted, requestId],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for) values ($1, $2, $3) returning id`,
        [c.clinicId, kept, new Date(at.getTime() - 10 * DAY)],
      );
      await client.query(`update slot_holds set status = 'converted', appointment_id = $2 where id = $1`, [converted, rows[0]!.id]);
      // A live hold: never touched.
      const live = await insertHold(client, c.clinicId, { holder: "voice:live", startsAt: later(6) });
      await client.query(`update contacts set updated_at = $2 where id = $1`, [gone, new Date(at.getTime() - 30 * DAY)]);
      return { old, released, converted, live };
    });

    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, at));
    expect(result.slotHoldsDeleted).toBe(1);
    expect(result.appointmentsDeleted).toBe(1);
    expect(result.contactsDeleted).toBe(1);

    const holds = await inTenant(c.clinicId, async (client) =>
      (await client.query<{ id: string; status: string; contact_id: string | null; appointment_id: string | null }>(
        `select id, status, contact_id, appointment_id from slot_holds`,
      )).rows,
    );
    const byId = new Map(holds.map((h) => [h.id, h]));
    expect(byId.has(ids.old)).toBe(false);
    expect(byId.get(ids.released)).toMatchObject({ status: "released", contact_id: null });
    expect(byId.get(ids.converted)).toMatchObject({ status: "converted", appointment_id: null, contact_id: kept });
    expect(byId.get(ids.live)).toMatchObject({ status: "held" });
  });

  test("the job ships off, and when on it sweeps every clinic", async () => {
    expect((await getJob(JOB_RETENTION_PURGE))?.enabled).toBe(false);
    expect((await runRetentionPurgeJob({ now })).status).toBe("disabled");

    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ('usr_purge_ops', 'Ops', 'ops-purge@healdesk.test', true, now(), now()) returning id`,
    );
    await setJobEnabled(JOB_RETENTION_PURGE, true, rows[0]!.id);
    const outcome = await runRetentionPurgeJob({ now });
    expect(outcome.status).toBe("ok");
    const sweep = await sweepRetention(now);
    expect(sweep.failures).toEqual([]);
    expect(sweep.clinicsConsidered).toBeGreaterThan(0);
  });
});
