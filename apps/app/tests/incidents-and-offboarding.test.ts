import { FAKE_GOOGLE_CLIENT, fakeGoogleCalendar, setGoogleFetch } from "@healdesk/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  addBusinessDays,
  listIncidents,
  markNotified,
  notifyDeadline,
  openIncident,
  overdueIncidents,
  ownerNotifyDeadline,
  resolveIncident,
} from "@/lib/incidents/incidents";
import {
  DESTROY_AFTER_DAYS,
  destroyDueClinics,
  dueForDestruction,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { listClinics } from "@/lib/ops/clinics";
import { amendContact, exportPatient } from "@/lib/patient-rights/export";
import { withTenant } from "@/lib/tenant";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  inTenant,
  seedCalendarTerms,
  seedClinic,
  seedContact,
  seedConversation,
  seedGoogleConnection,
} from "./setup/factories";

/**
 * The three BAA promises that were words until Phase 6: the breach clock,
 * the patient-rights export, and return-or-destroy at the end.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;

describe("incident clocks", () => {
  test("business days skip the weekend", () => {
    // Friday 11 September 2026 + 5 business days = Friday 18 September.
    expect(addBusinessDays(new Date("2026-09-11T15:00:00Z"), 5).toISOString().slice(0, 10)).toBe("2026-09-18");
    // Saturday + 1 business day = Monday.
    expect(addBusinessDays(new Date("2026-09-12T15:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-09-14");
  });

  test("a breach, a security incident and an improper use or disclosure are told within 24 hours at every clinic; a complaint gets two business days", () => {
    // BAA 1.3.0's reporting clause: immediately following discovery and in
    // any case within 24 hours, one rule for every practice (§12.14, gate 5,
    // PT-14). It replaced 1.2.1's five calendar days for a breach and five
    // business days for the other two, which 24 hours also meets. A Friday
    // discovery is due on Saturday: the clock does not wait for the week.
    const friday = new Date("2026-09-11T15:00:00Z");
    for (const cls of ["breach", "security_incident", "improper_use_or_disclosure"] as const) {
      for (const covered of [true, false, null]) {
        expect(notifyDeadline(cls, friday, covered).toISOString(), `${cls}, covered ${covered}`).toBe("2026-09-12T15:00:00.000Z");
      }
    }
    // Not a BAA clock: a service promise of a first reply in two business days.
    expect(notifyDeadline("service_complaint", friday, true).toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(notifyDeadline("service_complaint", friday, false).toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  test("a breach at a clinic outside HIPAA runs the clinic's own 30-day clock beside the 24 hours", () => {
    // The state-law clause's "immediately following discovery" (Cal. Civ.
    // Code 1798.82(b)) is 24 hours too, and the earlier clock is kept. The
    // second clock is the owner's, 1798.82(a)(2)(A): 30 days.
    const friday = new Date("2026-09-11T15:00:00Z");
    expect(notifyDeadline("breach", friday, false).toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(ownerNotifyDeadline("breach", friday, false)?.toISOString()).toBe("2026-10-11T15:00:00.000Z");
    // Only a breach gets the second clock.
    expect(ownerNotifyDeadline("security_incident", friday, false)).toBeNull();
    expect(ownerNotifyDeadline("improper_use_or_disclosure", friday, false)).toBeNull();
    // A covered clinic gets no second one, and an undetermined one cannot
    // have gone live, so it has no real data to breach.
    expect(ownerNotifyDeadline("breach", friday, true)).toBeNull();
    expect(ownerNotifyDeadline("breach", friday, null)).toBeNull();
  });
});

describe("destruction rule", () => {
  const started = new Date("2026-06-01T00:00:00Z");
  const base = { offboardingStartedAt: started, destroyAfter: new Date(started.getTime() + 30 * DAY), exportDeliveredAt: null, destroyedAt: null };

  test("never before destroy_after, never twice, never for a clinic still subscribed", () => {
    expect(dueForDestruction({ ...base, offboardingStartedAt: null, destroyAfter: null }, new Date("2027-01-01"))).toBe(false);
    expect(dueForDestruction(base, new Date(started.getTime() + 29 * DAY))).toBe(false);
    expect(dueForDestruction({ ...base, destroyedAt: new Date() }, new Date("2027-01-01"))).toBe(false);
  });

  test("after 30 days with the export delivered; after 90 without", () => {
    const delivered = { ...base, exportDeliveredAt: new Date(started.getTime() + 5 * DAY) };
    expect(dueForDestruction(delivered, new Date(started.getTime() + 31 * DAY))).toBe(true);
    expect(dueForDestruction(base, new Date(started.getTime() + 31 * DAY))).toBe(false);
    expect(dueForDestruction(base, new Date(started.getTime() + 90 * DAY))).toBe(true);
  });
});

describeDb("incidents, exports and offboarding", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("an incident carries its deadline, shows as overdue until notified, and cannot be deleted", async () => {
    const c = await seedClinic("incident");
    const discovered = new Date("2026-09-11T15:00:00Z");
    const opened = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      openIncident(tx, {
        class: "breach",
        summary: "Recording link shared to the wrong inbox; one conversation.",
        discoveredAt: discovered,
        openedBy: "test",
        isCoveredEntity: false,
      }),
    );
    // Not a covered entity: the clinic is told within 24 hours, and its own
    // 30-day clock to tell the people affected is stored beside it.
    expect(opened.notifyBy.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(opened.ftcNotifyBy?.toISOString()).toBe("2026-10-11T15:00:00.000Z");

    const overdue = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      overdueIncidents(tx, new Date("2026-09-17T00:00:00Z")),
    );
    expect(overdue.map((i) => i.id)).toEqual([opened.id]);

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markNotified(tx, opened.id, "Phoned the practice manager, then emailed the written notice."),
    );
    const afterNotice = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      overdueIncidents(tx, new Date("2026-09-17T00:00:00Z")),
    );
    expect(afterNotice).toEqual([]);

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => resolveIncident(tx, opened.id, "Link revoked; recipient confirmed deletion."));
    const open = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => listIncidents(tx, { openOnly: true }));
    expect(open).toEqual([]);
    const all = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => listIncidents(tx));
    expect(all).toHaveLength(1);

    // The runtime role has no DELETE on incidents: the record of a breach is
    // not something the application can lose.
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(client.query(`delete from incidents where id = $1`, [opened.id])).rejects.toThrow(/permission denied/);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("a covered entity's breach is told within 24 hours too and has no second clock; a complaint has a two-day reply clock", async () => {
    const c = await seedClinic("incident-ce");
    const rows = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => [
      await openIncident(tx, { class: "breach", summary: "x", openedBy: "test", isCoveredEntity: true, discoveredAt: new Date("2026-09-11T15:00:00Z") }),
      await openIncident(tx, { class: "service_complaint", summary: "y", openedBy: "test", isCoveredEntity: true, discoveredAt: new Date("2026-09-11T15:00:00Z") }),
    ]);
    expect(rows[0]!.notifyBy.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(rows[0]!.ftcNotifyBy).toBeNull();
    expect(rows[1]!.notifyBy.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  test("the patient export finds everything about one person, with the accounting beside it", async () => {
    const c = await seedClinic("export");
    const other = await seedClinic("export-other");
    const contactId = await seedContact(c.clinicId, "+15550100777");
    const { conversationId, appointmentId } = await seedConversation(c.clinicId, {
      startedAt: new Date("2026-09-01T15:00:00Z"),
      booked: true,
      contactId,
    });
    await seedContact(c.clinicId, "+15550100778"); // someone else at the same clinic
    await seedContact(other.clinicId, "+15550100777"); // same number, other clinic

    // A prior access, so the accounting has something to show.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      tx.audit.record({ action: "read", resourceType: "conversation", resourceId: conversationId, metadata: { purpose: "test" } });
    });

    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { phone: "+15550100777", requestedBy: "operator" }),
    );
    expect(bundle.contacts.map((r) => r.id)).toEqual([contactId]);
    expect(bundle.conversations.map((r) => r.id)).toEqual([conversationId]);
    expect(bundle.appointments.map((r) => r.id)).toEqual([appointmentId]);
    const priorReads = bundle.accountingOfDisclosures.filter((a) => a.action === "read");
    expect(priorReads.length).toBeGreaterThanOrEqual(1);

    // The export itself is an access, and the next accounting shows it.
    const second = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { phone: "+15550100777", requestedBy: "operator" }),
    );
    expect(second.accountingOfDisclosures.filter((a) => a.action === "export").length).toBeGreaterThanOrEqual(1);

    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportPatient(tx, { requestedBy: "operator" })),
    ).rejects.toThrow(/phone number or an email/);
  });

  test("an amendment corrects the copy and records which fields changed, not what they were", async () => {
    const c = await seedClinic("amend");
    const contactId = await seedContact(c.clinicId, "+15550100900");
    const changed = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      amendContact(tx, contactId, { fullName: "Corrected Name" }, "operator"),
    );
    expect(changed).toBe(true);
    const row = await inTenant(c.clinicId, async (client) => {
      const contact = await client.query<{ full_name: string }>(`select full_name from contacts where id = $1`, [contactId]);
      const audit = await client.query<{ metadata: Record<string, string> }>(
        `select metadata from audit_log where resource_type = 'contact_amendment' and resource_id = $1`,
        [contactId],
      );
      return { name: contact.rows[0]!.full_name, metadata: audit.rows[0]?.metadata };
    });
    expect(row.name).toBe("Corrected Name");
    expect(row.metadata?.changed).toBe("fullName");
    expect(JSON.stringify(row.metadata)).not.toContain("Synthetic Patient");

    const missing = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      amendContact(tx, "00000000-0000-4000-8000-000000000000", { fullName: "x" }, "operator"),
    );
    expect(missing).toBe(false);
  });

  test("offboarding stamps the dates, and destruction removes the patients, who messaged the clinic and the closed days but keeps the opt-outs, the audit trail and the channel history", async () => {
    const leaving = await seedClinic("offboard");
    const staying = await seedClinic("offboard-stay");
    for (const c of [leaving, staying]) {
      const contactId = await seedContact(c.clinicId, "+15550100555");
      await seedConversation(c.clinicId, { startedAt: new Date("2026-05-01T15:00:00Z"), booked: true, contactId });
      await inTenant(c.clinicId, async (client) => {
        await client.query(
          `insert into suppressions (clinic_id, phone, reason) values ($1, '+15550100555', 'stop_reply')`,
          [c.clinicId],
        );
        await client.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-25')`, [c.clinicId]);
        // Billing evidence: the plan was charged from this row.
        await client.query(`insert into channel_events (clinic_id, channel, kind) values ($1, 'voice', 'first_answer')`, [c.clinicId]);
        // Keyed hashes of who messaged the clinic, and of a message it was sent.
        await client.query(
          `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at) values ($1, 'whatsapp', 'v1:party', gen_random_uuid(), now(), now())`,
          [c.clinicId],
        );
        await client.query(`insert into meta_inbound_messages (clinic_id, platform, message_ref) values ($1, 'whatsapp', 'v1:message')`, [c.clinicId]);
      });
    }

    // The dates are the database's (app_start_offboarding): stamped now, and
    // destroy_after thirty days on.
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "customer.subscription.deleted"));
    let overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    const started = overview.offboardingStartedAt!;
    expect(Math.abs(Date.now() - started.getTime())).toBeLessThan(60_000);
    expect(overview.destroyAfter?.toISOString()).toBe(new Date(started.getTime() + DESTROY_AFTER_DAYS * DAY).toISOString());

    // Starting twice does not move the clock.
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    expect(overview.offboardingStartedAt?.toISOString()).toBe(started.toISOString());

    // Thirty-one days on. The runtime role cannot write the dates, so the
    // migrator, which owns the table, moves them back as the days would.
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = offboarding_started_at - interval '31 days',
              destroy_after = destroy_after - interval '31 days'
        where id = $1`,
      [leaving.clinicId],
    );

    // Day 31, export not yet delivered: nothing happens.
    expect(await destroyDueClinics()).toEqual([]);

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => markExportDelivered(tx, "bundle handed to the practice manager"));
    const results = await destroyDueClinics();
    expect(results.map((r) => r.clinicId)).toEqual([leaving.clinicId]);
    expect(results[0]!.deleted.conversations).toBe(1);
    expect(results[0]!.deleted.contacts).toBe(1);
    expect(results[0]!.deleted.clinic_closures).toBe(1);
    expect(results[0]!.deleted.chat_threads).toBe(1);
    expect(results[0]!.deleted.meta_inbound_messages).toBe(1);

    const left = await inTenant(leaving.clinicId, async (client) => ({
      contacts: (await client.query(`select id from contacts`)).rows.length,
      conversations: (await client.query(`select id from conversations`)).rows.length,
      appointments: (await client.query(`select id from appointments`)).rows.length,
      suppressions: (await client.query(`select id from suppressions`)).rows.length,
      audit: (await client.query(`select id from audit_log where resource_type = 'clinic_destruction'`)).rows.length,
      closures: (await client.query(`select closed_on from clinic_closures`)).rows.length,
      channelEvents: (await client.query(`select id from channel_events`)).rows.length,
      threads: (await client.query(`select party_ref from chat_threads`)).rows.length,
      messageRefs: (await client.query(`select message_ref from meta_inbound_messages`)).rows.length,
    }));
    expect(left).toEqual({ contacts: 0, conversations: 0, appointments: 0, suppressions: 1, audit: 1, closures: 0, channelEvents: 1, threads: 0, messageRefs: 0 });

    const kept = await inTenant(staying.clinicId, async (client) => ({
      contacts: (await client.query(`select id from contacts`)).rows.length,
      closures: (await client.query(`select closed_on from clinic_closures`)).rows.length,
      threads: (await client.query(`select party_ref from chat_threads`)).rows.length,
      messageRefs: (await client.query(`select message_ref from meta_inbound_messages`)).rows.length,
    }));
    expect(kept).toEqual({ contacts: 1, closures: 1, threads: 1, messageRefs: 1 });

    overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    expect(overview.destroyedAt).not.toBeNull();
    // Destroyed once: the next day's job finds nothing.
    expect(await destroyDueClinics(new Date(Date.now() + DAY))).toEqual([]);
  });

  test("destruction disconnects a Google Calendar still connected first, revokes its grant, and keeps the calendar elections", async () => {
    const google = fakeGoogleCalendar();
    google.addAccount({
      sub: "120000000000000000001",
      email: "bookings@leaving.test",
      hd: "leaving.test",
    });
    const { refreshToken } = google.grant({ sub: "120000000000000000001" });
    setGoogleFetch(google.fetch);
    const env = {
      id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    };
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
    try {
      const leaving = await seedClinic("offboard-calendar");
      await seedCalendarTerms(leaving);
      await seedGoogleConnection(leaving.clinicId, { refreshToken });
      await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
        startOffboarding(tx, "operator"),
      );
      await getMigratorPool().query(
        `update clinics
            set offboarding_started_at = offboarding_started_at - interval '31 days',
                destroy_after = destroy_after - interval '31 days'
          where id = $1`,
        [leaving.clinicId],
      );
      await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
        markExportDelivered(tx, "handed over"),
      );

      const results = await destroyDueClinics();
      expect(results.map((r) => r.clinicId)).toEqual([leaving.clinicId]);
      expect(results[0]!.deleted.provider_connections).toBe(1);
      expect(google.grantOf(refreshToken)?.revoked).toBe(true);

      const left = await inTenant(leaving.clinicId, async (client) => ({
        connections: (await client.query(`select id from provider_connections`)).rows.length,
        elections: (await client.query(`select id from calendar_elections`)).rows.length,
        disconnected: (
          await client.query(
            `select id from audit_log where metadata ->> 'disconnected' = 'offboarding'`,
          )
        ).rows.length,
      }));
      expect(left).toEqual({ connections: 0, elections: 1, disconnected: 1 });
    } finally {
      setGoogleFetch(undefined);
      if (env.id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = env.id;
      if (env.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = env.secret;
    }
  });
});
