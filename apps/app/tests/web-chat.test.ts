import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as messagePost, __setWebChatDepsForTests } from "@/app/api/widget/v1/[slug]/message/route";
import { OPTIONS as startOptions, POST as startPost } from "@/app/api/widget/v1/[slug]/start/route";
import type { AssistantMessage, AssistantPrompt, AssistantResponder } from "@/lib/assistant/turn";
import { endWebChat, originAllowed, readToken, sendWebChatMessage, signToken, startWebChat, webChatClinic, type WebChatClinic } from "@/lib/chat/web-chat";
import { runTranscriptEmailsJob } from "@/lib/conversations/transcript-outbox";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { addRecipient } from "@/lib/reporting/recipients";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, queuedNotices, seedClinic, seedEntitled, setWeekdayHours } from "./setup/factories";

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

  test("an urgent message gets the fixed line, and the model never sees it", async () => {
    const clinic = await liveWebClinic("chat-urgent");
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const { responder, seen } = scripted(() => ({ reply: "model" }));
    const answer = await sendWebChatMessage(clinic, start.token, "I'm having a bad reaction to the filler", { responder });
    expect(answer.mode === "chat" && answer.reply).toMatch(/call 911/);
    expect(seen).toHaveLength(0);
    // Recorded as urgent, not only as escalated, so Conversations can tell it from a handover.
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ outcome: string; urgent: boolean }>(`select outcome, urgent from conversations`),
    );
    expect(rows).toEqual([{ outcome: "escalated_to_human", urgent: true }]);
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

  test("a complete request becomes one booking request on the web chat channel, and the clinic's alert is queued, not mailed to the desk", async () => {
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
    // notifyDesk is retired: nothing goes to the report recipient. The clinic
    // gets L7 through the outbox, once, a pointer that names nobody.
    expect(transport.sent.filter((s) => s.message.phiClass !== "may-carry-phi")).toEqual([]);
    const alerts = await queuedNotices(clinic.clinicId, ["booking_request"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ channel: "web" });
    expect(JSON.stringify(alerts[0]!.payload)).not.toMatch(/Dana|0192|Thursday|Consultation/);
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
