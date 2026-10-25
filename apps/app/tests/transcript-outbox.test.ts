import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  deliverTranscriptEmail,
  endTranscriptCopy,
  queueTranscriptEmail,
  recordSesTranscriptEvent,
  resendTranscript,
  retryDelayMinutes,
  runTranscriptEmailsJob,
  sendQueuedTranscriptNow,
  transcriptWork,
} from "@/lib/conversations/transcript-outbox";
import { log } from "@/lib/log";
import { isMutating, runOperation, type Operator } from "@/lib/ops/api";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { JOB_TRANSCRIPT_EMAILS } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * The transcript outbox (drizzle/0069, 0072; lib/conversations/transcript-outbox.ts):
 * a conversation's transcript waits sealed until SES reports that the clinic's
 * mail server took it, and its copy is deleted in that same transaction; it is
 * tried again with back-off when a send fails and sent again after a bounce,
 * for at most 30 days after it was queued; a send nothing answers is deleted
 * 72 hours later; and the row stays as a receipt without the words. All by
 * the database's clock (the owner's decision of 14 October 2026). Synthetic
 * clinics and words only.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "transcript-outbox-test" } as const;
const WORDS = "Synthetic caller: I'd like a consultation on Thursday.";
const DAY = 24 * 60 * 60 * 1000;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  private count = 0;
  constructor(private answer: () => DeliveryResult = () => ({ status: "sent", messageId: "" })) {}
  setAnswer(answer: () => DeliveryResult) {
    this.answer = answer;
  }
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    const result = this.answer();
    if (result.status === "sent" && !result.messageId) {
      this.count += 1;
      return { status: "sent", messageId: `ses-${crypto.randomUUID()}-${this.count}` };
    }
    return result;
  }
}

const failing = (): DeliveryResult => ({ status: "failed", reason: "SES throttled the request" });

type Row = {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  ses_message_id: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  destroy_after: Date;
  created_at: Date;
  sealed: unknown;
  conversation_id: string;
};

/** Each queued row's clinic: the table forces row-level security, on its owner too. */
const tenantOf = new Map<string, string>();

async function row(id: string): Promise<Row | undefined> {
  const { rows } = await inTenant(tenantOf.get(id)!, (client) =>
    client.query<Row>(`select * from transcript_emails where id = $1`, [id]),
  );
  return rows[0];
}

async function queue(clinicId: string, conversationId: string, words = WORDS): Promise<string | null> {
  const id = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    queueTranscriptEmail(tx, {
      conversationId,
      channel: "voice",
      startedAt: new Date("2026-10-13T15:00:00Z"),
      turns: [
        { speaker: "assistant", text: "Hi, I'm the clinic's AI assistant, and this call is transcribed." },
        { speaker: "person", text: words },
      ],
    }),
  );
  if (id) tenantOf.set(id, clinicId);
  return id;
}

async function seeded(label: string) {
  const clinic = await seedClinic(label);
  const { conversationId } = await seedConversation(clinic.clinicId, { startedAt: new Date() });
  return { ...clinic, conversationId };
}

/** Queued and sent once: status sent, with SES's message id. */
async function sentOne(label: string) {
  const clinic = await seeded(label);
  const id = (await queue(clinic.clinicId, clinic.conversationId))!;
  expect(await deliverTranscriptEmail(clinic.clinicId, id, { transport: new FakeTransport() })).toBe("sent");
  const messageId = (await row(id))!.ses_message_id!;
  return { ...clinic, id, messageId };
}

async function opsAlerts(conversationId: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = 'transcript_undelivered' and fields->>'conversationId' = $1 order by raised_at`,
    [conversationId],
  );
  return rows.map((r) => r.fields);
}

/** Move a row's clocks as if time had passed: the migrator, with the clock trigger stood aside. */
async function age(id: string, set: string) {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [tenantOf.get(id)!]);
    await client.query("alter table transcript_emails disable trigger transcript_emails_clock");
    await client.query(`update transcript_emails set ${set} where id = $1`, [id]);
    await client.query("alter table transcript_emails enable trigger transcript_emails_clock");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** One statement as the runtime role, in the row's tenant. */
async function asApp(id: string, statement: string) {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [tenantOf.get(id)!]);
    await client.query(statement, [id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function setSwitch(enabled: boolean) {
  await getMigratorPool().query(`update scheduled_jobs set enabled = $2 where name = $1`, [
    JOB_TRANSCRIPT_EMAILS,
    enabled,
  ]);
}

const operator: Operator = { email: "ops@healdesk.test", request: {} };
async function op(name: "resendTranscript" | "transcriptDeliveries", args: Record<string, unknown>) {
  const outcome = await runOperation(name, args, operator);
  expect(outcome.status).toBe(200);
  return (outcome.body as { data: Record<string, unknown> }).data;
}

describeDb("the transcript outbox", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    await setSwitch(true);
  });

  afterAll(async () => {
    await closePools();
  });

  test("its migration seeds the job on, because it carries the deletion of undelivered copies", () => {
    const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const seeds = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(`${dir}${name}`, "utf8"))
      .filter((text) => text.includes("('transcript-emails'"));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatch(/\('transcript-emails', '[^']+', true\)/);
  });

  test("a queued transcript is sealed: the words are nowhere in the row", async () => {
    const { clinicId, conversationId } = await seeded("outbox-sealed");
    const id = await queue(clinicId, conversationId);
    expect(id).toBeTruthy();
    const stored = await row(id!);
    expect(stored?.status).toBe("pending");
    expect(stored?.sealed).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain("consultation");
    expect(JSON.stringify(stored)).not.toContain("Thursday");
    // One per conversation: a second queue is a no-op.
    expect(await queue(clinicId, conversationId)).toBeNull();
  });

  test("the database sets the 30-day cap at the queueing, and no send moves it", async () => {
    const { clinicId, id } = await sentOne("outbox-clock");
    const stored = await row(id);
    expect(stored!.destroy_after.getTime() - stored!.created_at.getTime()).toBe(30 * DAY);
    expect(stored!.sent_at).toBeTruthy();
    // A send after a bounce records its own time, and the cap stays put.
    await recordSesTranscriptEvent({ messageId: stored!.ses_message_id!, type: "bounce", bounceType: "Permanent" });
    await age(id, `next_attempt_at = now() - interval '1 second'`);
    expect(await deliverTranscriptEmail(clinicId, id, { transport: new FakeTransport() })).toBe("sent");
    const again = await row(id);
    expect(again!.destroy_after.getTime()).toBe(stored!.destroy_after.getTime());
    expect(again!.sent_at!.getTime()).toBeGreaterThanOrEqual(stored!.sent_at!.getTime());
  });

  test("the runtime role cannot rewrite the copy, move the cap, or end a copy early", async () => {
    const { clinicId, conversationId } = await seeded("outbox-immutable");
    const id = (await queue(clinicId, conversationId))!;
    await expect(asApp(id, `update transcript_emails set destroy_after = now() + interval '1 year' where id = $1`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(id, `update transcript_emails set created_at = now() where id = $1`)).rejects.toThrow(/permission denied/);
    // The runtime role may write `sealed` only to grow an open web chat
    // (drizzle/0071) or to NULL as the row becomes a receipt (0072).
    await expect(asApp(id, `update transcript_emails set sealed = '{}'::jsonb where id = $1`)).rejects.toThrow(/never rewritten/);
    await expect(asApp(id, `update transcript_emails set sealed = null where id = $1`)).rejects.toThrow(
      /deleted only as its transcript is delivered, expires or goes unconfirmed/,
    );
    // Each end on its own condition, by the database's clock.
    await expect(asApp(id, `update transcript_emails set sealed = null, status = 'expired' where id = $1`)).rejects.toThrow(
      /expires only 30 days after it was queued/,
    );
    await expect(asApp(id, `update transcript_emails set sealed = null, status = 'delivered' where id = $1`)).rejects.toThrow(
      /only a transcript SES accepted can be delivered/,
    );
    await expect(asApp(id, `update transcript_emails set sealed = null, status = 'unconfirmed' where id = $1`)).rejects.toThrow(
      /unconfirmed only 72 hours after a send nothing answered/,
    );
    // A receipt status keeps no copy, and only a receipt has none (the CHECK).
    await expect(asApp(id, `update transcript_emails set status = 'expired' where id = $1`)).rejects.toThrow();
    // Even the owner of the table cannot rewrite the copy.
    await expect(
      inTenant(clinicId, (client) => client.query(`update transcript_emails set sealed = '{}'::jsonb where id = $1`, [id])),
    ).rejects.toThrow(/never rewritten/);
    expect((await row(id))!.sealed).toBeTruthy();
    // And a forced row-level policy: another tenant sees nothing.
    const other = await seedClinic("outbox-other");
    const seen = await withTenant({ clinicId: other.clinicId, actor: ACTOR }, async (tx) =>
      tx.db.execute(sql`select id from transcript_emails`),
    );
    expect((seen as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });

  test("a row is queued holding its copy, never as a receipt", async () => {
    const { clinicId, conversationId } = await seeded("outbox-insert");
    await expect(
      inTenant(clinicId, (client) =>
        client.query(
          `insert into transcript_emails (clinic_id, conversation_id, sealed, status, destroy_after) values ($1, $2, null, 'delivered', now() + interval '1 day')`,
          [clinicId, conversationId],
        ),
      ),
    ).rejects.toThrow(/queued with its sealed copy/);
  });

  test("a production clinic without an agreement in effect queues nothing", async () => {
    const { clinicId, conversationId } = await seeded("outbox-gate");
    await getMigratorPool().query(`update clinics set data_classification = 'production' where id = $1`, [clinicId]);
    await expect(queue(clinicId, conversationId)).rejects.toThrow();
    await getMigratorPool().query(`update clinics set data_classification = 'synthetic' where id = $1`, [clinicId]);
  });

  test("a send goes to the clinic's address alone, through the PHI class, and keeps the copy until SES answers", async () => {
    const { clinicId, conversationId, staffEmail } = await seeded("outbox-send");
    const id = await queue(clinicId, conversationId);
    const transport = new FakeTransport();
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("sent");
    expect(transport.sent).toHaveLength(1);
    // The clinic's one address and nothing else: no blind copy, no archive
    // (the owner's decision of 14 October 2026).
    expect(transport.sent[0]!.target).toEqual({ to: staffEmail.toLowerCase(), clinicId, clinicName: expect.any(String) });
    expect(transport.sent[0]!.message.phiClass).toBe("may-carry-phi");
    expect(transport.sent[0]!.message.text).toContain(WORDS);
    const stored = await row(id!);
    expect(stored).toMatchObject({ status: "sent", attempts: 1, last_error: null, delivered_at: null });
    expect(stored!.ses_message_id).toMatch(/^ses-/);
    // Accepted is not delivered: the copy waits for SES's answer.
    expect(stored!.sealed).toBeTruthy();
    // Sent: not due again.
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("not_due");
    expect(transport.sent).toHaveLength(1);
  });

  test("a vet's transcript says it holds its clients' information; everyone else's, patient information", async () => {
    const vet = await seeded("outbox-vet");
    await getMigratorPool().query(`update clinics set specialty = 'veterinary' where id = $1`, [vet.clinicId]);
    const people = await seeded("outbox-people");
    const transport = new FakeTransport();
    for (const clinic of [vet, people]) {
      const id = await queue(clinic.clinicId, clinic.conversationId);
      expect(await deliverTranscriptEmail(clinic.clinicId, id!, { transport })).toBe("sent");
    }
    const [toVet, toPeople] = transport.sent.map((s) => s.message.text);
    expect(toVet).toContain("This email holds your clients' information.");
    expect(toVet).toContain("file it where your practice keeps client records");
    expect(toVet).not.toMatch(/\bpatients?\b/i);
    expect(toPeople).toContain("This email holds patient information.");
  });

  test("a failed send waits and tries again, and ops hears once, on the third failure, by ids", async () => {
    const { clinicId, conversationId } = await seeded("outbox-retry");
    const id = await queue(clinicId, conversationId);
    const transport = new FakeTransport(failing);

    const before = Date.now();
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("failed");
    let stored = await row(id!);
    expect(stored).toMatchObject({ status: "pending", attempts: 1, ses_message_id: null, sent_at: null });
    expect(stored!.last_error).toMatch(/throttled/);
    const wait = stored!.next_attempt_at.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(retryDelayMinutes(1) * 60_000 - 1000);
    expect(wait).toBeLessThan(retryDelayMinutes(1) * 60_000 + 5000);

    // Not due until the wait is over.
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("not_due");

    for (const attempt of [2, 3, 4]) {
      await age(id!, `next_attempt_at = now() - interval '1 second'`);
      expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("failed");
      stored = await row(id!);
      expect(stored!.attempts).toBe(attempt);
    }
    const alerts = await opsAlerts(conversationId);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toContain("consultation");
    expect(alerts[0]).toMatchObject({ clinicId, status: "retrying" });

    // And when SES takes it at last, it is sent.
    transport.setAnswer(() => ({ status: "sent", messageId: "" }));
    await age(id!, `next_attempt_at = now() - interval '1 second'`);
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("sent");
    expect((await row(id!))?.status).toBe("sent");
  });

  test("the back-off: 1, 2, 5, 10 and 30 minutes, then hourly", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(retryDelayMinutes)).toEqual([1, 2, 5, 10, 30, 60, 60]);
  });

  test("SES's delivery deletes the copy in the same transaction, and the row stays as a receipt without the words", async () => {
    const { clinicId, conversationId, id, messageId } = await sentOne("outbox-delivered");
    expect(await recordSesTranscriptEvent({ messageId: "not-ours", type: "delivery" })).toBe(false);

    expect(await recordSesTranscriptEvent({ messageId, type: "delivery" })).toBe(true);
    const stored = await row(id);
    expect(stored).toMatchObject({ status: "delivered", sealed: null, ses_message_id: messageId, attempts: 1, last_error: null });
    expect(stored!.delivered_at).toBeTruthy();
    expect(stored!.sent_at).toBeTruthy();
    expect(stored!.conversation_id).toBe(conversationId);
    expect(JSON.stringify(stored)).not.toContain("consultation");
    // The deletion is in the audit trail, by ids.
    const { rows: audits } = await inTenant(clinicId, (client) =>
      client.query<{ action: string; metadata: Record<string, unknown> }>(
        `select action, metadata from audit_log where clinic_id = $1 and resource_type = 'transcript_email' and resource_id = $2 and action = 'delete'`,
        [clinicId, id],
      ),
    );
    expect(audits).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ outcome: "delivered" }) })]);
    // Nothing to send, nothing for the job, and no alert.
    expect(await deliverTranscriptEmail(clinicId, id, { transport: new FakeTransport() })).toBe("not_due");
    expect((await transcriptWork()).some((w) => w.id === id)).toBe(false);
    expect(await opsAlerts(conversationId)).toHaveLength(0);
    // A repeated or late event is ours, and changes nothing.
    expect(await recordSesTranscriptEvent({ messageId, type: "delivery" })).toBe(true);
    expect(await recordSesTranscriptEvent({ messageId, type: "bounce", bounceType: "Permanent" })).toBe(true);
    expect((await row(id))!.status).toBe("delivered");
    // A receipt never changes again, and its copy never comes back.
    await expect(asApp(id, `update transcript_emails set status = 'pending' where id = $1`)).rejects.toThrow(/receipt, and never changes/);
    await expect(asApp(id, `update transcript_emails set sealed = '{}'::jsonb, status = 'sent' where id = $1`)).rejects.toThrow(
      /receipt, and never changes/,
    );
    await expect(asApp(id, `update transcript_emails set last_error = 'x' where id = $1`)).rejects.toThrow(/receipt, and never changes/);
  });

  test("a bounce is sent again an hour later and tells ops; only the recorded message id's delivery counts", async () => {
    const { clinicId, conversationId, id, messageId } = await sentOne("outbox-ses");

    // A transient bounce or a delay is SES still trying: noted, nothing changes.
    expect(await recordSesTranscriptEvent({ messageId, type: "bounce", bounceType: "Transient" })).toBe(true);
    expect(await recordSesTranscriptEvent({ messageId, type: "delay", reason: "MailboxFull" })).toBe(true);
    expect((await row(id))?.status).toBe("sent");

    const before = Date.now();
    expect(
      await recordSesTranscriptEvent({ messageId, type: "bounce", bounceType: "Permanent", reason: "550 mailbox unavailable" }),
    ).toBe(true);
    let stored = await row(id);
    expect(stored!.status).toBe("bounced");
    expect(stored!.sealed).toBeTruthy();
    expect(stored!.last_error).toMatch(/Permanent/);
    expect(stored!.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(await opsAlerts(conversationId)).toHaveLength(1);

    await age(id, `next_attempt_at = now() - interval '1 second'`);
    expect(await deliverTranscriptEmail(clinicId, id, { transport: new FakeTransport() })).toBe("sent");
    stored = await row(id);
    expect(stored!.status).toBe("sent");
    expect(stored!.ses_message_id).not.toBe(messageId);

    // The first message's delivery is not this one's: no row records that id
    // any more, and the copy stays.
    expect(await recordSesTranscriptEvent({ messageId, type: "delivery" })).toBe(false);
    expect((await row(id))!.status).toBe("sent");
    expect((await row(id))!.sealed).toBeTruthy();

    expect(await recordSesTranscriptEvent({ messageId: stored!.ses_message_id!, type: "delivery" })).toBe(true);
    stored = await row(id);
    expect(stored).toMatchObject({ status: "delivered", sealed: null, attempts: 2 });
    expect(stored!.delivered_at).toBeTruthy();
  });

  test("a copy not delivered 30 days after it was queued is deleted, the row expired, and ops told by ids", async () => {
    const pending = await seeded("outbox-expire-pending");
    const pendingId = (await queue(pending.clinicId, pending.conversationId))!;
    const bounced = await sentOne("outbox-expire-bounced");
    await recordSesTranscriptEvent({ messageId: bounced.messageId, type: "bounce", bounceType: "Permanent" });
    const sent = await sentOne("outbox-expire-sent");

    // Not yet: the cap is the database's clock, and the caller cannot move it.
    expect(await endTranscriptCopy(pending.clinicId, pendingId, "expired")).toBe(false);
    expect((await row(pendingId))!.sealed).toBeTruthy();

    for (const id of [pendingId, bounced.id, sent.id]) {
      await age(id, `created_at = now() - interval '31 days', destroy_after = now() - interval '1 day'`);
    }
    // Due to expire, and so never sent again.
    expect(await deliverTranscriptEmail(pending.clinicId, pendingId, { transport: new FakeTransport() })).toBe("not_due");
    const work = await transcriptWork();
    for (const [clinicId, id] of [
      [pending.clinicId, pendingId],
      [bounced.clinicId, bounced.id],
      [sent.clinicId, sent.id],
    ] as const) {
      expect(work).toContainEqual({ clinicId, id, due: "expired" });
    }

    const outcome = await runTranscriptEmailsJob({ transport: new FakeTransport() });
    expect(outcome.status).toBe("ok");
    for (const [conversationId, id] of [
      [pending.conversationId, pendingId],
      [bounced.conversationId, bounced.id],
      [sent.conversationId, sent.id],
    ] as const) {
      const stored = await row(id);
      expect(stored, id).toMatchObject({ status: "expired", sealed: null, delivered_at: null });
      expect((await opsAlerts(conversationId)).at(-1)).toMatchObject({ status: "expired" });
      expect(JSON.stringify(await opsAlerts(conversationId))).not.toContain("consultation");
    }
    // The receipt keeps why it failed, as SES said it, scrubbed.
    expect((await row(bounced.id))!.last_error).toMatch(/bounce \(Permanent\)/);
    // The conversation stays, without the words.
    const { rows } = await inTenant(pending.clinicId, (client) =>
      client.query(`select id from conversations where id = $1`, [pending.conversationId]),
    );
    expect(rows).toHaveLength(1);
  });

  test("a send nothing answers for 72 hours is deleted, the row unconfirmed, and ops told once", async () => {
    const quiet = await sentOne("outbox-unconfirmed");
    const recent = await sentOne("outbox-unconfirmed-recent");
    // A delay is not an answer.
    await recordSesTranscriptEvent({ messageId: quiet.messageId, type: "delay" });
    await age(quiet.id, `sent_at = now() - interval '73 hours'`);
    await age(recent.id, `sent_at = now() - interval '71 hours'`);

    expect(await endTranscriptCopy(recent.clinicId, recent.id, "unconfirmed")).toBe(false);
    const work = await transcriptWork();
    expect(work).toContainEqual({ clinicId: quiet.clinicId, id: quiet.id, due: "unconfirmed" });
    expect(work.some((w) => w.id === recent.id)).toBe(false);

    await runTranscriptEmailsJob({ transport: new FakeTransport() });
    expect(await row(quiet.id)).toMatchObject({ status: "unconfirmed", sealed: null, delivered_at: null });
    expect((await row(quiet.id))!.last_error).toMatch(/72 hours/);
    expect(await row(recent.id)).toMatchObject({ status: "sent" });
    expect((await row(recent.id))!.sealed).toBeTruthy();
    expect(await opsAlerts(quiet.conversationId)).toEqual([
      expect.objectContaining({ clinicId: quiet.clinicId, status: "unconfirmed" }),
    ]);
    // A late delivery for it changes nothing: the receipt is final.
    expect(await recordSesTranscriptEvent({ messageId: quiet.messageId, type: "delivery" })).toBe(true);
    expect((await row(quiet.id))!.status).toBe("unconfirmed");
    await runTranscriptEmailsJob({ transport: new FakeTransport() });
    expect(await opsAlerts(quiet.conversationId)).toHaveLength(1);
  });

  test("the job sends what is due and deletes what is past its cap, by the database's clock", async () => {
    const due = await seeded("outbox-job-send");
    const dueId = await queue(due.clinicId, due.conversationId);
    const old = await seeded("outbox-job-old");
    const oldId = await queue(old.clinicId, old.conversationId);
    await age(oldId!, `destroy_after = now() - interval '1 second', created_at = now() - interval '31 days'`);

    const work = await transcriptWork();
    expect(work).toEqual(
      expect.arrayContaining([
        { clinicId: due.clinicId, id: dueId, due: "send" },
        { clinicId: old.clinicId, id: oldId, due: "expired" },
      ]),
    );

    const transport = new FakeTransport();
    const outcome = await runTranscriptEmailsJob({ transport });
    expect(outcome.status).toBe("ok");
    expect((await row(dueId!))?.status).toBe("sent");
    expect(await row(oldId!)).toMatchObject({ status: "expired", sealed: null });
    expect(transport.sent.every((s) => s.target.clinicId !== old.clinicId)).toBe(true);
  });

  test("off, the job still deletes every undelivered copy past its cap: the agreement's promise waits for no switch", async () => {
    const expiring = await seeded("outbox-off-expire");
    const expiringId = (await queue(expiring.clinicId, expiring.conversationId))!;
    await age(expiringId, `destroy_after = now() - interval '1 second', created_at = now() - interval '31 days'`);
    const quiet = await sentOne("outbox-off-unconfirmed");
    await age(quiet.id, `sent_at = now() - interval '73 hours'`);
    await setSwitch(false);
    const transport = new FakeTransport();
    expect((await runTranscriptEmailsJob({ transport })).status).toBe("disabled");
    expect(await row(expiringId)).toMatchObject({ status: "expired", sealed: null });
    expect(await row(quiet.id)).toMatchObject({ status: "unconfirmed", sealed: null });
    expect(transport.sent).toHaveLength(0);
    await setSwitch(true);
  });

  test("off, the job and the send-now both stand aside", async () => {
    const { clinicId, conversationId } = await seeded("outbox-off");
    const id = await queue(clinicId, conversationId);
    await setSwitch(false);
    const transport = new FakeTransport();
    expect((await runTranscriptEmailsJob({ transport })).status).toBe("disabled");
    const warn = vi.spyOn(log, "warn");
    expect(await sendQueuedTranscriptNow(clinicId, id, { transport })).toBe("disabled");
    // Said, never silent: the switch being off is why a clinic gets no transcript.
    expect(warn).toHaveBeenCalledWith("transcript waiting: the transcript-emails job is off", { clinicId, jobId: id });
    warn.mockRestore();
    expect(transport.sent).toHaveLength(0);
    await setSwitch(true);
    expect(await sendQueuedTranscriptNow(clinicId, id, { transport })).toBe("sent");
    expect(await sendQueuedTranscriptNow(clinicId, null, { transport })).toBeNull();
  });

  test("a resend is possible while the copy exists, and not once the row is a receipt", async () => {
    // Sent and awaiting SES's answer.
    const delivered = await sentOne("outbox-resend");
    expect(await resendTranscript(delivered.clinicId, delivered.conversationId)).toBe("queued");
    expect((await row(delivered.id))?.status).toBe("pending");
    // Pending: queued again.
    expect(await resendTranscript(delivered.clinicId, delivered.conversationId)).toBe("queued");
    // Delivered: gone. The message id is still the one SES answers for.
    expect(await recordSesTranscriptEvent({ messageId: delivered.messageId, type: "delivery" })).toBe(true);
    expect((await row(delivered.id))?.status).toBe("delivered");
    expect(await resendTranscript(delivered.clinicId, delivered.conversationId)).toBe("gone");

    // Bounced: queued.
    const bounced = await sentOne("outbox-resend-bounced");
    await recordSesTranscriptEvent({ messageId: bounced.messageId, type: "reject", reason: "Bad content" });
    expect((await row(bounced.id))?.status).toBe("bounced");
    expect(await resendTranscript(bounced.clinicId, bounced.conversationId)).toBe("queued");

    // Expired and unconfirmed: gone.
    const expired = await sentOne("outbox-resend-expired");
    await age(expired.id, `destroy_after = now() - interval '1 second', created_at = now() - interval '31 days'`);
    expect(await endTranscriptCopy(expired.clinicId, expired.id, "expired")).toBe(true);
    expect(await resendTranscript(expired.clinicId, expired.conversationId)).toBe("gone");
    const quiet = await sentOne("outbox-resend-unconfirmed");
    await age(quiet.id, `sent_at = now() - interval '73 hours'`);
    expect(await endTranscriptCopy(quiet.clinicId, quiet.id, "unconfirmed")).toBe(true);
    expect(await resendTranscript(quiet.clinicId, quiet.conversationId)).toBe("gone");
  });

  test("the operator console can ask for a resend by conversation id, and learns when the copy is gone", async () => {
    const { clinicId, conversationId, id, messageId } = await sentOne("outbox-ops");
    expect(isMutating("resendTranscript")).toBe(true);
    expect(await op("resendTranscript", { clinicId, conversationId })).toMatchObject({ status: "queued" });
    expect((await row(id))?.status).toBe("pending");
    expect(await op("resendTranscript", { clinicId, conversationId: "not-a-uuid" })).toMatchObject({ status: "error" });
    await recordSesTranscriptEvent({ messageId, type: "delivery" });
    expect(await op("resendTranscript", { clinicId, conversationId })).toEqual({ status: "gone" });
  });

  test("the operator console reads the receipts: counts by status and the newest, never words or an address", async () => {
    const { clinicId, conversationId, id, messageId, staffEmail } = await sentOne("outbox-receipts");
    await recordSesTranscriptEvent({ messageId, type: "delivery" });
    const second = await seedConversation(clinicId, { startedAt: new Date() });
    const pendingId = (await queue(clinicId, second.conversationId))!;
    const third = await seedConversation(clinicId, { startedAt: new Date() });
    const bouncedId = (await queue(clinicId, third.conversationId))!;
    await deliverTranscriptEmail(clinicId, bouncedId, { transport: new FakeTransport() });
    await recordSesTranscriptEvent({
      messageId: (await row(bouncedId))!.ses_message_id!,
      type: "bounce",
      bounceType: "Permanent",
      reason: `550 5.1.1 <${staffEmail}> unknown`,
    });
    const fourth = await seedConversation(clinicId, { startedAt: new Date() });
    const oldId = (await queue(clinicId, fourth.conversationId))!;
    await age(oldId, `created_at = now() - interval '40 days', destroy_after = now() + interval '1 day'`);

    expect(isMutating("transcriptDeliveries")).toBe(false);
    const data = await op("transcriptDeliveries", { clinicId });
    expect(data).toMatchObject({ status: "ok", sinceDays: 30 });
    expect(data.counts).toEqual({ open: 0, pending: 1, sent: 0, bounced: 1, delivered: 1, expired: 0, unconfirmed: 0 });
    const receipts = data.receipts as Record<string, unknown>[];
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) {
      expect(Object.keys(receipt).sort()).toEqual(["attempts", "conversationId", "deliveredAt", "sentAt", "status"]);
    }
    expect(receipts.find((r) => r.conversationId === conversationId)).toMatchObject({
      status: "delivered",
      attempts: 1,
      sentAt: expect.any(String),
      deliveredAt: expect.any(String),
    });
    expect(receipts.find((r) => r.conversationId === second.conversationId)).toMatchObject({
      status: "pending",
      attempts: 0,
      sentAt: null,
      deliveredAt: null,
    });
    const text = JSON.stringify(data);
    expect(text).not.toContain("consultation");
    expect(text).not.toContain(staffEmail);
    expect(text).not.toContain("@");
    expect(text).not.toContain(id);
    expect(text).not.toContain(pendingId);

    // A longer window takes in the older one; a bad window is refused.
    expect(((await op("transcriptDeliveries", { clinicId, sinceDays: 60 })).counts as Record<string, number>).pending).toBe(2);
    for (const sinceDays of [0, 1.5, -3, 400, "30"]) {
      expect(await op("transcriptDeliveries", { clinicId, sinceDays }), String(sinceDays)).toMatchObject({ status: "error" });
    }
    expect(await op("transcriptDeliveries", { clinicId: "not-a-uuid" })).toMatchObject({ status: "error" });
    // Another clinic's receipts are its own.
    const other = await seedClinic("outbox-receipts-other");
    expect(((await op("transcriptDeliveries", { clinicId: other.clinicId })).receipts as unknown[]).length).toBe(0);
  });

  test("a conversation's deletion takes its transcript row with it, receipt or copy", async () => {
    const { clinicId, conversationId } = await seeded("outbox-cascade");
    const id = await queue(clinicId, conversationId);
    await inTenant(clinicId, (client) => client.query(`delete from conversations where id = $1`, [conversationId]));
    expect(await row(id!)).toBeUndefined();
    const delivered = await sentOne("outbox-cascade-receipt");
    await recordSesTranscriptEvent({ messageId: delivered.messageId, type: "delivery" });
    await inTenant(delivered.clinicId, (client) =>
      client.query(`delete from conversations where id = $1`, [delivered.conversationId]),
    );
    expect(await row(delivered.id)).toBeUndefined();
  });
});
