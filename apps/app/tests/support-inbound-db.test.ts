import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { closeSupportCase, matchSupportCase } from "@/lib/support/cases";
import { handleInboundNotice } from "@/lib/support/inbound/handle";
import type { InboundNotice } from "@/lib/support/inbound/notice";
import { runUnmatchedEmailRetention } from "@/lib/support/inbound/retention";
import { sweepInboundMail } from "@/lib/support/inbound/sweep";
import { threadingHeadersFor } from "@/lib/support/inbound/threading";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";
import { memoryMailStore } from "./setup/inbound-mail";

/**
 * Inbound support mail against the real database (ops automation lane P7g;
 * drizzle/0130): an email becomes exactly one case holding facts only, the
 * fixed acknowledgement is queued to the clinic's one address at most once
 * per case and only when the rules allow, a reply joins its case by ref or
 * thread, a stranger gets nothing, a redelivered notice changes nothing, and
 * the raw message is deleted on a parse failure, and kept in the bucket for
 * the drafter (lane P7h) when it is a clinic's (support-inbound-drafter-
 * db.test.ts follows it to its deletion). A sentinel
 * word written into the subject, the body, the display name and the
 * attachments' names is searched for in every column of every row of every
 * table afterwards, and is never found.
 *
 * Fixed clock throughout; the store is held in memory; no AWS.
 */

/**
 * A case's ref is drawn from node:crypto's randomInt (newSupportRef). Tests
 * may queue the draws, so a ref that would come up 1 time in 1,024 (one
 * beginning "HD", CI run 41022562042) is tested every run; otherwise the
 * real CSPRNG.
 */
const refDraws: number[] = [];
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  const randomInt = ((...args: Parameters<typeof real.randomInt>) =>
    refDraws.length > 0 ? refDraws.shift()! : (real.randomInt as (...a: unknown[]) => unknown)(...args)) as typeof real.randomInt;
  return { ...real, default: { ...real, randomInt }, randomInt };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const BUCKET = "healdesk-test-inbound-mail";
const NOW = new Date("2026-10-26T15:00:00Z");
const MINUTE = 60_000;
const PASS = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" } as const;
/** What the sweep hands in: no notice, so every verdict comes from SES's own headers in the message. */
const UNKNOWN = { spam: "UNKNOWN", virus: "UNKNOWN", spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" } as const;
const SENTINEL = "zebrasentinel";

const FIXTURES = join(__dirname, "fixtures", "inbound");
function eml(name: string, fill: Record<string, string>): string {
  let text = readFileSync(join(FIXTURES, name), "utf8");
  if (fill.FROM && !fill.DOMAIN) fill = { ...fill, DOMAIN: fill.FROM.split("@")[1]! };
  for (const [key, value] of Object.entries(fill)) text = text.replaceAll(`{{${key}}}`, value);
  return text;
}

let seq = 0;
function notice(id: string, over: Partial<InboundNotice> = {}): InboundNotice {
  return { sesMessageId: id, bucket: BUCKET, key: `mail/${id}`, receivedAt: NOW, verdicts: PASS, ...over };
}

/** Put one fixture in the store and hand it to the handler. */
async function deliver(
  store: ReturnType<typeof memoryMailStore>,
  file: string,
  fill: Record<string, string>,
  over: Partial<InboundNotice> & { now?: Date } = {},
) {
  seq += 1;
  const id = over.sesMessageId ?? `ses${String(seq).padStart(4, "0")}x`;
  // Each message its own Message-ID, as in the world: "<normal-1@...>" becomes "<normal-1-<id>@...>".
  const text = eml(file, fill).replace(/^Message-ID: <([^@>]+)@/m, `Message-ID: <$1-${id}@`);
  const messageId = /^Message-ID: (<[^>]+>)/m.exec(text)?.[1] ?? null;
  store.put(`mail/${id}`, text);
  const { now, ...rest } = over;
  const n = notice(id, { receivedAt: now ?? NOW, ...rest });
  // The support-draft job on, so a clinic's email is kept for the drafter (lane P7h; support-inbound-drafter-db.test.ts covers it off).
  const outcome = await handleInboundNotice(n, { store, now: now ?? NOW, allowFor: async () => ({ numbers: [], emails: [] }), drafterOn: async () => true });
  return { id, n, outcome, messageId };
}

async function caseRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(`select * from support_cases where id = $1`, [caseId]);
  return rows[0]!;
}

async function emailMessages(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(
    `select * from support_messages where case_id = $1 and kind = 'email' order by received_at, created_at`,
    [caseId],
  );
  return rows;
}

async function acks(clinicId: string) {
  return inTenant(clinicId, async (client) =>
    (await client.query<{ id: string; dedupe_key: string; payload: Record<string, unknown> }>(
      `select id, dedupe_key, payload from billing_notices where clinic_id = $1 and kind = 'support_received'`,
      [clinicId],
    )).rows,
  );
}

describeDb("inbound support mail (drizzle/0130)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(() => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_BUCKET", BUCKET);
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closePools();
  });

  test("a clinic's email opens one case about that clinic, facts only, queues one acknowledgement, and the raw object waits for the drafter", async () => {
    const clinic = await seedClinic("inb-normal");
    const store = memoryMailStore();
    const { id, outcome } = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    expect(outcome).toMatchObject({ outcome: "recorded", opened: true, acknowledged: true });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    // Lane P7h: kept in the bucket for the support-draft job, its key on the row.
    expect(store.objects.has(`mail/${id}`)).toBe(true);
    expect(store.deleted).toEqual([]);

    const c = await caseRow(outcome.caseId);
    expect(c).toMatchObject({ subject_clinic_id: clinic.clinicId, source: "email", state: "new", category: "forwarding", symptom: "calls_ring_out", urgency: "now", phi_suspected: false });
    const [m] = await emailMessages(outcome.caseId);
    expect(m).toMatchObject({ direction: "in", kind: "email", text: null, subject_screened: null, inbound_mail_id: id, inbound_object_key: `mail/${id}`, message_id: `<normal-1-${id}@mail.example-clinic.test>` });
    expect(m!.sender_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(m!.fields_json).toMatchObject({ source: "email", topic: "forwarding", matchedBy: "address", acknowledgement: "queued", dkim: "pass" });

    const sent = await acks(clinic.clinicId);
    expect(sent).toHaveLength(1);
    // The outbox sends under hd-<kind>-<row id>-1: the row's id is the case's.
    expect(sent[0]).toMatchObject({ id: outcome.caseId, dedupe_key: `support_received:${outcome.caseId}` });
    expect(sent[0]!.payload).toMatchObject({ caseId: outcome.caseId, hasPatientDetails: false });
    expect(String(sent[0]!.payload.supportRef)).toMatch(/^HD-[0-9A-Z]{5}$/);
  });

  test("the same notice again changes nothing: no second case, no second acknowledgement", async () => {
    const clinic = await seedClinic("inb-dup");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    // SNS delivers again, and the object is somehow back (the sweep's view).
    store.put(`mail/${first.id}`, eml("clinic-normal.eml", { FROM: clinic.staffEmail }));
    const again = await handleInboundNotice(first.n, { store, now: NOW, allowFor: async () => null });
    expect(again).toEqual({ outcome: "already_recorded", caseId: first.outcome.caseId });
    // Still waiting for the drafter (its key on the row): left alone.
    expect(store.objects.has(`mail/${first.id}`)).toBe(true);
    // Once the drafter has had it (the key cleared), a redelivery deletes what is there.
    await getMigratorPool().query(`update support_messages set inbound_object_key = null where inbound_mail_id = $1`, [first.id]);
    expect(await handleInboundNotice(first.n, { store, now: NOW, allowFor: async () => null })).toEqual({ outcome: "already_recorded", caseId: first.outcome.caseId });
    expect(store.objects.has(`mail/${first.id}`)).toBe(false);
    // And once more with the object gone: nothing to read.
    expect(await handleInboundNotice(first.n, { store, now: NOW })).toEqual({ outcome: "gone" });
    const { rows } = await getMigratorPool().query(`select count(*)::int as n from support_cases where subject_clinic_id = $1`, [clinic.clinicId]);
    expect(rows[0].n).toBe(1);
    expect(await acks(clinic.clinicId)).toHaveLength(1);
  });

  test("a plus-addressed sender is matched to the clinic's one sign-in", async () => {
    const clinic = await seedClinic("inb-plus");
    const store = memoryMailStore();
    const [local, domain] = clinic.staffEmail.split("@");
    const { outcome } = await deliver(store, "plus-addressed.eml", { FROM_PLUS: `${local}+support@${domain}` });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect((await caseRow(outcome.caseId)).subject_clinic_id).toBe(clinic.clinicId);
    expect(outcome.acknowledged).toBe(true);
  });

  test("a reply quoting the ref joins its case: waiting on the clinic comes back to new, and no second acknowledgement", async () => {
    const clinic = await seedClinic("inb-ref");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const c = await caseRow(first.outcome.caseId);
    await getMigratorPool().query(`update support_cases set state = 'waiting_clinic', last_outbound_at = $2 where id = $1`, [c.id, NOW]);

    const later = new Date(NOW.getTime() + 90 * MINUTE);
    const reply = await deliver(store, "ref-reply.eml", { FROM: clinic.staffEmail, REF: String(c.ref) }, { now: later });
    expect(reply.outcome).toMatchObject({ outcome: "recorded", caseId: c.id, opened: false, acknowledged: false });
    const after = await caseRow(String(c.id));
    expect(after.state).toBe("new");
    const messages = await emailMessages(String(c.id));
    expect(messages).toHaveLength(2);
    expect(messages[1]!.fields_json).toMatchObject({ matchedBy: "ref", senderMatchesCase: "yes", acknowledgement: "already" });
    expect(await acks(clinic.clinicId)).toHaveLength(1);
  });

  test("a reply quoting a ref that itself begins with HD joins its case too", async () => {
    const clinic = await seedClinic("inb-ref-hd");
    const store = memoryMailStore();
    // H, D, 7, F, 3 in SUPPORT_REF_ALPHABET: the case's ref is "HD7F3", printed "HD-HD7F3".
    refDraws.push(17, 13, 7, 15, 3);
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    expect(refDraws).toEqual([]);
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const c = await caseRow(first.outcome.caseId);
    expect(c.ref).toBe("HD7F3");

    const reply = await deliver(store, "ref-reply.eml", { FROM: clinic.staffEmail, REF: String(c.ref) }, { now: new Date(NOW.getTime() + 90 * MINUTE) });
    expect(reply.outcome).toMatchObject({ outcome: "recorded", caseId: c.id, opened: false, acknowledged: false });
    expect((await emailMessages(String(c.id)))[1]!.fields_json).toMatchObject({ matchedBy: "ref" });
    expect(await acks(clinic.clinicId)).toHaveLength(1);
  });

  test("In-Reply-To naming an email on a case joins it", async () => {
    const clinic = await seedClinic("inb-thread");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const next = await deliver(store, "in-reply-to.eml", { FROM: clinic.staffEmail, THREAD: first.messageId! }, { now: new Date(NOW.getTime() + 2 * 60 * MINUTE) });
    expect(next.outcome).toMatchObject({ outcome: "recorded", caseId: first.outcome.caseId, opened: false });
    const messages = await emailMessages(first.outcome.caseId);
    expect(messages[1]!.fields_json).toMatchObject({ matchedBy: "thread" });
    expect(messages[1]!.in_reply_to).toBe(first.messageId);
  });

  test("an unmatched prospect becomes a case with no clinic, no acknowledgement and nothing sent to it", async () => {
    const store = memoryMailStore();
    const { outcome } = await deliver(store, "prospect.eml", {});
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(outcome.acknowledged).toBe(false);
    const c = await caseRow(outcome.caseId);
    expect(c.subject_clinic_id).toBeNull();
    const [m] = await emailMessages(outcome.caseId);
    expect(m!.fields_json).toMatchObject({ matchedBy: "none", acknowledgement: "not_matched" });
    const { rows } = await getMigratorPool().query(`select count(*)::int as n from billing_notices where kind = 'support_received' and id = $1`, [outcome.caseId]);
    expect(rows[0].n).toBe(0);
  });

  test("a stranger quoting a clinic's ref cannot join, reopen or raise the case: a new case about no clinic, nothing sent", async () => {
    const clinic = await seedClinic("inb-stranger");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const before = await caseRow(first.outcome.caseId);
    await getMigratorPool().query(`update support_cases set state = 'waiting_clinic', last_outbound_at = $2 where id = $1`, [before.id, NOW]);
    const ref = String(before.ref);
    // Had it joined, the case waiting on the clinic would be back to `new`, with a second message.
    const other = await deliver(store, "ref-reply.eml", { FROM: "stranger@elsewhere.test", REF: ref }, { now: new Date(NOW.getTime() + MINUTE) });
    expect(other.outcome).toMatchObject({ outcome: "recorded", opened: true, acknowledged: false });
    if (other.outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(other.outcome.caseId).not.toBe(first.outcome.caseId);
    expect((await caseRow(other.outcome.caseId)).subject_clinic_id).toBeNull();
    const after = await caseRow(first.outcome.caseId);
    expect(after).toMatchObject({ state: "waiting_clinic", urgency: before.urgency, hidden_numbers: before.hidden_numbers });
    expect(await emailMessages(first.outcome.caseId)).toHaveLength(1);
    expect((await emailMessages(other.outcome.caseId))[0]!.fields_json).toMatchObject({ matchedBy: "none", acknowledgement: "not_matched", fromClinic: "no" });

    // The stranger's own reply, quoting its own new case's ref, joins that case (same sender).
    const again = await deliver(store, "ref-reply.eml", { FROM: "stranger@elsewhere.test", REF: String((await caseRow(other.outcome.caseId)).ref) }, { now: new Date(NOW.getTime() + 2 * MINUTE) });
    expect(again.outcome).toMatchObject({ outcome: "recorded", caseId: other.outcome.caseId, opened: false });
  });

  test("the clinic's own address, unauthenticated, quoting its ref does not join either", async () => {
    const clinic = await seedClinic("inb-forged-ref");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const ref = String((await caseRow(first.outcome.caseId)).ref);
    const forged = await deliver(store, "ref-reply.eml", { FROM: clinic.staffEmail, REF: ref }, { verdicts: { ...PASS, dkim: "GRAY", dmarc: "FAIL" } });
    expect(forged.outcome).toMatchObject({ outcome: "recorded", opened: true, acknowledged: false });
    if (forged.outcome.outcome !== "recorded") throw new Error("not recorded");
    expect((await caseRow(forged.outcome.caseId)).subject_clinic_id).toBeNull();
    expect(await emailMessages(first.outcome.caseId)).toHaveLength(1);
  });

  test("a closed case is never joined: the clinic's next email opens a new one", async () => {
    const clinic = await seedClinic("inb-closed");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    const ref = String((await caseRow(first.outcome.caseId)).ref);
    await closeSupportCase(first.outcome.caseId, "replied_by_hand", NOW);
    const next = await deliver(store, "ref-reply.eml", { FROM: clinic.staffEmail, REF: ref });
    expect(next.outcome).toMatchObject({ outcome: "recorded", opened: true });
  }, 60_000);

  test("patient-looking content: counts and phi_suspected, the acknowledgement's extra sentence, and the sentinel nowhere in the database", async () => {
    const clinic = await seedClinic("inb-phi");
    const store = memoryMailStore();
    const { id, outcome } = await deliver(store, "phi.eml", { FROM: clinic.staffEmail });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    // Waits for the drafter, in the bucket only; nothing of it in the database (below).
    expect(store.objects.has(`mail/${id}`)).toBe(true);
    const c = await caseRow(outcome.caseId);
    expect(c.phi_suspected).toBe(true);
    expect(Number(c.hidden_numbers)).toBeGreaterThanOrEqual(2);
    expect(Number(c.hidden_emails)).toBe(1);
    expect(Number(c.hidden_treatments)).toBeGreaterThanOrEqual(1);
    expect(Number(c.clinical_matches)).toBeGreaterThanOrEqual(1);
    const [m] = await emailMessages(outcome.caseId);
    expect(m!.attachments_json).toEqual({ count: 2, image: 1, pdf: 1, other: 0, size: "under_1mb" });
    const [ack] = await acks(clinic.clinicId);
    expect(ack!.payload).toMatchObject({ hasPatientDetails: true });

    // Every column of every row of every table, as the owner, with and without the clinic's tenant.
    const pool = getMigratorPool();
    const tables = (
      await pool.query<{ schema: string; name: string }>(
        `select table_schema as schema, table_name as name from information_schema.tables
          where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`,
      )
    ).rows;
    const found: string[] = [];
    for (const tenant of [null, clinic.clinicId]) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (tenant) await client.query(`select set_config('app.clinic_id', $1, true)`, [tenant]);
        for (const t of tables) {
          await client.query("savepoint s");
          try {
            const { rows } = await client.query<{ n: number }>(
              `select count(*)::int as n from "${t.schema}"."${t.name}" x where lower(x::text) like $1`,
              [`%${SENTINEL}%`],
            );
            if (rows[0]!.n > 0) found.push(`${t.schema}.${t.name}`);
            await client.query("release savepoint s");
          } catch {
            await client.query("rollback to savepoint s");
          }
        }
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }
    }
    expect(found).toEqual([]);
    expect(tables.length).toBeGreaterThan(50);
  });

  test("the fourth email from one sender within an hour is kept on one case but gets no acknowledgement", async () => {
    const clinic = await seedClinic("inb-flood");
    const store = memoryMailStore();
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push((await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail }, { now: new Date(NOW.getTime() + i * 5 * MINUTE) })).outcome);
    }
    const fourth = outcomes[3]!;
    expect(fourth).toMatchObject({ outcome: "recorded", opened: false, acknowledged: false });
    if (fourth.outcome !== "recorded") throw new Error("not recorded");
    const messages = await emailMessages(fourth.caseId);
    expect(messages.at(-1)!.fields_json).toMatchObject({ acknowledgement: "rate_limited" });
    // Three cases, three acknowledgements: one each, never a fourth.
    expect(await acks(clinic.clinicId)).toHaveLength(3);
  });

  test("a DKIM failure: a case about no clinic, nothing acknowledged", async () => {
    const clinic = await seedClinic("inb-dkim");
    const store = memoryMailStore();
    const { outcome } = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail }, { verdicts: { ...PASS, dkim: "FAIL" } });
    expect(outcome).toMatchObject({ outcome: "recorded", acknowledged: false });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect((await caseRow(outcome.caseId)).subject_clinic_id).toBeNull();
    expect((await emailMessages(outcome.caseId))[0]!.fields_json).toMatchObject({ dkim: "fail", authenticated: "no", matchedBy: "none", acknowledgement: "not_matched" });
    expect(await acks(clinic.clinicId)).toHaveLength(0);
  });

  test.each([
    ["ses-unsigned.eml", false],
    ["ses-dkim-fail.eml", false],
    ["ses-unaligned-pass.eml", false],
    ["ses-forged-results.eml", false],
    ["ses-aligned-pass.eml", true],
  ])("from SES's own headers (as the sweep reads it), %s: attributed and acknowledged only on an aligned pass (%s)", async (file, attributed) => {
    const clinic = await seedClinic(`inb-auth-${file.replace(/[^a-z]/g, "").slice(3, 15)}`);
    const store = memoryMailStore();
    const { outcome } = await deliver(store, file, { FROM: clinic.staffEmail }, { verdicts: UNKNOWN });
    if (outcome.outcome !== "recorded") throw new Error(`not recorded: ${JSON.stringify(outcome)}`);
    expect((await caseRow(outcome.caseId)).subject_clinic_id).toBe(attributed ? clinic.clinicId : null);
    expect(outcome.acknowledged).toBe(attributed);
    expect((await emailMessages(outcome.caseId))[0]!.fields_json).toMatchObject({ authenticated: attributed ? "yes" : "no", spam: "pass", virus: "pass" });
    expect(await acks(clinic.clinicId)).toHaveLength(attributed ? 1 : 0);
  });

  test("emails from one sender recorded at once: the advisory lock holds the hour's limit, at most three acknowledgements", async () => {
    const clinic = await seedClinic("inb-race");
    const store = memoryMailStore();
    const outcomes = await Promise.all(
      Array.from({ length: 7 }, () => deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail })),
    );
    expect(outcomes.every((o) => o.outcome.outcome === "recorded")).toBe(true);
    expect(outcomes.filter((o) => o.outcome.outcome === "recorded" && o.outcome.acknowledged)).toHaveLength(3);
    expect(await acks(clinic.clinicId)).toHaveLength(3);
  }, 60_000);

  test("auto-replies, a list, a bounce and our own mail are dropped: no case, and the object is deleted", async () => {
    const clinic = await seedClinic("inb-guard");
    const store = memoryMailStore();
    const { rows: before } = await getMigratorPool().query(`select count(*)::int as n from support_cases`);
    for (const file of ["auto-submitted.eml", "precedence-bulk.eml", "x-autoreply.eml", "x-auto-response-suppress.eml", "list.eml", "dsn.eml", "own-address.eml"]) {
      const { id, outcome } = await deliver(store, file, { FROM: clinic.staffEmail });
      expect(outcome.outcome, file).toBe("dropped");
      expect(store.objects.has(`mail/${id}`), file).toBe(false);
    }
    const spam = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail }, { verdicts: { ...PASS, spam: "FAIL" } });
    expect(spam.outcome).toEqual({ outcome: "dropped", reason: "spam" });
    const { rows: after } = await getMigratorPool().query(`select count(*)::int as n from support_cases`);
    expect(after[0].n).toBe(before[0].n);
  });

  test("a message that cannot be parsed is a case with no facts, about no clinic, and its object is deleted", async () => {
    const store = memoryMailStore();
    seq += 1;
    const id = `ses${seq}broken`;
    store.put(`mail/${id}`, `From: a@b.test\r\nX-Pad: ${"x".repeat(600 * 1024)}\r\nSubject: ${SENTINEL}\r\n\r\nbody`);
    const outcome = await handleInboundNotice(notice(id), { store, now: NOW });
    expect(outcome).toMatchObject({ outcome: "recorded", opened: true, acknowledged: false });
    expect(store.objects.has(`mail/${id}`)).toBe(false);
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(await caseRow(outcome.caseId)).toMatchObject({ subject_clinic_id: null, category: "other", symptom: "other" });
  });

  test("an oversize message is kept as a case from its headers alone, never parsed whole, and deleted", async () => {
    const clinic = await seedClinic("inb-big");
    const store = memoryMailStore();
    seq += 1;
    const id = `ses${seq}big`;
    const head = eml("clinic-normal.eml", { FROM: clinic.staffEmail }).split("\r\n\r\n")[0];
    store.put(`mail/${id}`, `${head}\r\n\r\n${"A".repeat(10 * 1024 * 1024 + 10)}`);
    const outcome = await handleInboundNotice(notice(id), { store, now: NOW, allowFor: async () => null });
    expect(outcome).toMatchObject({ outcome: "recorded", opened: true });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(store.objects.has(`mail/${id}`)).toBe(false);
    const [m] = await emailMessages(outcome.caseId);
    expect(m!.fields_json).toMatchObject({ oversize: "yes", matchedBy: "address" });
    expect((await caseRow(outcome.caseId)).subject_clinic_id).toBe(clinic.clinicId);
  });

  test("a provider's forwarding confirmation, signed by google.com, is left in the bucket for the owner, and becomes no case", async () => {
    const store = memoryMailStore();
    const { id, outcome } = await deliver(store, "gmail-confirmation-signed.eml", {}, { verdicts: UNKNOWN });
    expect(outcome).toEqual({ outcome: "provider_confirmation" });
    expect(store.objects.has(`mail/${id}`)).toBe(true);
  });

  test("one from the same address that google.com did not sign is an ordinary email: a case about no clinic, deleted", async () => {
    const store = memoryMailStore();
    const { id, outcome } = await deliver(store, "gmail-confirmation.eml", {});
    expect(outcome).toMatchObject({ outcome: "recorded", opened: true, acknowledged: false });
    expect(store.objects.has(`mail/${id}`)).toBe(false);
  });

  test("a transient storage failure is thrown (the webhook answers 5xx) and the object stays", async () => {
    const store = memoryMailStore();
    seq += 1;
    const id = `ses${seq}down`;
    store.put(`mail/${id}`, eml("prospect.eml", {}));
    store.failGets = true;
    await expect(handleInboundNotice(notice(id), { store, now: NOW })).rejects.toThrow(/read failed/);
    expect(store.objects.has(`mail/${id}`)).toBe(true);
  });

  test("an object outside the configured bucket or prefix is refused and not read", async () => {
    const store = memoryMailStore();
    expect(await handleInboundNotice(notice("x1", { bucket: "someone-else" }), { store, now: NOW })).toEqual({ outcome: "refused", reason: "wrong_bucket" });
    expect(await handleInboundNotice(notice("x2", { key: "exports/x2" }), { store, now: NOW })).toEqual({ outcome: "refused", reason: "bad_key" });
  });

  test("the sweep handles what the webhook left, deletes what is older than six hours, and counts only", async () => {
    const clinic = await seedClinic("inb-sweep");
    const store = memoryMailStore();
    store.put("mail/sweepfresh01", eml("clinic-normal.eml", { FROM: clinic.staffEmail }), new Date(NOW.getTime() - 30 * MINUTE));
    store.put("mail/sweepold0001", eml("clinic-normal.eml", { FROM: clinic.staffEmail }), new Date(NOW.getTime() - 7 * 60 * MINUTE));
    const counts = await sweepInboundMail({ store, now: NOW, allowFor: async () => null });
    expect(counts).toEqual({ handled: 1, already: 0, dropped: 0, deletedOld: 1, left: 0, failed: 0, undrafted: 0, cleared: 0 });
    expect(store.objects.size).toBe(0);
    const { rows } = await getMigratorPool().query(`select count(*)::int as n from support_messages where inbound_mail_id = 'sweepfresh01'`);
    expect(rows[0].n).toBe(1);
  });

  test("threading: a reply on an email case names the newest email before its approval", async () => {
    const clinic = await seedClinic("inb-headers");
    const store = memoryMailStore();
    const first = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    if (first.outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(await threadingHeadersFor(first.outcome.caseId, new Date(NOW.getTime() + MINUTE))).toEqual({
      "In-Reply-To": first.messageId,
      References: first.messageId,
    });
    // Approved before the email was recorded: nothing to thread under.
    expect(await threadingHeadersFor(first.outcome.caseId, new Date(NOW.getTime() - MINUTE))).toBeNull();

    // An email that says it was received earlier but was RECORDED after the approval does not change the headers.
    const late = await deliver(store, "ref-reply.eml", { FROM: clinic.staffEmail, REF: String((await caseRow(first.outcome.caseId)).ref) }, { now: new Date(NOW.getTime() + 5 * MINUTE), receivedAt: new Date(NOW.getTime() - 30 * MINUTE) });
    expect(late.outcome).toMatchObject({ outcome: "recorded", caseId: first.outcome.caseId });
    expect(await threadingHeadersFor(first.outcome.caseId, new Date(NOW.getTime() + 2 * MINUTE))).toEqual({
      "In-Reply-To": first.messageId,
      References: first.messageId,
    });
  });

  test("threading: only an email from the case's clinic is threaded under; a matched prospect's is not", async () => {
    const clinic = await seedClinic("inb-headers-prospect");
    const store = memoryMailStore();
    const { outcome } = await deliver(store, "prospect.eml", {});
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect(await matchSupportCase(outcome.caseId, clinic.clinicId, { type: "service", serviceName: "test" }, NOW)).toMatchObject({ outcome: "done" });
    expect(await threadingHeadersFor(outcome.caseId, new Date(NOW.getTime() + MINUTE))).toBeNull();
  });

  test("a Message-ID shaped like a link is never kept, so it can never kill a reply", async () => {
    const clinic = await seedClinic("inb-link-id");
    const store = memoryMailStore();
    seq += 1;
    const id = `ses${seq}linkid`;
    store.put(`mail/${id}`, eml("clinic-normal.eml", { FROM: clinic.staffEmail }).replace(/^Message-ID: .*$/m, "Message-ID: <https://x.example/y>"));
    const outcome = await handleInboundNotice(notice(id), { store, now: NOW, allowFor: async () => null });
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    expect((await emailMessages(outcome.caseId))[0]!.message_id).toBeNull();
    expect(await threadingHeadersFor(outcome.caseId, new Date(NOW.getTime() + MINUTE))).toBeNull();
  });

  test("retention of email cases about no clinic: idle 30 days closes silently, closed 30 days is deleted; a clinic's case is never touched", async () => {
    const clinic = await seedClinic("inb-retention");
    const store = memoryMailStore();
    const pool = getMigratorPool();
    // Each its own sender, so none is one sender's flood joined onto another.
    const stranger = (n: string) => ({ FROM: `${n}-${Date.now()}@prospect-practice.test` });
    const prospect = await deliver(store, "clinic-normal.eml", stranger("idle"));
    const recent = await deliver(store, "clinic-normal.eml", stranger("recent"));
    const clinics = await deliver(store, "clinic-normal.eml", { FROM: clinic.staffEmail });
    const ids = [prospect, recent, clinics].map((d) => (d.outcome.outcome === "recorded" ? d.outcome.caseId : ""));
    // Idle is judged by the time passed in: 31 days on, the recent one had mail 10 days before that.
    const later = new Date(Date.now() + 31 * 24 * 60 * MINUTE);
    await pool.query(`update support_cases set last_inbound_at = now() + interval '21 days' where id = $1`, [ids[1]]);
    const sent = (await pool.query(`select count(*)::int as n from billing_notices`)).rows[0].n;

    const now = new Date();
    // Other tests' cases share the database; each row is checked below.
    expect((await runUnmatchedEmailRetention(later)).closed).toBeGreaterThanOrEqual(1);
    expect(await caseRow(ids[0]!)).toMatchObject({ state: "closed", closed_reason: "no_further_reply" });
    expect((await caseRow(ids[1]!)).state).not.toBe("closed");
    expect((await caseRow(ids[2]!)).state).not.toBe("closed");
    // Silently: nothing queued to anyone.
    expect((await pool.query(`select count(*)::int as n from billing_notices`)).rows[0].n).toBe(sent);

    // Closed 29 days ago by the database's clock: kept. Closed 31 days ago: the case and its messages go.
    const day = 24 * 60 * MINUTE;
    const kept = await deliver(store, "clinic-normal.eml", stranger("kept"));
    const old = await deliver(store, "clinic-normal.eml", stranger("old"));
    const [keptId, oldId] = [kept, old].map((d) => (d.outcome.outcome === "recorded" ? d.outcome.caseId : ""));
    await closeSupportCase(keptId!, "spam", new Date(Date.now() - 29 * day));
    await closeSupportCase(oldId!, "not_a_clinic", new Date(Date.now() - 31 * day));
    // A clinic's closed case of the same age stays: it goes with the clinic.
    await closeSupportCase(ids[2]!, "replied_by_hand", new Date(Date.now() - 31 * day));
    expect((await runUnmatchedEmailRetention(now)).deleted).toBeGreaterThanOrEqual(1);
    expect(await caseRow(oldId!)).toBeUndefined();
    expect(await emailMessages(oldId!)).toHaveLength(0);
    expect(await caseRow(keptId!)).toBeDefined();
    expect(await caseRow(ids[2]!)).toBeDefined();
    // A time in the future brings nothing forward: the first case closed "31 days on" is still kept today.
    await runUnmatchedEmailRetention(new Date(Date.now() + 90 * day));
    expect(await caseRow(ids[0]!)).toBeDefined();
  }, 60_000);

  test("the database refuses words on an inbound email, and an email row without SES's id", async () => {
    const store = memoryMailStore();
    const { outcome } = await deliver(store, "prospect.eml", {});
    if (outcome.outcome !== "recorded") throw new Error("not recorded");
    const pool = getMigratorPool();
    await expect(
      pool.query(
        `insert into support_messages (case_id, direction, kind, inbound_mail_id, sender_ref, fields_json, received_at, text)
         values ($1, 'in', 'email', 'sesx1', repeat('a', 64), '{"source":"email"}', now(), 'words')`,
        [outcome.caseId],
      ),
    ).rejects.toThrow(/support_messages_email_check/);
    await expect(
      pool.query(
        `insert into support_messages (case_id, direction, kind, sender_ref, fields_json, received_at)
         values ($1, 'in', 'email', repeat('a', 64), '{"source":"email"}', now())`,
        [outcome.caseId],
      ),
    ).rejects.toThrow(/support_messages_email_check/);
    await expect(
      pool.query(
        `insert into support_messages (case_id, direction, kind, inbound_mail_id, sender_ref, fields_json, received_at, attachments_json)
         values ($1, 'in', 'email', 'sesx2', repeat('a', 64), '{"source":"email"}', now(), '{"name":"Scan.pdf"}')`,
        [outcome.caseId],
      ),
    ).rejects.toThrow(/support_messages_email_check/);
    for (const bad of ["<https://x.example/y>", `<${"a".repeat(240)}@b.test>`, "<a b@c.test>"]) {
      await expect(
        pool.query(
          `insert into support_messages (case_id, direction, kind, inbound_mail_id, sender_ref, fields_json, received_at, message_id)
           values ($1, 'in', 'email', 'sesx3', repeat('a', 64), '{"source":"email"}', now(), $2)`,
          [outcome.caseId, bad],
        ),
        bad,
      ).rejects.toThrow(/support_messages_email_ids_check/);
    }
  });
});
