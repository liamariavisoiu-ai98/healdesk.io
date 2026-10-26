import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { handleInboundNotice } from "@/lib/support/inbound/handle";
import type { InboundNotice } from "@/lib/support/inbound/notice";
import { sweepInboundMail } from "@/lib/support/inbound/sweep";
import { EMAIL_CHECK_ID } from "@/lib/support/draft/checks";
import { draftNextCase, type DraftModelClient } from "@/lib/support/draft/run";
import { queueRegeneration } from "@/lib/support/draft/store";
import { READ_TOOL_NAMES } from "@/lib/support/draft/tools";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { memoryMailStore } from "./setup/inbound-mail";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The support drafter reads a clinic's email (lane P7h; owner, 26 October
 * 2026; drizzle/0131), against the real database with a fake model and the
 * bucket held in memory. The owner's rule: nothing of the email is kept; the
 * drafter reads it in memory, keeps nothing of it, and proposes a reply for ops approval.
 *
 *   - the handler leaves a clinic's message in the bucket, its key on the
 *     facts-only row; the draft job gives the model the subject and body as
 *     written (no masking: the owner's decision), inside the <email> block,
 *     and never the display name or an attachment's name;
 *   - the object is deleted and its key cleared on every outcome: a draft,
 *     a model failure, a timeout, a message that cannot be parsed, and a
 *     draft that fails a check (which is then not stored, only the checks'
 *     names);
 *   - sentinels planted in the subject, the body, the display name and the
 *     attachments' names are searched for in every column of every row of
 *     every table, and in every console line the run wrote: found only in
 *     what the fake model received;
 *   - the sweep deletes a waiting object after six hours and clears its key;
 *     the key can only ever be cleared.
 *
 * Fixed clock throughout. No AWS, no vendor call.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const BUCKET = "healdesk-test-inbound-mail-p7h";
const NOW = new Date("2026-10-27T15:00:00Z");
const HOUR = 60 * 60 * 1000;
const PASS = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" } as const;
const BY_WEDNESDAY = "Hi, a person at healdesk will reply with the next step by Wednesday.";
const REPLY_BY_FACT = { tool: "get_case_history", field: "A person replies by", value: "Wednesday 28 October 2026" };

const SUBJECT_SENTINEL = "quokkasubjectmark";
const BODY_SENTINEL = "quokkabodymark";
const NAME_SENTINEL = "quokkanamemark";
const FILE_SENTINEL = "quokkafilemark";
const SENTINELS = [SUBJECT_SENTINEL, BODY_SENTINEL, NAME_SENTINEL, FILE_SENTINEL];
const STRANGER_NUMBER = "415-555-0199";

function email(from: string, id: string, subjectExtra = ""): string {
  return [
    `From: "${NAME_SENTINEL} Front Desk" <${from}>`,
    "To: support@healdesk.io",
    `Subject: Calls ring out ${SUBJECT_SENTINEL}${subjectExtra}`,
    "Date: Tue, 27 Oct 2026 14:00:00 +0000",
    `Message-ID: <drafter-${id}@mail.example-clinic.test>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Hi, ${BODY_SENTINEL} here. Since this morning our calls ring out and nobody answers, a caller on ${STRANGER_NUMBER} told us. Can you check the forwarding for us please today?`,
    "--mix",
    `Content-Type: image/png; name="${FILE_SENTINEL}.png"`,
    `Content-Disposition: attachment; filename="${FILE_SENTINEL}.png"`,
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgo=",
    "--mix--",
    "",
  ].join("\r\n");
}

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function use(name: string, input: unknown = {}): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name, input } as Anthropic.ToolUseBlock;
}

/** Reads every tool, then proposes `reply(firstRequestText)`. Records every request. */
class FakeDrafter implements DraftModelClient {
  readonly requests: string[] = [];
  constructor(
    private readonly reply: (prompt: string) => string,
    private readonly extra: { facts?: { tool: string; field: string; value: string }[]; questions?: string[] } = {},
  ) {}
  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.requests.push(JSON.stringify(params));
    if (this.requests.length % 2 === 1) return message(READ_TOOL_NAMES.map((name) => use(name)), "tool_use");
    const first = params.messages[0]!.content as string;
    return message(
      [
        use("propose_reply", {
          category: "forwarding",
          symptom: "calls_ring_out",
          urgency: "today",
          handoff_reasons: [],
          reply: this.reply(first).slice(0, 3_900),
          facts_used: this.extra.facts ?? [REPLY_BY_FACT],
          questions_for_ops: this.extra.questions ?? [],
          confidence: "medium",
        }),
      ],
      "tool_use",
    );
  }
}

/** A model that fails with an error whose message carries its prompt: nothing of it may be logged. */
function failing(name: string): DraftModelClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async create(params) {
      requests.push(JSON.stringify(params));
      const error = new Error(`upstream failed for ${JSON.stringify(params.messages)}`);
      error.name = name;
      throw error;
    },
  };
}

const lines: string[] = [];

async function sentinelsInDatabase(): Promise<string[]> {
  const pool = getMigratorPool();
  const tables = (
    await pool.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`,
    )
  ).rows;
  const found: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const t of tables) {
      await client.query("savepoint s");
      try {
        for (const sentinel of SENTINELS) {
          const { rows } = await client.query<{ n: number }>(
            `select count(*)::int as n from "${t.schema}"."${t.name}" x where lower(x::text) like $1`,
            [`%${sentinel}%`],
          );
          if (rows[0]!.n > 0) found.push(`${t.schema}.${t.name}:${sentinel}`);
        }
        await client.query("release savepoint s");
      } catch {
        await client.query("rollback to savepoint s");
      }
    }
    await client.query("rollback");
  } finally {
    client.release();
  }
  return found;
}

function sentinelsInLogs(): string[] {
  return SENTINELS.filter((s) => lines.some((l) => l.toLowerCase().includes(s)));
}

describeDb("the support drafter reads a clinic's email (drizzle/0131)", () => {
  let clinic: PortalClinic;
  let seq = 0;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("p7hdraft", { plan: "voice-webchat-500-300" });
  }, 240_000);

  beforeEach(async () => {
    vi.stubEnv("HEALDESK_INBOUND_MAIL_BUCKET", BUCKET);
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    lines.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(" "));
      });
    }
    // One open case per test: close what the last left.
    await getMigratorPool().query(`update support_cases set state = 'closed', closed_at = $1, closed_reason = 'no_reply_needed' where state <> 'closed'`, [NOW]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closePools();
  });

  /** One email from the clinic's sign-in, through the handler. */
  async function deliver(store: ReturnType<typeof memoryMailStore>, at: Date = NOW, options: { drafterOn?: boolean; subjectExtra?: string } = {}) {
    seq += 1;
    const id = `p7h${String(seq).padStart(4, "0")}x`;
    store.put(`mail/${id}`, email(clinic.email, id, options.subjectExtra), at);
    const notice: InboundNotice = { sesMessageId: id, bucket: BUCKET, key: `mail/${id}`, receivedAt: at, verdicts: PASS };
    const outcome = await handleInboundNotice(notice, {
      store,
      now: at,
      allowFor: async () => ({ numbers: [], emails: [] }),
      drafterOn: async () => options.drafterOn ?? true,
    });
    if (outcome.outcome !== "recorded") throw new Error(`not recorded: ${outcome.outcome}`);
    return { id, caseId: outcome.caseId };
  }

  async function keyOf(id: string): Promise<string | null> {
    const { rows } = await getMigratorPool().query<{ k: string | null }>(`select inbound_object_key as k from support_messages where inbound_mail_id = $1`, [id]);
    return rows[0]!.k;
  }

  async function lastReply(caseId: string) {
    const { rows } = await getMigratorPool().query<{
      draft_text: string | null;
      facts_json: Record<string, unknown>;
      checks_json: { results: { id: string; ok: boolean; rule: string }[] } | null;
    }>(`select draft_text, facts_json, checks_json from support_messages where case_id = $1 and kind = 'reply' order by created_at desc, id desc limit 1`, [caseId]);
    return rows[0]!;
  }

  async function stateOf(caseId: string): Promise<string> {
    const { rows } = await getMigratorPool().query<{ state: string }>(`select state from support_cases where id = $1`, [caseId]);
    return rows[0]!.state;
  }

  test("a clinic's email to support@ waits in the bucket; the model gets its subject and body as written, never the display name or an attachment; the draft is kept; the object is deleted and its key cleared; the sentinels are nowhere else", async () => {
    const store = memoryMailStore();
    const { id, caseId } = await deliver(store);
    expect(store.objects.has(`mail/${id}`)).toBe(true);
    expect(await keyOf(id)).toBe(`mail/${id}`);

    const model = new FakeDrafter(() => BY_WEDNESDAY);
    const outcome = await draftNextCase({ client: model, now: NOW, mailStore: store }, caseId);
    expect(outcome).toMatchObject({ outcome: "drafted", failed: [] });

    const sent = model.requests.join("\n").toLowerCase();
    expect(sent).toContain(SUBJECT_SENTINEL);
    expect(sent).toContain(BODY_SENTINEL);
    // Not masked (owner, 26 October 2026).
    expect(sent).toContain(STRANGER_NUMBER);
    expect(sent).toContain("<email>");
    expect(sent).not.toContain(NAME_SENTINEL);
    expect(sent).not.toContain(FILE_SENTINEL);

    expect(store.objects.has(`mail/${id}`)).toBe(false);
    expect(store.deleted).toContain(`mail/${id}`);
    expect(await keyOf(id)).toBeNull();
    const row = await lastReply(caseId);
    expect(row.draft_text).toBe(BY_WEDNESDAY);
    expect(row.checks_json!.results.map((r) => r.id)).toContain(EMAIL_CHECK_ID);

    expect(await sentinelsInDatabase()).toEqual([]);
    expect(sentinelsInLogs()).toEqual([]);
  }, 60_000);

  test("a model that echoes its prompt: the draft fails the email check, is not stored (only the checks' names), the case needs an edit, and the object is deleted", async () => {
    const store = memoryMailStore();
    const { id, caseId } = await deliver(store);
    const model = new FakeDrafter((prompt) => prompt);
    const outcome = await draftNextCase({ client: model, now: NOW, mailStore: store }, caseId);
    expect(outcome).toMatchObject({ outcome: "needs_edit" });
    if (outcome.outcome !== "needs_edit") throw new Error("not needs_edit");
    expect(outcome.failed).toContain(EMAIL_CHECK_ID);
    expect(await stateOf(caseId)).toBe("needs_edit");
    const row = await lastReply(caseId);
    expect(row.draft_text).toBeNull();
    expect(row.facts_json).toMatchObject({ failure: "checks_failed" });
    expect(row.checks_json!.results.find((r) => r.id === EMAIL_CHECK_ID)).toMatchObject({ ok: false });
    expect(Object.keys(row.checks_json!.results[0]!).sort()).toEqual(["id", "ok", "rule"]);
    expect(store.objects.has(`mail/${id}`)).toBe(false);
    expect(await keyOf(id)).toBeNull();
    expect(await sentinelsInDatabase()).toEqual([]);
    expect(sentinelsInLogs()).toEqual([]);
  }, 60_000);

  test.each([["model failure", "APIError"], ["timeout", "APIConnectionTimeoutError"]])(
    "a %s: the case needs an edit, the object is deleted, and nothing of the email is logged",
    async (_label, name) => {
      const store = memoryMailStore();
      const { id, caseId } = await deliver(store);
      const model = failing(name);
      const outcome = await draftNextCase({ client: model, now: NOW, mailStore: store }, caseId);
      expect(outcome).toMatchObject({ outcome: "failed", reason: "model_failed" });
      expect(model.requests.join("").toLowerCase()).toContain(BODY_SENTINEL);
      expect(store.objects.has(`mail/${id}`)).toBe(false);
      expect(await keyOf(id)).toBeNull();
      expect(await sentinelsInDatabase()).toEqual([]);
      expect(sentinelsInLogs()).toEqual([]);
    },
    60_000,
  );

  test("a message that cannot be parsed when the drafter reads it: email_unreadable, no model call, the object is deleted", async () => {
    const store = memoryMailStore();
    const { id, caseId } = await deliver(store);
    // Replaced in the bucket by something the parser refuses.
    store.put(`mail/${id}`, `From: a@b.test\r\nX-Pad: ${"x".repeat(600 * 1024)}\r\nSubject: ${SUBJECT_SENTINEL}\r\n\r\nbody`);
    const model = new FakeDrafter(() => BY_WEDNESDAY);
    const outcome = await draftNextCase({ client: model, now: NOW, mailStore: store }, caseId);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "email_unreadable" });
    expect(model.requests).toHaveLength(0);
    expect(store.objects.has(`mail/${id}`)).toBe(false);
    expect(await keyOf(id)).toBeNull();
    expect(sentinelsInLogs()).toEqual([]);
  }, 60_000);

  test("a regenerated draft after the email was read: the model is told the email is gone and is never given it again", async () => {
    const store = memoryMailStore();
    const { caseId } = await deliver(store);
    await draftNextCase({ client: new FakeDrafter(() => BY_WEDNESDAY), now: NOW, mailStore: store }, caseId);
    expect(await queueRegeneration(caseId, NOW)).toMatchObject({ outcome: "queued" });
    const model = new FakeDrafter(() => BY_WEDNESDAY);
    await draftNextCase({ client: model, now: new Date(NOW.getTime() + 60_000), mailStore: store }, caseId);
    const sent = model.requests.join("\n");
    expect(sent).toContain("which is no longer held");
    expect(sent.toLowerCase()).not.toContain(BODY_SENTINEL);
  }, 60_000);

  test("the sweep leaves a waiting object younger than six hours, deletes an older one and clears its key", async () => {
    const store = memoryMailStore();
    const fresh = await deliver(store, new Date(NOW.getTime() - 1 * HOUR));
    await getMigratorPool().query(`update support_cases set state = 'closed', closed_at = $1, closed_reason = 'no_reply_needed' where id = $2`, [NOW, fresh.caseId]);
    const old = await deliver(store, new Date(NOW.getTime() - 7 * HOUR));
    const counts = await sweepInboundMail({ store, now: NOW, allowFor: async () => null });
    // The old one sat undrafted: counted apart from plain old objects.
    expect(counts).toMatchObject({ already: 1, undrafted: 1, deletedOld: 0, failed: 0 });
    expect(store.objects.has(`mail/${fresh.id}`)).toBe(true);
    expect(await keyOf(fresh.id)).toBe(`mail/${fresh.id}`);
    expect(store.objects.has(`mail/${old.id}`)).toBe(false);
    expect(await keyOf(old.id)).toBeNull();

    // A row still naming an object the lifecycle rule took first: cleared too.
    store.objects.delete(`mail/${fresh.id}`);
    const later = await sweepInboundMail({ store, now: new Date(NOW.getTime() + 6 * HOUR), allowFor: async () => null });
    expect(later.cleared).toBe(1);
    expect(await keyOf(fresh.id)).toBeNull();
  }, 60_000);

  test("with the support-draft job off, a clinic's email is deleted at once and no key is kept", async () => {
    const store = memoryMailStore();
    const { id } = await deliver(store, NOW, { drafterOn: false });
    expect(store.objects.has(`mail/${id}`)).toBe(false);
    expect(await keyOf(id)).toBeNull();
  }, 60_000);

  test("a follow-up joining a case already drafted is deleted unread: nothing waits for a draft that will not come", async () => {
    const store = memoryMailStore();
    const { caseId } = await deliver(store);
    await draftNextCase({ client: new FakeDrafter(() => BY_WEDNESDAY), now: NOW, mailStore: store }, caseId);
    expect(await stateOf(caseId)).toBe("drafted");
    const { rows } = await getMigratorPool().query<{ ref: string }>(`select ref from support_cases where id = $1`, [caseId]);
    const followUp = await deliver(store, new Date(NOW.getTime() + 60_000), { subjectExtra: ` (ref HD-${rows[0]!.ref})` });
    expect(followUp.caseId).toBe(caseId);
    expect(store.objects.has(`mail/${followUp.id}`)).toBe(false);
    expect(await keyOf(followUp.id)).toBeNull();
  }, 60_000);

  test("the model's own free words beside the reply are not kept: questions are dropped, a fact's field must be a label its tool printed", async () => {
    const store = memoryMailStore();
    const asked = await deliver(store);
    // A question carrying a patient's name and symptom: the draft is kept, the question is not.
    await draftNextCase(
      { client: new FakeDrafter(() => BY_WEDNESDAY, { questions: ["Should we ask about Maria Lopez bruising?"] }), now: NOW, mailStore: store },
      asked.caseId,
    );
    expect(await stateOf(asked.caseId)).toBe("drafted");
    expect((await lastReply(asked.caseId)).facts_json).toMatchObject({ questionsForOps: [] });

    // A fact whose field is the model's own words: the facts check fails, and nothing of the draft is kept.
    await getMigratorPool().query(`update support_cases set state = 'closed', closed_at = $1, closed_reason = 'no_reply_needed' where id = $2`, [NOW, asked.caseId]);
    const fielded = await deliver(store);
    const outcome = await draftNextCase(
      {
        client: new FakeDrafter(() => BY_WEDNESDAY, { facts: [{ ...REPLY_BY_FACT, field: "Maria Lopez bruising" }] }),
        now: NOW,
        mailStore: store,
      },
      fielded.caseId,
    );
    expect(outcome).toMatchObject({ outcome: "needs_edit" });
    if (outcome.outcome !== "needs_edit") throw new Error("not needs_edit");
    expect(outcome.failed).toContain("facts");
    expect((await lastReply(fielded.caseId)).draft_text).toBeNull();

    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from support_messages where lower(facts_json::text) like '%maria lopez%' or lower(coalesce(draft_text, '')) like '%maria lopez%'`,
    );
    expect(rows[0]!.n).toBe(0);
    expect(lines.some((l) => l.toLowerCase().includes("maria lopez"))).toBe(false);
  }, 60_000);

  test("the runtime role may clear an object key, never set or move one", async () => {
    const store = memoryMailStore();
    const { id } = await deliver(store);
    const app = getAppPool();
    await expect(app.query(`update support_messages set inbound_object_key = 'mail/someoneelse' where inbound_mail_id = $1`, [id])).rejects.toThrow();
    await app.query(`update support_messages set inbound_object_key = null where inbound_mail_id = $1`, [id]);
    expect(await keyOf(id)).toBeNull();
    await expect(app.query(`update support_messages set inbound_object_key = $2 where inbound_mail_id = $1`, [id, `mail/${id}`])).rejects.toThrow();
  }, 60_000);

  test("mail from support@ or hello@ is ours coming back: dropped, deleted, no case", async () => {
    for (const from of ["support@healdesk.io", "hello@healdesk.io"]) {
      const store = memoryMailStore();
      seq += 1;
      const id = `p7hown${seq}`;
      store.put(`mail/${id}`, email(from, id));
      const outcome = await handleInboundNotice(
        { sesMessageId: id, bucket: BUCKET, key: `mail/${id}`, receivedAt: NOW, verdicts: PASS },
        { store, now: NOW },
      );
      expect(outcome).toEqual({ outcome: "dropped", reason: "own_address" });
      expect(store.objects.has(`mail/${id}`)).toBe(false);
    }
  });
});
