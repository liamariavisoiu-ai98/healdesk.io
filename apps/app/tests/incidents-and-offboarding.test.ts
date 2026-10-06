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

import { closePools, getAppPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

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

  test("each class gets the deadline the agreement names", () => {
    const friday = new Date("2026-09-11T15:00:00Z");
    expect(notifyDeadline("breach", friday, true).toISOString()).toBe("2026-09-16T15:00:00.000Z"); // 5 calendar days
    expect(notifyDeadline("security_incident", friday, true).toISOString().slice(0, 10)).toBe("2026-09-18");
    expect(notifyDeadline("improper_use_or_disclosure", friday, true).toISOString().slice(0, 10)).toBe("2026-09-18");
    expect(notifyDeadline("service_complaint", friday, true).toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  test("a breach at a clinic outside HIPAA is told within 24 hours, and the clinic's own 30-day clock runs beside it", () => {
    // BAA 1.3.0's state-law clause: "immediately following discovery", as
    // Cal. Civ. Code 1798.82(b) requires of a business holding data for its
    // owner. The second clock is the owner's, 1798.82(a)(2)(A): 30 days.
    const friday = new Date("2026-09-11T15:00:00Z");
    expect(notifyDeadline("breach", friday, false).toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(ownerNotifyDeadline("breach", friday, false)?.toISOString()).toBe("2026-10-11T15:00:00.000Z");
    // Only a breach changes; the other classes keep the agreement's clocks.
    expect(notifyDeadline("security_incident", friday, false).toISOString().slice(0, 10)).toBe("2026-09-18");
    expect(ownerNotifyDeadline("security_incident", friday, false)).toBeNull();
    // A covered clinic keeps the BAA's clocks and gets no second one, and an
    // undetermined one cannot have gone live, so it has no real data to breach.
    expect(ownerNotifyDeadline("breach", friday, true)).toBeNull();
    expect(notifyDeadline("breach", friday, null).toISOString()).toBe("2026-09-16T15:00:00.000Z");
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

  test("a covered entity's breach keeps the five-day clock and has no second one; a complaint has a two-day reply clock", async () => {
    const c = await seedClinic("incident-ce");
    const rows = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => [
      await openIncident(tx, { class: "breach", summary: "x", openedBy: "test", isCoveredEntity: true, discoveredAt: new Date("2026-09-11T15:00:00Z") }),
      await openIncident(tx, { class: "service_complaint", summary: "y", openedBy: "test", isCoveredEntity: true, discoveredAt: new Date("2026-09-11T15:00:00Z") }),
    ]);
    expect(rows[0]!.notifyBy.toISOString()).toBe("2026-09-16T15:00:00.000Z");
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

  test("offboarding stamps the dates, and destruction removes the patients but keeps the opt-outs and the audit trail", async () => {
    const started = new Date("2026-06-01T00:00:00Z");
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
      });
    }

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "customer.subscription.deleted", started));
    let overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    expect(overview.offboardingStartedAt?.toISOString()).toBe(started.toISOString());
    expect(overview.destroyAfter?.toISOString()).toBe(new Date(started.getTime() + DESTROY_AFTER_DAYS * DAY).toISOString());

    // Starting twice does not move the clock.
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator", new Date(started.getTime() + 10 * DAY)));
    overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    expect(overview.offboardingStartedAt?.toISOString()).toBe(started.toISOString());

    // Day 31, export not yet delivered: nothing happens.
    expect(await destroyDueClinics(new Date(started.getTime() + 31 * DAY))).toEqual([]);

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => markExportDelivered(tx, "bundle handed to the practice manager", new Date(started.getTime() + 20 * DAY)));
    const results = await destroyDueClinics(new Date(started.getTime() + 31 * DAY));
    expect(results.map((r) => r.clinicId)).toEqual([leaving.clinicId]);
    expect(results[0]!.deleted.conversations).toBe(1);
    expect(results[0]!.deleted.contacts).toBe(1);

    const left = await inTenant(leaving.clinicId, async (client) => ({
      contacts: (await client.query(`select id from contacts`)).rows.length,
      conversations: (await client.query(`select id from conversations`)).rows.length,
      appointments: (await client.query(`select id from appointments`)).rows.length,
      suppressions: (await client.query(`select id from suppressions`)).rows.length,
      audit: (await client.query(`select id from audit_log where resource_type = 'clinic_destruction'`)).rows.length,
    }));
    expect(left).toEqual({ contacts: 0, conversations: 0, appointments: 0, suppressions: 1, audit: 1 });

    const kept = await inTenant(staying.clinicId, async (client) => (await client.query(`select id from contacts`)).rows.length);
    expect(kept).toBe(1);

    overview = (await listClinics()).find((c) => c.id === leaving.clinicId)!;
    expect(overview.destroyedAt).not.toBeNull();
    // Destroyed once: the next day's job finds nothing.
    expect(await destroyDueClinics(new Date(started.getTime() + 32 * DAY))).toEqual([]);
  });
});
