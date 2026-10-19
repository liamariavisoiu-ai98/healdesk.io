import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { auth } from "@/lib/auth";
import { sendWebChatMessage, startWebChat, webChatClinic, type WebChatClinic } from "@/lib/chat/web-chat";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { raiseHandover } from "@/lib/handovers/record";
import { attachMetaChannel, setMetaFrontDoor } from "@/lib/meta/channels";
import { answerFrontDoor, type FrontDoorResponder } from "@/lib/meta/front-door";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { purgeClinic } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";
import { createVoiceServer } from "@/voice/server";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, queuedNotices, seedClinic, seedEntitled, setWeekdayHours } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Handovers (drizzle/0085, lib/handovers/record.ts): someone who asked AYA
 * for a person, on any channel, is kept for Bookings' Needs you until the
 * desk marks it handled, and the clinic is alerted (L11).
 *
 * - Each channel's own path records one, once per conversation: a call
 *   (linked to its conversation when the call ends), a web chat (with the
 *   number the visitor gives, on the conversation's contact), and a Meta
 *   thread (by its keyed reference, and never for a message the screen
 *   refused).
 * - The table holds no words, isolates tenants, takes no row it was not
 *   asked for open, is handled once and never reopened, and goes with the
 *   conversation or thread it points at, and at the record clock.
 * - Bookings lists the open ones behind the passkey step-up with one access
 *   row naming them, and "Mark handled" writes the device and the passkey.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return { NavigationSignal, headers: new Headers() };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
  useParams: () => null,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/app/c/[slug]/PatientPageGuard", async () => {
  const { createElement } = await import("react");
  return {
    PatientPageGuard: (props: { slug: string; children: unknown }) =>
      createElement("div", { "data-guard": props.slug }, props.children as never),
  };
});

const { default: BookingsPage } = await import("@/app/c/[slug]/bookings/page");
const { markHandover } = await import("@/app/c/[slug]/bookings/handover-actions");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "handover-test" } as const;
const SECRET = "test-retell-llm-secret-handovers-0123";
const DAY = 86_400_000;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${randomUUID()}` };
  }
}

type HandoverRow = {
  id: string;
  channel: string;
  platform: string | null;
  external_call_id: string | null;
  conversation_id: string | null;
  party_ref: string | null;
  meta_conversation_id: string | null;
  handled_at: Date | null;
  handled_by_label: string | null;
  handled_by_user_id: string | null;
};

async function handoverRows(clinicId: string): Promise<HandoverRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<HandoverRow>(
      `select id, channel, platform, external_call_id, conversation_id, party_ref, meta_conversation_id,
              handled_at, handled_by_label, handled_by_user_id
         from handovers order by created_at, id`,
    );
    return rows;
  });
}

/** As the runtime role, inside a tenant (or none), rolled back. */
async function asApp<T>(clinicId: string | null, fn: (q: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn((text, values) => client.query(text, values as unknown[]));
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function conversationRow(clinicId: string, opts: { channel: "voice" | "web_chat"; callId?: string; contactId?: string | null }): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into conversations (clinic_id, channel, started_at, external_call_id, contact_id)
       values ($1, $2, now(), $3, $4) returning id`,
      [clinicId, opts.channel, opts.callId ?? null, opts.contactId ?? null],
    );
    return rows[0]!.id;
  });
}

async function threadRow(clinicId: string, platform: string): Promise<{ partyRef: string; conversationId: string }> {
  const partyRef = randomBytes(16).toString("hex");
  const conversationId = randomUUID();
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
       values ($1, $2, $3, $4, now(), now())`,
      [clinicId, platform, partyRef, conversationId],
    ),
  );
  return { partyRef, conversationId };
}

function raise(clinicId: string, ref: Parameters<typeof raiseHandover>[1]): Promise<void> {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => raiseHandover(tx, ref));
}

describeDb("handovers: the table", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("a web chat's handover is kept once, with one L11 pointer and an audit row naming no one", async () => {
    const c = await seedClinic("handover-web");
    const conversationId = await conversationRow(c.clinicId, { channel: "web_chat" });
    await raise(c.clinicId, { channel: "web_chat", conversationId });
    await raise(c.clinicId, { channel: "web_chat", conversationId });
    const rows = await handoverRows(c.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "web_chat", conversation_id: conversationId, handled_at: null });
    const notices = await queuedNotices(c.clinicId, ["handover"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.dedupe_key).toBe(`handover:conversation:${conversationId}`);
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ resource_id: string; metadata: Record<string, unknown> }>(
        `select resource_id, metadata from audit_log where resource_type = 'handover'`,
      ),
    );
    expect(audit.rows).toEqual([{ resource_id: rows[0]!.id, metadata: { channel: "web_chat" } }]);
  });

  test("a call's handover carries the call id until its conversation is written, then goes with it", async () => {
    const c = await seedClinic("handover-voice");
    await raise(c.clinicId, { channel: "voice", callId: "call_link_1" });
    expect((await handoverRows(c.clinicId))[0]).toMatchObject({ channel: "voice", external_call_id: "call_link_1", conversation_id: null });
    // The ingest writes the call's conversation as the runtime role: the database links it.
    const client = await getAppPool().connect();
    let conversationId: string;
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const { rows } = await client.query<{ id: string }>(
        `insert into conversations (clinic_id, channel, started_at, external_call_id) values ($1, 'voice', now(), 'call_link_1') returning id`,
        [c.clinicId],
      );
      conversationId = rows[0]!.id;
      await client.query("commit");
    } finally {
      client.release();
    }
    expect((await handoverRows(c.clinicId))[0]!.conversation_id).toBe(conversationId);
    // A retried raise on a call already written links at once, and adds nothing.
    await raise(c.clinicId, { channel: "voice", callId: "call_link_1" });
    expect(await handoverRows(c.clinicId)).toHaveLength(1);
    await inTenant(c.clinicId, (q) => q.query(`delete from conversations where id = $1`, [conversationId]));
    expect(await handoverRows(c.clinicId)).toEqual([]);
  });

  test("a Meta handover goes with its thread", async () => {
    const c = await seedClinic("handover-thread");
    const thread = await threadRow(c.clinicId, "instagram");
    await raise(c.clinicId, { channel: "meta", platform: "instagram", partyRef: thread.partyRef, metaConversationId: thread.conversationId });
    expect(await handoverRows(c.clinicId)).toHaveLength(1);
    await inTenant(c.clinicId, (q) => q.query(`delete from chat_threads where party_ref = $1`, [thread.partyRef]));
    expect(await handoverRows(c.clinicId)).toEqual([]);
  });

  test("tenants are isolated, nothing is seen without one, and the row is asked open, handled once and never rewritten", async () => {
    const a = await seedClinic("handover-rls-a");
    const b = await seedClinic("handover-rls-b");
    const conversationId = await conversationRow(a.clinicId, { channel: "web_chat" });
    await raise(a.clinicId, { channel: "web_chat", conversationId });
    const [row] = await handoverRows(a.clinicId);

    expect(await asApp(b.clinicId, async (q) => (await q(`select id from handovers`)).rows)).toEqual([]);
    expect(await asApp(null, async (q) => (await q(`select id from handovers`)).rows)).toEqual([]);
    // Another tenant cannot mark it, or write one under A.
    expect(await asApp(b.clinicId, async (q) => (await q(`update handovers set handled_at = now(), handled_by_label = 'x', handled_by_user_id = 'u' where id = $1 returning id`, [row!.id])).rows)).toEqual([]);
    await expect(
      asApp(b.clinicId, (q) => q(`insert into handovers (clinic_id, channel, conversation_id) values ($1, 'web_chat', $2)`, [a.clinicId, conversationId])),
    ).rejects.toThrow(/row-level security/);
    // What was asked is the runtime role's to read, never to rewrite.
    await expect(asApp(a.clinicId, (q) => q(`update handovers set channel = 'voice' where id = $1`, [row!.id]))).rejects.toThrow(/permission denied/);
    // Recorded open.
    const another = await conversationRow(a.clinicId, { channel: "web_chat" });
    await expect(
      asApp(a.clinicId, (q) =>
        q(`insert into handovers (clinic_id, channel, conversation_id, handled_at, handled_by_label, handled_by_user_id) values ($1, 'web_chat', $2, now(), 'x', 'u')`, [a.clinicId, another]),
      ),
    ).rejects.toThrow(/recorded open/);
    // Handled once, at the database's clock; never reopened, even by the owner.
    await inTenant(a.clinicId, (q) =>
      q.query(`update handovers set handled_at = '2001-01-01', handled_by_label = 'Front desk', handled_by_user_id = 'u1' where id = $1`, [row!.id]),
    );
    const [handled] = await handoverRows(a.clinicId);
    expect(handled!.handled_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await expect(inTenant(a.clinicId, (q) => q.query(`update handovers set handled_at = null, handled_by_label = null, handled_by_user_id = null where id = $1`, [row!.id]))).rejects.toThrow(/never reopened/);
    await expect(inTenant(a.clinicId, (q) => q.query(`update handovers set created_at = now() - interval '1 day' where id = $1`, [row!.id]))).rejects.toThrow(/never rewritten/);
  });

  test("the record clock deletes a handover its conversation did not take with it", async () => {
    const c = await seedClinic("handover-purge");
    await raise(c.clinicId, { channel: "voice", callId: "call_never_written" });
    const kept = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, new Date()));
    expect(kept.handoversDeleted).toBe(0);
    const gone = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => purgeClinic(tx, new Date(Date.now() + 400 * DAY)));
    expect(gone.handoversDeleted).toBe(1);
    expect(await handoverRows(c.clinicId)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Each channel's own path
// -----------------------------------------------------------------------------

async function liveWebClinic(label: string): Promise<WebChatClinic> {
  const c = await seedClinic(label);
  await bindAgreementInEffect(c.clinicId);
  await setWeekdayHours(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), website = 'handover-chat.test' where id = $1`,
    [c.clinicId],
  );
  await seedEntitled(c.clinicId, { planId: "webchat-1000", planStartedAt: new Date("2026-10-01T00:00:00Z"), channelRows: [{ channel: "web", liveAt: new Date("2026-10-01T00:00:00Z") }] });
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
  });
  const clinic = await webChatClinic(c.slug);
  if (!clinic) throw new Error("no clinic");
  return clinic;
}

async function metaClinic(label: string, pageId: string) {
  const c = await seedClinic(label);
  await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
    await setPhoneSettings(tx, { publishedPhoneE164: "+14155550142" });
    await updateAgentConfig(tx, {
      greeting: "Hi",
      services: [{ name: "Lip filler", priceFromUsd: 300, priceToUsd: 600, durationMinutes: 30 }],
      escalationPhone: null,
      escalationHours: "Weekdays 9 to 5",
      notes: null,
    });
    await approveAgentConfig(tx, "Dr Chen");
    await attachMetaChannel(tx, { platform: "instagram", externalId: pageId, accessToken: "EAAB-instagram-token-0123456789" });
    await setMetaFrontDoor(tx, true);
  });
  return c;
}

describeDb("handovers: each channel records its own", () => {
  let port = 0;
  let server: ReturnType<typeof createVoiceServer>;
  let modelAnswer: (last: string) => Record<string, unknown> = () => ({ reply: "Happy to help." });
  const voiceResponder: AssistantResponder = async ({ messages }) => JSON.stringify(modelAnswer(messages[messages.length - 1]!.content));

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    server = createVoiceServer({ secret: SECRET, responder: voiceResponder, transport: new FakeTransport() });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await server.drain();
    await closePools();
  });

  test("web chat: asked once, with the number the visitor then gives on the conversation's contact", async () => {
    const clinic = await liveWebClinic("handover-chat");
    const responder: AssistantResponder = async ({ messages }) => {
      const last = messages[messages.length - 1]!.content;
      return JSON.stringify(
        last.includes("person")
          ? { reply: "Of course. What's your first name and a number the team can call?", handoff: true }
          : { reply: "Thanks Dana, the team will call you.", handoff: true, booking: { first_name: "Dana", phone: "415 555 0192" } },
      );
    };
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("chat did not start");
    const first = await sendWebChatMessage(clinic, start.token, "Can I speak to a person please?", { responder, transport: new FakeTransport() });
    if (first.mode !== "chat") throw new Error("not answered");
    const [row] = await handoverRows(clinic.clinicId);
    expect(row).toMatchObject({ channel: "web_chat", handled_at: null });
    await sendWebChatMessage(clinic, first.token, "I'm Dana, 415 555 0192", { responder, transport: new FakeTransport() });

    expect(await handoverRows(clinic.clinicId)).toHaveLength(1);
    expect(await queuedNotices(clinic.clinicId, ["handover"])).toHaveLength(1);
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ phone: string; full_name: string | null }>(
        `select p.phone, p.full_name from conversations v join contacts p on p.id = v.contact_id where v.id = $1`,
        [row!.conversation_id],
      ),
    );
    expect(rows).toEqual([{ phone: "+14155550192", full_name: "Dana" }]);
  }, 60_000);

  test("Meta: the model's handoff keeps one by the thread's reference; a message the screen refused keeps nothing", async () => {
    const c = await metaClinic("handover-meta", "17841400000000777");
    const asked: string[] = [];
    const responder: FrontDoorResponder = async (_system, text) => {
      asked.push(text);
      return JSON.stringify({ reply: "A person at the practice can help on the phone.", handoff: true, booking: { wants: false } });
    };
    const thread = { platform: "instagram" as const, externalId: "17841400000000777", senderId: "ig-user-1", connectionId: null };
    const clinical = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, { platform: "instagram", text: "I've had bad cystic acne for years, can I talk to someone?", responder, thread }),
    );
    expect(clinical?.screened).toBe("clinical");
    expect(asked).toEqual([]);
    expect(await handoverRows(c.clinicId)).toEqual([]);

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, { platform: "instagram", text: "Can I talk to a real person?", responder, thread }),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      answerFrontDoor(tx, { platform: "instagram", text: "Hello? A human please", responder, thread }),
    );
    const rows = await handoverRows(c.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "meta", platform: "instagram", conversation_id: null });
    // The thread's keyed reference, never the sender's id.
    expect(rows[0]!.party_ref).not.toContain("ig-user-1");
    const notices = await queuedNotices(c.clinicId, ["handover"]);
    expect(notices.map((n) => n.dedupe_key)).toEqual([`handover:conversation:${rows[0]!.meta_conversation_id}`]);
  }, 60_000);

  test("voice: kept by the call id while the call goes on, and linked to the call's conversation when it ends", async () => {
    const clinic = await seedClinic("handover-call");
    modelAnswer = (last) =>
      last.includes("person") ? { reply: "I'll let the team know you'd like to speak to someone.", handoff: true } : { reply: "We're open weekdays." };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/llm-websocket/${SECRET}/${clinic.clinicId}/call_handover_1`);
    const received: Record<string, unknown>[] = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const replies = () => received.filter((m) => m.response_type === "response");
    const until = async (n: number) => {
      for (let i = 0; i < 200 && replies().length < n; i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    await until(1);
    ws.send(JSON.stringify({ interaction_type: "call_details", call: { call_id: "call_handover_1", from_number: "+14155550188", direction: "inbound" } }));
    ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "Can I talk to a person?" }] }));
    await until(2);
    expect(await handoverRows(clinic.clinicId)).toMatchObject([{ channel: "voice", external_call_id: "call_handover_1", conversation_id: null }]);

    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));
    const [row] = await handoverRows(clinic.clinicId);
    expect(row!.conversation_id).not.toBeNull();
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ phone: string }>(
        `select p.phone from conversations v join contacts p on p.id = v.contact_id where v.id = $1`,
        [row!.conversation_id],
      ),
    );
    expect(rows).toEqual([{ phone: "+14155550188" }]);
  }, 60_000);
});

// -----------------------------------------------------------------------------
// Bookings
// -----------------------------------------------------------------------------

type Signed = { cookie: string; token: string; userId: string };

async function signIn(userId: string): Promise<Signed> {
  const started = await auth.api.startLinkSession({ body: { userId }, headers: new Headers(), asResponse: true });
  const cookie = started.headers.getSetCookie().find((c) => c.startsWith("hd.session_token="))!.split(";")[0]!;
  const token = decodeURIComponent(cookie.slice("hd.session_token=".length)).split(".")[0]!;
  return { cookie, token, userId };
}

function browse(who: Signed | null, path: string): void {
  mocks.headers = new Headers({
    ...(who ? { cookie: who.cookie } : {}),
    "x-healdesk-path": path,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "x-forwarded-for": "203.0.113.7",
  });
}

async function stepUpWithPasskey(who: Signed, label = "Front desk Mac"): Promise<{ factorId: string; stepUpId: string }> {
  const pool = getMigratorPool();
  const factor = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [who.userId, label, randomBytes(16).toString("base64url")],
  );
  const step = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now() - interval '1 minute', now()) returning id`,
    [hashSessionToken(who.token), who.userId, factor.rows[0]!.id, label],
  );
  return { factorId: factor.rows[0]!.id, stepUpId: step.rows[0]!.id };
}

type AuditRow = { action: string; resource_type: string; resource_id: string | null; resource_ids: string[] | null; actor_label: string; metadata: Record<string, unknown> | null };

async function auditRows(clinicId: string): Promise<AuditRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<AuditRow>(
      `select action, resource_type, resource_id, resource_ids, actor_label, metadata from audit_log where clinic_id = $1 order by occurred_at, id`,
      [clinicId],
    );
    return rows;
  });
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function renderBookings(slug: string): Promise<string> {
  return renderToStaticMarkup(await BookingsPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describeDb("handovers on Bookings", () => {
  let a: PortalClinic;
  let b: PortalClinic;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.headers = new Headers();
    a = await provisionPortalClinic("handovers-a");
    b = await provisionPortalClinic("handovers-b");
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("Needs you lists each open handover behind the step-up, with one access row naming them by the passkey", async () => {
    const contactId = await inTenant(a.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone, full_name) values ($1, '+14155550134', 'Maria Lopez') returning id`,
        [a.clinicId],
      );
      return rows[0]!.id;
    });
    const call = await conversationRow(a.clinicId, { channel: "voice", callId: "call_desk_1", contactId });
    await raise(a.clinicId, { channel: "voice", callId: "call_desk_1" });
    await raise(a.clinicId, { channel: "voice", callId: "call_still_going" });
    const chat = await conversationRow(a.clinicId, { channel: "web_chat" });
    await raise(a.clinicId, { channel: "web_chat", conversationId: chat });
    const thread = await threadRow(a.clinicId, "instagram");
    await raise(a.clinicId, { channel: "meta", platform: "instagram", partyRef: thread.partyRef, metaConversationId: thread.conversationId });
    const ids = (await handoverRows(a.clinicId)).map((r) => r.id);
    expect(ids).toHaveLength(4);

    const path = `/c/${a.clinicSlug}/bookings`;
    const link = await signIn(a.userId);
    browse(link, path);
    await expect(renderBookings(a.clinicSlug)).rejects.toThrow("NEXT_REDIRECT");
    expect((await auditRows(a.clinicId)).filter((r) => r.action === "read" && r.resource_type === "handover")).toEqual([]);

    const { factorId } = await stepUpWithPasskey(link);
    const page = text(await renderBookings(a.clinicSlug));
    expect(page).toContain("Asked for a person");
    expect(page).toContain("Maria asked for a person on the phone");
    expect(page).toContain("Call Maria");
    expect(page).toContain("The call was still going.");
    expect(page).toContain("Someone asked for a person in your website chat");
    expect(page).toContain("They didn't leave a number. The chat's transcript was emailed to you.");
    expect(page).toContain("Someone asked for a person on Instagram");
    expect(page).toContain("Reply to them in your Instagram inbox. Nothing they wrote is kept here.");
    expect(page.match(/Mark handled/g)).toHaveLength(4);
    expect(page).not.toContain("Nothing needs you right now.");
    const html = await renderBookings(a.clinicSlug);
    expect(html).toContain(`/c/${a.clinicSlug}/conversations/${call}`);

    const reads = (await auditRows(a.clinicId)).filter((r) => r.action === "read" && r.resource_type === "handover");
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect([...reads[0]!.resource_ids!].sort()).toEqual([...ids].sort());
    expect(reads[0]!.actor_label).toBe("Front desk Mac");
    expect(reads[0]!.metadata).toMatchObject({ passkeyId: factorId });
  }, 60_000);

  test("Mark handled: once, by the device and its passkey; it leaves Needs you; another clinic's is not found", async () => {
    const chat = await conversationRow(a.clinicId, { channel: "web_chat" });
    await raise(a.clinicId, { channel: "web_chat", conversationId: chat });
    const [row] = await handoverRows(a.clinicId);
    const otherChat = await conversationRow(b.clinicId, { channel: "web_chat" });
    await raise(b.clinicId, { channel: "web_chat", conversationId: otherChat });
    const [other] = await handoverRows(b.clinicId);

    const path = `/c/${a.clinicSlug}/bookings`;
    const link = await signIn(a.userId);
    browse(link, path);
    // Without the step-up the action goes to it, and nothing changes.
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).rejects.toThrow("NEXT_REDIRECT");
    expect((await handoverRows(a.clinicId))[0]!.handled_at).toBeNull();

    const { factorId, stepUpId } = await stepUpWithPasskey(link);
    expect(await markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).toEqual({ status: "saved", message: "Marked handled." });
    const [handled] = await handoverRows(a.clinicId);
    expect(handled).toMatchObject({ handled_by_label: "Front desk Mac", handled_by_user_id: a.userId });
    expect(handled!.handled_at).not.toBeNull();
    const updates = (await auditRows(a.clinicId)).filter((r) => r.action === "update" && r.resource_type === "handover");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.metadata).toMatchObject({ outcome: "handled", passkeyId: factorId, stepUpId });

    expect(await markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).toEqual({
      status: "saved",
      message: "Someone on your team already marked this handled.",
    });
    expect((await auditRows(a.clinicId)).filter((r) => r.action === "update" && r.resource_type === "handover")).toHaveLength(1);
    const page = text(await renderBookings(a.clinicSlug));
    expect(page).not.toContain("Asked for a person");
    expect(page).toContain("Nothing needs you right now.");

    const before = (await auditRows(a.clinicId)).length;
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: other!.id }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: "not-a-uuid" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await auditRows(a.clinicId)).length).toBe(before);
    expect((await handoverRows(b.clinicId))[0]!.handled_at).toBeNull();
  }, 60_000);
});
