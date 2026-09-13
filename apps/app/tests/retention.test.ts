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

    // Clinic A: one ancient booked conversation (past both clocks), one
    // middle-aged one (past media, inside records), one fresh.
    const ancient = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 800 * DAY), booked: true });
    const middle = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 120 * DAY) });
    const fresh = await seedConversation(a.clinicId, { startedAt: new Date(now.getTime() - 10 * DAY) });
    await inTenant(a.clinicId, async (client) => {
      await client.query(
        `update conversations set transcript_uri = 's3://t/' || id, recording_uri = 's3://r/' || id`,
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
    expect(result.mediaCleared).toBe(2); // ancient + middle; fresh keeps its media
    expect(result.conversationsDeleted).toBe(1);
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
    expect(audit[0]!.result_count).toBe(6);
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/\+1555/);
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
