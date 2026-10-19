import { URGENT_TEAM_TOLD_LINE } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as messagePost, __setWebChatDepsForTests } from "@/app/api/widget/v1/[slug]/message/route";
import { OPTIONS as startOptions, POST as startPost } from "@/app/api/widget/v1/[slug]/start/route";
import type { AssistantMessage, AssistantPrompt, AssistantResponder } from "@/lib/assistant/turn";
import { endWebChat, originAllowed, readToken, sendWebChatMessage, signToken, startWebChat, webChatClinic, type WebChatClinic } from "@/lib/chat/web-chat";
import { runTranscriptEmailsJob } from "@/lib/conversations/transcript-outbox";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { addRecipient } from "@/lib/reporting/recipients";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { ALERT_BURST_AFTER } from "@/lib/notices/booking-alerts";
import { JOB_BILLING_NOTICES, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedEntitled, setWeekdayHours } from "./setup/factories";

/**
 * The web chat (lib/chat/web-chat.ts, app/api/widget/v1): the opening line,
 * one conversation per chat, the sealed transcript row while it lasts, the
 * guard and the urgent screen around the model, one booking request, and the
 * transcript emailed when the chat ends. Synthetic clinics, a fake model.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "web-chat-test" } as const;
const WINDOW_START = new Date("2026-10-01T00:00:00Z");

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${crypto.randomUUID()}` };
  }
  transcripts() {
    return this.sent.filter((s) => s.message.phiClass === "may-carry-phi");
  }
}

type Seen = { system: AssistantPrompt; messages: AssistantMessage[] };

function scripted(answer: (last: string, seen: Seen) => Record<string, unknown> | string) {
  const seen: Seen[] = [];
  const responder: AssistantResponder = async ({ system, messages }) => {
    const entry = { system, messages };
    seen.push(entry);
    const out = answer(messages[messages.length - 1]!.content, entry);
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  return { responder, seen };
}

async function liveWebClinic(label: string, website: string | null = "radiance-chat.test"): Promise<WebChatClinic> {
  const c = await seedClinic(label);
  await bindAgreementInEffect(c.clinicId);
  await setWeekdayHours(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), website = $2 where id = $1`,
    [c.clinicId, website],
  );
  await seedEntitled(c.clinicId, { planId: "webchat-1000", planStartedAt: WINDOW_START, channelRows: [{ channel: "web", liveAt: WINDOW_START }] });
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
    await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
    await updateAgentConfig(tx, {
      greeting: "Hi",
      services: [{ name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 }],
      escalationPhone: null,
      escalationHours: "Weekdays 9 to 5",
      notes: null,
    });
    await approveAgentConfig(tx, "Dr Chen");
    await addRecipient(tx, { email: "desk@radiance-chat.test", addedBy: "test" });
  });
  const clinic = await webChatClinic(c.slug);
  if (!clinic) throw new Error("no clinic");
  return clinic;
}

/** The clinic's alerts in the outbox (lib/notices/booking-alerts.ts). */
async function alertRows(clinicId: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ kind: string; dedupe_key: string; payload: Record<string, unknown>; sent_at: Date | null }>(
      `select kind, dedupe_key, payload, sent_at from billing_notices
        where kind in ('booking_request', 'deposit_to_collect', 'handover', 'urgent', 'calendar_check')
        order by created_at`,
    ),
  );
  return rows;
}

/** An operator who can flip the sender's switch. */
async function opsUser(): Promise<string> {
  const ops = `usr_ops_${crypto.randomUUID().slice(0, 8)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
    [ops, `${ops}@healdesk.test`],
  );
  return ops;
}

/**
 * A deployment that sends: Resend configured, and no quota refusal left over
 * from another file (it lasts the UTC day), so the urgent reply may say the
 * team was told.
 */
async function resendConfigured(): Promise<void> {
  vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
  await getMigratorPool().query(`truncate email_daily_quota`);
}

/**
 * Make every insert into `table` for this clinic fail, as a pool timeout or
 * a deadlock would, until the returned function is called.
 */
async function failInserts(table: "conversations", clinicId: string): Promise<() => Promise<void>> {
  const pool = getMigratorPool();
  await pool.query(`create or replace function test_refuse_insert() returns trigger language plpgsql as $$ begin raise exception 'test: this write fails'; end $$`);
  await pool.query(`create trigger test_refuse_insert before insert on ${table} for each row when (new.clinic_id = '${clinicId}'::uuid) execute function test_refuse_insert()`);
  return async () => {
    await pool.query(`drop trigger if exists test_refuse_insert on ${table}`);
  };
}

async function transcriptRow(clinicId: string, conversationId: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ id: string; status: string; sealed: unknown; next_attempt_at: Date }>(
      `select id, status, sealed, next_attempt_at from transcript_emails where conversation_id = $1`,
      [conversationId],
    ),
  );
  return rows[0];
}

describeDb("the web chat", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'transcript-emails'`);
  }, 180_000);

  beforeEach(() => {
    __setWebChatDepsForTests(undefined);
  });

  afterAll(async () => {
    __setWebChatDepsForTests(undefined);
    await closePools();
  });

  test("opens with the locked AI line and the clinic's greeting, and stores nothing yet", async () => {
    const clinic = await liveWebClinic("chat-open");
    const start = await startWebChat(clinic);
    expect(start.mode).toBe("chat");
    if (start.mode !== "chat") return;
    expect(start.opening).toMatch(/^You're chatting with an AI assistant for chat-open Clinic\./);
    expect(start.opening).toContain("How can I help you today?");
    expect(readToken(start.token, clinic.clinicId)?.conversationId).toBeNull();
    const { rows } = await inTenant(clinic.clinicId, (client) => client.query(`select id from conversations`));
    expect(rows).toHaveLength(0);
  });

  test("a clinic that has not bought the web chat gets the contact form", async () => {
    // A production clinic with an agreement and nothing bought: the gate fails closed.
    const c = await seedClinic("chat-unbought");
    await bindAgreementInEffect(c.clinicId);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`, [c.clinicId]);
    const clinic = (await webChatClinic(c.slug))!;
    const start = await startWebChat(clinic);
    expect(start.mode).toBe("contact_form");
  });

  test("a conversation: one row, counted once, its transcript sealed while it lasts, the history passed to the model", async () => {
    const clinic = await liveWebClinic("chat-flow");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder, seen } = scripted((last) => ({ reply: last.includes("price") ? "A consultation is $150." : "We're open weekdays.", booking: {} }));
    const transport = new FakeTransport();

    const first = await sendWebChatMessage(clinic, start.token, "When are you open?", { responder, transport });
    expect(first).toMatchObject({ mode: "chat", reply: "We're open weekdays.", ended: false });
    if (first.mode !== "chat") return;
    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    expect(conversationId).toBeTruthy();

    const second = await sendWebChatMessage(clinic, first.token, "What's the price of a consultation?", { responder, transport });
    expect(second).toMatchObject({ mode: "chat", reply: "A consultation is $150." });
    if (second.mode !== "chat") return;
    expect(readToken(second.token, clinic.clinicId)!.conversationId).toBe(conversationId);

    // The model saw the whole conversation, the opening line in the system prompt.
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The opening line is the turn's own context; the menu and the never-say
    // list are the stable prefix the prompt cache holds.
    expect(seen[1]!.system.turn).toContain("You opened the conversation with");
    expect(seen[1]!.system.stable).toContain("Consultation: $150");
    expect(seen[1]!.system.stable).toContain("guaranteed results");
    expect(seen[1]!.system.stable).toBe(seen[0]!.system.stable);

    const { rows: convos } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ channel: string; disclosure_played_at: Date | null }>(`select channel, disclosure_played_at from conversations where id = $1`, [conversationId]),
    );
    expect(convos).toEqual([expect.objectContaining({ channel: "web_chat" })]);
    expect(convos[0]!.disclosure_played_at).toBeTruthy();

    const row = await transcriptRow(clinic.clinicId, conversationId);
    expect(row?.status).toBe("open");
    expect(JSON.stringify(row?.sealed)).not.toContain("consultation");

    const { rows: usage } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ n: number }>(`select count(*)::int as n from usage_events where location_clinic_id = $1 and source = 'web_chat'`, [clinic.clinicId]),
    );
    expect(usage[0]!.n).toBe(1);
    expect(transport.transcripts()).toHaveLength(0);
  });

  test("an urgent message gets the fixed line, the model never sees it, and the clinic is alerted at once", async () => {
    const clinic = await liveWebClinic("chat-urgent");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder, seen } = scripted(() => ({ reply: "model" }));
    const ops = `usr_ops_${crypto.randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
      [ops, `${ops}@healdesk.test`],
    );
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    const transport = new FakeTransport();
    try {
      const answer = await sendWebChatMessage(clinic, start.token, "I'm having a bad reaction to the filler", { responder, transport });
      if (answer.mode !== "chat") throw new Error("no chat");
      expect(answer.reply).toMatch(/call 911/);
      // This deployment sends no mail (no Resend), so the reply does not say the team was told.
      expect(answer.reply).not.toContain("I've told the team");
      expect(seen).toHaveLength(0);
      // Recorded as urgent, not only as escalated, so Conversations can tell it from a handover.
      const { rows } = await inTenant(clinic.clinicId, (client) =>
        client.query<{ id: string; outcome: string; urgent: boolean }>(`select id, outcome, urgent from conversations`),
      );
      expect(rows.map(({ outcome, urgent }) => ({ outcome, urgent }))).toEqual([{ outcome: "escalated_to_human", urgent: true }]);

      // One urgent alert, keyed on the chat, sent the moment the message committed.
      let alerts = await alertRows(clinic.clinicId);
      expect(alerts).toMatchObject([{ kind: "urgent", dedupe_key: `urgent:web:${rows[0]!.id}` }]);
      expect(alerts[0]!.sent_at).not.toBeNull();
      const mail = transport.sent.filter((s) => s.message.phiClass === "none");
      expect(mail).toHaveLength(1);
      expect(mail[0]!.message.subject).toMatch(/^Urgent: /);
      expect(JSON.stringify(mail[0]!.message)).not.toMatch(/reaction|filler/);
      expect(mail[0]!.message.text).toContain(`/conversations/${rows[0]!.id}`);

      // A second urgent message in the same chat queues and sends nothing more.
      await sendWebChatMessage(clinic, answer.token, "It's getting worse, my lips are swelling", { responder, transport });
      alerts = await alertRows(clinic.clinicId);
      expect(alerts).toHaveLength(1);
      expect(transport.sent.filter((s) => s.message.phiClass === "none")).toHaveLength(1);
    } finally {
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
    }
  });

  test("live, the urgent reply says the team was told, and the alert reaches the clinic's one address", async () => {
    const clinic = await liveWebClinic("chat-urgent-live");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "model" }));
    const ops = await opsUser();
    await resendConfigured();
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    const transport = new FakeTransport();
    try {
      const answer = await sendWebChatMessage(clinic, start.token, "I'm having a bad reaction to the filler", { responder, transport });
      if (answer.mode !== "chat") throw new Error("no chat");
      expect(answer.reply).toMatch(/call 911/);
      expect(answer.reply).toContain(URGENT_TEAM_TOLD_LINE);
      const alerts = await alertRows(clinic.clinicId);
      expect(alerts).toMatchObject([{ kind: "urgent" }]);
      expect(alerts[0]!.sent_at).not.toBeNull();
      const mail = transport.sent.filter((s) => s.message.phiClass === "none");
      expect(mail.map((m) => m.target.to)).toEqual(["chat-urgent-live@example-clinic.test"]);
    } finally {
      vi.unstubAllEnvs();
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
    }
  });

  test("an urgent message whose record fails still gets the fixed urgent reply, without saying the team was told", async () => {
    const clinic = await liveWebClinic("chat-urgent-failed");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "model" }));
    const ops = await opsUser();
    await resendConfigured();
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = await failInserts("conversations", clinic.clinicId);
    try {
      const answer = await sendWebChatMessage(clinic, start.token, "I'm having a bad reaction to the filler", { responder });
      if (answer.mode !== "chat") throw new Error("no chat");
      expect(answer.reply).toMatch(/call 911/);
      expect(answer.reply).toMatch(/Otherwise, please call chat-urgent-failed Clinic on \S/);
      expect(answer.reply).not.toContain(URGENT_TEAM_TOLD_LINE);
      expect(answer.reply).not.toMatch(/trouble on my end/);
      // Nothing was recorded, the alert included.
      expect(await alertRows(clinic.clinicId)).toEqual([]);
      expect(error.mock.calls.map((c) => String(c[0]))).toEqual(
        expect.arrayContaining([expect.stringContaining("web chat urgent message not recorded")]),
      );
      // An ordinary message still gets the failure line.
      const plain = await sendWebChatMessage(clinic, start.token, "When are you open?", { responder });
      expect(plain.mode === "chat" && plain.reply).toMatch(/trouble on my end/);
    } finally {
      await restore();
      error.mockRestore();
      vi.unstubAllEnvs();
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
    }
  });

  test(`urgent chats are never capped: past ${ALERT_BURST_AFTER} in an hour, each still goes to the clinic at once as its own email`, async () => {
    const clinic = await liveWebClinic("chat-urgent-flood");
    const { responder } = scripted(() => ({ reply: "model" }));
    const ops = await opsUser();
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    const transport = new FakeTransport();
    const chats = ALERT_BURST_AFTER + 3;
    try {
      for (let i = 0; i < chats; i += 1) {
        const start = await startWebChat(clinic);
        if (start.mode !== "chat") throw new Error("no chat");
        const answer = await sendWebChatMessage(clinic, start.token, "I'm having a bad reaction to the filler", { responder, transport });
        expect(answer.mode === "chat" && answer.reply).toMatch(/call 911/);
      }
      // The spec: urgent messages reach the clinic immediately. One email a
      // chat, each sent as its chat committed, each opening its own chat.
      const mail = transport.sent.filter((s) => s.message.phiClass === "none");
      expect(mail).toHaveLength(chats);
      expect(new Set(mail.map((m) => m.message.subject))).toEqual(new Set(["Urgent: someone wrote something urgent in your website chat"]));
      const { rows } = await inTenant(clinic.clinicId, (client) => client.query<{ n: number }>(`select count(*)::int as n from conversations where urgent`));
      expect(rows[0]!.n).toBe(chats);
    } finally {
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
    }
  });

  test("a request for a person with a name and a number: the conversation names them, so the alert's link shows who", async () => {
    const clinic = await liveWebClinic("chat-handover-contact");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({
      reply: "Thanks Ana, the team will get back to you within a day.",
      handoff: true,
      booking: { first_name: "Ana", phone: "415 555 0101" },
    }));
    const answer = await sendWebChatMessage(clinic, start.token, "Can I speak to a real person? I'm Ana, 415 555 0101", { responder });
    if (answer.mode !== "chat") throw new Error("no chat");
    const conversationId = readToken(answer.token, clinic.clinicId)!.conversationId!;
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ phone: string; full_name: string | null; outcome: string }>(
        `select c.phone, c.full_name, v.outcome from conversations v join contacts c on c.id = v.contact_id where v.id = $1`,
        [conversationId],
      ),
    );
    expect(rows).toEqual([{ phone: "+14155550101", full_name: "Ana", outcome: "escalated_to_human" }]);
    // No booking request: no time was given.
    expect((await inTenant(clinic.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(0);
    expect(await alertRows(clinic.clinicId)).toMatchObject([{ kind: "handover", payload: { conversationId } }]);
  });

  test("a request for a person alerts the clinic once, and the chat stays escalated after an ordinary message", async () => {
    const clinic = await liveWebClinic("chat-handover");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted((last) =>
      last.includes("person") ? { reply: "Of course: the team will get back to you.", handoff: true } : { reply: "We're open weekdays." },
    );
    const first = await sendWebChatMessage(clinic, start.token, "Can I talk to a real person?", { responder });
    if (first.mode !== "chat") throw new Error("no chat");
    const second = await sendWebChatMessage(clinic, first.token, "A person please", { responder });
    if (second.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, second.token, "And when are you open?", { responder });

    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    const alerts = await alertRows(clinic.clinicId);
    expect(alerts).toMatchObject([
      { kind: "handover", dedupe_key: `handover:web:${conversationId}`, payload: { channel: "web", conversationId } },
    ]);
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ outcome: string; urgent: boolean }>(`select outcome, urgent from conversations`),
    );
    expect(rows).toEqual([{ outcome: "escalated_to_human", urgent: false }]);
  });

  test("a card number is cut from the transcript and never reaches the model", async () => {
    const clinic = await liveWebClinic("chat-card");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder, seen } = scripted(() => ({ reply: "model" }));
    const transport = new FakeTransport();
    const answer = await sendWebChatMessage(clinic, start.token, "my card is 4242 4242 4242 4242", { responder, transport });
    expect(seen).toHaveLength(0);
    if (answer.mode !== "chat") throw new Error("no chat");
    expect(answer.reply).toMatch(/don't share card details/);
    await endWebChat(clinic, answer.token, { transport });
    const email = transport.transcripts()[0]!.message.text;
    expect(email).not.toContain("4242 4242");
    expect(email).toContain("[card number removed]");
  });

  test("a language saved before the screens read it is never answered in: the prompt offers only English and Spanish", async () => {
    const clinic = await liveWebClinic("chat-languages");
    // The database still accepts the older list; the engine reads it through SCREENED_LANGUAGES.
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, languages) values ($1, '{en,fr,es}')
         on conflict (clinic_id) do update set languages = excluded.languages`,
        [clinic.clinicId],
      ),
    );
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder, seen } = scripted(() => ({ reply: "We're open weekdays." }));
    await sendWebChatMessage(clinic, start.token, "When are you open?", { responder });
    expect(seen[0]!.system.stable).toContain("Languages: you answer in English and Spanish.");
    expect(seen[0]!.system.stable).not.toContain("French");
  });

  test("the guard replaces an off-menu price and a never-say phrase", async () => {
    const clinic = await liveWebClinic("chat-guard");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const priced = scripted(() => ({ reply: "Lip filler is $650." }));
    const a = await sendWebChatMessage(clinic, start.token, "How much is lip filler?", { responder: priced.responder });
    expect(a.mode === "chat" && a.reply).toMatch(/consultation/);
    expect(a.mode === "chat" && a.reply).not.toContain("$650");
    const promised = scripted(() => ({ reply: "It's completely safe and painless!" }));
    const b = await sendWebChatMessage(clinic, start.token, "Is it safe?", { responder: promised.responder });
    expect(b.mode === "chat" && b.reply).not.toMatch(/completely safe|painless/i);
  });

  test("a complete request becomes one booking request on the web chat channel, and the clinic one pointer to it", async () => {
    const clinic = await liveWebClinic("chat-request");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const booking = { wants: true, first_name: "Dana", phone: "415 555 0192", window: "Thursday afternoon", service: "Consultation" };
    const { responder } = scripted(() => ({ reply: "Thanks Dana, the team will confirm Thursday afternoon within a day.", booking }));
    const transport = new FakeTransport();
    const first = await sendWebChatMessage(clinic, start.token, "Dana, 415 555 0192, Thursday afternoon please", { responder, transport });
    if (first.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, first.token, "Thanks!", { responder, transport });
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ channel: string; preferred_window: string; platform: string | null }>(`select channel, preferred_window, platform from booking_requests`),
    );
    expect(rows).toEqual([{ channel: "web_chat", preferred_window: "Thursday afternoon", platform: null }]);
    // The clinic's alert (L7) is queued with the request, for the outbox to
    // send to the clinic's one address: nothing is mailed to the report
    // recipients, and no link to the single-use /booking/ page goes anywhere.
    expect(transport.sent.filter((s) => s.message.phiClass !== "may-carry-phi")).toEqual([]);
    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    const alerts = await alertRows(clinic.clinicId);
    expect(alerts).toMatchObject([{ kind: "booking_request", payload: { channel: "web", conversationId } }]);
    expect(JSON.stringify(alerts)).not.toMatch(/Dana|0192|Thursday|Consultation|\/booking\//);
  });

  test("ending the chat sends the transcript to the clinic, and the next message starts a new conversation", async () => {
    const clinic = await liveWebClinic("chat-end");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "Happy to help." }));
    const transport = new FakeTransport();
    const first = await sendWebChatMessage(clinic, start.token, "Do you have parking?", { responder, transport });
    if (first.mode !== "chat") throw new Error("no chat");
    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    expect(await endWebChat(clinic, first.token, { transport })).toBe(true);
    expect(transport.transcripts()).toHaveLength(1);
    const email = transport.transcripts()[0]!.message.text;
    expect(email).toContain("Visitor: Do you have parking?");
    expect(email).toContain("Assistant: You're chatting with an AI assistant");
    expect((await transcriptRow(clinic.clinicId, conversationId))?.status).toBe("sent");
    expect(await endWebChat(clinic, first.token, { transport })).toBe(false);

    const again = await sendWebChatMessage(clinic, first.token, "One more thing", { responder, transport });
    if (again.mode !== "chat") throw new Error("no chat");
    expect(readToken(again.token, clinic.clinicId)!.conversationId).not.toBe(conversationId);
  });

  test("after thirty quiet minutes the job sends it, and a late message starts a new conversation", async () => {
    const clinic = await liveWebClinic("chat-quiet");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "Sure." }));
    const transport = new FakeTransport();
    const first = await sendWebChatMessage(clinic, start.token, "Hello", { responder, transport });
    if (first.mode !== "chat") throw new Error("no chat");
    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    await inTenant(clinic.clinicId, (client) =>
      client.query(`update transcript_emails set next_attempt_at = now() - interval '1 second' where conversation_id = $1`, [conversationId]),
    );
    const late = await sendWebChatMessage(clinic, first.token, "Still there?", { responder, transport });
    if (late.mode !== "chat") throw new Error("no chat");
    expect(readToken(late.token, clinic.clinicId)!.conversationId).not.toBe(conversationId);

    await runTranscriptEmailsJob({ transport });
    expect((await transcriptRow(clinic.clinicId, conversationId))?.status).toBe("sent");
    expect(transport.transcripts().some((t) => t.message.text.includes("Visitor: Hello"))).toBe(true);
  });

  test("an open chat's copy can change only while it is open", async () => {
    const clinic = await liveWebClinic("chat-immutable");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "Sure." }));
    const transport = new FakeTransport();
    const first = await sendWebChatMessage(clinic, start.token, "Hello", { responder, transport });
    if (first.mode !== "chat") throw new Error("no chat");
    const conversationId = readToken(first.token, clinic.clinicId)!.conversationId!;
    await endWebChat(clinic, first.token, { transport });
    await expect(
      inTenant(clinic.clinicId, (client) => client.query(`update transcript_emails set sealed = '{}'::jsonb where conversation_id = $1`, [conversationId])),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      inTenant(clinic.clinicId, (client) => client.query(`update transcript_emails set status = 'open' where conversation_id = $1`, [conversationId])),
    ).rejects.toThrow(/never reopened/);
  });

  test("a forged or foreign token is refused", async () => {
    const clinic = await liveWebClinic("chat-token");
    const other = await liveWebClinic("chat-token-other");
    const start = await startWebChat(other);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder } = scripted(() => ({ reply: "x" }));
    expect(await sendWebChatMessage(clinic, start.token, "hi", { responder })).toEqual({ mode: "invalid", reason: "token" });
    const [body] = start.token.split(".");
    expect(await sendWebChatMessage(other, `${body}.AAAA`, "hi", { responder })).toEqual({ mode: "invalid", reason: "token" });
    const old = signToken({ clinicId: other.clinicId, conversationId: null, sessionId: "s", issuedAt: Date.now() - 13 * 60 * 60 * 1000 });
    expect(await sendWebChatMessage(other, old, "hi", { responder })).toEqual({ mode: "invalid", reason: "token" });
  });

  test("the routes answer the clinic's own website only", async () => {
    const clinic = await liveWebClinic("chat-cors");
    const slug = (await getMigratorPool().query<{ slug: string }>(`select slug from clinics where id = $1`, [clinic.clinicId])).rows[0]!.slug;
    const params = { params: Promise.resolve({ slug }) };
    const req = (origin: string, body: unknown = {}) =>
      new Request(`https://app.healdesk.test/api/widget/v1/${slug}/start`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

    const ok = await startPost(req("https://www.radiance-chat.test"), params);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://www.radiance-chat.test");
    const started = (await ok.json()) as { mode: string; token: string };
    expect(started.mode).toBe("chat");

    const refused = await startPost(req("https://evil.test"), params);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();

    const pre = await startOptions(new Request(`https://app.healdesk.test/api/widget/v1/${slug}/start`, { method: "OPTIONS", headers: { origin: "https://radiance-chat.test" } }), params);
    expect(pre.status).toBe(204);

    const { responder } = scripted(() => ({ reply: "Hello from the clinic." }));
    __setWebChatDepsForTests({ responder });
    const message = await messagePost(
      new Request(`https://app.healdesk.test/api/widget/v1/${slug}/message`, {
        method: "POST",
        headers: { origin: "https://radiance-chat.test", "content-type": "application/json" },
        body: JSON.stringify({ token: started.token, text: "hi" }),
      }),
      params,
    );
    expect(message.status).toBe(200);
    expect(await message.json()).toMatchObject({ mode: "chat", reply: "Hello from the clinic." });

    const missing = await startPost(req("https://radiance-chat.test"), { params: Promise.resolve({ slug: "no-such-clinic" }) });
    expect(missing.status).toBe(404);
  });
});

describe("originAllowed", () => {
  test("the clinic's own host, www, subdomains, https only; localhost over http", () => {
    expect(originAllowed("https://radiance.test", "radiance.test/book")).toBe(true);
    expect(originAllowed("https://www.radiance.test", "radiance.test")).toBe(true);
    expect(originAllowed("https://book.radiance.test", "www.radiance.test")).toBe(true);
    expect(originAllowed("http://radiance.test", "radiance.test")).toBe(false);
    expect(originAllowed("https://radiance.test.evil.test", "radiance.test")).toBe(false);
    expect(originAllowed("https://notradiance.test", "radiance.test")).toBe(false);
    expect(originAllowed(null, "radiance.test")).toBe(false);
    expect(originAllowed("http://localhost:5173", "radiance.test")).toBe(true);
    expect(originAllowed(null, null)).toBe(true);
  });
});
