import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  deliverTranscriptEmail,
  destroyTranscriptEmail,
  queueTranscriptEmail,
  recordSesTranscriptEvent,
  resendTranscript,
  retryDelayMinutes,
  runTranscriptEmailsJob,
  sendQueuedTranscriptNow,
  transcriptWork,
} from "@/lib/conversations/transcript-outbox";
import { runOperation, type Operator } from "@/lib/ops/api";
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
 * The transcript outbox (drizzle/0069, lib/conversations/transcript-outbox.ts):
 * a conversation's transcript waits sealed until SES has taken it, is tried
 * again with back-off when it has not, is sent again after a bounce, and is
 * deleted seven days after it first went, by the database's clock. Synthetic
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

async function opsAlerts(conversationId: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = 'transcript_undelivered' and fields->>'conversationId' = $1`,
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

async function setSwitch(enabled: boolean) {
  await getMigratorPool().query(`update scheduled_jobs set enabled = $2 where name = $1`, [
    JOB_TRANSCRIPT_EMAILS,
    enabled,
  ]);
}

const ARCHIVE_KEYS = ["HEALDESK_TRANSCRIPT_ARCHIVE_TO", "HEALDESK_TRANSCRIPT_ARCHIVE_BAA"] as const;

describeDb("the transcript outbox", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(async () => {
    for (const key of ARCHIVE_KEYS) delete process.env[key];
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    await setSwitch(true);
  });

  afterEach(() => {
    for (const key of ARCHIVE_KEYS) delete process.env[key];
  });

  afterAll(async () => {
    await closePools();
  });

  test("its migration seeds the job on, because it carries the seven-day deletion", () => {
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
    expect(JSON.stringify(stored)).not.toContain("consultation");
    expect(JSON.stringify(stored)).not.toContain("Thursday");
    // One per conversation: a second queue is a no-op.
    expect(await queue(clinicId, conversationId)).toBeNull();
  });

  test("the database sets the clocks, whatever the writer sends", async () => {
    const { clinicId, conversationId } = await seeded("outbox-clock");
    const id = await queue(clinicId, conversationId);
    const stored = await row(id!);
    expect(stored!.destroy_after.getTime() - stored!.created_at.getTime()).toBe(7 * DAY);
  });

  test("the runtime role cannot rewrite the copy or move its deletion", async () => {
    const { clinicId, conversationId } = await seeded("outbox-immutable");
    const id = await queue(clinicId, conversationId);
    const attempt = async (sql: string) => {
      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
        await client.query(sql, [id]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(attempt(`update transcript_emails set destroy_after = now() + interval '1 year' where id = $1`)).rejects.toThrow(
      /permission denied/,
    );
    // The runtime role may write `sealed` only to grow an open web chat
    // (drizzle/0071); a queued call's copy is refused by the trigger.
    await expect(attempt(`update transcript_emails set sealed = '{}'::jsonb where id = $1`)).rejects.toThrow(
      /never rewritten/,
    );
    // Even the owner of the table cannot rewrite the copy.
    await expect(
      inTenant(clinicId, (client) => client.query(`update transcript_emails set sealed = '{}'::jsonb where id = $1`, [id])),
    ).rejects.toThrow(/never rewritten/);
    // And a forced row-level policy: another tenant sees nothing.
    const other = await seedClinic("outbox-other");
    const seen = await withTenant({ clinicId: other.clinicId, actor: ACTOR }, async (tx) =>
      tx.db.execute(sql`select id from transcript_emails`),
    );
    expect((seen as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });

  test("a production clinic without an agreement in effect queues nothing", async () => {
    const { clinicId, conversationId } = await seeded("outbox-gate");
    await getMigratorPool().query(`update clinics set data_classification = 'production' where id = $1`, [clinicId]);
    await expect(queue(clinicId, conversationId)).rejects.toThrow();
    await getMigratorPool().query(`update clinics set data_classification = 'synthetic' where id = $1`, [clinicId]);
  });

  test("a send goes to the clinic's address through the PHI class, and starts the seven days from the send", async () => {
    const { clinicId, conversationId, staffEmail } = await seeded("outbox-send");
    const id = await queue(clinicId, conversationId);
    const transport = new FakeTransport();
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("sent");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.target.to).toBe(staffEmail.toLowerCase());
    expect(transport.sent[0]!.target.bcc).toBeUndefined();
    expect(transport.sent[0]!.message.phiClass).toBe("may-carry-phi");
    expect(transport.sent[0]!.message.text).toContain(WORDS);
    const stored = await row(id!);
    expect(stored).toMatchObject({ status: "sent", attempts: 1, last_error: null });
    expect(stored!.ses_message_id).toMatch(/^ses-/);
    expect(stored!.destroy_after.getTime() - stored!.sent_at!.getTime()).toBe(7 * DAY);
    // Sent: not due again.
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("not_due");
    expect(transport.sent).toHaveLength(1);
  });

  test("the archive copy is a blind copy, and only to a mailbox stated to be under a BAA", async () => {
    const { clinicId, conversationId } = await seeded("outbox-archive");
    const id = await queue(clinicId, conversationId);
    process.env.HEALDESK_TRANSCRIPT_ARCHIVE_TO = "transcripts@healdesk.test";
    const unstated = new FakeTransport();
    await resendTranscript(clinicId, conversationId);
    expect(await deliverTranscriptEmail(clinicId, id!, { transport: unstated })).toBe("sent");
    expect(unstated.sent[0]!.target.bcc).toBeUndefined();

    process.env.HEALDESK_TRANSCRIPT_ARCHIVE_BAA = "signed";
    await resendTranscript(clinicId, conversationId);
    const stated = new FakeTransport();
    expect(await deliverTranscriptEmail(clinicId, id!, { transport: stated })).toBe("sent");
    expect(stated.sent).toHaveLength(1);
    expect(stated.sent[0]!.target.to).not.toBe("transcripts@healdesk.test");
    expect(stated.sent[0]!.target.bcc).toEqual(["transcripts@healdesk.test"]);
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

  test("SES's events: a delivery is noted; a hard bounce is sent again an hour later and tells ops", async () => {
    const { clinicId, conversationId } = await seeded("outbox-ses");
    const id = await queue(clinicId, conversationId);
    const transport = new FakeTransport();
    await deliverTranscriptEmail(clinicId, id!, { transport });
    const messageId = (await row(id!))!.ses_message_id!;
    const firstDestroy = (await row(id!))!.destroy_after;

    expect(await recordSesTranscriptEvent({ messageId: "not-ours", type: "delivery" })).toBe(false);

    // A transient bounce is SES still trying: noted, nothing changes.
    expect(await recordSesTranscriptEvent({ messageId, type: "bounce", bounceType: "Transient" })).toBe(true);
    expect((await row(id!))?.status).toBe("sent");

    const before = Date.now();
    expect(
      await recordSesTranscriptEvent({ messageId, type: "bounce", bounceType: "Permanent", reason: "550 mailbox unavailable" }),
    ).toBe(true);
    let stored = await row(id!);
    expect(stored!.status).toBe("bounced");
    expect(stored!.last_error).toMatch(/Permanent/);
    expect(stored!.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(await opsAlerts(conversationId)).toHaveLength(1);

    await age(id!, `next_attempt_at = now() - interval '1 second'`);
    expect(await deliverTranscriptEmail(clinicId, id!, { transport })).toBe("sent");
    stored = await row(id!);
    expect(stored!.status).toBe("sent");
    expect(stored!.ses_message_id).not.toBe(messageId);
    // A send after a bounce never moves the seven days.
    expect(stored!.destroy_after.getTime()).toBe(firstDestroy.getTime());

    expect(await recordSesTranscriptEvent({ messageId: stored!.ses_message_id!, type: "delivery" })).toBe(true);
    stored = await row(id!);
    expect(stored!.status).toBe("delivered");
    expect(stored!.delivered_at).toBeTruthy();
  });

  test("a copy is deleted on its day, sent or not; one that never went tells ops", async () => {
    const sentOne = await seeded("outbox-destroy-sent");
    const sentId = await queue(sentOne.clinicId, sentOne.conversationId);
    await deliverTranscriptEmail(sentOne.clinicId, sentId!, { transport: new FakeTransport() });
    const unsentOne = await seeded("outbox-destroy-unsent");
    const unsentId = await queue(unsentOne.clinicId, unsentOne.conversationId);

    // Not yet.
    expect(await destroyTranscriptEmail(sentOne.clinicId, sentId!)).toBe(false);
    expect(await row(sentId!)).toBeDefined();

    const later = new Date(Date.now() + 8 * DAY);
    expect(await destroyTranscriptEmail(sentOne.clinicId, sentId!, { now: later })).toBe(true);
    expect(await row(sentId!)).toBeUndefined();
    expect(await opsAlerts(sentOne.conversationId)).toHaveLength(0);

    expect(await destroyTranscriptEmail(unsentOne.clinicId, unsentId!, { now: later })).toBe(true);
    expect(await row(unsentId!)).toBeUndefined();
    expect(await opsAlerts(unsentOne.conversationId)).toEqual([
      expect.objectContaining({ clinicId: unsentOne.clinicId, status: "expired" }),
    ]);
    // The conversation stays, without the words.
    const { rows } = await inTenant(sentOne.clinicId, (client) =>
      client.query(`select id from conversations where id = $1`, [sentOne.conversationId]),
    );
    expect(rows).toHaveLength(1);
  });

  test("the job sends what is due and deletes what is past its day, by the database's clock", async () => {
    const due = await seeded("outbox-job-send");
    const dueId = await queue(due.clinicId, due.conversationId);
    const old = await seeded("outbox-job-old");
    const oldId = await queue(old.clinicId, old.conversationId);
    await deliverTranscriptEmail(old.clinicId, oldId!, { transport: new FakeTransport() });
    await age(oldId!, `destroy_after = now() - interval '1 second', created_at = now() - interval '8 days', sent_at = now() - interval '8 days'`);

    const work = await transcriptWork();
    expect(work).toEqual(
      expect.arrayContaining([
        { clinicId: due.clinicId, id: dueId, due: "send" },
        { clinicId: old.clinicId, id: oldId, due: "destroy" },
      ]),
    );

    const transport = new FakeTransport();
    const outcome = await runTranscriptEmailsJob({ transport });
    expect(outcome.status).toBe("ok");
    expect((await row(dueId!))?.status).toBe("sent");
    expect(await row(oldId!)).toBeUndefined();
  });

  test("off, the job still deletes every copy on its day: the agreement's seven days wait for no switch", async () => {
    const { clinicId, conversationId } = await seeded("outbox-off-delete");
    const id = await queue(clinicId, conversationId);
    await age(id!, `destroy_after = now() - interval '1 second', created_at = now() - interval '8 days'`);
    await setSwitch(false);
    const transport = new FakeTransport();
    expect((await runTranscriptEmailsJob({ transport })).status).toBe("disabled");
    expect(await row(id!)).toBeUndefined();
    expect(transport.sent).toHaveLength(0);
    await setSwitch(true);
  });

  test("off, the job and the send-now both stand aside", async () => {
    const { clinicId, conversationId } = await seeded("outbox-off");
    const id = await queue(clinicId, conversationId);
    await setSwitch(false);
    const transport = new FakeTransport();
    expect((await runTranscriptEmailsJob({ transport })).status).toBe("disabled");
    expect(await sendQueuedTranscriptNow(clinicId, id, { transport })).toBe("disabled");
    expect(transport.sent).toHaveLength(0);
    await setSwitch(true);
    expect(await sendQueuedTranscriptNow(clinicId, id, { transport })).toBe("sent");
    expect(await sendQueuedTranscriptNow(clinicId, null, { transport })).toBeNull();
  });

  test("a resend is possible while the copy lasts, and not after", async () => {
    const { clinicId, conversationId } = await seeded("outbox-resend");
    const id = await queue(clinicId, conversationId);
    await deliverTranscriptEmail(clinicId, id!, { transport: new FakeTransport() });
    expect(await resendTranscript(clinicId, conversationId)).toBe(true);
    expect((await row(id!))?.status).toBe("pending");
    await destroyTranscriptEmail(clinicId, id!, { now: new Date(Date.now() + 8 * DAY) });
    expect(await resendTranscript(clinicId, conversationId)).toBe(false);
  });

  test("the operator console can ask for a resend by conversation id, and learns when the copy is gone", async () => {
    const { clinicId, conversationId } = await seeded("outbox-ops");
    const id = await queue(clinicId, conversationId);
    await deliverTranscriptEmail(clinicId, id!, { transport: new FakeTransport() });
    const operator: Operator = { email: "ops@healdesk.test", request: {} };
    const ask = async (args: Record<string, unknown>) => {
      const outcome = await runOperation("resendTranscript", args, operator);
      expect(outcome.status).toBe(200);
      return (outcome.body as { data: Record<string, unknown> }).data;
    };
    expect(await ask({ clinicId, conversationId })).toMatchObject({ status: "queued" });
    expect((await row(id!))?.status).toBe("pending");
    expect(await ask({ clinicId, conversationId: "not-a-uuid" })).toMatchObject({ status: "error" });
    await destroyTranscriptEmail(clinicId, id!, { now: new Date(Date.now() + 8 * DAY) });
    expect(await ask({ clinicId, conversationId })).toEqual({ status: "gone" });
  });

  test("a conversation's deletion takes its queued transcript with it", async () => {
    const { clinicId, conversationId } = await seeded("outbox-cascade");
    const id = await queue(clinicId, conversationId);
    await inTenant(clinicId, (client) => client.query(`delete from conversations where id = $1`, [conversationId]));
    expect(await row(id!)).toBeUndefined();
  });
});
