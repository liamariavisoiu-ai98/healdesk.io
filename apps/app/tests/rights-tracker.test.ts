import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { isMutating, runOperation, type Operator } from "@/lib/ops/api";
import { dueSoonSentence, overdueSentence, rightsSource } from "@/lib/ops/inbox/rights";
import { operatorLabel } from "@/lib/ops/rights-ops";
import {
  backupExpiresOn,
  businessDaysLeft,
  clockState,
  daysLeftFor,
  dueOnFor,
  RIGHTS_CLOCKS,
  RIGHTS_KINDS,
} from "@/lib/rights/clocks";
import { NO_OPERATOR, NO_ROUTE, NO_ROUTE_AMENDMENT, NO_ROUTE_CORRECTION, prepareCommand, RUN_TASK } from "@/lib/rights/commands";
import { listRights, RETELL_OUTSTANDING, RUN_THEN_MARK, type RightsRow } from "@/lib/rights/tracker";
import { JOB_RIGHTS_WATCH, rightsAlertsFor, runRightsWatchJob, watchRights } from "@/lib/scheduler/rights-watch";
import { getJob } from "@/lib/scheduler/jobs";
import { runTick } from "@/lib/scheduler/tick";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedDemoClinic } from "./setup/factories";

/**
 * Lane P6c: the patient-rights tracker. The clocks across weekends, the
 * prepared commands (ids and fixed words only, nothing a shell would read
 * as more), the table's own refusals and row security, the idempotent
 * intake, the merged cross-clinic list, the daily watch's alerts once each
 * and off by default, and Home's two rows. Every clock is the test's; the
 * database's own clock only stamps rows. HEALDESK_OPS_EMAIL and
 * SLACK_WEBHOOK_URL are unset, so nothing is mailed or posted.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const CLINIC = "0c1d2e3f-0000-4000-8000-000000000001";
const CONTACT = "9a8b7c6d-1111-4222-8333-444455556666";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// -----------------------------------------------------------------------------
// The clocks
// -----------------------------------------------------------------------------

describe("the clocks", () => {
  test("count weekdays in UTC, over weekends and from a Friday", () => {
    // Friday 23 October 2026.
    expect(dueOnFor("erasure", "2026-10-23")).toBe("2026-11-06");
    expect(dueOnFor("amendment", "2026-10-23")).toBe("2026-11-06");
    expect(dueOnFor("correction", "2026-10-23")).toBe("2026-11-06");
    expect(dueOnFor("export", "2026-10-23")).toBe("2026-11-06");
    expect(dueOnFor("patient_request", "2026-10-23")).toBe("2026-10-30");
    // Received on a Saturday or a Sunday: the first business day is Monday.
    expect(dueOnFor("patient_request", "2026-10-24")).toBe("2026-10-30");
    expect(dueOnFor("erasure", "2026-10-25")).toBe("2026-11-06");
    // A Wednesday.
    expect(dueOnFor("patient_request", "2026-10-21")).toBe("2026-10-28");
    expect(dueOnFor("erasure", "2026-10-21")).toBe("2026-11-04");
  });

  test("the table has a clock for every kind: ten business days, five to pass a request on", () => {
    expect(Object.keys(RIGHTS_CLOCKS).sort()).toEqual([...RIGHTS_KINDS].sort());
    for (const kind of RIGHTS_KINDS) {
      expect(RIGHTS_CLOCKS[kind].businessDays).toBe(kind === "patient_request" ? 5 : 10);
    }
  });

  test("days left are business days, zero on the due day, negative after", () => {
    expect(businessDaysLeft("2026-10-22", "2026-10-26")).toBe(2); // Thu to Mon: Fri, Mon
    expect(businessDaysLeft("2026-10-24", "2026-10-26")).toBe(1); // Sat to Mon
    expect(businessDaysLeft("2026-10-26", "2026-10-26")).toBe(0);
    expect(businessDaysLeft("2026-10-27", "2026-10-26")).toBe(-1);
    expect(businessDaysLeft("2026-10-31", "2026-10-30")).toBe(0); // Sat after a Friday due day
    expect(businessDaysLeft("2026-11-02", "2026-10-30")).toBe(-1);
  });

  test("what a person reads never says 0 days left once the day has passed", () => {
    expect(daysLeftFor("2026-10-31", "2026-10-30")).toBe(-1); // Sat after a Friday due day
    expect(daysLeftFor("2026-11-01", "2026-10-30")).toBe(-1);
    expect(daysLeftFor("2026-11-03", "2026-10-30")).toBe(-2);
    expect(daysLeftFor("2026-10-30", "2026-10-30")).toBe(0);
    expect(daysLeftFor("2026-10-24", "2026-10-26")).toBe(1);
  });

  test("due soon is two business days or fewer; past the day is overdue", () => {
    expect(clockState("2026-10-21", "2026-10-26")).toBe("on_time"); // Thu, Fri, Mon: 3
    expect(clockState("2026-10-22", "2026-10-26")).toBe("due_soon");
    expect(clockState("2026-10-26", "2026-10-26")).toBe("due_soon");
    expect(clockState("2026-10-27", "2026-10-26")).toBe("overdue");
    expect(clockState("2026-10-31", "2026-10-30")).toBe("overdue");
  });

  test("an erasure's backups age out 35 calendar days after the deletion", () => {
    expect(backupExpiresOn(new Date("2026-10-01T15:00:00Z"))).toBe("2026-11-05");
  });
});

// -----------------------------------------------------------------------------
// The prepared commands
// -----------------------------------------------------------------------------

/** Every word after the script: a task name, a uuid, a closed word, a day, a field list or the operator's address. */
const FIXED = new Set([
  "patient-request",
  "erase-person",
  "patient-export",
  "amend-contact",
  "access",
  "amendment",
  "accounting",
  "deletion",
  "other",
  "practice",
  "person_via_practice",
  "representative_via_practice",
]);

function expectOnlyIdsAndFixedWords(command: string, operator = "ops@healdesk.test"): void {
  expect(command.startsWith(`${RUN_TASK} `)).toBe(true);
  for (const word of command.slice(RUN_TASK.length + 1).split(" ")) {
    const ok =
      FIXED.has(word) ||
      UUID.test(word) ||
      /^\d{4}-\d{2}-\d{2}$/.test(word) ||
      /^(fullName|phone|email)(,(fullName|phone|email))*$/.test(word) ||
      word === operator;
    expect(ok, `${word} in ${command}`).toBe(true);
  }
  expect(command).not.toMatch(/[;|&$`<>()'"\\\n\t]/);
}

describe("the prepared commands", () => {
  const base = { clinicId: CLINIC, receivedOn: "2026-10-23", operator: "Ops@Healdesk.test" };

  test("each kind's line, as the handover gives it, from ids and fixed words", () => {
    const request = prepareCommand({ ...base, kind: "patient_request", askedFor: "deletion" });
    expect(request).toEqual({
      command: `${RUN_TASK} patient-request ${CLINIC} deletion ops@healdesk.test 2026-10-23`,
      note: null,
      blocked: false,
    });
    const withContact = prepareCommand({ ...base, kind: "patient_request", askedFor: "access", contactId: CONTACT });
    expect(withContact.command).toBe(`${RUN_TASK} patient-request ${CLINIC} access ops@healdesk.test 2026-10-23 ${CONTACT}`);
    // With a contact id (the portal route, M5), the others have a line too.
    expect(prepareCommand({ ...base, kind: "erasure", contactId: CONTACT, requestedBy: "practice" }).command).toBe(
      `${RUN_TASK} erase-person ${CLINIC} ${CONTACT} practice ops@healdesk.test 2026-10-23`,
    );
    expect(prepareCommand({ ...base, kind: "export", contactId: CONTACT, requestedBy: "person_via_practice" }).command).toBe(
      `${RUN_TASK} patient-export ${CLINIC} ${CONTACT} person_via_practice`,
    );
    expect(
      prepareCommand({ ...base, kind: "correction", contactId: CONTACT, requestedBy: "practice", clearFields: ["phone", "email", "phone"] })
        .command,
    ).toBe(`${RUN_TASK} amend-contact ${CLINIC} ${CONTACT} phone,email practice ops@healdesk.test`);
    for (const out of [request, withContact]) expectOnlyIdsAndFixedWords(out.command!);
  });

  test("a request with no contact id is blocked, with the sentence in place of a command; an amendment always is", () => {
    for (const kind of ["erasure", "export", "correction"] as const) {
      expect(prepareCommand({ ...base, kind }), kind).toEqual({ command: null, note: NO_ROUTE, blocked: true });
    }
    expect(NO_ROUTE).toBe("No portal route yet turns this request into a contact id");
    // An amendment needs the practice's words, not a contact id: its own note, contact id or not.
    for (const contactId of [null, CONTACT]) {
      expect(prepareCommand({ ...base, kind: "amendment", contactId, requestedBy: "practice" })).toEqual({
        command: null,
        note: NO_ROUTE_AMENDMENT,
        blocked: true,
      });
    }
    // A correction with new values rather than fields to clear: its own note.
    expect(prepareCommand({ ...base, kind: "correction", contactId: CONTACT, requestedBy: "practice" })).toEqual({
      command: null,
      note: NO_ROUTE_CORRECTION,
      blocked: true,
    });
  });

  test("a shell metacharacter in the operator's address never reaches the line", () => {
    for (const operator of [
      "ops;rm -rf ~@healdesk.test",
      "$(id)@healdesk.test",
      "`id`@healdesk.test",
      "ops@healdesk.test; curl evil.example",
      "ops@healdesk.test && true",
      "ops@healdesk.test|sh",
      "o ps@healdesk.test",
      "ops@healdesk.test'",
      "ops@healdesk.test\nid",
      "",
      `${"a".repeat(250)}@healdesk.test`,
    ]) {
      expect(prepareCommand({ ...base, operator, kind: "patient_request", askedFor: "other" }), operator).toEqual({
        command: null,
        note: NO_OPERATOR,
        blocked: false,
      });
    }
  });

  test("a contact id that is not a uuid is no contact id, never a word in the line", () => {
    expect(prepareCommand({ ...base, kind: "erasure", contactId: "x; rm -rf /", requestedBy: "practice" }).blocked).toBe(true);
    const request = prepareCommand({ ...base, kind: "patient_request", askedFor: "other", contactId: "$(id)" });
    expect(request.command).toBe(`${RUN_TASK} patient-request ${CLINIC} other ops@healdesk.test 2026-10-23`);
    expect(prepareCommand({ ...base, kind: "erasure", contactId: CONTACT, requestedBy: "Sam's mum" as never }).blocked).toBe(true);
    expect(() => prepareCommand({ ...base, clinicId: "not-a-clinic", kind: "patient_request", askedFor: "other" })).toThrow();
    expect(() => prepareCommand({ ...base, receivedOn: "2026-10-23; id", kind: "patient_request", askedFor: "other" })).toThrow();
  });
});

describe("the operator's label on a row", () => {
  test("is the address's local part, never the address, and never a run of digits", () => {
    expect(operatorLabel("ops@healdesk.test")).toBe("ops");
    expect(operatorLabel("Liam.Ops@healdesk.io")).toBe("liam.ops");
    expect(operatorLabel("ops5550131@healdesk.io")).toBe("operator");
    expect(operatorLabel("weird name@healdesk.io")).toBe("operator");
  });
});

// -----------------------------------------------------------------------------
// The watch's rule, pure
// -----------------------------------------------------------------------------

function row(over: Partial<RightsRow>): RightsRow {
  return {
    id: randomUUID(),
    source: "intake",
    intakeId: null,
    recordId: null,
    clinicId: CLINIC,
    clinicName: "Synthetic Clinic",
    kind: "erasure",
    askedFor: null,
    verifiedVia: "notice_address",
    receivedOn: "2026-10-12",
    dueOn: "2026-10-26",
    dueDerived: false,
    daysLeft: 0,
    state: "on_time",
    command: null,
    commandNote: null,
    retellStep: null,
    backupExpiresOn: null,
    closedOn: null,
    ...over,
  };
}

describe("which alerts a request is owed", () => {
  test("blocked once, then its clock: due soon, overdue", () => {
    expect(rightsAlertsFor(row({ state: "blocked" }), "2026-10-20")).toEqual(["rights_request_blocked"]);
    expect(rightsAlertsFor(row({ state: "blocked" }), "2026-10-22")).toEqual(["rights_request_blocked", "rights_request_due_soon"]);
    expect(rightsAlertsFor(row({ state: "overdue" }), "2026-10-27")).toEqual(["rights_request_overdue"]);
    expect(rightsAlertsFor(row({ state: "done" }), "2026-10-27")).toEqual([]);
  });

  test("never a patient's own request already recorded on the host: the L32 sweep has those", () => {
    expect(rightsAlertsFor(row({ kind: "patient_request", source: "patient_request", recordId: CONTACT }), "2026-10-27")).toEqual([]);
    expect(rightsAlertsFor(row({ kind: "patient_request", recordId: CONTACT }), "2026-10-27")).toEqual([]);
    expect(rightsAlertsFor(row({ kind: "patient_request", askedFor: "access" }), "2026-10-27")).toEqual(["rights_request_overdue"]);
  });
});

describe("Home's sentences", () => {
  test("count, plainly", () => {
    expect(dueSoonSentence(1)).toBe("1 patient-rights request is due within two business days.");
    expect(dueSoonSentence(3)).toBe("3 patient-rights requests are due within two business days.");
    expect(overdueSentence(1)).toBe("1 patient-rights request is past its date.");
    expect(overdueSentence(2)).toBe("2 patient-rights requests are past their date.");
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

async function asApp<T>(clinicId: string, fn: (q: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const out = await fn(client as never);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** recordRightsIntake as the form sends it: with a fresh request key unless the test gives one. */
async function record(args: Record<string, unknown>) {
  return runOperation("recordRightsIntake", { requestKey: randomUUID(), ...args }, OPERATOR);
}

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (!("data" in outcome.body)) throw new Error(`not ok: ${JSON.stringify(outcome.body)}`);
  return outcome.body.data as T;
}

async function seedPatientRequest(
  clinicId: string,
  receivedAt: string,
  replyBy: string,
  acknowledged = false,
  kind = "deletion",
): Promise<string> {
  return inTenant(clinicId, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into patient_requests (clinic_id, kind, received_at, reply_by, recorded_by)
       values ($1, $4, $2, $3, 'ops') returning id`,
      [clinicId, receivedAt, replyBy, kind],
    );
    const id = rows[0]!.id;
    if (acknowledged) {
      await q.query(`update patient_requests set acknowledged_at = now(), acknowledged_by = 'Front desk' where id = $1`, [id]);
    }
    return id;
  });
}

async function seedErasure(clinicId: string, receivedAt: string, dueBy: string): Promise<string> {
  return inTenant(clinicId, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into erasure_requests (clinic_id, requested_by, received_at, due_by) values ($1, 'practice', $2, $3) returning id`,
      [clinicId, receivedAt, dueBy],
    );
    return rows[0]!.id;
  });
}

/** One clinic's alerts of an event: ops_alerts has no clinic key to cascade, so an earlier run's rows stay. */
async function alertsOf(event: string, clinicId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await getMigratorPool().query(`select fields from ops_alerts where event = $1 and fields->>'clinicId' = $2`, [
    event,
    clinicId,
  ]);
  return rows.map((r) => r.fields as Record<string, unknown>);
}

describeDb("the rights tracker, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    vi.unstubAllEnvs();
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePools();
  });

  test("the table refuses an address, a run of digits, a wrong closed word and a due day off the clock", async () => {
    const c = await seedClinic("rights-text");
    const insert = (over: Record<string, string | null>) => {
      const v = { kind: "erasure", asked_for: null, received_on: "2026-10-01", verified_via: "notice_address", due_on: "2026-10-15", recorded_by: "ops", ...over };
      return asApp(c.clinicId, (q) =>
        q.query(
          `insert into rights_intakes (clinic_id, request_key, kind, asked_for, received_on, verified_via, due_on, recorded_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7)`,
          [c.clinicId, v.kind, v.asked_for, v.received_on, v.verified_via, v.due_on, v.recorded_by],
        ),
      );
    };
    await expect(insert({ recorded_by: "ops@healdesk.test" })).rejects.toMatchObject({ constraint: "rights_intakes_text_check" });
    await expect(insert({ recorded_by: "ops 555 0131" })).rejects.toMatchObject({ constraint: "rights_intakes_text_check" });
    await expect(insert({ recorded_by: "5550131001" })).rejects.toMatchObject({ constraint: "rights_intakes_text_check" });
    await expect(insert({ kind: "deletion" })).rejects.toMatchObject({ constraint: "rights_intakes_kind_check" });
    await expect(insert({ verified_via: "email" })).rejects.toMatchObject({ constraint: "rights_intakes_verified_via_check" });
    await expect(insert({ asked_for: "access" })).rejects.toMatchObject({ constraint: "rights_intakes_asked_for_check" });
    await expect(insert({ kind: "patient_request" })).rejects.toMatchObject({ constraint: "rights_intakes_asked_for_check" });
    await expect(insert({ due_on: "2026-10-02" })).rejects.toMatchObject({ constraint: "rights_intakes_due_check" });
    await expect(insert({ received_on: "2999-01-01", due_on: "2999-01-15" })).rejects.toThrow(/cannot be received after today/);
    await insert({});
  });

  test("row security: a clinic sees only its own; the runtime role cannot delete, move or reopen one", async () => {
    const a = await seedClinic("rights-a");
    const b = await seedClinic("rights-b");
    const recorded = data<{ id: string }>(
      await record({ clinicId: a.clinicId, kind: "export", receivedOn: "2026-10-01", verifiedVia: "phone_confirmed" }),
    );
    expect((await asApp(b.clinicId, (q) => q.query(`select id from rights_intakes`))).rows).toEqual([]);
    expect((await asApp(a.clinicId, (q) => q.query(`select id from rights_intakes`))).rows).toEqual([{ id: recorded.id }]);
    await expect(asApp(a.clinicId, (q) => q.query(`delete from rights_intakes where id = $1`, [recorded.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(a.clinicId, (q) => q.query(`update rights_intakes set due_on = '2026-12-01' where id = $1`, [recorded.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(b.clinicId, (q) =>
        q.query(
          `insert into rights_intakes (clinic_id, request_key, kind, received_on, verified_via, due_on, recorded_by) values ($1, gen_random_uuid(), 'export', '2026-10-01', 'unverified', '2026-10-15', 'ops')`,
          [a.clinicId],
        ),
      ),
    ).rejects.toThrow();
    expect(data<{ outcome: string }>(await runOperation("closeRightsIntake", { clinicId: a.clinicId, id: recorded.id, status: "done" }, OPERATOR)).outcome).toBe("closed");
    await expect(
      asApp(a.clinicId, (q) => q.query(`update rights_intakes set status = 'open', closed_at = null where id = $1`, [recorded.id])),
    ).rejects.toThrow(/already closed/);
    expect(data<{ outcome: string }>(await runOperation("closeRightsIntake", { clinicId: a.clinicId, id: recorded.id, status: "not_applicable" }, OPERATOR))).toEqual({
      outcome: "already_closed",
      status: "done",
      auditRecorded: true,
    });
    // Another clinic's intake is not found from this one.
    expect((await runOperation("closeRightsIntake", { clinicId: b.clinicId, id: recorded.id, status: "done" }, OPERATOR)).status).toBe(404);
  });

  test("recording is idempotent by the form's key, writes for the operator, and names no person", async () => {
    const c = await seedClinic("rights-once");
    const args = { clinicId: c.clinicId, requestKey: randomUUID(), kind: "erasure", receivedOn: "2026-10-02", verifiedVia: "notice_address" };
    const first = data<{ outcome: string; id: string; dueOn: string }>(await record(args));
    expect(first).toMatchObject({ outcome: "recorded", dueOn: "2026-10-16" });
    // The same key again (a retried submit): the same request, nothing written.
    const again = data<{ outcome: string; id: string }>(await record(args));
    expect(again).toMatchObject({ outcome: "already_recorded", id: first.id });
    const { rows } = await inTenant(c.clinicId, (q) =>
      q.query(`select recorded_by, status, due_on::text from rights_intakes where clinic_id = $1`, [c.clinicId]),
    );
    expect(rows).toEqual([{ recorded_by: "ops", status: "open", due_on: "2026-10-16" }]);
    // A second person's request of the same kind, the same day, at the same clinic: its own key, its own row.
    const other = data<{ outcome: string; id: string }>(await record({ ...args, requestKey: randomUUID() }));
    expect(other.outcome).toBe("recorded");
    expect(other.id).not.toBe(first.id);
    const both = await inTenant(c.clinicId, (q) => q.query(`select id from rights_intakes where clinic_id = $1`, [c.clinicId]));
    expect(both.rows).toHaveLength(2);
    // The first request's own trail: one audit row and one security event, the retry adding none.
    const audit = await inTenant(c.clinicId, (q) =>
      q.query(`select action, actor_service_name, metadata from audit_log where resource_type = 'rights_intake' and clinic_id = $1 and resource_id = $2`, [
        c.clinicId,
        first.id,
      ]),
    );
    expect(audit.rows).toEqual([
      { action: "create", actor_service_name: "ops@healdesk.test", metadata: { kind: "erasure", verifiedVia: "notice_address", linked: false } },
    ]);
    const events = await getMigratorPool().query(
      `select actor_label, metadata from security_events where event = 'rights_intake_recorded' and metadata->>'intakeId' = $1`,
      [first.id],
    );
    expect(events.rows).toEqual([
      {
        actor_label: "ops@healdesk.test",
        metadata: { clinicSlug: c.slug, intakeId: first.id, kind: "erasure", verifiedVia: "notice_address", linkedRecordId: null },
      },
    ]);
    expect(isMutating("recordRightsIntake")).toBe(true);
    expect(isMutating("closeRightsIntake")).toBe(true);
    expect(isMutating("listRights")).toBe(false);
  });

  test("the envelope refuses what is not an id, a closed word or a day", async () => {
    const c = await seedClinic("rights-args");
    const base = { clinicId: c.clinicId, kind: "erasure", receivedOn: "2026-10-02", verifiedVia: "notice_address" };
    for (const bad of [
      { ...base, name: "Sam" },
      { ...base, kind: "deletion" },
      { ...base, receivedOn: "2 October" },
      { ...base, receivedOn: "2999-01-01" },
      { ...base, verifiedVia: "by email" },
      { ...base, askedFor: "access" },
      { ...base, kind: "patient_request" },
      { ...base, kind: "export", linkedRecordId: randomUUID() },
      { ...base, linkedRecordId: "not-a-uuid" },
    ]) {
      expect((await record(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await record({ ...base, linkedRecordId: randomUUID() })).status).toBe(404);
    // The request key: required, and a uuid.
    for (const requestKey of [undefined, "", "retry-1", 42]) {
      expect((await runOperation("recordRightsIntake", { ...base, requestKey }, OPERATOR)).status, String(requestKey)).toBe(400);
    }
    // A linked patient request must have asked for what the intake says.
    const passedOn = await seedPatientRequest(c.clinicId, "2026-10-19T10:00:00Z", "2026-10-26");
    const mismatch = await record({ ...base, kind: "patient_request", askedFor: "access", linkedRecordId: passedOn });
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(mismatch.body)).toContain("asked for something else");
    expect((await record({ ...base, kind: "patient_request", askedFor: "deletion", linkedRecordId: passedOn })).status).toBe(200);
    // One intake per record: a second key naming the same record returns the first.
    const first = await inTenant(c.clinicId, (q) => q.query<{ id: string }>(`select id from rights_intakes where linked_record_id = $1`, [passedOn]));
    expect(data<{ outcome: string; id: string }>(await record({ ...base, kind: "patient_request", askedFor: "deletion", linkedRecordId: passedOn }))).toMatchObject({
      outcome: "already_recorded",
      id: first.rows[0]!.id,
    });
    expect((await runOperation("listRights", { status: "late" }, OPERATOR)).status).toBe(400);
    expect((await runOperation("listRights", { limit: 0 }, OPERATOR)).status).toBe(400);
  });

  test("the list merges the records with a clock, once each, with commands only where one can run", async () => {
    const c = await seedClinic("rights-list");
    const now = new Date("2026-10-22T12:00:00Z"); // a Thursday
    // A patient's request passed on and not marked received, and the intake that became it.
    const passedOn = await seedPatientRequest(c.clinicId, "2026-10-19T10:00:00Z", "2026-10-26");
    const linked = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "patient_request", askedFor: "deletion", receivedOn: "2026-10-19", verifiedVia: "unverified", linkedRecordId: passedOn }),
    );
    // A patient's request marked received: done.
    await seedPatientRequest(c.clinicId, "2026-10-12T10:00:00Z", "2026-10-19", true);
    // A deletion that ran, its Retell step outstanding.
    const erasure = await seedErasure(c.clinicId, "2026-10-08T09:00:00Z", "2026-10-22T09:00:00Z");
    // A deletion request that came as words: blocked.
    const blocked = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "erasure", receivedOn: "2026-10-20", verifiedVia: "notice_address" }),
    );
    // A patient's request still to record on the host: a command.
    const toRun = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "patient_request", askedFor: "access", receivedOn: "2026-10-21", verifiedVia: "unverified" }),
    );
    const list = await listRights({ actor: { type: "service", serviceName: "ops@healdesk.test" }, operator: "ops@healdesk.test", now, clinics: [{ id: c.clinicId, name: "List Clinic" }] });
    expect(list.count).toBe(4);
    const byId = new Map(list.rows.map((r) => [r.id, r]));
    expect(byId.get(linked.id)).toMatchObject({
      source: "intake",
      recordId: passedOn,
      dueOn: "2026-10-26",
      daysLeft: 2,
      state: "due_soon",
      command: null,
      commandNote: null,
    });
    expect(byId.has(passedOn)).toBe(false);
    expect(byId.get(erasure)).toMatchObject({
      source: "erasure_request",
      kind: "erasure",
      dueOn: "2026-10-22",
      state: "due_soon",
      retellStep: "outstanding",
      backupExpiresOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(byId.get(blocked.id)).toMatchObject({ state: "blocked", command: null, commandNote: NO_ROUTE, dueOn: "2026-11-03", daysLeft: 8 });
    expect(byId.get(toRun.id)).toMatchObject({
      state: "on_time",
      dueOn: "2026-10-28",
      command: `${RUN_TASK} patient-request ${c.clinicId} access ops@healdesk.test 2026-10-21`,
    });
    // Blocked rows carry no command; every command is ids and fixed words.
    for (const r of list.rows) {
      if (r.state === "blocked") expect(r.command).toBeNull();
      if (r.command) expectOnlyIdsAndFixedWords(r.command);
    }
    // Earliest due first.
    expect(list.rows.map((r) => r.dueOn)).toEqual([...list.rows.map((r) => r.dueOn)].sort());
    // The done one, under done.
    const done = await listRights({ actor: { type: "service", serviceName: "t" }, operator: "ops@healdesk.test", now, filter: "done", clinics: [{ id: c.clinicId, name: "List Clinic" }] });
    expect(done.rows.map((r) => [r.source, r.state])).toEqual([["patient_request", "done"]]);
    // Nothing that names a person, anywhere in the answer.
    expect(JSON.stringify(list)).not.toMatch(/contact_?id|phone|email|@(?!healdesk\.test)/i);
    // One access row for the clinic whose request records were read.
    const access = await inTenant(c.clinicId, (q) =>
      q.query<{ n: number }>(
        `select count(*)::int as n from audit_log where clinic_id = $1 and resource_type = 'patient_rights' and action = 'read'`,
        [c.clinicId],
      ),
    );
    expect(access.rows[0]!.n).toBe(2);
  });

  test("across clinics the demo clinic is left out unless asked for", async () => {
    const real = await seedClinic("rights-real");
    const demo = await seedDemoClinic("rights-demo");
    await record({ clinicId: real.clinicId, kind: "export", receivedOn: "2026-10-20", verifiedVia: "notice_address" });
    await record({ clinicId: demo.clinicId, kind: "export", receivedOn: "2026-10-20", verifiedVia: "notice_address" });
    const plain = data<{ rows: RightsRow[] }>(await runOperation("listRights", {}, OPERATOR));
    expect(plain.rows.map((r) => r.clinicId)).toEqual([real.clinicId]);
    const all = data<{ rows: RightsRow[] }>(await runOperation("listRights", { includeDemo: true }, OPERATOR));
    expect(all.rows.map((r) => r.clinicId).sort()).toEqual([real.clinicId, demo.clinicId].sort());
  });

  test("the watch is off by default; on, it raises each alert once per request and state", async () => {
    const c = await seedClinic("rights-watch");
    expect((await getJob(JOB_RIGHTS_WATCH))?.enabled).toBe(false);
    expect(await runRightsWatchJob({ now: new Date("2026-10-22T08:00:00Z") })).toEqual({ status: "disabled" });

    const blocked = data<{ id: string }>(await record({ clinicId: c.clinicId, kind: "erasure", receivedOn: "2026-10-08", verifiedVia: "notice_address" }));
    const passedOn = await seedPatientRequest(c.clinicId, "2026-10-12T10:00:00Z", "2026-10-19");
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = $1`, [JOB_RIGHTS_WATCH]);

    // Tuesday 20 October; the erasure's due day is Thursday 22 October: two business days left.
    expect((await runRightsWatchJob({ now: new Date("2026-10-20T08:00:00Z") })).status).toBe("ok");
    expect(await alertsOf("rights_request_blocked", c.clinicId)).toEqual([{ clinicId: c.clinicId, requestId: blocked.id }]);
    expect(await alertsOf("rights_request_due_soon", c.clinicId)).toEqual([{ clinicId: c.clinicId, requestId: blocked.id }]);
    expect(await alertsOf("rights_request_overdue", c.clinicId)).toEqual([]);
    // Run again the same day and the next: nothing new until the day passes.
    await watchRights(new Date("2026-10-20T09:00:00Z"));
    await watchRights(new Date("2026-10-21T08:00:00Z"));
    expect(await alertsOf("rights_request_blocked", c.clinicId)).toHaveLength(1);
    expect(await alertsOf("rights_request_due_soon", c.clinicId)).toHaveLength(1);
    // Past it: overdue, once.
    const late = await watchRights(new Date("2026-10-23T08:00:00Z"));
    await watchRights(new Date("2026-10-26T08:00:00Z"));
    expect(late).toMatchObject({ open: 2, leftToL32: 1, overdue: 1 });
    expect(await alertsOf("rights_request_overdue", c.clinicId)).toEqual([{ clinicId: c.clinicId, requestId: blocked.id }]);
    // The patient's request recorded on the host is the L32 sweep's, never these events.
    for (const event of ["rights_request_blocked", "rights_request_due_soon", "rights_request_overdue"]) {
      expect((await alertsOf(event, c.clinicId)).some((f) => f.requestId === passedOn), event).toBe(false);
    }
    // Closed, it is owed nothing more.
    await runOperation("closeRightsIntake", { clinicId: c.clinicId, id: blocked.id, status: "done" }, OPERATOR);
    expect(await watchRights(new Date("2026-10-27T08:00:00Z"))).toMatchObject({ open: 1, blocked: 0, overdue: 0 });
  });

  test("a linked deletion is done only once Retell's copy is recorded, and its intake cannot close before", async () => {
    const c = await seedClinic("rights-retell");
    const erasure = await seedErasure(c.clinicId, "2026-10-08T09:00:00Z", "2026-10-22T09:00:00Z");
    const intake = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "erasure", receivedOn: "2026-10-08", verifiedVia: "notice_address", linkedRecordId: erasure }),
    );
    const close = await runOperation("closeRightsIntake", { clinicId: c.clinicId, id: intake.id, status: "done" }, OPERATOR);
    expect(close.status).toBe(409);
    expect(JSON.stringify(close.body)).toContain(RETELL_OUTSTANDING);
    const listOf = async () =>
      (await listRights({ actor: { type: "service", serviceName: "t" }, operator: "ops@healdesk.test", now: new Date("2026-10-23T08:00:00Z"), filter: "all", clinics: [{ id: c.clinicId, name: "R" }] })).rows;
    expect(await listOf()).toMatchObject([{ id: intake.id, recordId: erasure, state: "overdue", retellStep: "outstanding" }]);
    // Stamped at Retell: done, even with the intake still open; and now it may close.
    await inTenant(c.clinicId, (q) =>
      q.query(`update erasure_requests set vendor_steps = '{"retell": {"at": "2026-10-20T00:00:00Z", "by": "ops", "how": "deleted"}}' where id = $1`, [erasure]),
    );
    expect(await listOf()).toMatchObject([{ id: intake.id, state: "done", retellStep: "stamped", daysLeft: null }]);
    expect((await runOperation("closeRightsIntake", { clinicId: c.clinicId, id: intake.id, status: "done" }, OPERATOR)).status).toBe(200);
  });

  test("a linked patient request stays open until the practice marks it, closed intake or not", async () => {
    const c = await seedClinic("rights-l32");
    const passedOn = await seedPatientRequest(c.clinicId, "2026-10-19T10:00:00Z", "2026-10-26");
    const intake = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "patient_request", askedFor: "deletion", receivedOn: "2026-10-19", verifiedVia: "unverified", linkedRecordId: passedOn }),
    );
    expect((await runOperation("closeRightsIntake", { clinicId: c.clinicId, id: intake.id, status: "done" }, OPERATOR)).status).toBe(200);
    const open = await listRights({ actor: { type: "service", serviceName: "t" }, operator: "ops@healdesk.test", now: new Date("2026-10-22T08:00:00Z"), clinics: [{ id: c.clinicId, name: "R" }] });
    expect(open.rows).toMatchObject([{ id: intake.id, recordId: passedOn, state: "due_soon" }]);
  });

  test("nothing pairs an intake with a request the host recorded: two intakes, one request, each its own row and clock", async () => {
    const c = await seedClinic("rights-nomatch");
    const one = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "patient_request", askedFor: "deletion", receivedOn: "2026-10-12", verifiedVia: "unverified" }),
    );
    const two = data<{ id: string }>(
      await record({ clinicId: c.clinicId, kind: "patient_request", askedFor: "deletion", receivedOn: "2026-10-12", verifiedVia: "unverified" }),
    );
    // The owner ran one command: the host records one request, the same kind and day.
    const onHost = await seedPatientRequest(c.clinicId, "2026-10-12T00:00:00Z", "2026-10-19");
    const listAt = async (iso: string) =>
      (await listRights({ actor: { type: "service", serviceName: "t" }, operator: "ops@healdesk.test", now: new Date(iso), clinics: [{ id: c.clinicId, name: "M" }] })).rows;
    const rows = await listAt("2026-10-13T08:00:00Z");
    expect(rows).toHaveLength(3);
    for (const id of [one.id, two.id]) {
      expect(rows.find((r) => r.id === id)).toMatchObject({
        source: "intake",
        recordId: null,
        dueOn: "2026-10-19",
        command: expect.stringContaining("patient-request"),
        commandNote: RUN_THEN_MARK,
      });
    }
    expect(rows.find((r) => r.id === onHost)).toMatchObject({ source: "patient_request", state: "on_time" });
    // Closing one intake changes nothing for the other, nor for the host's request.
    await runOperation("closeRightsIntake", { clinicId: c.clinicId, id: one.id, status: "done" }, OPERATOR);
    const after = await listAt("2026-10-13T08:00:00Z");
    expect(after.map((r) => r.id).sort()).toEqual([two.id, onHost].sort());
    expect(after.find((r) => r.id === two.id)).toMatchObject({ commandNote: RUN_THEN_MARK, state: "on_time" });
    // Past its day the open intake is alerted as overdue by the watch, the request left to the L32 sweep.
    await watchRights(new Date("2026-10-21T08:00:00Z"));
    expect(await alertsOf("rights_request_overdue", c.clinicId)).toEqual([{ clinicId: c.clinicId, requestId: two.id }]);
    // A purged host request revives nothing: the closed intake stays closed, the open one unchanged.
    await inTenant(c.clinicId, (q) => q.query(`delete from patient_requests where id = $1`, [onHost]));
    const purged = await listAt("2026-10-13T08:00:00Z");
    expect(purged.map((r) => r.id)).toEqual([two.id]);
    expect(purged[0]).toMatchObject({ commandNote: RUN_THEN_MARK, state: "on_time", dueOn: "2026-10-19" });
  });

  test("a linked row is due on the earlier of the intake's day and the record's", async () => {
    const c = await seedClinic("rights-due");
    // The deletion's stored due day is later than ten business days from the intake's receipt.
    const erasure = await seedErasure(c.clinicId, "2026-10-12T09:00:00Z", "2026-10-30T09:00:00Z");
    const intake = data<{ id: string; dueOn: string }>(
      await record({ clinicId: c.clinicId, kind: "erasure", receivedOn: "2026-10-08", verifiedVia: "notice_address", linkedRecordId: erasure }),
    );
    expect(intake.dueOn).toBe("2026-10-22");
    const list = await listRights({ actor: { type: "service", serviceName: "t" }, operator: "ops@healdesk.test", now: new Date("2026-10-26T08:00:00Z"), clinics: [{ id: c.clinicId, name: "D" }] });
    expect(list.rows).toMatchObject([{ id: intake.id, dueOn: "2026-10-22", state: "overdue", daysLeft: -2 }]);
  });

  test("runs from the 08 UTC tick and from no other hour's, reporting disabled while off", async () => {
    const at = async (iso: string) => (await runTick(new Date(iso))).find((outcome) => outcome.job === "rights-watch");
    expect(await at("2026-10-20T08:00:00Z")).toMatchObject({ status: "disabled" });
    for (const hour of ["07", "09"]) {
      expect(await at(`2026-10-20T${hour}:00:00Z`), hour).toBeUndefined();
    }
  });

  test("Home shows one row for the due soon and one for the late, linking to the Patient rights page", async () => {
    const c = await seedClinic("rights-home");
    await record({ clinicId: c.clinicId, kind: "export", receivedOn: "2026-10-08", verifiedVia: "notice_address" }); // due 22 Oct
    await record({ clinicId: c.clinicId, kind: "correction", receivedOn: "2026-10-01", verifiedVia: "notice_address" }); // due 15 Oct
    await seedPatientRequest(c.clinicId, "2026-10-16T10:00:00Z", "2026-10-23");
    const ctx = {
      now: new Date("2026-10-21T12:00:00Z"),
      operator: OPERATOR,
      actor: { type: "service" as const, serviceName: OPERATOR.email },
      request: {},
      clinicNames: async () => new Map<string, string>(),
    };
    const { rows, partial } = await rightsSource.read(ctx);
    expect(partial).toBeUndefined();
    expect(rows).toEqual([
      {
        id: "rights:overdue",
        kind: "rights",
        count: 1,
        sentence: "1 patient-rights request is past its date.",
        clinic: null,
        button: { label: "Open patient rights", kind: "link", href: "/admin/rights" },
        tone: "bad",
        dueAt: "2026-10-15",
      },
      {
        id: "rights:due_soon",
        kind: "rights",
        count: 2,
        sentence: "2 patient-rights requests are due within two business days.",
        clinic: null,
        button: { label: "Open patient rights", kind: "link", href: "/admin/rights" },
        tone: "warn",
        dueAt: "2026-10-22",
      },
    ]);
  });
});
