import { BAA_TEMPLATES, DPA_TEMPLATES, TRANSCRIPT_RETENTION_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { eraseContact, purgeClinic, purgeIsPromised } from "@/lib/retention/purge";
import { JOB_RETENTION_PURGE, getJob, setJobEnabled } from "@/lib/scheduler/jobs";
import { runRetentionPurgeJob, sweepRetention } from "@/lib/scheduler/retention-purge";
import { runTick } from "@/lib/scheduler/tick";
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

  test("the portal's transcript setting shortens transcripts, and only transcripts, and never lengthens them", async () => {
    // BAA 1.3.0 clause 11: "Practice may shorten these periods in its
    // portal". The portal's setting (90, 30 or 7 days) was read by nothing.
    const transcriptKept = async (label: string, settingDays: number | null, mediaDays?: number) => {
      const c = await seedClinic(label);
      if (mediaDays) {
        await getMigratorPool().query(`update clinics set retention_media_days = $2 where id = $1`, [
          c.clinicId,
          mediaDays,
        ]);
      }
      if (settingDays !== null) {
        await inTenant(c.clinicId, (client) =>
          client.query(
            `insert into clinic_settings (clinic_id, transcript_retention_days) values ($1, $2)`,
            [c.clinicId, settingDays],
          ),
        );
      }
      const call = await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 8 * DAY) });
      await inTenant(c.clinicId, (client) =>
        client.query(`update conversations set transcript_uri = 's3://t/' || id`),
      );
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));
      return inTenant(c.clinicId, async (client) => {
        const { rows } = await client.query<{ id: string; transcript_uri: string | null }>(
          `select id, transcript_uri from conversations`,
        );
        // The conversation itself is on the record clock (90 days) and stays.
        expect(rows.map((r) => r.id)).toEqual([call.conversationId]);
        return rows[0]!.transcript_uri !== null;
      });
    };
    // Seven days: an eight-day-old transcript goes, and its conversation stays.
    expect(await transcriptKept("transcripts-7", 7)).toBe(false);
    // Ninety, or no setting at all: it stays.
    expect(await transcriptKept("transcripts-90", 90)).toBe(true);
    expect(await transcriptKept("transcripts-none", null)).toBe(true);
    // A setting longer than the clinic's own period changes nothing: with the
    // media clock at seven days, ninety in the portal still clears it.
    expect(await transcriptKept("transcripts-longer", 90, 7)).toBe(false);
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

  test("erasure removes one person's rows and leaves no copy of their number behind", async () => {
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

    const rows = await inTenant(c.clinicId, async (client) => {
      const contacts = await client.query<{ phone: string }>(`select phone from contacts order by phone`);
      const suppressed = await client.query<{ phone: string; reason: string }>(`select phone, reason from suppressions`);
      return { contacts: contacts.rows, suppressed: suppressed.rows };
    });
    expect(rows.contacts.map((r) => r.phone)).toEqual(["+15550100002"]);
    // Until gate 6 the number stayed here "so the request itself is honoured";
    // BAA 1.3.0's clause 4(c) allows only a record of the request, kept no
    // longer than needed (erasure_requests, without the number).
    expect(rows.suppressed).toEqual([]);
    expect(await count(c.clinicId, "conversations")).toBe(1);
  });

  test("never-processed payloads go at the record clock, and processed ones at thirty days or the record clock if shorter", async () => {
    const c = await seedClinic("purge-payloads");
    const short = await seedClinic("purge-payloads-short");
    await getMigratorPool().query(`update clinics set retention_record_days = 7 where id = $1`, [
      short.clinicId,
    ]);
    const payload = (clinicId: string, deliveryId: string, daysOld: number, processed: boolean) =>
      inTenant(clinicId, (client) =>
        client.query(
          `insert into webhook_events
             (clinic_id, provider, delivery_id, signature_valid, raw_payload, processed_at, received_at)
           values ($1, 'synthflow', $2, $3, '{"lead":{"phone_number":"+15550150001"}}', $4, $5)`,
          [
            clinicId,
            deliveryId,
            processed,
            processed ? new Date(now.getTime() - daysOld * DAY) : null,
            new Date(now.getTime() - daysOld * DAY),
          ],
        ),
      );
    // The default record clock (90 days).
    await payload(c.clinicId, "never-100", 100, false); // past the record clock: goes
    await payload(c.clinicId, "never-60", 60, false); // inside it: stays
    await payload(c.clinicId, "done-40", 40, true); // past thirty days: goes
    await payload(c.clinicId, "done-20", 20, true); // stays
    // A record clock of seven days: nothing raw outlives it, processed or not.
    await payload(short.clinicId, "never-10", 10, false);
    await payload(short.clinicId, "done-10", 10, true);
    await payload(short.clinicId, "done-3", 3, true);

    const left = async (clinicId: string) => {
      await withTenant({ clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));
      return inTenant(clinicId, async (client) =>
        (
          await client.query<{ delivery_id: string }>(
            `select delivery_id from webhook_events order by delivery_id`,
          )
        ).rows.map((r) => r.delivery_id),
      );
    };
    expect(await left(c.clinicId)).toEqual(["done-20", "never-60"]);
    expect(await left(short.clinicId)).toEqual(["done-3"]);
  });

  test("a sync run that crashed does not hold the purge off a clinic for good", async () => {
    const c = await seedClinic("purge-stale-sync");
    await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 200 * DAY) });
    const run = async (startedHoursAgo: number) =>
      inTenant(c.clinicId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into provider_connections
             (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
           values ($1, 'mindbody', 'active', 'x', 'x', 'x', 'x', 'v1', 1)
           on conflict do nothing returning id`,
          [c.clinicId],
        );
        const connection =
          rows[0]?.id ??
          (await client.query<{ id: string }>(`select id from provider_connections limit 1`)).rows[0]!.id;
        await client.query(
          `insert into sync_runs (clinic_id, connection_id, resource, status, started_at)
           values ($1, $2, 'appointments', 'running', $3)`,
          [c.clinicId, connection, new Date(now.getTime() - startedHoursAgo * 60 * 60 * 1000)],
        );
      });

    // A run in flight, started an hour ago, holds it.
    await run(1);
    const held = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, now));
    expect(held.skipped).toBe("sync_running");
    expect(await count(c.clinicId, "conversations")).toBe(1);

    // Two days later the same row is a crashed run's: the purge goes ahead.
    const later = new Date(now.getTime() + 2 * DAY);
    const result = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      purgeClinic(tx, later),
    );
    expect(result.skipped).toBeNull();
    expect(await count(c.clinicId, "conversations")).toBe(0);
  });

  test("a clinic held at 03 by the night's sync is purged at 09 the same day, not never", async () => {
    // The nightly sync starts at 02 and holds a clinic's purge for six hours,
    // and the purge ran only at 03: a clinic whose sync was slow or crashed
    // every night was never purged.
    const c = await seedClinic("purge-held-0902");
    const night = new Date("2026-09-13T02:00:00Z");
    await seedConversation(c.clinicId, { startedAt: new Date(night.getTime() - 200 * DAY) });
    await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'mindbody', 'active', 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
        [c.clinicId],
      );
      await client.query(
        `insert into sync_runs (clinic_id, connection_id, resource, status, started_at)
         values ($1, $2, 'appointments', 'running', $3)`,
        [c.clinicId, rows[0]!.id, night],
      );
    });
    await setJobEnabled(JOB_RETENTION_PURGE, true, c.staffUserId);
    try {
      const at03 = await runTick(new Date("2026-09-13T03:00:00Z"));
      expect(at03.find((o) => o.job === "retention-purge")?.status).toBe("ok");
      expect(await count(c.clinicId, "conversations")).toBe(1);
      const at09 = await runTick(new Date("2026-09-13T09:00:00Z"));
      expect(at09.find((o) => o.job === "retention-purge")?.status).toBe("ok");
      expect(await count(c.clinicId, "conversations")).toBe(0);
    } finally {
      await setJobEnabled(JOB_RETENTION_PURGE, false, c.staffUserId);
    }
  });

  test("the job ships off; off, it purges every clinic on BAA 1.3.0 or later or the DPA, and on, every clinic", async () => {
    expect((await getJob(JOB_RETENTION_PURGE))?.enabled).toBe(false);
    const bound = async (label: string, version: string | null) => {
      const c = await seedClinic(label);
      if (version) {
        await getMigratorPool().query(
          `insert into baa_acceptances
             (organization_id, document_version, document_hash, rendered_text, variables, assent_label,
              accepted_by_name, accepted_by_email, accepted_at, bound_at)
           values ($1, $2, repeat('c', 64), 'AGREEMENT (test)', '{}'::jsonb, 'I agree', 'Alex Chen',
                   'alex@purge.test', now() - interval '1 year', now() - interval '1 year')`,
          [c.organizationId, version],
        );
      }
      await seedConversation(c.clinicId, { startedAt: new Date(now.getTime() - 200 * DAY) });
      return c.clinicId;
    };
    const v130 = await bound("purge-130", "1.3.0");
    const dpa = await bound("purge-dpa", "dpa/1.0.0");
    const v121 = await bound("purge-121", "1.2.1");
    const none = await bound("purge-none", null);

    // Switched off: the job runs all the same for the agreements that state
    // the purge's periods, and only for them.
    const off = await runRetentionPurgeJob({ now });
    expect(off.status).toBe("ok");
    expect(off.status === "ok" ? off.note : "").toMatch(/^Switched off: only the clinics on BAA 1\.3\.0/);
    expect(await count(v130, "conversations")).toBe(0);
    expect(await count(dpa, "conversations")).toBe(0);
    expect(await count(v121, "conversations")).toBe(1);
    expect(await count(none, "conversations")).toBe(1);

    // Switched on (the ops step at release): every clinic.
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ('usr_purge_ops', 'Ops', 'ops-purge@healdesk.test', true, now(), now()) returning id`,
    );
    await setJobEnabled(JOB_RETENTION_PURGE, true, rows[0]!.id);
    const on = await runRetentionPurgeJob({ now });
    expect(on.status).toBe("ok");
    expect(await count(v121, "conversations")).toBe(0);
    expect(await count(none, "conversations")).toBe(0);
    const sweep = await sweepRetention(now);
    expect(sweep.failures).toEqual([]);
    expect(sweep.clinicsConsidered).toBeGreaterThan(0);
  });

  test("which agreements promise the purge: BAA 1.3.0 and every later version, and the DPA; none of the earlier versions", () => {
    for (const t of BAA_TEMPLATES) {
      expect(purgeIsPromised(t.version), t.version).toBe(
        !["1.2.1", "1.2.0", "1.1.0-draft", "1.0.0", "0.1.0-draft"].includes(t.version),
      );
    }
    expect(purgeIsPromised("1.3.0")).toBe(true);
    expect(purgeIsPromised("1.4.0")).toBe(true);
    for (const t of DPA_TEMPLATES) expect(purgeIsPromised(t.version), t.version).toBe(true);
    expect(purgeIsPromised(null)).toBe(false);
  });
});
