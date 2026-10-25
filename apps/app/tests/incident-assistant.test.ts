import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { FIELD_EDITORS, reportEffect, batchEffect } from "@/lib/approvals/incident-kinds";
import { parseIncidentBatchPayload, parseIncidentReportPayload } from "@/lib/approvals/incident-payloads";
import { KIND_SPECS, parsePayload } from "@/lib/approvals/kinds";
import { MAX_BATCH_CLINICS } from "@/lib/approvals/incident-payloads";
import { runIncidentSweep } from "@/lib/approvals/incident-sweep";
import { proposeApprovals } from "@/lib/approvals/proposers";
import { getApproval, propose } from "@/lib/approvals/store";
import { runOpsSlackSweep } from "@/lib/ops/slack";
import { runIncidentDeadlinesJob } from "@/lib/scheduler/incident-deadlines";
import { fieldsHash, parseReportFields, prefillReport, type ReportFields } from "@/lib/incidents/assistant/report-draft";
import { readScopeArgs } from "@/lib/incidents/assistant/scope";
import { CHECKLIST_STEPS, SCOPE_CHANNELS, SCOPE_VENDORS, VENDOR_CHANNELS } from "@/lib/incidents/assistant/vocab";
import { openIncident } from "@/lib/incidents/incidents";
import { opDecideApproval, opListApprovals } from "@/lib/ops/approval-ops";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { withTenant } from "@/lib/tenant";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedConversation, seedDemoClinic } from "./setup/factories";

/**
 * The incident assistant (ops automation Phase 6, lane P6i; design E6 §3
 * item 17; owner decision D18), against the real schema: the scope's counts
 * from what the service keeps of a conversation, the checklist that cannot
 * be rewritten, the batch that opens each clinic's incident once and only on
 * the owner's approval with a fresh code, the report pre-filled and edited
 * from the lists only, sent once by the Incidents page's own sender, and the
 * legal clock that re-alerts every 4 hours and never runs by itself.
 */

vi.setConfig({ testTimeout: 90_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const ACTOR = { type: "service", serviceName: "incident-assistant-test" } as const;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ORIGIN = "https://app.healdesk.test";

const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" },
};

let testStartedAt = new Date(0);

/** The real clock, to the minute: the database stamps its own times, and the ops read "now" themselves. */
function baseNow(): Date {
  return new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
}

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (outcome.status !== 200) throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { data: T }).data;
}

async function webChat(clinicId: string, startedAt: Date): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(`insert into conversations (clinic_id, channel, outcome, started_at) values ($1, 'web_chat', 'qualified_no_booking', $2)`, [
      clinicId,
      startedAt,
    ]),
  );
}

/** A Meta conversation as the usage ledger keeps it: Meta leaves no conversation row (lib/meta). */
async function metaConversation(clinicId: string, occurredAt: Date): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into usage_events (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at, included, used_before)
       values ($1, $1, 'chat_conversations', 'meta', $2, 1, $3, 300, 0)`,
      [clinicId, `ref_${randomUUID()}`, occurredAt],
    ),
  );
}

async function openAt(clinicId: string, cls: "breach" | "security_incident" | "improper_use_or_disclosure" | "service_complaint", discoveredAt: Date) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) =>
    openIncident(tx, {
      class: cls,
      summary: "Opened by a test; ids only.",
      openedBy: "ops@healdesk.test",
      isCoveredEntity: true,
      discoveredAt,
    }),
  );
}

/** The items of a kind about these clinics (or, for a batch, with no clinic) proposed in this test: earlier tests' rows stay. */
async function itemsOf(kind: string, clinicIds: readonly string[] | null = null) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    status: string;
    subject_ref: string;
    subject_clinic_id: string | null;
    payload: Record<string, unknown>;
    due_at: Date;
    urgency: string;
    proposed_by: string;
    outcome_code: string | null;
  }>(
    `select id, status, subject_ref, subject_clinic_id, payload, due_at, urgency, proposed_by, outcome_code
       from ops_approvals
      where kind = $1 and proposed_at > $3
        and ($2::uuid[] is null and subject_clinic_id is null or subject_clinic_id = any($2::uuid[]))
      order by proposed_at`,
    [kind, clinicIds, testStartedAt],
  );
  return rows;
}

async function eventsOf(approvalId: string) {
  const { rows } = await getMigratorPool().query<{
    event: string;
    actor_label: string;
    outcome_code: string | null;
    draft_hash_approved: string | null;
    draft_hash_sent: string | null;
  }>(
    `select event, actor_label, outcome_code, draft_hash_approved, draft_hash_sent from ops_approval_events where approval_id = $1 order by at, event`,
    [approvalId],
  );
  return rows;
}

async function incidentsOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string; class: string; summary: string; reports_sent: number; opened_by: string }>(
      `select id, class, summary, reports_sent, opened_by from incidents where clinic_id = $1 order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

async function reportNotices(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices where clinic_id = $1 and kind = 'incident_report' order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

async function stepAlerts(): Promise<Record<string, unknown>[]> {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = 'incident_step_waiting' order by raised_at`,
  );
  return rows.map((r) => r.fields);
}

async function decide(args: Record<string, unknown>, now = new Date(Date.now() + MINUTE)) {
  const out = await opDecideApproval({ codeChecked: true, ...args }, OPERATOR, { now });
  expect(out.status).toBe(200);
  return (out.body as { data: { status: string; outcomeCode?: string; message?: string | null } }).data;
}

/** Two clinics with conversations in a window, one with none, and the demo clinic with one. */
async function seededWindow() {
  const now = baseNow();
  const from = new Date(now.getTime() - 3 * DAY);
  const to = new Date(now.getTime() - DAY);
  const inside = new Date(from.getTime() + HOUR);
  const a = await seedClinic("scope-a");
  await bindAgreementInEffect(a.clinicId, "1.5.0");
  await seedConversation(a.clinicId, { startedAt: inside });
  await seedConversation(a.clinicId, { startedAt: new Date(inside.getTime() + HOUR) });
  await webChat(a.clinicId, inside);
  await metaConversation(a.clinicId, inside);
  // Outside the window: never counted.
  await seedConversation(a.clinicId, { startedAt: new Date(to.getTime() + HOUR) });
  const b = await seedClinic("scope-b");
  await bindAgreementInEffect(b.clinicId, "1.2.1");
  await webChat(b.clinicId, inside);
  const none = await seedClinic("scope-none");
  await seedConversation(none.clinicId, { startedAt: new Date(from.getTime() - DAY) });
  const demo = await seedDemoClinic("scope-demo");
  await seedConversation(demo.clinicId, { startedAt: inside });
  return { now, from, to, a, b, none, demo };
}

describe("the closed lists", () => {
  test("every vendor maps to channels the catalog has, and the steps are the procedure's", () => {
    expect(SCOPE_VENDORS).toEqual(["retell", "anthropic", "database_host", "aws", "meta"]);
    expect(SCOPE_CHANNELS).toEqual(["voice", "web", "meta"]);
    for (const v of SCOPE_VENDORS) for (const c of VENDOR_CHANNELS[v]) expect(SCOPE_CHANNELS).toContain(c);
    expect(VENDOR_CHANNELS.retell).toEqual(["voice"]);
    expect(VENDOR_CHANNELS.meta).toEqual(["meta"]);
    expect(CHECKLIST_STEPS).toEqual([
      "contain",
      "open",
      "preserve_ids",
      "investigate",
      "notify_email",
      "notify_phone",
      "affected_list_recorded",
      "help_clinic",
      "resolve",
    ]);
  });

  test("the operations are named, and the three writes are mutating", () => {
    for (const op of ["incidentScope", "incidentChecklist", "tickIncidentStep", "proposeIncidentBatch", "proposeIncidentReport"]) {
      expect(isOpName(op), op).toBe(true);
    }
    expect(isMutating("tickIncidentStep")).toBe(true);
    expect(isMutating("proposeIncidentBatch")).toBe(true);
    expect(isMutating("proposeIncidentReport")).toBe(true);
    expect(isMutating("incidentScope")).toBe(false);
    expect(isMutating("incidentChecklist")).toBe(false);
  });

  test("both kinds are legal clocks that need a fresh code and never expire", () => {
    for (const kind of ["incident_open_batch", "incident_report_send"] as const) {
      expect(KIND_SPECS[kind]).toMatchObject({ urgency: "legal_clock", irreversible: true, expiryDays: null, retriedBy: null });
    }
    expect(KIND_SPECS.incident_report_send.fieldsEditable).toBe(true);
    expect(KIND_SPECS.incident_open_batch.fieldsEditable).toBeUndefined();
  });

  test("a scope's arguments are refused unless they come from the lists", () => {
    const now = new Date("2026-11-02T10:00:00.000Z");
    const ok = { vendor: "retell", from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
    expect(readScopeArgs(ok, now)).toMatchObject({ source: "vendor", value: "retell" });
    expect(readScopeArgs({ ...ok, vendor: "stripe" }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ ...ok, channel: "voice" }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ channel: "sms", from: ok.from, to: ok.to }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ ...ok, to: "2026-12-01T00:00:00.000Z" }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ ...ok, from: ok.to, to: ok.from }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ ...ok, class: "breach" }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ ...ok, class: "service_complaint", discoveredAt: "2026-11-01T12:00:00.000Z" }, now)).toHaveProperty(
      "problem",
    );
  });

  test("the database host and AWS reach every clinic holding data unless narrowed; the rest are read by the window", () => {
    const now = new Date("2026-11-02T10:00:00.000Z");
    const w = { from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
    expect(readScopeArgs({ vendor: "database_host", ...w }, now)).toMatchObject({ reach: "all_holding" });
    expect(readScopeArgs({ vendor: "aws", ...w }, now)).toMatchObject({ reach: "all_holding" });
    expect(readScopeArgs({ vendor: "aws", ...w, reach: "window_only" }, now)).toMatchObject({ reach: "window_only" });
    for (const vendor of ["retell", "anthropic", "meta"]) {
      expect(readScopeArgs({ vendor, ...w }, now)).toMatchObject({ reach: "window_only" });
      expect(readScopeArgs({ vendor, ...w, reach: "all_holding" }, now)).toHaveProperty("problem");
    }
    expect(readScopeArgs({ channel: "voice", ...w, reach: "all_holding" }, now)).toHaveProperty("problem");
    expect(readScopeArgs({ vendor: "aws", ...w, reach: "everyone" }, now)).toHaveProperty("problem");
  });
});

describe("the report draft", () => {
  const BREACH = prefillReport({ incidentClass: "breach", discoveredOn: "2026-10-05", batch: null });

  test("is pre-filled from the incident with codes only, guessing no count and no event it cannot read", () => {
    expect(BREACH).toEqual({
      event: null,
      occurredOn: null,
      info: [],
      mitigations: ["investigating"],
      steps: [],
      recommendations: ["assess_notice_duty", "keep_record"],
      delayedByLawEnforcement: false,
      delayEndedOn: null,
    });
    expect(
      prefillReport({ incidentClass: "security_incident", discoveredOn: "2026-10-05", batch: { source: "vendor", fromDay: "2026-10-03" } }),
    ).toMatchObject({ event: "subcontractor_incident", occurredOn: "2026-10-03", recommendations: ["keep_record"] });
    expect(prefillReport({ incidentClass: "improper_use_or_disclosure", discoveredOn: "2026-10-05", batch: null }).event).toBe(
      "impermissible_use",
    );
  });

  test("takes an edit only as list values: a sentence, an extra key, a count as words or a repeated code is refused", () => {
    const good: ReportFields = { ...BREACH, event: "software_fault", info: [{ type: "first_name", count: 3 }] };
    expect(parseReportFields(good)).toEqual(good);
    const hostile: unknown[] = [
      { ...good, event: "Jane's number went to the wrong inbox" },
      { ...good, summary: "free text" },
      { ...good, info: [{ type: "first_name", count: "three" }] },
      { ...good, info: [{ type: "first_name", count: 3, note: "Jane" }] },
      { ...good, info: [{ type: "the patient's diagnosis", count: 1 }] },
      { ...good, mitigations: ["investigating", "investigating"] },
      { ...good, mitigations: ["We called her at +1 555 010 0123"] },
      { ...good, occurredOn: "yesterday" },
      { ...good, occurredOn: "2026-02-30" },
      { ...good, delayedByLawEnforcement: "yes" },
      [good],
      "event=software_fault",
    ];
    for (const h of hostile) expect(parseReportFields(h), JSON.stringify(h)).toBeNull();
  });

  test("never names a deadline, and hashes the same choices the same way", () => {
    const text = JSON.stringify(BREACH);
    expect(text).not.toMatch(/24|hour|deadline|notify_?by|target/i);
    expect(fieldsHash(BREACH)).toBe(fieldsHash(JSON.parse(text) as ReportFields));
    expect(fieldsHash({ ...BREACH, steps: ["tell_practice"] })).not.toBe(fieldsHash(BREACH));
  });

  test("its payload parsers refuse anything the kinds did not declare", () => {
    const report = { incidentId: randomUUID(), report: 1, fields: BREACH };
    expect(parseIncidentReportPayload(report)).toEqual(report);
    expect(parseIncidentReportPayload({ ...report, note: "x" })).toBeNull();
    expect(parseIncidentReportPayload({ ...report, fields: { ...BREACH, event: "free words" } })).toBeNull();
    const batch = {
      source: "vendor",
      value: "retell",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
      incidentClass: "security_incident",
      discoveredAt: "2026-10-03T00:00:00.000Z",
      reach: "window_only",
      clinicIds: [randomUUID()],
      counts: [3],
    };
    expect(parseIncidentBatchPayload(batch)).toEqual(batch);
    // Retell sees a call only while it happens: never every clinic holding data.
    expect(parseIncidentBatchPayload({ ...batch, reach: "all_holding" })).toBeNull();
    expect(parseIncidentBatchPayload({ ...batch, value: "aws", reach: "all_holding" })).not.toBeNull();
    expect(parseIncidentBatchPayload({ ...batch, counts: [] })).toBeNull();
    expect(parseIncidentBatchPayload({ ...batch, value: "voice" })).toBeNull();
    expect(parseIncidentBatchPayload({ ...batch, clinicIds: [] })).toBeNull();
    expect(parseIncidentBatchPayload({ ...batch, incidentClass: "service_complaint" })).toBeNull();
    expect(parsePayload("incident_open_batch", { ...batch, extra: 1 })).toBeNull();
  });

  test("its sentences say what approving does, and never the internal target; the deadline and the missing choice are the card's lines, not repeated here", () => {
    const effect = reportEffect({ report: 1, incidentClass: "breach" });
    expect(effect).toBe(
      "Emails the practice's address this incident's report, built only from the choices below, and records the practice as told. It cannot be taken back. It links to the incident's page, where the practice reads who it affected; that list is never emailed. Phone the practice as well: the report does not replace the call.",
    );
    expect(effect).not.toMatch(/24 hours|internal|deadline|Pick what happened/);
    expect(reportEffect({ report: 3, incidentClass: "security_incident" })).toBe(
      "Emails the practice's address update 2 to this incident's report, built only from the choices below, and records the practice as told. It cannot be taken back. Phone the practice as well: the report does not replace the call.",
    );
    expect(
      batchEffect({ incidentClass: "security_incident", toOpen: 1, alreadyOpen: 1, reach: "window_only" }),
    ).toBe(
      "Opens an incident at the 1 clinic below, classed as a security incident, and puts each one's report in this list for your yes. Nothing is sent to any clinic. 1 clinic already has this incident open and is left as it is.",
    );
  });
});

describeDb("the incident assistant (database)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    testStartedAt = new Date();
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
    await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'billing-notices'`);
    process.env.BETTER_AUTH_URL = ORIGIN;
  });

  afterAll(async () => {
    await closePools();
  });

  describe("incidentScope", () => {
    test("counts each clinic's conversations per channel in the window, with its version and both clocks; demo only when asked", async () => {
      const s = await seededWindow();
      const discoveredAt = new Date(s.to.getTime() + HOUR);
      const args = { from: s.from.toISOString(), to: s.to.toISOString(), class: "security_incident", discoveredAt: discoveredAt.toISOString() };
      const scope = data<{
        channels: string[];
        clinics: {
          clinicId: string;
          clinicName: string;
          conversations: Record<string, number>;
          total: number;
          agreementVersion: string | null;
          demo: boolean;
          clocks: { internalTarget: string; agreementDeadline: string | null; agreementRule: string } | null;
        }[];
        clinicsWithNone: number;
        unread: number;
      }>(await runOperation("incidentScope", { vendor: "anthropic", ...args }, OPERATOR));
      expect(scope.channels).toEqual(["voice", "web", "meta"]);
      expect(scope.unread).toBe(0);
      const ids = scope.clinics.map((c) => c.clinicId);
      expect(ids).toContain(s.a.clinicId);
      expect(ids).toContain(s.b.clinicId);
      expect(ids).not.toContain(s.none.clinicId);
      expect(ids).not.toContain(s.demo.clinicId);
      const a = scope.clinics.find((c) => c.clinicId === s.a.clinicId)!;
      expect(a.conversations).toEqual({ voice: 2, web: 1, meta: 1 });
      expect(a.total).toBe(4);
      expect(a.agreementVersion).toBe("1.5.0");
      expect(a.clocks).toEqual({
        internalTarget: new Date(discoveredAt.getTime() + DAY).toISOString(),
        agreementDeadline: new Date(discoveredAt.getTime() + 60 * DAY).toISOString(),
        agreementRule: "sixty_calendar_days",
        ownerNoticeBy: null,
      });
      const b = scope.clinics.find((c) => c.clinicId === s.b.clinicId)!;
      expect(b).toMatchObject({ conversations: { voice: 0, web: 1, meta: 0 }, agreementVersion: "1.2.1" });
      expect(b.clocks!.agreementRule).toBe("five_days");
      // The soonest agreement deadline first.
      expect(ids.indexOf(s.b.clinicId)).toBeLessThan(ids.indexOf(s.a.clinicId));
      // Nothing but ids, counts, versions, dates, codes and the clinic's name.
      expect(Object.keys(a).sort()).toEqual(
        ["agreementVersion", "billingClinicId", "clinicId", "clinicName", "clocks", "conversations", "coveredEntity", "holdsData", "demo", "offboarding", "total"].sort(),
      );

      const voice = data<{ clinics: { clinicId: string; conversations: Record<string, number> }[] }>(
        await runOperation("incidentScope", { vendor: "retell", from: args.from, to: args.to }, OPERATOR),
      );
      expect(voice.clinics.map((c) => c.clinicId)).toEqual([s.a.clinicId]);
      expect(voice.clinics[0]!.conversations).toEqual({ voice: 2, web: 0, meta: 0 });

      const meta = data<{ clinics: { clinicId: string }[] }>(
        await runOperation("incidentScope", { channel: "meta", from: args.from, to: args.to }, OPERATOR),
      );
      expect(meta.clinics.map((c) => c.clinicId)).toEqual([s.a.clinicId]);

      const withDemo = data<{ clinics: { clinicId: string; demo: boolean }[] }>(
        await runOperation("incidentScope", { vendor: "retell", from: args.from, to: args.to, includeDemo: true }, OPERATOR),
      );
      expect(withDemo.clinics.find((c) => c.clinicId === s.demo.clinicId)?.demo).toBe(true);

      const refused = await runOperation("incidentScope", { vendor: "stripe", from: args.from, to: args.to }, OPERATOR);
      expect(refused.status).toBe(400);
    });
  });

  describe("the checklist", () => {
    test("ticks each step once, by the operator, and the rows can never be rewritten or hold free text", async () => {
      const c = await seedClinic("checklist");
      const i = await openAt(c.clinicId, "breach", new Date(Date.now() - HOUR));
      const tick = (step: string, operator: Operator = OPERATOR) =>
        runOperation("tickIncidentStep", { clinicId: c.clinicId, incidentId: i.id, step }, operator);

      expect(data<{ status: string }>(await tick("contain"))).toMatchObject({ status: "ticked", step: "contain", auditRecorded: true });
      expect(data<{ status: string }>(await tick("contain"))).toMatchObject({ status: "already", step: "contain" });
      expect(data<{ status: string; message: string }>(await tick("notify_email"))).toMatchObject({ status: "refused" });
      expect(data<{ status: string }>(await tick("resolve"))).toMatchObject({ status: "refused" });
      expect(data<{ status: string }>(await tick("call the patient"))).toMatchObject({ status: "refused" });
      expect(
        data<{ status: string; affectedCount: number | null }>(await tick("affected_list_recorded")),
      ).toMatchObject({ status: "ticked", affectedCount: 0 });

      // No operator: refused before anything is read.
      const anonymous = await tick("investigate", { email: "", request: {} });
      expect(anonymous.status).toBe(401);

      const view = data<{ steps: { step: string; tickedAt: string | null; tickedBy: string | null }[] }>(
        await runOperation("incidentChecklist", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR),
      );
      expect(view.steps.map((s) => s.step)).toEqual([...CHECKLIST_STEPS]);
      expect(view.steps.find((s) => s.step === "contain")).toMatchObject({ tickedBy: "ops@healdesk.test" });
      expect(view.steps.find((s) => s.step === "investigate")!.tickedAt).toBeNull();

      const [security] = (
        await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown> }>(
          `select actor_label, metadata from security_events where event = 'incident_step_ticked' and metadata->>'step' = 'contain'`,
        )
      ).rows;
      expect(security).toMatchObject({ actor_label: "ops@healdesk.test", metadata: { incidentId: i.id, step: "contain" } });

      // Add-only for the runtime role and the migrator alike.
      for (const pool of [getAppPool(), getMigratorPool()]) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
          await expect(client.query(`update incident_checklist_ticks set step = 'investigate' where incident_id = $1`, [i.id])).rejects.toThrow();
          await client.query("rollback");
          await client.query("begin");
          await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
          await expect(client.query(`delete from incident_checklist_ticks where incident_id = $1`, [i.id])).rejects.toThrow();
          await client.query("rollback");
        } finally {
          client.release();
        }
      }
      // Never free text: the step, the operator and the scope key are checked by the database.
      for (const [step, by, key] of [
        ["notes", "ops@healdesk.test", null],
        ["investigate", "Called Jane at home", null],
        ["investigate", "ops@healdesk.test", "vendor:retell:yesterday"],
      ] as const) {
        await expect(
          inTenant(c.clinicId, (cl) =>
            cl.query(`insert into incident_checklist_ticks (clinic_id, incident_id, step, ticked_by, batch_key) values ($1, $2, $3, $4, $5)`, [
              c.clinicId,
              i.id,
              step,
              by,
              key,
            ]),
          ),
          `${step} / ${by} / ${key}`,
        ).rejects.toThrow();
      }
    });
  });

  describe("incident_open_batch", () => {
    test("proposes one item, opens nothing until approved with the code, then opens each clinic's incident once", async () => {
      const s = await seededWindow();
      const discoveredAt = new Date(s.to.getTime() + HOUR);
      const args = {
        vendor: "anthropic",
        from: s.from.toISOString(),
        to: s.to.toISOString(),
        class: "security_incident",
        discoveredAt: discoveredAt.toISOString(),
      };
      const proposed = data<{ status: string; approvalId: string; clinics: number }>(await runOperation("proposeIncidentBatch", args, OPERATOR));
      expect(proposed).toMatchObject({ status: "proposed", clinics: 2 });
      // The same scope again: the waiting item, not a second one.
      expect(data<{ status: string; approvalId: string }>(await runOperation("proposeIncidentBatch", args, OPERATOR))).toMatchObject({
        status: "already_waiting",
        approvalId: proposed.approvalId,
      });
      const [item] = await itemsOf("incident_open_batch");
      expect(item).toMatchObject({ status: "waiting", subject_clinic_id: null, urgency: "legal_clock", proposed_by: "incident-assistant" });
      expect(item!.due_at.toISOString()).toBe(new Date(discoveredAt.getTime() + DAY).toISOString());
      expect(await incidentsOf(s.a.clinicId)).toEqual([]);
      expect((await eventsOf(item!.id))[0]).toMatchObject({ event: "proposed", actor_label: "ops@healdesk.test" });

      // Its packet: both clocks per clinic, and what approving does.
      const listed = (await opListApprovals({ family: "incident" }, OPERATOR)).body as {
        data: {
          items: {
            id: string;
            packet: { effect: string; facts: { clinicsTotal: number; toOpen: number; clinics: { clinicId: string; clocks: unknown; conversations: number }[] } };
          }[];
        };
      };
      const packet = listed.data.items.find((x) => x.id === item!.id)!.packet;
      expect(packet.facts).toMatchObject({ clinicsTotal: 2, toOpen: 2 });
      // The billing family's list never carries, or builds, an incident item.
      const billing = (await opListApprovals({ family: "billing" }, OPERATOR)).body as { data: { items: { kind: string }[] } };
      expect(billing.data.items.filter((x) => x.kind.startsWith("incident_"))).toEqual([]);
      expect((await opListApprovals({ family: "everything" }, OPERATOR)).status).toBe(400);
      expect(packet.effect).toBe(
        "Opens an incident at each of the 2 clinics below, classed as a security incident, and puts each one's report in this list for your yes. Nothing is sent to any clinic.",
      );
      expect(packet.facts.clinics.find((c) => c.clinicId === s.a.clinicId)).toMatchObject({ conversations: 4 });

      // No fresh code: refused, nothing opened.
      const noCode = await opDecideApproval({ id: item!.id, action: "approve", reasonCode: "owner_checked" }, OPERATOR);
      expect((noCode.body as { data: { status: string } }).data.status).toBe("error");
      expect(await incidentsOf(s.a.clinicId)).toEqual([]);

      const done = await decide({ id: item!.id, action: "approve", reasonCode: "owner_checked" });
      expect(done).toMatchObject({ status: "executed", outcomeCode: "opened" });
      const [ia] = await incidentsOf(s.a.clinicId);
      const [ib] = await incidentsOf(s.b.clinicId);
      expect(ia).toMatchObject({ class: "security_incident", opened_by: "ops@healdesk.test" });
      expect(ib).toMatchObject({ class: "security_incident" });
      expect(ia!.summary).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(await incidentsOf(s.none.clinicId)).toEqual([]);
      expect(await incidentsOf(s.demo.clinicId)).toEqual([]);

      // Each opened incident's report is waiting for its own yes, due at its agreement deadline.
      const reports = await itemsOf("incident_report_send", [s.a.clinicId, s.b.clinicId]);
      expect(reports.map((r) => r.subject_ref).sort()).toEqual([`${ia!.id}:1`, `${ib!.id}:1`].sort());
      const ra = reports.find((r) => r.subject_clinic_id === s.a.clinicId)!;
      expect(ra.due_at.toISOString()).toBe(new Date(discoveredAt.getTime() + 60 * DAY).toISOString());
      expect((ra.payload as { fields: ReportFields }).fields).toMatchObject({
        event: "subcontractor_incident",
        occurredOn: s.from.toISOString().slice(0, 10),
      });
      expect(await reportNotices(s.a.clinicId)).toEqual([]);

      // Proposed and approved again: nothing is opened twice.
      const again = data<{ status: string; approvalId: string }>(await runOperation("proposeIncidentBatch", args, OPERATOR));
      expect(again.status).toBe("proposed");
      const twice = await decide({ id: again.approvalId, action: "approve", reasonCode: "owner_checked" });
      expect(twice).toMatchObject({ status: "executed", outcomeCode: "opened" });
      expect(twice.message).toContain("2 clinics already had this scope's incident open");
      expect(await incidentsOf(s.a.clinicId)).toHaveLength(1);
      expect(await incidentsOf(s.b.clinicId)).toHaveLength(1);
    });

    test("an empty scope proposes nothing; a rejected batch opens nothing", async () => {
      const s = await seededWindow();
      const empty = data<{ status: string }>(
        await runOperation(
          "proposeIncidentBatch",
          {
            vendor: "retell",
            from: new Date(s.from.getTime() - 30 * DAY).toISOString(),
            to: new Date(s.from.getTime() - 20 * DAY).toISOString(),
            class: "breach",
            discoveredAt: s.now.toISOString(),
          },
          OPERATOR,
        ),
      );
      expect(empty.status).toBe("refused");
      const proposed = data<{ approvalId: string }>(
        await runOperation(
          "proposeIncidentBatch",
          { vendor: "retell", from: s.from.toISOString(), to: s.to.toISOString(), class: "breach", discoveredAt: s.now.toISOString() },
          OPERATOR,
        ),
      );
      expect(await decide({ id: proposed.approvalId, action: "reject", reasonCode: "not_needed" })).toMatchObject({ status: "rejected" });
      expect(await incidentsOf(s.a.clinicId)).toEqual([]);
      expect(await itemsOf("incident_report_send", [s.a.clinicId, s.b.clinicId])).toEqual([]);
    });
  });

  describe("incident_report_send", () => {
    async function reportItem(cls: "breach" | "security_incident" = "breach") {
      const c = await seedClinic(`report-${cls}`);
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const discoveredAt = new Date(Date.now() - 2 * HOUR);
      const i = await openAt(c.clinicId, cls, discoveredAt);
      const proposed = data<{ status: string; approvalId: string }>(
        await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR),
      );
      expect(proposed.status).toBe("proposed");
      return { c, i, approvalId: proposed.approvalId, discoveredAt };
    }

    test("its packet shows both clocks, the internal one apart, and its draft holds list values only", async () => {
      const { i, approvalId } = await reportItem();
      const item = await getApproval(approvalId);
      expect(item!.dueAt.toISOString()).toBe(i.agreementNotifyBy!.toISOString());
      const payloadText = JSON.stringify(item!.payload);
      expect(payloadText).not.toContain(i.notifyBy.toISOString());
      expect(payloadText).not.toMatch(/target|deadline|hour/i);
      const listed = (await opListApprovals({}, OPERATOR)).body as {
        data: { items: { id: string; packet: { facts: Record<string, unknown> } }[] };
      };
      const facts = listed.data.items.find((x) => x.id === approvalId)!.packet.facts;
      expect(facts).toMatchObject({
        kind: "incident_report_send",
        internalTarget: i.notifyBy.toISOString(),
        agreementDeadline: i.agreementNotifyBy!.toISOString(),
        report: 1,
      });
      expect(Object.keys(facts.fields as object).sort()).toEqual(
        ["delayEndedOn", "delayedByLawEnforcement", "event", "info", "mitigations", "occurredOn", "recommendations", "steps"],
      );
    });

    test("approve without a choice of what happened is refused before anything is recorded; hostile edits are refused", async () => {
      const { c, approvalId } = await reportItem();
      const missing = await decide({ id: approvalId, action: "approve", reasonCode: "owner_checked" });
      expect(missing.status).toBe("error");
      expect(missing.message).toContain("Pick what happened from the list.");
      for (const editedFields of [
        { event: "Jane's number leaked" },
        { ...prefillReport({ incidentClass: "breach", discoveredOn: "2026-10-05", batch: null }), event: "misdirected_email", note: "x" },
        { ...prefillReport({ incidentClass: "breach", discoveredOn: "2026-10-05", batch: null }), event: "misdirected_email", info: [{ type: "phone_number", count: "+1 555 010 0123" }] },
      ]) {
        const out = await decide({ id: approvalId, action: "approve", reasonCode: "owner_checked", editedFields });
        expect(out.status, JSON.stringify(editedFields)).toBe("error");
      }
      // A choice the sender would refuse for this incident is refused now.
      const security = await decide({
        id: approvalId,
        action: "approve",
        reasonCode: "owner_checked",
        editedFields: {
          ...prefillReport({ incidentClass: "breach", discoveredOn: "2026-10-05", batch: null }),
          event: "misdirected_email",
          occurredOn: "2999-01-01",
        },
      });
      expect(security.status).toBe("error");
      expect((await getApproval(approvalId))!.status).toBe("waiting");
      expect(await reportNotices(c.clinicId)).toEqual([]);
      // A kind with no choices takes none.
      const s = await seededWindow();
      const batch = data<{ approvalId: string }>(
        await runOperation(
          "proposeIncidentBatch",
          { vendor: "aws", from: s.from.toISOString(), to: s.to.toISOString(), class: "breach", discoveredAt: s.now.toISOString() },
          OPERATOR,
        ),
      );
      const noFields = await decide({ id: batch.approvalId, action: "approve", reasonCode: "owner_checked", editedFields: {} });
      expect(noFields).toMatchObject({ status: "error", message: "This item has no choices to edit. Nothing was changed." });
    });

    test("approve with the owner's choices sends exactly once through Send report, recording both hashes", async () => {
      const { c, i, approvalId } = await reportItem();
      const choices: ReportFields = {
        event: "software_fault",
        occurredOn: null,
        info: [{ type: "first_name", count: 2 }],
        mitigations: ["fault_fixed", "investigating"],
        steps: ["unexpected_contact"],
        recommendations: ["assess_notice_duty", "notify_people"],
        delayedByLawEnforcement: false,
        delayEndedOn: null,
      };
      const out = await decide({ id: approvalId, action: "approve", reasonCode: "owner_checked", editedFields: choices });
      expect(out).toMatchObject({ status: "executed", outcomeCode: "sent" });
      const notices = await reportNotices(c.clinicId);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.dedupe_key).toBe(`incident_report:${i.id}:1`);
      expect(notices[0]!.payload).toMatchObject({
        kind: "breach",
        event: "software_fault",
        infoRows: [{ type: "first_name", count: 2 }],
        mitigationRows: [{ code: "fault_fixed" }, { code: "investigating" }],
        stepRows: [{ code: "unexpected_contact" }],
        recommendationRows: [{ code: "assess_notice_duty" }, { code: "notify_people" }],
      });
      expect(JSON.stringify(notices[0]!.payload)).not.toContain(i.notifyBy.toISOString());
      const events = await eventsOf(approvalId);
      expect(events.map((e) => e.event)).toEqual(["proposed", "edited", "approved", "executed"]);
      const hash = fieldsHash(choices);
      expect(events.find((e) => e.event === "approved")!.draft_hash_approved).toBe(hash);
      expect(events.find((e) => e.event === "executed")!.draft_hash_sent).toBe(hash);
      // Once: a second decision is refused, and the incident's next report is an update.
      expect((await decide({ id: approvalId, action: "approve", reasonCode: "owner_checked", editedFields: choices })).status).toBe("error");
      expect(await reportNotices(c.clinicId)).toHaveLength(1);
      expect((await incidentsOf(c.clinicId))[0]!.reports_sent).toBe(1);
    });

    test("reject sends nothing, and an editor is held to the same rules as the sender", async () => {
      const { c, approvalId } = await reportItem("security_incident");
      expect(await decide({ id: approvalId, action: "reject", reasonCode: "handled_elsewhere" })).toMatchObject({ status: "rejected" });
      expect(await reportNotices(c.clinicId)).toEqual([]);
      expect(FIELD_EDITORS.incident_report_send).toBeDefined();
      // After a rejection an operator may propose the report again, under its own subject.
      const again = data<{ status: string; approvalId: string }>(
        await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: (await incidentsOf(c.clinicId))[0]!.id }, OPERATOR),
      );
      expect(again.status).toBe("proposed");
      expect((await getApproval(again.approvalId))!.subjectRef).toMatch(/:1:1$/);
    });
  });

  describe("the proposer", () => {
    test("proposes the first report of an open reportable incident, never a service complaint's, and never sends", async () => {
      const c = await seedClinic("auto");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const breach = await openAt(c.clinicId, "breach", new Date(Date.now() - HOUR));
      await openAt(c.clinicId, "service_complaint", new Date(Date.now() - HOUR));
      const later = await openAt(c.clinicId, "security_incident", new Date(Date.now() - HOUR));
      await runOperation("markIncidentNotReportable", { clinicId: c.clinicId, incidentId: later.id, reason: "A routine unsuccessful attempt." }, OPERATOR);
      const demo = await seedDemoClinic("auto-demo");
      await openAt(demo.clinicId, "breach", new Date(Date.now() - HOUR));

      const now = new Date(Date.now() + MINUTE);
      await proposeApprovals(now);
      const items = await itemsOf("incident_report_send", [c.clinicId, demo.clinicId]);
      expect(items.map((r) => r.subject_ref)).toEqual([`${breach.id}:1`]);
      expect(items[0]).toMatchObject({ status: "waiting", proposed_by: "approvals-propose" });
      // Idempotent: a second run proposes nothing more.
      await proposeApprovals(new Date(now.getTime() + MINUTE));
      expect(await itemsOf("incident_report_send", [c.clinicId, demo.clinicId])).toHaveLength(1);
      expect(await reportNotices(c.clinicId)).toEqual([]);

      // Sent from the Incidents page by hand: the waiting item leaves the list unrun.
      await runOperation(
        "sendIncidentReport",
        { clinicId: c.clinicId, incidentId: breach.id, event: "misdirected_email", info: [], mitigations: ["investigating"] },
        OPERATOR,
      );
      await proposeApprovals(new Date(now.getTime() + 2 * MINUTE));
      expect((await itemsOf("incident_report_send", [c.clinicId]))[0]).toMatchObject({ status: "expired", outcome_code: "no_longer_needed" });
      expect(await reportNotices(c.clinicId)).toHaveLength(1);
    });

    test("a waiting legal-clock item is re-alerted every 4 hours, by email and Slack, and never runs by itself", async () => {
      const c = await seedClinic("clock");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      await openAt(c.clinicId, "breach", new Date(Date.now() - HOUR));
      const t0 = new Date(Date.now() + MINUTE);
      await proposeApprovals(t0);
      expect(await stepAlerts()).toEqual([{ kind: "incident_report_send", count: 1 }]);
      await proposeApprovals(new Date(t0.getTime() + HOUR));
      await proposeApprovals(new Date(t0.getTime() + 3 * HOUR));
      expect(await stepAlerts()).toHaveLength(1);
      await proposeApprovals(new Date(t0.getTime() + 4 * HOUR + MINUTE));
      expect(await stepAlerts()).toHaveLength(2);
      // A week on, it is still waiting: never expired, never approved, never sent.
      await proposeApprovals(new Date(t0.getTime() + 8 * DAY));
      const [item] = await itemsOf("incident_report_send", [c.clinicId]);
      expect(item!.status).toBe("waiting");
      expect(await reportNotices(c.clinicId)).toEqual([]);
      // Each is a row in the ops log, which the ops-slack sweep posts whatever its event (lib/ops/slack.ts).
      expect(await stepAlerts()).toHaveLength(3);
    });
  });

  describe("the review's fixes", () => {
    const CHOICES: ReportFields = {
      event: "software_fault",
      occurredOn: null,
      info: [{ type: "first_name", count: 1 }],
      mitigations: ["investigating"],
      steps: [],
      recommendations: ["keep_record"],
      delayedByLawEnforcement: false,
      delayEndedOn: null,
    };

    async function openBreach(label: string) {
      const c = await seedClinic(label);
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const i = await openAt(c.clinicId, "breach", new Date(Date.now() - HOUR));
      return { c, i };
    }

    async function setJob(name: string, enabled: boolean) {
      await getMigratorPool().query(`update scheduled_jobs set enabled = $2 where name = $1`, [name, enabled]);
    }

    test("a rejected or failed first report is never proposed again by the hourly pass, nor one whose practice was told", async () => {
      const { c, i } = await openBreach("stick-reject");
      const t0 = new Date(Date.now() + MINUTE);
      await runIncidentSweep(t0);
      const [first] = await itemsOf("incident_report_send", [c.clinicId]);
      expect(await decide({ id: first!.id, action: "reject", reasonCode: "handled_elsewhere" })).toMatchObject({ status: "rejected" });
      const alertsBefore = (await stepAlerts()).length;
      await runIncidentSweep(new Date(t0.getTime() + 5 * HOUR));
      expect((await itemsOf("incident_report_send", [c.clinicId])).map((r) => r.status)).toEqual(["rejected"]);
      expect(await stepAlerts()).toHaveLength(alertsBefore);
      // By hand it can still be proposed.
      expect(
        data<{ status: string }>(await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR)).status,
      ).toBe("proposed");

      // A failed one: approved, and its operation failed.
      const failedCase = await openBreach("stick-failed");
      await runIncidentSweep(t0);
      const [item] = await itemsOf("incident_report_send", [failedCase.c.clinicId]);
      await getMigratorPool().query(`update ops_approvals set status = 'approved', decided_at = now() where id = $1`, [item!.id]);
      await getMigratorPool().query(`update ops_approvals set status = 'failed', outcome_code = 'refused' where id = $1`, [item!.id]);
      await runIncidentSweep(new Date(t0.getTime() + HOUR));
      expect((await itemsOf("incident_report_send", [failedCase.c.clinicId])).map((r) => r.status)).toEqual(["failed"]);

      // Told by phone and recorded: nothing proposed.
      const told = await openBreach("stick-told");
      await runOperation("markIncidentNotified", { clinicId: told.c.clinicId, incidentId: told.i.id, how: "Phoned the practice manager" }, OPERATOR);
      await runIncidentSweep(t0);
      expect(await itemsOf("incident_report_send", [told.c.clinicId])).toEqual([]);
    });

    test("two waiting items for one report approved at once send one report; the loser is refused, never an update", async () => {
      const { c, i } = await openBreach("race");
      const a = data<{ approvalId: string }>(await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR));
      const first = (await getApproval(a.approvalId))!;
      const b = await propose(
        {
          kind: "incident_report_send",
          subjectClinicId: c.clinicId,
          subjectRef: `${i.id}:1:1`,
          payload: parsePayload("incident_report_send", first.payload)!,
          dueAt: first.dueAt,
          proposedBy: "incident-assistant",
        },
        new Date(),
      );
      expect(b).not.toBeNull();
      const outcomes = await Promise.all(
        [a.approvalId, b!].map((id) => decide({ id, action: "approve", reasonCode: "owner_checked", editedFields: CHOICES })),
      );
      expect(outcomes.map((o) => o.status).sort()).toEqual(["executed", "failed"]);
      expect(await reportNotices(c.clinicId)).toHaveLength(1);
      expect((await reportNotices(c.clinicId))[0]!.dedupe_key).toBe(`incident_report:${i.id}:1`);
      expect((await incidentsOf(c.clinicId))[0]!.reports_sent).toBe(1);
    });

    test("the sender itself refuses a report number that has already gone", async () => {
      const { c, i } = await openBreach("expected");
      const send = (expectedReport: number) =>
        runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, event: "misdirected_email", info: [], mitigations: ["investigating"], expectedReport },
          OPERATOR,
        );
      expect(data<{ status: string }>(await send(1)).status).toBe("sent");
      expect(data<{ status: string }>(await send(1))).toMatchObject({ status: "refused" });
      expect(await reportNotices(c.clinicId)).toHaveLength(1);
    });

    test("with approvals-propose off, the incident-deadlines job proposes the first report and alerts by email and Slack", async () => {
      await setJob("approvals-propose", false);
      await setJob("incident-deadlines", true);
      const { c } = await openBreach("safety-net");
      const t0 = new Date(Date.now() + MINUTE);
      await runIncidentDeadlinesJob({ now: t0 });
      expect((await itemsOf("incident_report_send", [c.clinicId])).map((r) => r.status)).toEqual(["waiting"]);
      const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown>; mailed: boolean }>(
        `select fields, (sent_at is not null or last_error is not null) as mailed from ops_alerts where event = 'incident_step_waiting'`,
      );
      // Raised for email: the ops address was tried (sent, or why not, is on the row).
      expect(rows).toEqual([{ fields: { kind: "incident_report_send", count: 1 }, mailed: true }]);
      // And Slack: the sweep posts it.
      vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T000/B000/abcdefghijkl");
      const posted: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: { body: string }) => {
          posted.push(init.body);
          return new Response("ok", { status: 200 });
        }),
      );
      try {
        await runOpsSlackSweep(new Date());
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
      expect(posted.some((body) => body.includes("incident step"))).toBe(true);
      // Four hours on, the same job alerts again; it has proposed nothing more.
      await runIncidentDeadlinesJob({ now: new Date(t0.getTime() + 4 * HOUR + MINUTE) });
      expect(await stepAlerts()).toHaveLength(2);
      expect(await itemsOf("incident_report_send", [c.clinicId])).toHaveLength(1);
    });

    test("a report item at the demo clinic, or about an incident reported by hand, leaves the list unrun", async () => {
      const demo = await seedDemoClinic("gone-demo");
      const di = await openAt(demo.clinicId, "breach", new Date(Date.now() - HOUR));
      const proposed = data<{ approvalId: string }>(
        await runOperation("proposeIncidentReport", { clinicId: demo.clinicId, incidentId: di.id }, OPERATOR),
      );
      await runIncidentSweep(new Date(Date.now() + MINUTE));
      expect(await getApproval(proposed.approvalId)).toMatchObject({ status: "expired", outcomeCode: "clinic_out_of_service" });
    });

    test("approving a report the Incidents page already sent by hand runs nothing", async () => {
      const { c, i } = await openBreach("by-hand");
      const p = data<{ approvalId: string }>(await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR));
      await runOperation(
        "sendIncidentReport",
        { clinicId: c.clinicId, incidentId: i.id, event: "misdirected_email", info: [], mitigations: ["investigating"] },
        OPERATOR,
      );
      const out = await decide({ id: p.approvalId, action: "approve", reasonCode: "owner_checked", editedFields: CHOICES });
      expect(out).toMatchObject({ status: "failed", outcomeCode: "no_longer_needed" });
      expect(await reportNotices(c.clinicId)).toHaveLength(1);
    });

    test("an edit whose every key is valid but whose event is not a code is refused on the event", async () => {
      const { c, i } = await openBreach("bad-event");
      const p = data<{ approvalId: string }>(await runOperation("proposeIncidentReport", { clinicId: c.clinicId, incidentId: i.id }, OPERATOR));
      const out = await decide({
        id: p.approvalId,
        action: "approve",
        reasonCode: "owner_checked",
        editedFields: { ...CHOICES, event: "A caller's details went to the wrong inbox" },
      });
      expect(out.status).toBe("error");
      expect(out.message).toContain("each one must come from its list");
      expect(await reportNotices(c.clinicId)).toEqual([]);
      void i;
    });

    test("two batch items for one scope approved at once open each clinic's incident once; the database refuses a second open tick", async () => {
      const s = await seededWindow();
      const args = {
        vendor: "retell",
        from: s.from.toISOString(),
        to: s.to.toISOString(),
        class: "improper_use_or_disclosure",
        discoveredAt: s.now.toISOString(),
      };
      const first = data<{ approvalId: string }>(await runOperation("proposeIncidentBatch", args, OPERATOR));
      const item = (await getApproval(first.approvalId))!;
      const copy = await propose(
        {
          kind: "incident_open_batch",
          subjectClinicId: null,
          subjectRef: `${item.subjectRef}:copy`,
          payload: parsePayload("incident_open_batch", item.payload)!,
          proposedBy: "incident-assistant",
        },
        new Date(),
      );
      const outcomes = await Promise.all(
        [first.approvalId, copy!].map((id) => decide({ id, action: "approve", reasonCode: "owner_checked" })),
      );
      expect(outcomes.map((o) => o.status)).toEqual(["executed", "executed"]);
      const opened = await incidentsOf(s.a.clinicId);
      expect(opened).toHaveLength(1);
      const key = `vendor:retell:window_only:${s.from.toISOString()}:${s.to.toISOString()}:improper_use_or_disclosure`;
      await expect(
        inTenant(s.a.clinicId, async (cl) => {
          const other = await openAt(s.a.clinicId, "breach", new Date(Date.now() - HOUR));
          await cl.query(
            `insert into incident_checklist_ticks (clinic_id, incident_id, step, ticked_by, batch_key) values ($1, $2, 'open', 'ops@healdesk.test', $3)`,
            [s.a.clinicId, other.id, key],
          );
        }),
      ).rejects.toThrow();
    });

    test("a database host scope reaches every clinic holding data unless narrowed to its window", async () => {
      const s = await seededWindow();
      const empty = await seedClinic("holds-nothing");
      const base = { vendor: "database_host", from: s.from.toISOString(), to: s.to.toISOString() };
      const all = data<{ reach: string; clinics: { clinicId: string; total: number; holdsData: boolean | null }[] }>(
        await runOperation("incidentScope", base, OPERATOR),
      );
      expect(all.reach).toBe("all_holding");
      const ids = all.clinics.map((c) => c.clinicId);
      // scope-none had a conversation only before the window: it holds data, so it is in scope.
      expect(ids).toEqual(expect.arrayContaining([s.a.clinicId, s.b.clinicId, s.none.clinicId]));
      expect(all.clinics.find((c) => c.clinicId === s.none.clinicId)).toMatchObject({ total: 0, holdsData: true });
      expect(ids).not.toContain(empty.clinicId);
      expect(ids).not.toContain(s.demo.clinicId);
      const narrow = data<{ reach: string; clinics: { clinicId: string; holdsData: boolean | null }[] }>(
        await runOperation("incidentScope", { ...base, reach: "window_only" }, OPERATOR),
      );
      expect(narrow.reach).toBe("window_only");
      expect(narrow.clinics.map((c) => c.clinicId)).not.toContain(s.none.clinicId);
      expect(narrow.clinics[0]!.holdsData).toBeNull();
      expect((await runOperation("incidentScope", { ...base, vendor: "retell", reach: "all_holding" }, OPERATOR)).status).toBe(400);
    });

    test("a batch opens at most 100 clinics", () => {
      expect(MAX_BATCH_CLINICS).toBe(100);
      const ids = Array.from({ length: 101 }, () => randomUUID());
      expect(
        parseIncidentBatchPayload({
          source: "vendor",
          value: "aws",
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-02T00:00:00.000Z",
          incidentClass: "breach",
          discoveredAt: "2026-10-03T00:00:00.000Z",
          reach: "all_holding",
          clinicIds: ids,
          counts: ids.map(() => 0),
        }),
      ).toBeNull();
    });
  });
});
