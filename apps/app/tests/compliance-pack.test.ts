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

import type { SQL } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { buildCompliancePack, headlineOf, median, rightsSection, unreadSections, type CompliancePack } from "@/lib/compliance-pack/build";
import { buildInfo, failedWeeksOf, JOB_COMPLIANCE_PACK, readyFields, runCompliancePackJob } from "@/lib/compliance-pack/job";
import { canonicalJson, getPack, insertPack, packHash } from "@/lib/compliance-pack/store";
import { opGenerateCompliancePack } from "@/lib/ops/pack-ops";
import { runOpsSlackSweep } from "@/lib/ops/slack";
import { opsAlertsSource } from "@/lib/ops/inbox/ops-alerts";
import type { RightsRow } from "@/lib/rights/tracker";
import { dueWeekStart, isWeekStart, packWeek } from "@/lib/compliance-pack/week";
import { isMutating, runOperation, type Operator } from "@/lib/ops/api";
import { addLocalDays } from "@/lib/scheduler/summary-clock";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedDemoClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "203.0.113.9", userAgent: "vitest" } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Consecutive Mondays drawn from the past (2000 to 2024), none of them handed
 * out before in this run, nor next to one that was: the job looks back four
 * weeks from the week it is due, so each test's weeks must never meet another's.
 */
const used = new Set<string>();
function reserveWeeks(count: number): string[] {
  for (;;) {
    const first = addLocalDays("2000-01-03", 7 * Math.floor(Math.random() * 1300));
    const run = Array.from({ length: count }, (_, i) => addLocalDays(first, 7 * i));
    const guard = Array.from({ length: count + 10 }, (_, i) => addLocalDays(first, 7 * (i - 5)));
    if (guard.some((w) => used.has(w))) continue;
    for (const w of run) used.add(w);
    return run;
  }
}
const randomPastWeek = (): string => reserveWeeks(1)[0]!;

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
    const unread = unreadSections(pack);
    expect(unread).toEqual(["agreements", "incidents", "dataLifecycle", "access", "approvals"]);
    const full = { ...pack, headline, build: buildInfo("2026-10-19", new Date("2026-10-29T12:00:00Z"), unread) } as CompliancePack;
    expect(full.build).toEqual({ partial: true, unreadSections: unread, builtLate: true, lateDays: 3 });
    expect(readyFields(full)).toEqual({
      windowStart: "2026-10-19",
      rightsOverdueCount: 0,
      vendorsCount: 0,
      unreadCount: 5,
      lateDays: 3,
    });
  });

  test("a pack made in the due hour is on time; one an hour or more later is built late", () => {
    expect(buildInfo("2026-10-19", new Date("2026-10-26T11:59:59Z"), [])).toEqual({
      partial: false,
      unreadSections: [],
      builtLate: false,
      lateDays: 0,
    });
    expect(buildInfo("2026-10-19", new Date("2026-10-26T12:00:00Z"), []).builtLate).toBe(true);
  });

  test("the job's note gives back the weeks that failed, and nothing from a run that did not fail", () => {
    expect([...failedWeeksOf("failed", "due week 2026-10-19: 3 already stored; failed 2026-10-05, 2026-10-12")]).toEqual([
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(failedWeeksOf("ok", "due week 2026-10-19: failed 2026-10-12").size).toBe(0);
    expect(failedWeeksOf("failed", "Unknown job").size).toBe(0);
  });

  test("a rights row done with no closing day is never open, overdue or closed this week", () => {
    // A standalone erasure whose subcontractor step was stamped before the
    // week: the tracker says done and keeps no closing day (closedOn null).
    const stampedErasure = {
      id: "0c1d2e3f-0000-4000-8000-000000000011",
      source: "erasure_request",
      intakeId: null,
      recordId: "0c1d2e3f-0000-4000-8000-000000000011",
      clinicId: "0c1d2e3f-0000-4000-8000-000000000001",
      clinicName: "",
      kind: "erasure",
      askedFor: null,
      verifiedVia: null,
      receivedOn: "2026-09-01",
      dueOn: "2026-09-15",
      dueDerived: false,
      daysLeft: null,
      state: "done",
      command: null,
      commandNote: null,
      retellStep: "stamped",
      backupExpiresOn: "2026-10-06",
      closedOn: null,
    } as RightsRow;
    const ranIntake = { ...stampedErasure, id: "0c1d2e3f-0000-4000-8000-000000000012", source: "intake", receivedOn: "2026-10-20", dueOn: "2026-11-03" } as RightsRow;
    const section = rightsSection([stampedErasure, ranIntake], { start: "2026-10-19", lastDay: "2026-10-25" });
    expect(section).toMatchObject({
      status: "ok",
      receivedThisWeek: 1,
      openAtWeekEnd: 0,
      overdueAtWeekEnd: 0,
      closedThisWeek: 0,
      doneWithNoClosingDayNow: 2,
    });
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

/** Every key a payload may hold, at any depth. A new key is a decision, made here. */
const PAYLOAD_KEYS = new Set([
  "schema", "week", "start", "lastDay", "timeZone", "from", "to", "headline",
  "incidentsOpen", "rightsOverdue", "resignsOpen", "vendorsNeedingAttention", "transcriptCopiesPast30Days",
  "build", "partial", "unreadSections", "builtLate", "lateDays",
  "agreements", "status", "unreadClinics", "boundThisWeek", "kind", "version", "count",
  "resigns", "openedThisWeek", "signedThisWeek", "withdrawnThisWeek", "openAtWeekEnd", "openAtWeekEndBelowFloorNow",
  "reviews", "decidedThisWeek", "openAtWeekEndNow",
  "vendors", "subjects", "subject", "state", "effectiveOn", "expiresOn", "expiresWithin30Days", "recordedThisWeek",
  "incidents", "openedByClass", "class", "notifiedThisWeek", "reportedThisWeek", "notReportableThisWeek",
  "resolvedThisWeek", "reportableOpenAtWeekEnd", "targetMissed", "clinicId", "incidentId", "agreementDeadlineAtRisk", "agreementNotifyBy",
  "rights", "receivedThisWeek", "receivedByKind", "closedThisWeek", "closedOnTimeThisWeek", "closedLateThisWeek",
  "overdueAtWeekEnd", "dueSoonAtWeekEnd", "blockedNow", "doneWithNoClosingDayNow",
  "dataLifecycle", "transcripts", "queuedThisWeek", "deliveredThisWeek", "copiesPast30DaysNow", "jobsNow", "job",
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
    // Weeks an earlier run of this file stored on the same database: never handed out again.
    const { rows } = await getMigratorPool().query<{ week: string }>(`select week_start::text as week from compliance_packs`);
    for (const { week } of rows) used.add(week);
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
    expect(first.agreements).toMatchObject({ status: "ok", boundThisWeek: [], resigns: { openAtWeekEnd: 0 }, reviews: { openAtWeekEndNow: 0 } });
    expect(first.build).toEqual({ partial: false, unreadSections: [], builtLate: false, lateDays: 0 });
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
    // Live clinic only: one discovered and resolved long before the week, its
    // target missed then (never listed); one discovered before the week and
    // resolved only after it (open at the week's end, its target missed); and
    // a service complaint open at the week's end (no agreement reports it, so
    // it stays out of the headline).
    await inTenant(live.clinicId, async (q) => {
      await q.query(
        `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, resolved_at, opened_by)
         values ($1, 'security_incident', 'synthetic: long ago', $2, $3, $4, 'ops')`,
        [live.clinicId, at(w.from, -24 * 60), at(w.from, -24 * 59), at(w.from, -24 * 50)],
      );
      await q.query(
        `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, resolved_at, opened_by)
         values ($1, 'improper_use_or_disclosure', 'synthetic: resolved after', $2, $3, $4, 'ops')`,
        [live.clinicId, at(w.from, -72), at(w.from, -48), at(w.to, 5)],
      );
      await q.query(
        `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, opened_by)
         values ($1, 'service_complaint', 'synthetic: complaint', $2, $3, 'ops')`,
        [live.clinicId, at(w.from, -100), at(w.from, 200)],
      );
    });
    const [{ id: resolvedAfter }] = (
      await inTenant(live.clinicId, (q) =>
        q.query<{ id: string }>(`select id from incidents where clinic_id = $1 and class = 'improper_use_or_disclosure'`, [live.clinicId]),
      )
    ).rows as [{ id: string }];
    const [{ id: openIncident }] = (
      await inTenant(live.clinicId, (q) =>
        q.query<{ id: string }>(`select id from incidents where clinic_id = $1 and class = 'security_incident' and resolved_at is null`, [live.clinicId]),
      )
    ).rows as [{ id: string }];

    // Re-signs: one opened in the week, still open at its end; one signed
    // exactly at the week's end (still open AT it); one signed inside it.
    const agreementId = await bindAgreementInEffect(live.clinicId);
    await inTenant(live.clinicId, async (q) => {
      for (const [started, signed] of [
        [at(w.from, 50), null],
        [at(w.from, -100), w.to],
        [at(w.from, -100), at(w.from, 20)],
      ] as const) {
        await q.query(
          `insert into agreement_resigns
             (clinic_id, from_agreement_id, reason, source, requested_by, started_at, signed_at, status,
              superseding_agreement_id, resolved_at, resolved_by)
           values ($1, $2, 'baa_version', 'operator', 'ops', $3, $4::timestamptz, $5,
                   case when $4::timestamptz is null then null else $2::uuid end, $4::timestamptz,
                   case when $4::timestamptz is null then null else 'practice' end)`,
          [live.clinicId, agreementId, started, signed, signed ? "signed" : "open"],
        );
      }
    });
    // Agreements, counted the week they were bound: one signed at checkout
    // weeks before and bound (imported at provisioning) in the week counts;
    // one signed in the week but bound after it does not.
    for (const [version, accepted, bound] of [
      ["1.5.1", at(w.from, -24 * 30), at(w.from, 3)],
      ["1.5.0", at(w.from, 4), at(w.to, 1)],
    ] as const) {
      await migrator.query(
        `insert into baa_acceptances (id, organization_id, document_version, document_hash, rendered_text, variables, assent_label,
           accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, $3, repeat('f', 64), 'AGREEMENT (synthetic test)', '{}'::jsonb, 'I agree', 'Alex Chen', 'alex@agreement.test', $4, $5)`,
        [randomUUID(), live.organizationId, version, accepted, bound],
      );
    }

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
              ('anthropic', 'withdrawn', 'synthetic ref', $1, null, 'ops', $5),
              ('retell', 'attested', 'synthetic ref', $1, null, 'ops', $6)`,
      // Retell attested at the week's end: after it, so not in force in it and not recorded in it.
      [week, addLocalDays(week, 20), at(w.from, 5), at(w.from, -500), at(w.from, -400), w.to],
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
      openAtWeekEnd: 3,
      reportableOpenAtWeekEnd: 2,
      targetMissed: [
        { clinicId: live.clinicId, incidentId: openIncident },
        { clinicId: live.clinicId, incidentId: resolvedAfter },
      ].sort((a, b) => a.incidentId.localeCompare(b.incidentId)),
      agreementDeadlineAtRisk: [{ clinicId: live.clinicId, incidentId: openIncident, agreementNotifyBy: at(w.to, 120).toISOString() }],
    });
    expect(pack.agreements).toMatchObject({
      status: "ok",
      boundThisWeek: [{ kind: "baa", version: "1.5.1", count: 1 }],
      resigns: { openedThisWeek: 1, openAtWeekEnd: 2, signedThisWeek: 1 },
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
    expect(pack.vendors).toMatchObject({ recordedThisWeek: 1 });
    expect(pack.headline).toEqual({
      incidentsOpen: 2,
      rightsOverdue: 0,
      resignsOpen: 2,
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

  test("a read of vendors, access or approvals that fails makes that section could_not_read", async () => {
    await seedClinic("pack-platform-unread");
    const original = unsafeDb.execute.bind(unsafeDb);
    const text = (q: unknown) =>
      ((q as SQL)?.queryChunks ?? []).map((c) => (Array.isArray((c as { value?: unknown }).value) ? (c as { value: string[] }).value.join("") : "")).join("");
    for (const [table, unread] of [
      ["platform_compliance", ["vendors", "access"]],
      ["security_events", ["access"]],
      ["ops_approval", ["approvals"]],
    ] as const) {
      const spy = vi.spyOn(unsafeDb, "execute").mockImplementation(((q: SQL) =>
        text(q).includes(`from ${table}`) ? Promise.reject(new Error("unreachable (test)")) : original(q)) as never);
      try {
        const pack = await buildCompliancePack(randomPastWeek());
        expect(unreadSections(pack), table).toEqual(unread);
        for (const section of unread as readonly ("vendors" | "access" | "approvals")[]) expect(pack[section], `${table} ${section}`).toEqual({ status: "could_not_read" });
        if ((unread as readonly string[]).includes("vendors")) expect(pack.headline.vendorsNeedingAttention).toBeNull();
      } finally {
        spy.mockRestore();
      }
    }
  });

  test("the job is off by default, stores the due weeks once, and tells only the ops address, once a week", async () => {
    await seedClinic("pack-job");
    const weeks = reserveWeeks(6);
    const week = weeks[5]!;
    const due = packWeek(week).dueAt;
    const app = getAppPool();
    const count = async (list: readonly string[]) =>
      (await app.query(`select count(*)::int as n from compliance_packs where week_start = any($1::date[])`, [list])).rows[0]!.n;

    expect(await runCompliancePackJob({ now: due })).toEqual({ status: "disabled" });
    expect(await count(weeks)).toBe(0);

    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    // A minute before 07:00 New York, the week before is the one due, and the four before it are filled.
    const early = await runCompliancePackJob({ now: new Date(due.getTime() - 60_000) });
    expect(early).toEqual({ status: "ok", note: `due week ${weeks[4]}: stored ${weeks.slice(0, 5).join(", ")}; 0 already stored` });
    expect(await count([week])).toBe(0);
    expect(await count(weeks.slice(0, 5))).toBe(5);
    expect(state.sent).toHaveLength(5);
    state.sent = [];

    const stored = await runCompliancePackJob({ now: due });
    expect(stored).toEqual({ status: "ok", note: `due week ${week}: stored ${week}; 4 already stored` });
    const again = await runCompliancePackJob({ now: new Date(due.getTime() + 3_600_000) });
    expect(again).toEqual({ status: "ok", note: `due week ${week}: 5 already stored` });
    expect(await count(weeks)).toBe(6);

    const row = await getPack(week);
    expect(row).toMatchObject({ weekStart: week, generatedBy: "compliance-pack", generatedAt: due.toISOString() });
    expect(row!.payloadHash).toBe(packHash(row!.payload));
    expect(row!.payload.build).toEqual({ partial: false, unreadSections: [], builtLate: false, lateDays: 0 });

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
      lateDays: 0,
    });
    expect(mail.text).toContain("Vendor agreements lapsed, withdrawn, missing or ending within 30 days: 4.");
    expect(mail.text).toContain("Incidents still open when the week ended, less service complaints: 0.");
    expect(mail.text).toContain("counted in UTC days");
    expect(mail.text).not.toMatch(/incomplete|after it was due/);
    expect(mail.html).toContain("https://healdesk.test/admin/compliance");
    expect(`${mail.subject}\n${mail.text}`.match(/@/g) ?? []).toEqual([]);
    if (process.env.PACK_EMAIL_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.PACK_EMAIL_OUT}.txt`, `Subject: ${mail.subject}\n\n${mail.text}`);
      writeFileSync(`${process.env.PACK_EMAIL_OUT}.html`, mail.html);
    }
  });

  test("a stored pack whose pointer never went is told on the next run, once", async () => {
    await seedClinic("pack-reraise");
    const weeks = reserveWeeks(5);
    const week = weeks[4]!;
    const due = packWeek(week).dueAt;
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    // Stored with no pointer, as when the ops log could not be reached.
    for (const w of weeks) await insertPack(await buildCompliancePack(w), "compliance-pack", due);
    expect(await runCompliancePackJob({ now: due })).toEqual({ status: "ok", note: `due week ${week}: 5 already stored` });
    expect(state.sent).toHaveLength(5);
    await runCompliancePackJob({ now: at(due, 1) });
    expect(state.sent).toHaveLength(5);
  });

  test("a worker down for ten days fills the gap on its first run back, each pack marked late", async () => {
    await seedClinic("pack-gap");
    const weeks = reserveWeeks(7);
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    // Running on the Monday weeks[4] fell due: weeks[0..4] stored.
    await runCompliancePackJob({ now: packWeek(weeks[4]!).dueAt });
    state.sent = [];
    // Down from then until ten days after weeks[5] fell due.
    const back = new Date(packWeek(weeks[5]!).dueAt.getTime() + 10 * 86_400_000);
    expect(await runCompliancePackJob({ now: back })).toEqual({
      status: "ok",
      note: `due week ${weeks[6]}: stored ${weeks[5]}, ${weeks[6]}; 3 already stored`,
    });
    expect((await getPack(weeks[5]!))!.payload.build).toEqual({ partial: false, unreadSections: [], builtLate: true, lateDays: 10 });
    // Three days late, give or take the hour a clock change moves a Monday's 07:00 in UTC: the
    // whole days are worked out from the week's own due time, so the test does too (a random week
    // across a change would otherwise read 2 or 3).
    const lateDays6 = Math.floor((back.getTime() - packWeek(weeks[6]!).dueAt.getTime()) / 86_400_000);
    expect([2, 3]).toContain(lateDays6);
    expect((await getPack(weeks[6]!))!.payload.build).toMatchObject({ builtLate: true, lateDays: lateDays6 });
    expect((await getPack(weeks[4]!))!.payload.build).toMatchObject({ builtLate: false });
    // One pointer per new week, each saying how late it is.
    expect(state.sent).toHaveLength(2);
    expect(state.sent.map((m) => m.text).join("\n")).toContain("It was made 10 days after it was due");
  });

  test("a week with a section unread is not stored for 48 hours, then stored as incomplete", async () => {
    await seedClinic("pack-partial");
    const weeks = reserveWeeks(5);
    const week = weeks[4]!;
    const due = packWeek(week).dueAt;
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    state.extraClinics = [{ id: "not-a-clinic-id" }];

    // The four older weeks are long past their 48 hours: stored, marked partial. The due one is not.
    const first = await runCompliancePackJob({ now: due });
    expect(first).toEqual({
      status: "failed",
      note: `due week ${week}: stored ${weeks.slice(0, 4).join(", ")}; 0 already stored; failed ${week}`,
    });
    expect(await getPack(week)).toBeNull();
    expect((await getPack(weeks[0]!))!.payload.build).toMatchObject({
      partial: true,
      unreadSections: ["agreements", "incidents", "rights", "dataLifecycle"],
    });
    expect(await runCompliancePackJob({ now: at(due, 47.9) })).toMatchObject({ status: "failed" });
    expect(await getPack(week)).toBeNull();
    state.sent = [];

    const late = await runCompliancePackJob({ now: at(due, 48) });
    expect(late).toEqual({ status: "ok", note: `due week ${week}: stored ${week}; 4 already stored` });
    const pack = (await getPack(week))!.payload;
    expect(pack.build).toEqual({
      partial: true,
      unreadSections: ["agreements", "incidents", "rights", "dataLifecycle"],
      builtLate: true,
      lateDays: 2,
    });
    expect(pack.incidents).toEqual({ status: "could_not_read", unreadClinics: 1 });
    // compliance_pack_failed went once (the second failing run); the pointer says incomplete in plain words.
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.text).toContain("This pack is incomplete: 4 sections could not be read for two days");
    expect(state.sent[0]!.text).not.toContain("Incidents still open");
  });

  test("the same week failing on two runs in a row raises compliance_pack_failed, once", async () => {
    const weeks = reserveWeeks(5);
    const week = weeks[4]!;
    const due = packWeek(week).dueAt;
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_COMPLIANCE_PACK]);
    state.clinicsThrow = true;
    const failed = async () =>
      (
        await getAppPool().query(`select count(*)::int as n from ops_alerts where event = 'compliance_pack_failed' and dedupe_key = $1`, [
          `key:compliance_pack_failed:${week}`,
        ])
      ).rows[0]!.n;

    const note = `due week ${week}: 0 already stored; failed ${weeks.join(", ")}`;
    expect(await runCompliancePackJob({ now: due })).toEqual({ status: "failed", note });
    expect(await failed()).toBe(0);
    expect(await runCompliancePackJob({ now: at(due, 1) })).toEqual({ status: "failed", note });
    expect(await failed()).toBe(1);
    await runCompliancePackJob({ now: at(due, 2) });
    expect(await failed()).toBe(1);
    // One alert per failing week, each once; never the driver's words in the note.
    expect(state.sent.filter((m) => m.kind === "ops_alert")).toHaveLength(5);
    expect(note).not.toMatch(/unreachable/);

    state.clinicsThrow = false;
    expect(await runCompliancePackJob({ now: at(due, 3) })).toEqual({
      status: "ok",
      note: `due week ${week}: stored ${weeks.join(", ")}; 0 already stored`,
    });
  });

  test("the pointer is never posted to Slack and never a Home row; other alerts still are", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxx");
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { body: string }) => {
        posted.push(init.body);
        return new Response("ok", { status: 200 });
      }),
    );
    try {
      const now = new Date();
      // ops_alerts is not emptied between files: alerts other tests left unposted can fill the
      // sweep's batch before this test's own two rows, so set them aside first (they are not
      // what this test is about).
      await getMigratorPool().query(
        `update ops_alerts set slack_posted_at = now(), slack_attempts = 1
          where slack_posted_at is null and event <> 'compliance_pack_ready'`,
      );
      await getMigratorPool().query(
        `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at)
         values ('compliance_pack_ready', $1, '{"windowStart":"2026-10-19","unreadCount":0}'::jsonb, $2, $2),
                ('dmarc_review_due', $3, '{}'::jsonb, $2, $2)`,
        [`key:compliance_pack_ready:test-${randomUUID()}`, now, `key:dmarc-${randomUUID()}`],
      );
      const result = await runOpsSlackSweep(now);
      expect(result.status).toBe("ok");
      // Other files' alerts of the last day are posted too (ops_alerts is not emptied between tests).
      expect(posted.length).toBeGreaterThanOrEqual(1);
      expect(posted.some((body) => /DMARC/i.test(body))).toBe(true);
      expect(posted.some((body) => /compliance pack is stored/i.test(body))).toBe(false);
      const { rows: unposted } = await getMigratorPool().query(
        `select count(*)::int as n from ops_alerts where event = 'compliance_pack_ready' and slack_posted_at is null and slack_attempts = 0`,
      );
      const { rows: all } = await getMigratorPool().query(`select count(*)::int as n from ops_alerts where event = 'compliance_pack_ready'`);
      expect(unposted[0]!.n).toBe(all[0]!.n);
      const { rows } = await opsAlertsSource.read({ now, actor: { type: "system" }, request: {}, clinicNames: async () => new Map() } as never);
      expect(rows.some((r: { id: string }) => r.id.startsWith("alert:compliance_pack_ready"))).toBe(false);
      expect(rows.some((r: { id: string }) => r.id.startsWith("alert:dmarc_review_due"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("the three operations: read one, list the newest, and make a missed week once", async () => {
    await seedClinic("pack-ops");
    const week = randomPastWeek();
    const now = at(packWeek(week).dueAt, 24 * 30);
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

    const made = data(await opGenerateCompliancePack({ week }, OPERATOR, now));
    expect(made).toMatchObject({ status: "stored", weekStart: week, unreadSections: 0, auditRecorded: true });
    const packId = made.packId as string;
    expect(packId).toMatch(UUID);

    const { rows: events } = await getAppPool().query(
      `select actor_label, ip_address, metadata from security_events where event = 'compliance_pack_generated'`,
    );
    expect(events).toEqual([{ actor_label: "ops@healdesk.test", ip_address: "203.0.113.9", metadata: { packId } }]);

    expect(data(await opGenerateCompliancePack({ week }, OPERATOR, now))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("already stored"),
    });
    // Not a week still to come, and not more than 104 weeks back.
    expect(data(await runOperation("generateCompliancePack", { week: addLocalDays(dueWeekStart(new Date()), 14) }, OPERATOR))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("has not ended"),
    });
    const oldest = addLocalDays(dueWeekStart(now), -7 * 104);
    expect(data(await opGenerateCompliancePack({ week: addLocalDays(oldest, -7) }, OPERATOR, now))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("last 104 weeks"),
    });
    expect((await runOperation("generateCompliancePack", { week: addLocalDays(week, 3) }, OPERATOR)).status).toBe(400);
    // A week with a section unread inside its 48 hours is refused, and nothing is stored.
    const [fresh] = reserveWeeks(1);
    state.extraClinics = [{ id: "not-a-clinic-id" }];
    expect(data(await opGenerateCompliancePack({ week: fresh }, OPERATOR, at(packWeek(fresh!).dueAt, 1)))).toMatchObject({
      status: "refused",
      message: expect.stringContaining("could not be read"),
    });
    expect(await getPack(fresh!)).toBeNull();
    state.extraClinics = [];

    expect(data(await runOperation("getCompliancePack", { week }, OPERATOR))).toMatchObject({
      status: "found",
      pack: { id: packId, weekStart: week, generatedBy: "ops-console", payload: { build: { builtLate: true, lateDays: 30 } } },
    });

    const packs = data(await runOperation("listCompliancePacks", { limit: 104 }, OPERATOR)).packs as {
      weekStart: string;
      headline: unknown;
    }[];
    // The list is the newest 104 packs. The tests store random past weeks into one shared
    // database, so this week is among them only while fewer than 104 newer ones exist (a fresh
    // CI database; a long-lived local one fills up): check its headline when it is there, and
    // always check the order and that every row carries its headline.
    const mine = packs.find((p) => p.weekStart === week);
    if (mine) expect(mine.headline).toMatchObject({ incidentsOpen: 0 });
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.length).toBeLessThanOrEqual(104);
    expect(packs.map((p) => p.weekStart)).toEqual([...packs.map((p) => p.weekStart)].sort().reverse());
    for (const p of packs) expect(p).toHaveProperty("headline");
    expect((await runOperation("listCompliancePacks", { limit: 0 }, OPERATOR)).status).toBe(400);
    // The operator's generation sends nothing: the pointer is the job's.
    expect(state.sent).toEqual([]);
  });
});
