import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import {
  opAssignSupportCase,
  opCloseSupportCase,
  opGetSupportCase,
  opListSupportCases,
  opMatchSupportCase,
  opSnoozeSupportCase,
} from "@/lib/ops/support-case-ops";
import { insertCase, recordChatEscalation } from "@/lib/support/cases";
import { opsPeople } from "@/lib/support/people";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The support cases' ops operations (lane P7a; lib/ops/support-case-ops.ts)
 * against the real database: registered, the writes mutating and audited
 * with the operator's name, the reads carrying no word of text, the facts
 * panel from the existing readers, and each move refused where the case's
 * state does not allow it. Every clock is fixed; the shared ops_alerts table
 * is cleared for this file.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "support-case-ops-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "203.0.113.9", userAgent: "vitest" } };
const NOW = new Date("2026-10-14T15:00:00Z");
const WORDS = "Marisol's filler appointment at 3pm went wrong, call 512 555 0100";

const OPS = [
  "listSupportCases",
  "getSupportCase",
  "snoozeSupportCase",
  "assignSupportCase",
  "matchSupportCase",
  "closeSupportCase",
] as const;

function data<T = Record<string, unknown>>(outcome: { status: number; body: unknown }): T {
  expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
  return (outcome.body as { data: T }).data;
}

async function chatCase(clinicId: string, topic: "forwarding" | "billing" | "other" = "other", symptom = "other") {
  return recordChatEscalation({
    clinicId,
    actor: ACTOR,
    requestId: randomUUID(),
    fields: { topic, symptom, carrier: null, phoneSystem: null, mode: null, channel: null },
    replyByOn: "2026-10-15",
    now: NOW,
  });
}

async function securityEvent(event: string, ref: string) {
  const { rows } = await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown>; ip_address: string | null }>(
    `select actor_label, metadata, ip_address from security_events where event = $1 and metadata->>'ref' = $2`,
    [event, ref],
  );
  return rows;
}

test("the six operations are registered; the four moves are mutating and the two reads are not", () => {
  for (const op of OPS) expect(isOpName(op), op).toBe(true);
  expect(OPS.filter((op) => isMutating(op))).toEqual([
    "snoozeSupportCase",
    "assignSupportCase",
    "matchSupportCase",
    "closeSupportCase",
  ]);
});

test("HEALDESK_OPS_PEOPLE: comma-separated names, a bad one left out, the team by default", () => {
  expect(opsPeople(undefined)).toEqual(["The Healdesk Team"]);
  expect(opsPeople("")).toEqual(["The Healdesk Team"]);
  expect(opsPeople(" Liam ,  Dana  Reyes, ops@healdesk.io, 5125550100, Liam")).toEqual(["Liam", "Dana Reyes"]);
});

describeDb("support case operations", () => {
  let portal: PortalClinic;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    portal = await provisionPortalClinic("supportops", { plan: "voice-webchat-500-300" });
  }, 180_000);

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("HEALDESK_OPS_PEOPLE", "Liam, Dana Reyes");
    await getMigratorPool().query(`delete from ops_alerts`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  test("list and get carry no word of text, and get shows the facts panel from the existing readers", async () => {
    const c = await chatCase(portal.clinicId, "forwarding", "calls_ring_out");
    // An email message with words on another case (the inbound slice's shape), to prove nothing reads them out.
    const other = await seedClinic("supportops-other");
    const email = await withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
      insertCase(tx.db, {
        subjectClinicId: portal.clinicId,
        source: "email",
        category: "billing",
        symptom: "other",
        urgency: "today",
        replyByOn: "2026-10-15",
        now: NOW,
      }),
    );
    // Lane P7g (0130): an inbound email holds facts only, and the database refuses its words outright.
    await expect(
      getMigratorPool().query(
        `insert into support_messages (case_id, direction, kind, inbound_mail_id, sender_ref, fields_json, received_at, subject_screened, text)
         values ($1, 'in', 'email', 'sesops1', repeat('a', 64), '{"source":"email"}', now(), $2, $2)`,
        [email.id, WORDS],
      ),
    ).rejects.toThrow(/support_messages_email_check/);
    await getMigratorPool().query(
      `insert into support_messages (case_id, direction, kind, inbound_mail_id, sender_ref, fields_json, received_at)
       values ($1, 'in', 'email', 'sesops2', repeat('a', 64), '{"source":"email","topic":"billing"}', now())`,
      [email.id],
    );
    await getMigratorPool().query(
      `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at) values
         ('calendar_disconnected', $1, $2, $3, $3),
         ('calendar_disconnected', $4, $5, $3, $3),
         ('setup_reminder_due', $6, $2, $7, $7)`,
      [
        `a:${portal.clinicId}`,
        JSON.stringify({ clinicId: portal.clinicId }),
        new Date("2026-10-12T10:00:00Z"),
        `a:${other.clinicId}`,
        JSON.stringify({ clinicId: other.clinicId }),
        `b:${portal.clinicId}`,
        // Older than 14 days: out of the panel.
        new Date("2026-09-20T10:00:00Z"),
      ],
    );

    const listed = data<{ rows: Record<string, unknown>[]; count: number; truncated: boolean }>(
      await opListSupportCases({ state: "open" }, OPERATOR, NOW),
    );
    const mine = listed.rows.filter((r) => r.clinicId === portal.clinicId);
    expect(mine.map((r) => r.id).sort()).toEqual([c.caseId, email.id].sort());
    const row = mine.find((r) => r.id === c.caseId)!;
    expect(row).toMatchObject({
      ref: `HD-${c.ref}`,
      clinicName: expect.any(String),
      source: "chat",
      category: "forwarding",
      symptom: "calls_ring_out",
      urgency: "now",
      state: "new",
      replyByOn: "2026-10-15",
      pastDue: false,
      ageHours: 0,
      inboundCount: 1,
    });
    expect(JSON.stringify(listed)).not.toContain("Marisol");

    const got = data<{
      case: Record<string, unknown>;
      messages: Record<string, unknown>[];
      facts: { days: number; account: Record<string, unknown> | null; alerts: { event: string }[] | null; transcripts: Record<string, number> | null };
      draft: null;
      people: string[];
    }>(await opGetSupportCase({ caseId: email.id }, OPERATOR, NOW));
    expect(JSON.stringify(got)).not.toContain("Marisol");
    expect(JSON.stringify(got)).not.toMatch(/512.?555/);
    expect(got.messages).toEqual([
      expect.objectContaining({ direction: "in", kind: "email", fields: null, hasDraft: false }),
    ]);
    expect(got.draft).toBeNull();
    expect(got.people).toEqual(["Liam", "Dana Reyes"]);
    expect(got.facts.days).toBe(14);
    expect(got.facts.alerts).toEqual([
      { event: "calendar_disconnected", raisedAt: "2026-10-12T10:00:00.000Z", lastRaisedAt: "2026-10-12T10:00:00.000Z", repeats: 0 },
    ]);
    expect(got.facts.transcripts).toMatchObject({ delivered: 0 });
    expect(got.facts.account).toMatchObject({ clinicId: portal.clinicId, isClosed: false });
    // No phone number crosses: a flag says whether each is set.
    expect(got.facts.account).not.toHaveProperty("directLineE164");
    expect(got.facts.account).not.toHaveProperty("publishedPhoneE164");
    expect(got.facts.account).toHaveProperty("isDirectLineSet");

    const chat = data<{ messages: Record<string, unknown>[] }>(await opGetSupportCase({ caseId: c.caseId }, OPERATOR, NOW));
    expect(chat.messages).toEqual([
      expect.objectContaining({
        kind: "chat_escalation",
        fields: { topic: "forwarding", symptom: "calls_ring_out", carrier: null, phoneSystem: null, mode: null, channel: null },
      }),
    ]);

    expect((await opGetSupportCase({ caseId: randomUUID() }, OPERATOR, NOW)).status).toBe(404);
    expect((await opGetSupportCase({ caseId: "HD-7F3KQ" }, OPERATOR, NOW)).status).toBe(400);
    expect((await opListSupportCases({ state: "pending" }, OPERATOR, NOW)).status).toBe(400);
    expect((await opListSupportCases({ limit: 500 }, OPERATOR, NOW)).status).toBe(400);
    expect((await opListSupportCases({ text: true }, OPERATOR, NOW)).status).toBe(400);
  });

  test("snooze, reassign and close: each audited with the operator's name, ids and closed words only; a closed case refuses every move", async () => {
    const clinic = await seedClinic("supportops-moves");
    const c = await chatCase(clinic.clinicId, "billing", "invoice_question");
    const ref = `HD-${c.ref}`;

    // Snooze: a time in the next 30 days only.
    expect((await opSnoozeSupportCase({ caseId: c.caseId, until: "2026-10-14T14:00:00Z" }, OPERATOR, NOW)).status).toBe(400);
    expect((await opSnoozeSupportCase({ caseId: c.caseId, until: "2026-12-01T14:00:00Z" }, OPERATOR, NOW)).status).toBe(400);
    expect((await opSnoozeSupportCase({ caseId: c.caseId, until: "tomorrow" }, OPERATOR, NOW)).status).toBe(400);
    expect(data(await opSnoozeSupportCase({ caseId: c.caseId, until: "2026-10-17T13:00:00Z" }, OPERATOR, NOW))).toEqual({
      outcome: "done",
      ref,
      state: "snoozed",
      auditRecorded: true,
    });
    const [snoozed] = await securityEvent("support_case_snoozed", ref);
    expect(snoozed).toMatchObject({
      actor_label: "ops@healdesk.test",
      ip_address: "203.0.113.9",
      metadata: { ref, clinicId: clinic.clinicId, from: "new", to: "snoozed", days: 3 },
    });

    // Reassign: only a name from HEALDESK_OPS_PEOPLE.
    expect((await opAssignSupportCase({ caseId: c.caseId, label: "Somebody Else" }, OPERATOR, NOW)).status).toBe(400);
    expect(data(await opAssignSupportCase({ caseId: c.caseId, label: "Dana Reyes" }, OPERATOR, NOW))).toMatchObject({
      outcome: "done",
      state: "snoozed",
    });
    expect(data(await opAssignSupportCase({ caseId: c.caseId, label: "Dana Reyes" }, OPERATOR, NOW))).toMatchObject({
      outcome: "unchanged",
    });
    expect(await securityEvent("support_case_assigned", ref)).toEqual([
      expect.objectContaining({ actor_label: "ops@healdesk.test", metadata: expect.objectContaining({ label: "Dana Reyes" }) }),
    ]);

    // Match: a chat case always names its clinic already.
    expect((await opMatchSupportCase({ caseId: c.caseId, clinicId: clinic.clinicId }, OPERATOR, NOW)).status).toBe(200);
    const elsewhere = await seedClinic("supportops-elsewhere");
    expect((await opMatchSupportCase({ caseId: c.caseId, clinicId: elsewhere.clinicId }, OPERATOR, NOW)).status).toBe(409);

    // Close: a closed reason only, then final.
    expect((await opCloseSupportCase({ caseId: c.caseId, reason: "because" }, OPERATOR, NOW)).status).toBe(400);
    expect(data(await opCloseSupportCase({ caseId: c.caseId, reason: "replied_by_hand" }, OPERATOR, NOW))).toMatchObject({
      outcome: "done",
      state: "closed",
    });
    const { rows } = await getMigratorPool().query(
      `select closed_reason, closed_at, inbound_text_delete_after, snoozed_until, assignee_label from support_cases where id = $1`,
      [c.caseId],
    );
    expect(rows[0]).toMatchObject({
      closed_reason: "replied_by_hand",
      closed_at: NOW,
      inbound_text_delete_after: new Date("2026-11-13T15:00:00Z"),
      snoozed_until: null,
      assignee_label: "Dana Reyes",
    });
    expect(await securityEvent("support_case_closed", ref)).toEqual([
      expect.objectContaining({ actor_label: "ops@healdesk.test", metadata: expect.objectContaining({ reason: "replied_by_hand", to: "closed" }) }),
    ]);
    for (const outcome of [
      await opCloseSupportCase({ caseId: c.caseId, reason: "duplicate" }, OPERATOR, NOW),
      await opSnoozeSupportCase({ caseId: c.caseId, until: "2026-10-17T13:00:00Z" }, OPERATOR, NOW),
      await opAssignSupportCase({ caseId: c.caseId, label: "Liam" }, OPERATOR, NOW),
    ]) {
      expect(outcome.status).toBe(409);
      expect((outcome.body as { error: string }).error).toContain(`${ref} is closed`);
    }
  });

  test("match: an unmatched case takes its clinic once, in that clinic's tenant; a clinic that has left is refused", async () => {
    const clinic = await seedClinic("supportops-match");
    // An email nobody matched (the inbound slice's case): no clinic, no tenant.
    const { rows } = await getMigratorPool().query<{ id: string; ref: string }>(
      `insert into support_cases (ref, source, category, symptom, urgency, reply_by_on) values ('MATC1', 'email', 'other', 'other', 'this_week', '2026-10-15') returning id, ref`,
    );
    const unmatched = rows[0]!;
    expect(data(await opMatchSupportCase({ caseId: unmatched.id, clinicId: clinic.clinicId }, OPERATOR, NOW))).toMatchObject({
      outcome: "done",
      ref: "HD-MATC1",
    });
    const { rows: after } = await getMigratorPool().query(`select subject_clinic_id from support_cases where id = $1`, [unmatched.id]);
    expect(after[0]).toEqual({ subject_clinic_id: clinic.clinicId });
    expect(await securityEvent("support_case_matched", "HD-MATC1")).toHaveLength(1);
    expect((await opMatchSupportCase({ caseId: unmatched.id, clinicId: randomUUID() }, OPERATOR, NOW)).status).toBe(404);

  });

  test("through the dispatch: an operation reaches its handler and refuses what it does not take", async () => {
    const outcome = await runOperation("listSupportCases", { state: "needs_us", limit: 5 }, OPERATOR);
    expect(outcome.status).toBe(200);
    expect(data<{ rows: unknown[] }>(outcome).rows.length).toBeLessThanOrEqual(5);
    expect((await runOperation("closeSupportCase", { caseId: randomUUID(), reason: "spam" }, OPERATOR)).status).toBe(404);
  });
});
