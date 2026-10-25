import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Lane P6h: the weekly compliance pack. The week and its due moment on New
 * York's clock in both seasons; the table that refuses every change for
 * every role and anything shaped like an address or a phone number; a pack
 * that is a pure function of the database and the week, with zeros only
 * where a read worked and `could_not_read` where it did not; a payload with
 * no free text; the job off by default, once per week, telling the owner
 * once and only the ops address, and alerting when the same week fails
 * twice; and the three operations. Every clock is the test's.
 *
 * compliance_packs can never be emptied (its triggers refuse TRUNCATE, the
 * migrator included), so every week this file stores is drawn at random
 * from the past: a second run of the file never meets the first one's rows.
 */

const state = vi.hoisted(() => ({
  extraClinics: [] as { id: string }[],
  clinicsThrow: false,
  sent: [] as { to: string; kind: string; subject: string; text: string; html: string }[],
}));

vi.mock("@/lib/ops/clinics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ops/clinics")>();
  return {
    ...real,
    listClinics: async () => {
      if (state.clinicsThrow) throw new Error("clinic list unreachable (test)");
      return [...(await real.listClinics()), ...(state.extraClinics as never[])];
    },
  };
});

vi.mock("@/lib/email/send", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...real,
    sendEmail: async (message: { to: string; kind: string; subject: string; text: string; html: string }) => {
      state.sent.push({ to: message.to, kind: message.kind, subject: message.subject, text: message.text, html: message.html });
      return { status: "sent", messageId: `test-${state.sent.length}` };
    },
  };
});

import { buildCompliancePack, headlineOf, median, rightsSection, unreadSections, type CompliancePack } from "@/lib/compliance-pack/build";
import { JOB_COMPLIANCE_PACK, readyFields, runCompliancePackJob } from "@/lib/compliance-pack/job";
import { canonicalJson, getPack, packHash } from "@/lib/compliance-pack/store";
import { dueWeekStart, isWeekStart, packWeek } from "@/lib/compliance-pack/week";
import { isMutating, runOperation, type Operator } from "@/lib/ops/api";
import { addLocalDays } from "@/lib/scheduler/summary-clock";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedDemoClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "203.0.113.9", userAgent: "vitest" } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Monday drawn from the past (2000 to 2024), never the same twice in a run. */
const used = new Set<string>();
function randomPastWeek(): string {
  for (;;) {
    const start = addLocalDays("2000-01-03", 7 * Math.floor(Math.random() * 1300));
    if (!used.has(start)) {
      used.add(start);
      return start;
    }
  }
}

// -----------------------------------------------------------------------------
// The week (pure)
// -----------------------------------------------------------------------------

describe("the week, on New York's clock", () => {
  test("a week starts on a Monday, and only a real Monday is one", () => {
    expect(isWeekStart("2026-10-19")).toBe(true);
    expect(isWeekStart("2026-10-20")).toBe(false);
    expect(isWeekStart("2026-02-30")).toBe(false);
    expect(isWeekStart("2026-10-19T00:00:00Z")).toBe(false);
    expect(isWeekStart(20261019)).toBe(false);
    expect(() => packWeek("2026-10-21")).toThrow(RangeError);
  });

  test("summer: the week is 168 hours and is due at 11:00 UTC on the next Monday", () => {
    const w = packWeek("2026-10-19");
    expect(w.from.toISOString()).toBe("2026-10-19T04:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(w.dueAt.toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(w.lastDay).toBe("2026-10-25");
    expect(dueWeekStart(new Date("2026-10-26T10:59:59.999Z"))).toBe("2026-10-12");
    expect(dueWeekStart(new Date("2026-10-26T11:00:00.000Z"))).toBe("2026-10-19");
    expect(dueWeekStart(new Date("2026-11-01T23:00:00.000Z"))).toBe("2026-10-19");
  });

  test("autumn: the week the clocks go back is 169 hours, and its pack is due at 12:00 UTC", () => {
    // New York leaves daylight time at 02:00 on Sunday 1 November 2026.
    const w = packWeek("2026-10-26");
    expect(w.from.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect((w.to.getTime() - w.from.getTime()) / 3_600_000).toBe(169);
    expect(w.dueAt.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(dueWeekStart(new Date("2026-11-02T11:00:00.000Z"))).toBe("2026-10-19");
    expect(dueWeekStart(new Date("2026-11-02T11:59:59.999Z"))).toBe("2026-10-19");
    expect(dueWeekStart(new Date("2026-11-02T12:00:00.000Z"))).toBe("2026-10-26");
  });

  test("spring: the week the clocks go forward is 167 hours, and the next is due at 11:00 UTC", () => {
    // New York enters daylight time at 02:00 on Sunday 14 March 2027.
    const w = packWeek("2027-03-08");
    expect(w.from.toISOString()).toBe("2027-03-08T05:00:00.000Z");
    expect(w.to.toISOString()).toBe("2027-03-15T04:00:00.000Z");
    expect((w.to.getTime() - w.from.getTime()) / 3_600_000).toBe(167);
    expect(w.dueAt.toISOString()).toBe("2027-03-15T11:00:00.000Z");
    expect(dueWeekStart(new Date("2027-03-15T10:59:59.999Z"))).toBe("2027-03-01");
    expect(dueWeekStart(new Date("2027-03-15T11:00:00.000Z"))).toBe("2027-03-08");
    // A winter Monday: due at 12:00 UTC.
    expect(packWeek("2027-01-04").dueAt.toISOString()).toBe("2027-01-11T12:00:00.000Z");
  });

  test("the hourly tick meets the due hour in both seasons", () => {
    // The tick runs at every UTC hour; the due week moves at exactly one of them.
    const summer = Array.from({ length: 24 }, (_, h) => dueWeekStart(new Date(Date.UTC(2026, 9, 26, h))));
    expect(summer.indexOf("2026-10-19")).toBe(11);
    const winter = Array.from({ length: 24 }, (_, h) => dueWeekStart(new Date(Date.UTC(2026, 10, 2, h))));
    expect(winter.indexOf("2026-10-26")).toBe(12);
  });
});

// -----------------------------------------------------------------------------
// Pure pieces
// -----------------------------------------------------------------------------

describe("the pack's pure pieces", () => {
  test("the median is the middle, or the mean of the two middles, rounded", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 6])).toBe(3);
  });

  test("the canonical JSON sorts keys at every depth, so the hash survives jsonb's reordering", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}');
    expect(packHash({ b: 1, a: 2 })).toBe(packHash({ a: 2, b: 1 }));
    expect(packHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a section that could not be read gives no headline number, and the pointer leaves it out", () => {
    const pack = {
      schema: 1,
      week: { start: "2026-10-19", lastDay: "2026-10-25", timeZone: "America/New_York", from: "", to: "" },
      agreements: { status: "could_not_read", unreadClinics: 1 },
      vendors: { status: "ok", subjects: [], recordedThisWeek: 0 },
      incidents: { status: "could_not_read" },
      rights: rightsSection([], { start: "2026-10-19", lastDay: "2026-10-25" }),
      dataLifecycle: { status: "could_not_read" },
      access: { status: "could_not_read" },
      approvals: { status: "could_not_read" },
      launchPromises: { status: "read_on_the_console" },
    } as unknown as Omit<CompliancePack, "headline">;
    const headline = headlineOf(pack);
    expect(headline).toEqual({
      incidentsOpen: null,
      rightsOverdue: 0,
      resignsOpen: null,
      vendorsNeedingAttention: 0,
      transcriptCopiesPast30Days: null,
    });
    const full = { ...pack, headline } as CompliancePack;
    expect(unreadSections(full)).toEqual(["agreements", "incidents", "dataLifecycle", "access", "approvals"]);
    expect(readyFields(full)).toEqual({ windowStart: "2026-10-19", rightsOverdueCount: 0, vendorsCount: 0, unreadCount: 5 });
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

/** Every key a payload may hold, at any depth. A new key is a decision, made here. */
const PAYLOAD_KEYS = new Set([
  "schema", "week", "start", "lastDay", "timeZone", "from", "to", "headline",
  "incidentsOpen", "rightsOverdue", "resignsOpen", "vendorsNeedingAttention", "transcriptCopiesPast30Days",
  "agreements", "status", "unreadClinics", "signed", "kind", "version", "count",
  "resigns", "openedThisWeek", "signedThisWeek", "withdrawnThisWeek", "openAtWeekEnd", "belowFloorAtWeekEnd",
  "reviews", "decidedThisWeek",
  "vendors", "subjects", "subject", "state", "effectiveOn", "expiresOn", "expiresWithin30Days", "recordedThisWeek",
  "incidents", "openedByClass", "class", "notifiedThisWeek", "reportedThisWeek", "notReportableThisWeek",
  "resolvedThisWeek", "targetMissed", "clinicId", "incidentId", "agreementDeadlineAtRisk", "agreementNotifyBy",
  "rights", "receivedThisWeek", "receivedByKind", "closedThisWeek", "closedOnTimeThisWeek", "closedLateThisWeek",
  "overdueAtWeekEnd", "dueSoonAtWeekEnd", "blockedNow",
  "dataLifecycle", "transcripts", "queuedThisWeek", "deliveredThisWeek", "copiesPast30DaysNow", "jobs", "job",
  "enabled", "lastRunAt", "lastRunStatus", "failureAlertsThisWeek", "event",
  "access", "events", "freshCodeSteps", "approvalDecisions", "platformAttestations", "deviceRecoveriesIssued",
  "operatorSignIns",
  "approvals", "approvedThisWeek", "rejectedThisWeek", "executedThisWeek", "failedThisWeek", "expiredThisWeek",
  "medianMinutesToDecide", "waitingAtWeekEnd",
  "launchPromises",
]);
/** A string a payload may hold: a uuid, a day, an instant, a version, a time zone or a closed word. */
const PAYLOAD_STRING =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|(?:dpa\/)?\d+\.\d+\.\d+(?:-[a-z]+)?|America\/New_York|[a-z][a-z0-9_-]{0,40})$/;

function walk(value: unknown, keys: Set<string>, strings: string[]): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      walk(v, keys, strings);
    }
  } else if (typeof value === "string") strings.push(value);
}

function expectNoFreeText(pack: unknown): void {
  const keys = new Set<string>();
  const strings: string[] = [];
  walk(pack, keys, strings);
  for (const key of keys) expect(PAYLOAD_KEYS.has(key), `key ${key}`).toBe(true);
  for (const s of strings) expect(s, "a string in the pack").toMatch(PAYLOAD_STRING);
  expect(JSON.stringify(pack)).not.toContain("@");
}

const at = (iso: Date, hours: number) => new Date(iso.getTime() + hours * 3_600_000);

describeDb("the compliance pack, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    vi.unstubAllEnvs();
    vi.stubEnv("HEALDESK_OPS_EMAIL", "owner-ops@healdesk.test");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.test");
    state.extraClinics = [];
    state.clinicsThrow = false;
    state.sent = [];
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePools();
  });

  test("a stored pack can never be changed, deleted or truncated, by the runtime role or the migrator", async () => {
    const week = randomPastWeek();
    const app = getAppPool();
    await app.query(
      `insert into compliance_packs (week_start, payload, payload_hash, generated_by) values ($1, '{"schema":1}', repeat('a', 64), 'compliance-pack')`,
      [week],
    );
    for (const pool of [app, getMigratorPool()]) {
      await expect(pool.query(`update compliance_packs set payload = '{}' where week_start = $1`, [week])).rejects.toThrow();
      await expect(pool.query(`delete from compliance_packs where week_start = $1`, [week])).rejects.toThrow();
      await expect(pool.query(`truncate compliance_packs`)).rejects.toThrow();
    }
    // The migrator's refusal is the trigger's, whatever its privileges.
    await expect(getMigratorPool().query(`update compliance_packs set generated_by = 'x' where week_start = $1`, [week])).rejects.toThrow(
      /written once and never changed/,
    );
    // ENABLE ALWAYS: a session in replica mode does not skip them either.
    const { rows: triggers } = await getMigratorPool().query(
      `select tgname, tgenabled from pg_trigger where tgrelid = 'compliance_packs'::regclass and not tgisinternal order by tgname`,
    );
    expect(triggers).toEqual([
      { tgname: "compliance_packs_immutable", tgenabled: "A" },
      { tgname: "compliance_packs_no_truncate", tgenabled: "A" },
    ]);
    const { rows } = await app.query(`select count(*)::int as n from compliance_packs where week_start = $1`, [week]);
    expect(rows[0]!.n).toBe(1);
    // A second pack for the same week is refused by the key.
    await expect(
      app.query(`insert into compliance_packs (week_start, payload, payload_hash, generated_by) values ($1, '{}', repeat('b', 64), 'x')`, [week]),
    ).rejects.toMatchObject({ constraint: "compliance_packs_week_key" });
  });

  test("the table refuses an address, a phone number, a day that is not a Monday, a bad hash and a bad service name", async () => {
    const app = getAppPool();
    const insert = (week: string, payload: string, hash = "a".repeat(64), by = "compliance-pack") =>
      app.query(`insert into compliance_packs (week_start, payload, payload_hash, generated_by) values ($1, $2::jsonb, $3, $4)`, [
        week,
        payload,
        hash,
        by,
      ]);
    const week = randomPastWeek();
    await expect(insert(week, '{"x":"owner@clinic.test"}')).rejects.toMatchObject({ constraint: "compliance_packs_payload_check" });
    await expect(insert(week, '{"x":"555 123 4567"}')).rejects.toMatchObject({ constraint: "compliance_packs_payload_check" });
    await expect(insert(week, '{"x":5551234567}')).rejects.toMatchObject({ constraint: "compliance_packs_payload_check" });
    await expect(insert(week, '["not an object"]')).rejects.toMatchObject({ constraint: "compliance_packs_payload_check" });
    await expect(insert(addLocalDays(week, 1), "{}")).rejects.toMatchObject({ constraint: "compliance_packs_week_check" });
    await expect(insert(week, "{}", "XYZ")).rejects.toMatchObject({ constraint: "compliance_packs_hash_check" });
    await expect(insert(week, "{}", "a".repeat(64), "Ops Console")).rejects.toMatchObject({ constraint: "compliance_packs_generated_by_check" });
    // Uuids and ISO instants are not phone numbers.
    await insert(week, `{"id":"${randomUUID()}","at":"2026-10-19T04:00:00.000Z","n":123456}`);
  });

  test("a week with nothing in it is a pack of zeros, every section read, and the same twice", async () => {
    await seedClinic("pack-empty");
    const week = randomPastWeek();
    const first = await buildCompliancePack(week);
    const second = await buildCompliancePack(week);
    expect(second).toEqual(first);
    expect(packHash(second)).toBe(packHash(first));
    expect(unreadSections(first)).toEqual([]);
    expect(first.headline).toEqual({
      incidentsOpen: 0,
      rightsOverdue: 0,
      resignsOpen: 0,
      // No vendor is attested in an empty database: all four need a person.
      vendorsNeedingAttention: 4,
      transcriptCopiesPast30Days: 0,
    });
    expect(first.agreements).toMatchObject({ status: "ok", signed: [], resigns: { openAtWeekEnd: 0 }, reviews: { openAtWeekEnd: 0 } });
    expect(first.incidents).toMatchObject({ status: "ok", openedThisWeek: 0, targetMissed: [], agreementDeadlineAtRisk: [] });
    expect(first.access).toMatchObject({ status: "ok", operatorSignIns: "not_recorded_on_the_host" });
    expect(first.approvals).toMatchObject({ status: "ok", medianMinutesToDecide: null, waitingAtWeekEnd: 0 });
    expect(first.launchPromises).toEqual({ status: "read_on_the_console" });
    expectNoFreeText(first);
  });

  test("a seeded week counts what happened in it, at New York's midnight, and leaves demo clinics out", async () => {
    const week = randomPastWeek();
    const w = packWeek(week);
    const live = await seedClinic("pack-live");
    const demo = await seedDemoClinic("pack-demo");
    const migrator = getMigratorPool();

    // Incidents: one opened in the week and still open, its 24-hour target
    // missed and its agreement deadline inside 14 days; one opened the week
    // before and resolved in it; one opened a minute after the week ended.
    for (const clinic of [live.clinicId, demo.clinicId]) {
      await inTenant(clinic, async (q) => {
        await q.query(
          `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, agreement_notify_by, opened_by)
           values ($1, 'security_incident', 'synthetic: a laptop left on a train', $2, $3, $4, 'ops')`,
          [clinic, at(w.from, 30), at(w.from, 54), at(w.to, 24 * 5)],
        );
        await q.query(
          `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, notified_at, notified_how, resolved_at, opened_by)
           values ($1, 'breach', 'synthetic: resolved', $2, $3, $4, 'phone', $5, 'ops')`,
          [clinic, at(w.from, -48), at(w.from, -24), at(w.from, -30), at(w.from, 10)],
        );
        await q.query(
          `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, opened_by)
           values ($1, 'service_complaint', 'synthetic: next week', $2, $3, 'ops')`,
          [clinic, at(w.to, 0.02), at(w.to, 24)],
        );
      });
    }
    const [{ id: openIncident }] = (
      await inTenant(live.clinicId, (q) =>
        q.query<{ id: string }>(`select id from incidents where clinic_id = $1 and class = 'security_incident'`, [live.clinicId]),
      )
    ).rows as [{ id: string }];

    // A re-sign opened in the week, still open at its end.
    const agreementId = await bindAgreementInEffect(live.clinicId);
    await inTenant(live.clinicId, (q) =>
      q.query(
        `insert into agreement_resigns (clinic_id, from_agreement_id, reason, source, requested_by, started_at)
         values ($1, $2, 'baa_version', 'operator', 'ops', $3)`,
        [live.clinicId, agreementId, at(w.from, 50)],
      ),
    );
    // A signature in the week (the factory's is a month before now, so add one dated inside).
    await migrator.query(
      `insert into baa_acceptances (id, organization_id, document_version, document_hash, rendered_text, variables, assent_label,
         accepted_by_name, accepted_by_email, accepted_at)
       values ($1, $2, '1.5.1', repeat('f', 64), 'AGREEMENT (synthetic test)', '{}'::jsonb, 'I agree', 'Alex Chen', 'alex@agreement.test', $3)`,
      [randomUUID(), live.organizationId, at(w.from, 3)],
    );

    // Patient rights: an erasure received on the week's Tuesday, ten business days to run, still open.
    const tuesday = addLocalDays(week, 1);
    await inTenant(live.clinicId, (q) =>
      q.query(
        `insert into rights_intakes (clinic_id, request_key, kind, received_on, verified_via, due_on, recorded_by)
         values ($1, gen_random_uuid(), 'erasure', $2, 'notice_address', $3, 'ops')`,
        [live.clinicId, tuesday, addLocalDays(tuesday, 14)],
      ),
    );

    // The vendor chain: AWS attested in the week, lapsing within 30 days; Anthropic withdrawn before it.
    await migrator.query(
      `insert into platform_compliance (subject, action, document_ref, effective_on, expires_on, actor_label, recorded_at)
       values ('aws', 'attested', 'synthetic ref', $1, $2, 'ops', $3),
              ('anthropic', 'attested', 'synthetic ref', $1, null, 'ops', $4),
              ('anthropic', 'withdrawn', 'synthetic ref', $1, null, 'ops', $5)`,
      [week, addLocalDays(week, 20), at(w.from, 5), at(w.from, -500), at(w.from, -400)],
    );

    // The access log: two passkeys and one approval decided with a fresh code, inside; one just outside.
    for (const [event, when, meta] of [
      ["passkey_added", at(w.from, 1), null],
      ["passkey_added", at(w.to, -1), null],
      ["approval_approved", at(w.from, 2), { freshCode: true }],
      ["passkey_added", at(w.to, 0), null],
    ] as const) {
      await migrator.query(`insert into security_events (event, actor_label, occurred_at, metadata) values ($1, 'ops', $2, $3)`, [
        event,
        when,
        meta ? JSON.stringify(meta) : null,
      ]);
    }

    // The approval inbox: one proposed in the week and approved 90 minutes later.
    const approval = randomUUID();
    await migrator.query(
      `insert into ops_approvals (id, kind, subject_ref, payload, due_at, urgency, proposed_by, proposed_at)
       values ($1, 'billing_request_retry', $2, '{}'::jsonb, $3, 'money', 'approvals-propose', $4)`,
      [approval, `pack-test:${randomUUID()}`, at(w.from, 30), at(w.from, 6)],
    );
    await migrator.query(`update ops_approvals set status = 'approved', decided_at = $2 where id = $1`, [approval, at(w.from, 7.5)]);
    await migrator.query(
      `insert into ops_approval_events (approval_id, event, actor_label, at) values ($1, 'proposed', 'approvals-propose', $2), ($1, 'approved', 'ops', $3)`,
      [approval, at(w.from, 6), at(w.from, 7.5)],
    );

    const pack = await buildCompliancePack(week);
    expect(unreadSections(pack)).toEqual([]);
    expect(pack.incidents).toMatchObject({
      status: "ok",
      openedThisWeek: 1,
      openedByClass: [{ class: "security_incident", count: 1 }],
      resolvedThisWeek: 1,
      openAtWeekEnd: 1,
      targetMissed: [{ clinicId: live.clinicId, incidentId: openIncident }],
      agreementDeadlineAtRisk: [{ clinicId: live.clinicId, incidentId: openIncident, agreementNotifyBy: at(w.to, 120).toISOString() }],
    });
    expect(pack.agreements).toMatchObject({
      status: "ok",
      signed: [{ kind: "baa", version: "1.5.1", count: 1 }],
      resigns: { openedThisWeek: 1, openAtWeekEnd: 1, signedThisWeek: 0 },
    });
    expect(pack.rights).toMatchObject({
      status: "ok",
      receivedThisWeek: 1,
      receivedByKind: [{ kind: "erasure", count: 1 }],
      openAtWeekEnd: 1,
      overdueAtWeekEnd: 0,
    });
    const vendors = pack.vendors.status === "ok" ? pack.vendors.subjects : [];
    expect(vendors.find((s) => s.subject === "aws")).toMatchObject({ state: "in_force", expiresWithin30Days: true });
    expect(vendors.find((s) => s.subject === "anthropic")).toMatchObject({ state: "withdrawn" });
    expect(vendors.find((s) => s.subject === "retell")).toMatchObject({ state: "not_attested" });
    expect(pack.access).toMatchObject({ status: "ok", freshCodeSteps: { approvalDecisions: 1, platformAttestations: 1 } });
    const events = pack.access.status === "ok" ? pack.access.events : [];
    expect(events.find((e) => e.event === "passkey_added")?.count).toBe(2);
    expect(pack.approvals).toMatchObject({ status: "ok", approvedThisWeek: 1, medianMinutesToDecide: 90 });
    expect(pack.headline).toEqual({
      incidentsOpen: 1,
      rightsOverdue: 0,
      resignsOpen: 1,
      vendorsNeedingAttention: 4,
      transcriptCopiesPast30Days: 0,
    });
    expectNoFreeText(pack);
    // The synthetic incident summary and the document reference never reach the pack.
    expect(JSON.stringify(pack)).not.toMatch(/laptop|synthetic|Alex/);
    // The same database and week: the same pack.
    expect(packHash(await buildCompliancePack(week))).toBe(packHash(pack));
  });

  test("a clinic that cannot be read makes its sections could_not_read, never zero", async () => {
    await seedClinic("pack-unread");
    state.extraClinics = [{ id: "not-a-clinic-id" }];
    const pack = await buildCompliancePack(randomPastWeek());
    for (const section of ["agreements", "incidents", "rights", "dataLifecycle"] as const) {
      expect(pack[section], section).toMatchObject({ status: "could_not_read" });
      expect(Object.keys(pack[section]).sort(), section).toEqual(["status", "unreadClinics"]);
    }
    expect(pack.headline).toMatchObject({ incidentsOpen: null, rightsOverdue: null, resignsOpen: null, transcriptCopiesPast30Days: null });
    expect(pack.vendors.status).toBe("ok");
    expect(readyFields(pack)).toMatchObject({ unreadCount: 4 });
    expect(readyFields(pack)).not.toHaveProperty("incidentsOpenCount");
  });

  test("the job is off by default, stores the due week once, and tells only the ops address, once", async () => {
    await seedClinic("pack-job");
    const week = randomPastWeek();
    const due = packWeek(week).dueAt;
    const app = getAppPool();
    const count = async () => (await app.query(`select count(*)::int as n from compliance_packs where week_start = $1`, [week])).rows[0]!.n;

    expect(await runCompliancePackJob({ now: due })).toEqual({ status: "disabled" });
    expect(await count()).toBe(0);

    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    // A minute before 07:00 New York, the week before is the one due.
    const early = await runCompliancePackJob({ now: new Date(due.getTime() - 60_000) });
    expect(early.status).toBe("ok");
    expect(await count()).toBe(0);
    const firstWeek = addLocalDays(week, -7);
    expect(early).toMatchObject({ note: `week ${firstWeek}: stored` });
    state.sent = [];

    const stored = await runCompliancePackJob({ now: due });
    expect(stored).toMatchObject({ status: "ok", note: `week ${week}: stored` });
    expect(await count()).toBe(1);
    const again = await runCompliancePackJob({ now: new Date(due.getTime() + 3_600_000) });
    expect(again).toMatchObject({ status: "ok", note: `week ${week}: already stored` });
    expect(await count()).toBe(1);

    const row = await getPack(week);
    expect(row).toMatchObject({ weekStart: week, generatedBy: "compliance-pack", generatedAt: due.toISOString() });
    expect(row!.payloadHash).toBe(packHash(row!.payload));

    // One pointer, to the ops address only, as an ops alert with the week and the numbers.
    expect(state.sent).toHaveLength(1);
    const mail = state.sent[0]!;
    expect(mail.to).toBe("owner-ops@healdesk.test");
    expect(mail.kind).toBe("ops_alert");
    const { rows: alerts } = await app.query(
      `select fields from ops_alerts where event = 'compliance_pack_ready' and dedupe_key = $1`,
      [`key:compliance_pack_ready:${week}`],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.fields).toEqual({
      windowStart: week,
      incidentsOpenCount: 0,
      rightsOverdueCount: 0,
      resignsOpenCount: 0,
      vendorsCount: 4,
      transcriptCopiesCount: 0,
      unreadCount: 0,
    });
    expect(mail.text).toContain("Vendor agreements lapsed, withdrawn, missing or ending within 30 days: 4.");
    expect(mail.text).toContain("Incidents still open when the week ended: 0.");
    expect(mail.html).toContain("https://healdesk.test/admin/compliance");
    expect(`${mail.subject}\n${mail.text}`.match(/@/g) ?? []).toEqual([]);
    if (process.env.PACK_EMAIL_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.PACK_EMAIL_OUT}.txt`, `Subject: ${mail.subject}\n\n${mail.text}`);
      writeFileSync(`${process.env.PACK_EMAIL_OUT}.html`, mail.html);
    }
  });

  test("the same week failing twice in a row raises compliance_pack_failed, once", async () => {
    const week = randomPastWeek();
    const due = packWeek(week).dueAt;
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    state.clinicsThrow = true;
    const failed = async () =>
      (
        await getAppPool().query(`select count(*)::int as n from ops_alerts where event = 'compliance_pack_failed' and dedupe_key = $1`, [
          `key:compliance_pack_failed:${week}`,
        ])
      ).rows[0]!.n;

    expect(await runCompliancePackJob({ now: due })).toMatchObject({ status: "failed", note: `week ${week}: could not be made` });
    expect(await failed()).toBe(0);
    expect(await runCompliancePackJob({ now: at(due, 1) })).toMatchObject({
      status: "failed",
      note: `week ${week}: could not be made again; ops told`,
    });
    expect(await failed()).toBe(1);
    await runCompliancePackJob({ now: at(due, 2) });
    expect(await failed()).toBe(1);
    expect(state.sent.filter((m) => m.kind === "ops_alert")).toHaveLength(1);

    state.clinicsThrow = false;
    expect(await runCompliancePackJob({ now: at(due, 3) })).toMatchObject({ status: "ok", note: `week ${week}: stored` });
  });

  test("the three operations: read one, list the newest, and make a missed week once", async () => {
    await seedClinic("pack-ops");
    const week = randomPastWeek();
    const data = (outcome: { status: number; body: unknown }) => {
      expect(outcome.status).toBe(200);
      return (outcome.body as { data: Record<string, unknown> }).data;
    };
    expect(isMutating("generateCompliancePack")).toBe(true);
    expect(isMutating("getCompliancePack")).toBe(false);
    expect(isMutating("listCompliancePacks")).toBe(false);

    expect(data(await runOperation("getCompliancePack", { week }, OPERATOR))).toEqual({ status: "not_found" });
    expect((await runOperation("getCompliancePack", { week: addLocalDays(week, 2) }, OPERATOR)).status).toBe(400);
    expect((await runOperation("getCompliancePack", { week, extra: 1 }, OPERATOR)).status).toBe(400);

    const made = data(await runOperation("generateCompliancePack", { week }, OPERATOR));
    expect(made).toMatchObject({ status: "stored", weekStart: week, unreadSections: 0, auditRecorded: true });
    const packId = made.packId as string;
    expect(packId).toMatch(UUID);

    const { rows: events } = await getAppPool().query(
      `select actor_label, ip_address, metadata from security_events where event = 'compliance_pack_generated'`,
    );
    expect(events).toEqual([{ actor_label: "ops@healdesk.test", ip_address: "203.0.113.9", metadata: { packId } }]);

    expect(data(await runOperation("generateCompliancePack", { week }, OPERATOR))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("already stored"),
    });
    // A week that has not ended cannot be made.
    const future = addLocalDays(dueWeekStart(new Date()), 14);
    expect(data(await runOperation("generateCompliancePack", { week: future }, OPERATOR))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("has not ended"),
    });
    expect((await runOperation("generateCompliancePack", { week: addLocalDays(week, 3) }, OPERATOR)).status).toBe(400);

    expect(data(await runOperation("getCompliancePack", { week }, OPERATOR))).toMatchObject({
      status: "found",
      pack: { id: packId, weekStart: week, generatedBy: "ops-console" },
    });

    const packs = data(await runOperation("listCompliancePacks", { limit: 104 }, OPERATOR)).packs as {
      weekStart: string;
      headline: unknown;
    }[];
    expect(packs.find((p) => p.weekStart === week)?.headline).toMatchObject({ incidentsOpen: 0 });
    expect((await runOperation("listCompliancePacks", { limit: 0 }, OPERATOR)).status).toBe(400);
    // The operator's generation sends nothing: the pointer is the job's.
    expect(state.sent).toEqual([]);
  });
});
