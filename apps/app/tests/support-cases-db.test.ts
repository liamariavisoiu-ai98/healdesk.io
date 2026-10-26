import { randomUUID } from "node:crypto";

import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { KEPT_FOR_GOOD } from "@/lib/offboarding/account-closure";
import { destroyDueClinics, markExportDelivered, startOffboarding } from "@/lib/offboarding/offboarding";
import { PURGE_COVERAGE } from "@/lib/retention/purge";
import {
  closeSupportCase,
  insertCase,
  newSupportRef,
  recordChatEscalation,
  snoozeSupportCase,
} from "@/lib/support/cases";
import { readRef, urgencyFor, SYMPTOM_URGENCY } from "@/lib/support/case-vocab";
import { ESCALATION_TOPICS, type EscalationFields } from "@/lib/support/escalation-fields";
import { withTenant } from "@/lib/tenant";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Support cases (ops automation lane P7a; drizzle/0125) against the real
 * database: a chat escalation becomes exactly one case holding fields and no
 * words; the same request again is the same case; a second escalation on
 * the same open topic joins it; the tables refuse words on a chat
 * escalation, a delete by the runtime role, a clinic named from outside its
 * tenant, and any change to a closed case; and a clinic's cases go with it
 * at destruction, on the destruction floor, never another clinic's.
 *
 * Fixed dates throughout: L25's day is passed in, never read from a clock.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "support-cases-test" } as const;
const NOW = new Date("2026-10-14T15:00:00Z");
const REPLY_BY = "2026-10-15";

function fields(topic: EscalationFields["topic"], symptom: string, extra: Partial<EscalationFields> = {}): EscalationFields {
  return { topic, symptom, carrier: null, phoneSystem: null, mode: null, channel: null, ...extra };
}

async function casesOf(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    ref: string;
    state: string;
    category: string;
    symptom: string;
    urgency: string;
    reply_by_on: string;
    source: string;
  }>(
    `select id, ref, state, category, symptom, urgency, to_char(reply_by_on, 'YYYY-MM-DD') as reply_by_on, source
       from support_cases where subject_clinic_id = $1 order by opened_at, id`,
    [clinicId],
  );
  return rows;
}

async function messagesOf(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(
    `select * from support_messages where case_id = $1 order by created_at, id`,
    [caseId],
  );
  return rows;
}

/** One statement as the runtime role, optionally inside a tenant, rolled back. */
async function asApp(clinicId: string | null, text: string, values: unknown[] = []): Promise<unknown[]> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return (await client.query(text, values)).rows;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** Offboarded, export delivered, and moved past the pass-through: due for destruction. */
async function leave(clinicId: string): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
  await withTenant({ clinicId, actor: ACTOR }, (tx) => markExportDelivered(tx, "bundle handed over"));
  const secs = (FORWARDING_PASS_THROUGH_DAYS + 1) * 86_400;
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(secs => $2),
            destroy_after = destroy_after - make_interval(secs => $2),
            export_delivered_at = export_delivered_at - make_interval(secs => $2)
      where id = $1`,
    [clinicId, secs],
  );
}

describeDb("support cases (drizzle/0125)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
  }, 180_000);

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closePools();
  });

  test("a chat escalation opens exactly one case, with fields and no words, and the same request again is the same case", async () => {
    const clinic = await seedClinic("cases-one");
    const requestId = randomUUID();
    const input = {
      clinicId: clinic.clinicId,
      actor: ACTOR,
      requestId,
      fields: fields("forwarding", "calls_not_reaching_aya", { carrier: "verizon", phoneSystem: "landline", mode: "overflow_after_hours" }),
      replyByOn: REPLY_BY,
      now: NOW,
    };
    const first = await recordChatEscalation(input);
    expect(first.outcome).toBe("opened");
    expect(readRef(first.ref)).toBe(first.ref);

    const again = await recordChatEscalation(input);
    expect(again).toEqual({ outcome: "already_recorded", caseId: first.caseId, ref: first.ref });

    const cases = await casesOf(clinic.clinicId);
    expect(cases).toEqual([
      {
        id: first.caseId,
        ref: first.ref,
        state: "new",
        category: "forwarding",
        symptom: "calls_not_reaching_aya",
        urgency: "now",
        reply_by_on: REPLY_BY,
        source: "chat",
      },
    ]);
    const messages = await messagesOf(first.caseId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "in",
      kind: "chat_escalation",
      request_id: requestId,
      text: null,
      subject_screened: null,
      draft_text: null,
      fields_json: {
        topic: "forwarding",
        symptom: "calls_not_reaching_aya",
        carrier: "verizon",
        phoneSystem: "landline",
        mode: "overflow_after_hours",
        channel: null,
      },
    });
  });

  test("a second escalation on the same open topic joins the case and can raise its urgency; another topic is its own case", async () => {
    const clinic = await seedClinic("cases-join");
    const base = { clinicId: clinic.clinicId, actor: ACTOR, replyByOn: REPLY_BY, now: NOW };
    const first = await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("calendar", "other") });
    expect((await casesOf(clinic.clinicId))[0]!.urgency).toBe("this_week");

    const second = await recordChatEscalation({
      ...base,
      requestId: randomUUID(),
      fields: fields("calendar", "disconnected"),
      replyByOn: "2026-10-16",
    });
    expect(second).toMatchObject({ outcome: "joined", caseId: first.caseId, ref: first.ref });
    const [joined] = await casesOf(clinic.clinicId);
    // The more urgent of the two; the first symptom and the earliest promise stay.
    expect(joined).toMatchObject({ urgency: "today", symptom: "other", reply_by_on: REPLY_BY });
    expect(await messagesOf(first.caseId)).toHaveLength(2);

    // A less urgent one never lowers it.
    await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("calendar", "other") });
    expect((await casesOf(clinic.clinicId))[0]!.urgency).toBe("today");

    const billing = await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("billing", "invoice_question") });
    expect(billing.outcome).toBe("opened");
    expect(billing.caseId).not.toBe(first.caseId);
    expect(await casesOf(clinic.clinicId)).toHaveLength(2);
  });

  test("a case waiting on the clinic comes back to new with the new reply-by day; a closed case is never reopened", async () => {
    const clinic = await seedClinic("cases-back");
    const base = { clinicId: clinic.clinicId, actor: ACTOR, now: NOW };
    const first = await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("transcript", "not_received"), replyByOn: REPLY_BY });
    await getMigratorPool().query(`update support_cases set state = 'waiting_clinic', last_outbound_at = $2 where id = $1`, [
      first.caseId,
      NOW,
    ]);
    const back = await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("transcript", "not_received"), replyByOn: "2026-10-19" });
    expect(back.outcome).toBe("joined");
    expect((await casesOf(clinic.clinicId))[0]).toMatchObject({ state: "new", reply_by_on: "2026-10-19" });

    // Snoozed: back to new, the snooze cleared, the earlier promise kept.
    await snoozeSupportCase(first.caseId, new Date("2026-10-20T13:00:00Z"), NOW);
    await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("transcript", "other"), replyByOn: "2026-10-21" });
    const { rows } = await getMigratorPool().query(`select state, snoozed_until, to_char(reply_by_on, 'YYYY-MM-DD') as d from support_cases where id = $1`, [first.caseId]);
    expect(rows[0]).toEqual({ state: "new", snoozed_until: null, d: "2026-10-19" });

    expect((await closeSupportCase(first.caseId, "replied_by_hand", NOW)).outcome).toBe("done");
    const after = await recordChatEscalation({ ...base, requestId: randomUUID(), fields: fields("transcript", "not_received"), replyByOn: REPLY_BY });
    expect(after.outcome).toBe("opened");
    expect(after.caseId).not.toBe(first.caseId);
  });

  test("a new ref is tried again after a collision", async () => {
    const clinic = await seedClinic("cases-ref");
    const taken = await recordChatEscalation({
      clinicId: clinic.clinicId,
      actor: ACTOR,
      requestId: randomUUID(),
      fields: fields("other", "other"),
      replyByOn: REPLY_BY,
      now: NOW,
    });
    const refs = [taken.ref, taken.ref, "ZZZZ9"];
    const opened = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      insertCase(tx.db, {
        subjectClinicId: clinic.clinicId,
        source: "chat",
        category: "plan",
        symptom: "other",
        urgency: "this_week",
        replyByOn: REPLY_BY,
        now: NOW,
        newRef: () => refs.shift()!,
      }),
    );
    expect(opened.ref).toBe("ZZZZ9");
    expect(refs).toEqual([]);
  });

  test("the tables refuse words on a chat escalation, a delete, a clinic named from outside its tenant, and any change to a closed case", async () => {
    const clinic = await seedClinic("cases-guard");
    const other = await seedClinic("cases-guard-other");
    const c = await recordChatEscalation({
      clinicId: clinic.clinicId,
      actor: ACTOR,
      requestId: randomUUID(),
      fields: fields("other", "other"),
      replyByOn: REPLY_BY,
      now: NOW,
    });

    // Words on a chat escalation: refused by CHECK, for the runtime role and the migrator alike.
    await expect(
      asApp(
        clinic.clinicId,
        `insert into support_messages (case_id, direction, kind, request_id, fields_json, text)
         values ($1, 'in', 'chat_escalation', $2, '{"topic":"other"}', 'Marisol called about her filler')`,
        [c.caseId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      getMigratorPool().query(
        `insert into support_messages (case_id, direction, kind, request_id, fields_json, text)
         values ($1, 'in', 'chat_escalation', $2, '{"topic":"other"}', 'words')`,
        [c.caseId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A number or an address in the fields: refused.
    await expect(
      asApp(
        clinic.clinicId,
        `insert into support_messages (case_id, direction, kind, request_id, fields_json)
         values ($1, 'in', 'chat_escalation', $2, '{"topic":"5125550100"}')`,
        [c.caseId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // An email case would carry words: a chat escalation never lands on one.
    const email = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      insertCase(tx.db, {
        subjectClinicId: clinic.clinicId,
        source: "email",
        category: "billing",
        symptom: "other",
        urgency: "today",
        replyByOn: REPLY_BY,
        now: NOW,
      }),
    );
    await expect(
      asApp(
        clinic.clinicId,
        `insert into support_messages (case_id, direction, kind, request_id, fields_json)
         values ($1, 'in', 'chat_escalation', $2, '{"topic":"billing"}')`,
        [email.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/came from the chat/) });
    // Inbound text is only ever deleted, never rewritten.
    const [inbound] = (await asApp(
      clinic.clinicId,
      `insert into support_messages (case_id, direction, kind, text) values ($1, 'in', 'email', 'screened words') returning id`,
      [email.id],
    )) as { id: string }[];
    expect(inbound).toBeDefined();
    const { rows: kept } = await getMigratorPool().query<{ id: string }>(
      `insert into support_messages (case_id, direction, kind, text) values ($1, 'in', 'email', 'screened words') returning id`,
      [email.id],
    );
    await expect(
      asApp(null, `update support_messages set text = 'rewritten' where id = $1`, [kept[0]!.id]),
    ).rejects.toMatchObject({ code: "42501" });
    await asApp(null, `update support_messages set text = null where id = $1`, [kept[0]!.id]);

    // The runtime role cannot delete or truncate either table.
    await expect(asApp(null, `delete from support_cases where id = $1`, [c.caseId])).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(null, `delete from support_messages where case_id = $1`, [c.caseId])).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(null, `truncate support_messages`)).rejects.toMatchObject({ code: "42501" });
    // Nor change a case's ref.
    await expect(asApp(null, `update support_cases set ref = 'AAAAA' where id = $1`, [c.caseId])).rejects.toMatchObject({ code: "42501" });

    // A case naming a clinic from outside that clinic's tenant: refused.
    await expect(
      asApp(
        other.clinicId,
        `insert into support_cases (ref, subject_clinic_id, source, category, symptom, urgency, reply_by_on)
         values ($1, $2, 'chat', 'plan', 'other', 'this_week', $3)`,
        [newSupportRef(), clinic.clinicId, REPLY_BY],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(
        null,
        `insert into support_cases (ref, subject_clinic_id, source, category, symptom, urgency, reply_by_on)
         values ($1, $2, 'chat', 'plan', 'other', 'this_week', $3)`,
        [newSupportRef(), clinic.clinicId, REPLY_BY],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // A chat case always names its clinic.
    await expect(
      asApp(
        null,
        `insert into support_cases (ref, source, category, symptom, urgency, reply_by_on)
         values ($1, 'chat', 'plan', 'other', 'this_week', $2)`,
        [newSupportRef(), REPLY_BY],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Closed is final: no change, no new message, even by the migrator.
    await closeSupportCase(c.caseId, "duplicate", NOW);
    await expect(asApp(null, `update support_cases set state = 'new', closed_at = null, closed_reason = null where id = $1`, [c.caseId])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(getMigratorPool().query(`update support_cases set assignee_label = 'Liam' where id = $1`, [c.caseId])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      asApp(clinic.clinicId, `insert into support_messages (case_id, direction, kind) values ($1, 'out', 'reply')`, [c.caseId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("a clinic's cases go with it at destruction, on the floor and in its own tenant only; a clinic that has left takes no new case", async () => {
    expect(KEPT_FOR_GOOD).not.toHaveProperty("support_cases");
    expect(PURGE_COVERAGE.purged).not.toHaveProperty("support_cases");

    const leaving = await seedClinic("cases-leaving");
    const staying = await seedClinic("cases-staying");
    const mine = await recordChatEscalation({
      clinicId: leaving.clinicId,
      actor: ACTOR,
      requestId: randomUUID(),
      fields: fields("plan", "cancel"),
      replyByOn: REPLY_BY,
      now: NOW,
    });
    await closeSupportCase(mine.caseId, "replied_by_hand", NOW);
    await recordChatEscalation({ clinicId: leaving.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("plan", "cancel"), replyByOn: REPLY_BY, now: NOW });
    const theirs = await recordChatEscalation({ clinicId: staying.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("plan", "cancel"), replyByOn: REPLY_BY, now: NOW });

    // Leaving but not due yet: refused; never another tenant's.
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    await expect(asApp(leaving.clinicId, `select app_destroy_support_cases($1::uuid)`, [leaving.clinicId])).rejects.toMatchObject({
      code: "23514",
      message: expect.stringMatching(/not due for destruction/),
    });
    await expect(asApp(staying.clinicId, `select app_destroy_support_cases($1::uuid)`, [leaving.clinicId])).rejects.toMatchObject({
      code: "42501",
    });
    await leave(leaving.clinicId);

    const results = (await destroyDueClinics()).filter((r) => r.clinicId === leaving.clinicId);
    expect(results).toHaveLength(1);
    // Counted in the destruction's audit row, beside the tenant tables' counts.
    const audits = await inTenant(leaving.clinicId, async (q) =>
      (
        await q.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where resource_type = 'clinic_destruction' and resource_id = $1`,
          [leaving.clinicId],
        )
      ).rows,
    );
    expect(audits).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ supportCasesDeleted: 2 }) })]);
    expect(await casesOf(leaving.clinicId)).toEqual([]);
    const { rows: orphans } = await getMigratorPool().query(`select 1 from support_messages where case_id = $1`, [mine.caseId]);
    expect(orphans).toEqual([]);
    expect((await casesOf(staying.clinicId)).map((c) => c.id)).toEqual([theirs.caseId]);

    // Destroyed: a new case for it is refused, in its tenant or not.
    await expect(
      recordChatEscalation({ clinicId: leaving.clinicId, actor: ACTOR, requestId: randomUUID(), fields: fields("other", "other"), replyByOn: REPLY_BY, now: NOW }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
  });
});

describe("triage", () => {
  test("every symptom of every topic has an urgency, and the E5 'now' cases are now", () => {
    for (const [topic, def] of Object.entries(ESCALATION_TOPICS)) {
      for (const symptom of Object.keys(def.symptoms)) {
        expect((SYMPTOM_URGENCY as Record<string, Record<string, string>>)[topic]?.[symptom], `${topic}.${symptom}`).toMatch(
          /^(now|today|this_week)$/,
        );
      }
    }
    expect(urgencyFor("forwarding", "calls_not_reaching_aya")).toBe("now");
    expect(urgencyFor("forwarding", "calls_ring_out")).toBe("now");
    expect(urgencyFor("channel", "website_line_not_working")).toBe("now");
    expect(urgencyFor("sign_in", "lost_device")).toBe("now");
    expect(urgencyFor("plan", "move_up_a_step")).toBe("this_week");
    expect(urgencyFor("nonsense", "other")).toBe("this_week");
  });

  test("refs: Crockford base32, read back leniently", () => {
    for (let i = 0; i < 50; i += 1) expect(newSupportRef()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    expect(readRef("hd-7f3kq")).toBe("7F3KQ");
    expect(readRef("HD-7F3KO")).toBe("7F3K0");
    expect(readRef("7F3KI")).toBe("7F3K1");
    expect(readRef("HD-7F3K")).toBeNull();
    expect(readRef("HD-7F3KU")).toBeNull();
  });
});
