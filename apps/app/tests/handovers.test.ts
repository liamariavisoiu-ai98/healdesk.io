import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { auth } from "@/lib/auth";
import { sendWebChatMessage, startWebChat, webChatClinic, type WebChatClinic } from "@/lib/chat/web-chat";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { contacts } from "@/db/schema";
import { attachHandoverCaller, HandoverChatHeldError, linkCallHandovers, raiseHandover } from "@/lib/handovers/record";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { attachMetaChannel, setMetaFrontDoor } from "@/lib/meta/channels";
import { answerFrontDoor, type FrontDoorResponder } from "@/lib/meta/front-door";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { appendAmendment } from "@/lib/patient-rights/amendments";
import { erasePerson, reapplyErasures } from "@/lib/patient-rights/erasure";
import { exportClinic, exportPatient } from "@/lib/patient-rights/export";
import { purgeClinic } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";
import { createVoiceServer } from "@/voice/server";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, queuedNotices, seedClinic, seedEntitled, setWeekdayHours } from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Handovers (drizzle/0092, lib/handovers/record.ts): someone who asked AYA
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
const { MAX_OPEN_HANDOVERS, olderHandoversLine } = await import("@/lib/portal/bookings");

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
  callback_phone: string | null;
  callback_first_name: string | null;
};

async function handoverRows(clinicId: string): Promise<HandoverRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<HandoverRow>(
      `select id, channel, platform, external_call_id, conversation_id, party_ref, meta_conversation_id,
              handled_at, handled_by_label, handled_by_user_id, callback_phone, callback_first_name
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

  test("erasure by the number the visitor gave takes the handover and its chat, not a chat someone else's request holds; both exports carry it", async () => {
    const c = await seedClinic("handover-erase");
    const alone = await conversationRow(c.clinicId, { channel: "web_chat" });
    const shared = await conversationRow(c.clinicId, { channel: "web_chat" });
    for (const conversationId of [alone, shared]) {
      await raise(c.clinicId, { channel: "web_chat", conversationId });
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        attachHandoverCaller(tx, { conversationId, capture: { firstName: "Dana", phone: "415 555 0161" } }),
      );
    }
    // Someone else's request in the second chat, under their own number.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const [other] = await tx.db.insert(contacts).values({ clinicId: c.clinicId, phone: "+14155550162", timezone: "America/New_York", updatedAt: new Date() }).returning({ id: contacts.id });
      await createBookingRequest(tx, { channel: "web_chat", contactId: other!.id, conversationId: shared, preferredWindow: "Friday morning", treatment: null });
    });
    expect((await handoverRows(c.clinicId)).map((h) => h.callback_phone)).toEqual(["+14155550161", "+14155550161"]);

    const person = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { phone: "+14155550161", requestedBy: "practice" }),
    );
    expect(person.handovers).toHaveLength(2);
    // And the chat behind one that erasure would take with them; not the one
    // someone else's request holds.
    expect(person.conversations.map((v) => v.id)).toEqual([alone]);
    const clinic = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportClinic(tx, "practice", "portal_download"));
    expect(clinic.handovers).toHaveLength(2);

    const erased = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      erasePerson(tx, { phone: "+14155550161", requestedBy: "practice" }),
    );
    expect(erased.deleted).toMatchObject({ handovers: 2, conversations: 1 });
    expect(await handoverRows(c.clinicId)).toEqual([]);
    const left = await inTenant(c.clinicId, async (q) => (await q.query<{ id: string }>(`select id from conversations order by id`)).rows.map((r) => r.id));
    expect(left).toEqual([shared]);
  });

  test("on the host a person is named by an id: a handover's, or its chat's, names someone who only left a call-back number", async () => {
    const c = await seedClinic("handover-by-id");
    const chat = await conversationRow(c.clinicId, { channel: "web_chat" });
    await raise(c.clinicId, { channel: "web_chat", conversationId: chat });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      attachHandoverCaller(tx, { conversationId: chat, capture: { firstName: "Ari", phone: "415 555 0171" } }),
    );
    const [row] = await handoverRows(c.clinicId);
    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { contactId: row!.id, requestedBy: "practice" }),
    );
    expect(bundle.handovers.map((h) => h.id)).toEqual([row!.id]);
    expect(bundle.conversations.map((v) => v.id)).toEqual([chat]);
    // By the chat's conversation id, the address the practice sees.
    const erased = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      erasePerson(tx, { contactId: chat, requestedBy: "practice" }),
    );
    expect(erased.deleted).toMatchObject({ handovers: 1, conversations: 1 });
    expect(await handoverRows(c.clinicId)).toEqual([]);

    // A restore brings the row back as it was: re-applying the erasure takes
    // it, and its chat, again.
    const back = await conversationRow(c.clinicId, { channel: "web_chat" });
    const pool = getMigratorPool();
    await pool.query(`alter table handovers disable trigger handovers_guard`);
    try {
      await inTenant(c.clinicId, (q) =>
        q.query(
          `insert into handovers (id, clinic_id, channel, conversation_id, callback_phone, callback_first_name, created_at)
           values ($3, $1, 'web_chat', $2, '+14155550171', 'Ari', now() - interval '1 hour')`,
          [c.clinicId, back, row!.id],
        ),
      );
    } finally {
      await pool.query(`alter table handovers enable trigger handovers_guard`);
    }
    await inTenant(c.clinicId, (q) => q.query(`update conversations set started_at = now() - interval '1 hour' where id = $1`, [back]));
    expect((await reapplyErasures()).failures).toBe(0);
    expect(await handoverRows(c.clinicId)).toEqual([]);
    const chats = await inTenant(c.clinicId, async (q) => (await q.query(`select id from conversations where id = $1`, [back])).rows);
    expect(chats).toEqual([]);
  });

  test("named by a handover's or its chat's id, only that handover and its chat are reached, never anyone found by the typed number", async () => {
    const c = await seedClinic("handover-scoped");
    // A patient, and another visitor's handover, both on the number typed.
    await inTenant(c.clinicId, (q) =>
      q.query(`insert into contacts (clinic_id, phone, full_name) values ($1, '+14155550181', 'Pat Patient')`, [c.clinicId]),
    );
    const theirs = await conversationRow(c.clinicId, { channel: "web_chat" });
    const other = await conversationRow(c.clinicId, { channel: "web_chat" });
    for (const [conversationId, firstName] of [[theirs, "Sam"], [other, "Robin"]] as const) {
      await raise(c.clinicId, { channel: "web_chat", conversationId });
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        attachHandoverCaller(tx, { conversationId, capture: { firstName, phone: "415 555 0181" } }),
      );
    }
    const mine = (await handoverRows(c.clinicId)).find((h) => h.conversation_id === theirs)!;
    // Someone else's booking on another chat in the same clinic holds nothing of these.
    const elsewhere = await conversationRow(c.clinicId, { channel: "web_chat" });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const [booker] = await tx.db.insert(contacts).values({ clinicId: c.clinicId, phone: "+14155550189", timezone: "America/New_York", updatedAt: new Date() }).returning({ id: contacts.id });
      await createBookingRequest(tx, { channel: "web_chat", contactId: booker!.id, conversationId: elsewhere, preferredWindow: "Tuesday", treatment: null });
    });

    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      exportPatient(tx, { contactId: theirs, requestedBy: "practice" }),
    );
    expect(bundle.contacts).toEqual([]);
    expect(bundle.handovers.map((h) => h.id)).toEqual([mine.id]);
    expect(bundle.conversations.map((v) => v.id)).toEqual([theirs]);

    const erased = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      erasePerson(tx, { contactId: mine.id, requestedBy: "practice" }),
    );
    expect(erased.deleted).toMatchObject({ handovers: 1, conversations: 1, contacts: 0 });
    expect((await handoverRows(c.clinicId)).map((h) => h.conversation_id)).toEqual([other]);
    const left = await inTenant(c.clinicId, async (q) => ({
      contacts: (await q.query(`select id from contacts`)).rows.length,
      chats: (await q.query(`select id from conversations order by id`)).rows.length,
    }));
    expect(left).toEqual({ contacts: 2, chats: 2 });
  });

  test("a named handover whose chat holds the visitor's own booking is refused; their contact takes the handover and the chat", async () => {
    const c = await seedClinic("handover-chat-held");
    const chat = await conversationRow(c.clinicId, { channel: "web_chat" });
    await raise(c.clinicId, { channel: "web_chat", conversationId: chat });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      // The call-back number and the booking's number differ.
      await attachHandoverCaller(tx, { conversationId: chat, capture: { firstName: "Lee", phone: "415 555 0191" } });
      const [contact] = await tx.db.insert(contacts).values({ clinicId: c.clinicId, phone: "+14155550192", timezone: "America/New_York", updatedAt: new Date() }).returning({ id: contacts.id });
      await createBookingRequest(tx, { channel: "web_chat", contactId: contact!.id, conversationId: chat, preferredWindow: "Monday", treatment: null });
    });
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { contactId: chat, requestedBy: "practice" })),
    ).rejects.toBeInstanceOf(HandoverChatHeldError);
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportPatient(tx, { contactId: chat, requestedBy: "practice" })),
    ).rejects.toBeInstanceOf(HandoverChatHeldError);
    const contactId = await inTenant(c.clinicId, async (q) => (await q.query<{ id: string }>(`select id from contacts where phone = '+14155550192'`)).rows[0]!.id);
    // Their export carries what erasing them takes: the chat and the handover in it.
    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportPatient(tx, { contactId, requestedBy: "practice" }));
    expect(bundle.conversations.map((v) => v.id)).toEqual([chat]);
    expect(bundle.handovers).toHaveLength(1);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { contactId, requestedBy: "practice" }));
    const left = await inTenant(c.clinicId, async (q) => ({
      handovers: (await q.query(`select id from handovers`)).rows.length,
      chats: (await q.query(`select id from conversations`)).rows.length,
    }));
    expect(left).toEqual({ handovers: 0, chats: 0 });
  });

  test("erasing a contact takes a chat their booking was made in with no handover, and a shared chat once its last booking goes", async () => {
    const c = await seedClinic("handover-request-chats");
    const booked = await conversationRow(c.clinicId, { channel: "web_chat" });
    const shared = await conversationRow(c.clinicId, { channel: "web_chat" });
    const ids = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const [a] = await tx.db.insert(contacts).values({ clinicId: c.clinicId, phone: "+14155550201", timezone: "America/New_York", updatedAt: new Date() }).returning({ id: contacts.id });
      const [b] = await tx.db.insert(contacts).values({ clinicId: c.clinicId, phone: "+14155550202", timezone: "America/New_York", updatedAt: new Date() }).returning({ id: contacts.id });
      await createBookingRequest(tx, { channel: "web_chat", contactId: a!.id, conversationId: booked, preferredWindow: "Monday", treatment: null });
      await createBookingRequest(tx, { channel: "web_chat", contactId: a!.id, conversationId: shared, preferredWindow: "Tuesday", treatment: null });
      await createBookingRequest(tx, { channel: "web_chat", contactId: b!.id, conversationId: shared, preferredWindow: "Wednesday", treatment: null });
      return { a: a!.id, b: b!.id };
    });
    await raise(c.clinicId, { channel: "web_chat", conversationId: shared });
    const chats = async () => (await inTenant(c.clinicId, async (q) => (await q.query<{ id: string }>(`select id from conversations order by id`)).rows.map((r) => r.id)));

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { contactId: ids.a, requestedBy: "practice" }));
    // The chat with no handover goes; the shared one stays for B's booking.
    expect(await chats()).toEqual([shared]);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { contactId: ids.b, requestedBy: "practice" }));
    expect(await chats()).toEqual([]);
  });

  test("an amended chat does not stop a call-back-only visitor being erased: the handover goes, the chat waits for its amendment's clock", async () => {
    const c = await seedClinic("handover-amended");
    const chat = await conversationRow(c.clinicId, { channel: "web_chat" });
    await raise(c.clinicId, { channel: "web_chat", conversationId: chat });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await attachHandoverCaller(tx, { conversationId: chat, capture: { firstName: "Jo", phone: "415 555 0211" } });
      await appendAmendment(tx, { target: { kind: "conversation", id: chat }, amendment: "The visitor asked for this to be noted.", requestedBy: "practice", recordedBy: "ops@healdesk.test" });
    });
    const erased = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => erasePerson(tx, { contactId: chat, requestedBy: "practice" }));
    expect(erased.deleted).toMatchObject({ handovers: 1 });
    expect(await handoverRows(c.clinicId)).toEqual([]);
  });

  test("a call's handover the database missed linking is linked before anything relies on it", async () => {
    const c = await seedClinic("handover-heal");
    await raise(c.clinicId, { channel: "voice", callId: "call_missed_link" });
    // The race: the conversation lands without its trigger seeing the handover.
    const pool = getMigratorPool();
    await pool.query(`alter table conversations disable trigger conversations_link_handover`);
    let conversationId: string;
    try {
      conversationId = await conversationRow(c.clinicId, { channel: "voice", callId: "call_missed_link" });
    } finally {
      await pool.query(`alter table conversations enable trigger conversations_link_handover`);
    }
    expect((await handoverRows(c.clinicId))[0]!.conversation_id).toBeNull();
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => linkCallHandovers(tx))).toBe(1);
    expect((await handoverRows(c.clinicId))[0]!.conversation_id).toBe(conversationId);
  });

  test("a restore loads handled rows as they were with the guard off, as docs/handover.md says, and not with it on", async () => {
    const c = await seedClinic("handover-restore");
    const conversationId = await conversationRow(c.clinicId, { channel: "web_chat" });
    const pool = getMigratorPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const load = () =>
        client.query(
          `insert into handovers (clinic_id, channel, conversation_id, created_at, handled_at, handled_by_label, handled_by_user_id)
           values ($1, 'web_chat', $2, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', 'Front desk', 'u1')`,
          [c.clinicId, conversationId],
        );
      await client.query("savepoint plain");
      await expect(load()).rejects.toThrow(/recorded open/);
      await client.query("rollback to savepoint plain");
      await client.query(`alter table handovers disable trigger handovers_guard`);
      await load();
      await client.query(`alter table handovers enable trigger handovers_guard`);
      const { rows } = await client.query<{ created_at: Date }>(`select created_at from handovers`);
      expect(rows[0]!.created_at.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
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
    // The answer gate asks the vendors' agreements on the call's path
    // (lib/compliance/vendor-coverage.ts): attested, as before any real call.
    await attestPlatform(COVERAGE_VENDORS);
    server = createVoiceServer({ secret: SECRET, responder: voiceResponder, transport: new FakeTransport(), realCalls: true });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await server.drain();
    await closePools();
  });

  test("web chat: asked once, with the number the visitor then gives held on the handover, never as a contact", async () => {
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
      client.query<{ callback_phone: string; callback_first_name: string | null; conversation_contact: string | null; contacts: number }>(
        `select h.callback_phone, h.callback_first_name, v.contact_id as conversation_contact,
                (select count(*)::int from contacts) as contacts
           from handovers h join conversations v on v.id = h.conversation_id`,
      ),
    );
    // Never a contact a later lookup by the number could find, and never on
    // the conversation, which a later request may tie to someone else.
    expect(rows).toEqual([{ callback_phone: "+14155550192", callback_first_name: "Dana", conversation_contact: null, contacts: 0 }]);
  }, 60_000);

  test("web chat: a handover after an urgent alert keeps nothing, and the urgent alert stands", async () => {
    const clinic = await liveWebClinic("handover-chat-urgent");
    const responder: AssistantResponder = async () => JSON.stringify({ reply: "A person will help.", handoff: true });
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("chat did not start");
    const first = await sendWebChatMessage(clinic, start.token, "I'm having a severe reaction to my filler", { responder, transport: new FakeTransport() });
    if (first.mode !== "chat") throw new Error("not answered");
    await sendWebChatMessage(clinic, first.token, "Can I speak to a person?", { responder, transport: new FakeTransport() });
    expect(await handoverRows(clinic.clinicId)).toEqual([]);
    expect(await queuedNotices(clinic.clinicId, ["urgent"])).toHaveLength(1);
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

async function renderBookings(slug: string, query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await BookingsPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) }));
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
    // A number the caller gave AYA is not kept here: Bookings says where it is.
    expect(page).toContain(
      "This is the number they called from. If they gave AYA a different one, it's in the call's transcript, which is emailed to you when the call ends.",
    );
    expect(page).toContain(
      "The caller's number appears here once the call ends, if it was shown. If they gave AYA one, it's in the call's transcript, which is emailed to you when the call ends.",
    );
    expect(page).not.toContain("Their call is in Conversations.");
    expect(page).toContain("Someone asked for a person in your website chat");
    expect(page).toContain("They haven't left a number. The chat's transcript is emailed to you when it ends.");
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

  test("a call whose caller ID was withheld says the number they gave AYA is in the transcript email, not in Conversations", async () => {
    const call = await conversationRow(a.clinicId, { channel: "voice", callId: "call_withheld" });
    await raise(a.clinicId, { channel: "voice", callId: "call_withheld" });
    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    await stepUpWithPasskey(link);
    const html = await renderBookings(a.clinicSlug);
    const page = text(html);
    expect(page).toContain("Someone asked for a person on the phone");
    expect(page).toContain(
      "The caller's number wasn't shown. If they gave AYA one, it's in the call's transcript, which is emailed to you when the call ends.",
    );
    expect(html).toContain(`/c/${a.clinicSlug}/conversations/${call}`);
  }, 60_000);

  test("Needs you lists the newest open handovers first, so a new one is never behind old ones nobody marked, and says how many more there are", async () => {
    // More open handovers than Needs you lists, all older than the next.
    await inTenant(a.clinicId, (client) =>
      client.query(
        `insert into handovers (clinic_id, channel, external_call_id)
         select $1, 'voice', 'call_old_' || g from generate_series(1, $2::int) g order by g`,
        [a.clinicId, MAX_OPEN_HANDOVERS],
      ),
    );
    await raise(a.clinicId, { channel: "voice", callId: "call_newest" });
    const rows = await handoverRows(a.clinicId);
    expect(rows).toHaveLength(MAX_OPEN_HANDOVERS + 1);
    const oldest = rows[0]!;
    const newest = rows.at(-1)!;
    expect([oldest.external_call_id, newest.external_call_id]).toEqual(["call_old_1", "call_newest"]);

    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    await stepUpWithPasskey(link);
    const html = await renderBookings(a.clinicSlug);
    // The one the L11 email just pointed at is on the screen it links to, first.
    expect(html).toContain(`id="handover-${newest.id}"`);
    expect(html).not.toContain(`id="handover-${oldest.id}"`);
    expect(html.indexOf(`id="handover-${newest.id}"`)).toBeLessThan(html.indexOf(`id="handover-${rows[1]!.id}"`));
    expect(html.match(/id="handover-[0-9a-f-]{36}"/g)).toHaveLength(MAX_OPEN_HANDOVERS);
    expect(text(html)).toContain(
      `Showing the ${MAX_OPEN_HANDOVERS} most recent of ${MAX_OPEN_HANDOVERS + 1}. One older one is not shown: mark the ones your team has dealt with, and the rest appear here.`,
    );
    // The access row names the handovers shown, and only those.
    const reads = (await auditRows(a.clinicId)).filter((r) => r.action === "read" && r.resource_type === "handover");
    expect(reads.at(-1)!.resource_ids).toHaveLength(MAX_OPEN_HANDOVERS);
    expect(reads.at(-1)!.resource_ids).not.toContain(oldest.id);
  }, 60_000);

  test("the line under a capped list counts the older ones; a list that fits says nothing", async () => {
    expect(olderHandoversLine(140, 100)).toBe(
      "Showing the 100 most recent of 140. 40 older ones are not shown: mark the ones your team has dealt with, and the rest appear here.",
    );
    const chat = await conversationRow(a.clinicId, { channel: "web_chat" });
    await raise(a.clinicId, { channel: "web_chat", conversationId: chat });
    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    await stepUpWithPasskey(link);
    expect(text(await renderBookings(a.clinicSlug))).not.toContain("most recent of");
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
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).rejects.toMatchObject({
      url: `/c/${a.clinicSlug}/bookings?handled=marked&h=${row!.id}`,
    });
    const [handled] = await handoverRows(a.clinicId);
    expect(handled).toMatchObject({ handled_by_label: "Front desk Mac", handled_by_user_id: a.userId });
    expect(handled!.handled_at).not.toBeNull();
    const updates = (await auditRows(a.clinicId)).filter((r) => r.action === "update" && r.resource_type === "handover");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.metadata).toMatchObject({ outcome: "handled", passkeyId: factorId, stepUpId });

    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).rejects.toMatchObject({
      url: `/c/${a.clinicSlug}/bookings?handled=already&h=${row!.id}`,
    });
    expect((await auditRows(a.clinicId)).filter((r) => r.action === "update" && r.resource_type === "handover")).toHaveLength(1);
    const page = text(await renderBookings(a.clinicSlug, { handled: "marked" }));
    expect(page).not.toContain("Asked for a person");
    expect(page).toContain("Nothing needs you right now.");
    // Said in the page's own status region, since the card has gone.
    expect(await renderBookings(a.clinicSlug, { handled: "marked" })).toMatch(/role="status"[^>]*>[^]*Marked handled\./);

    const before = (await auditRows(a.clinicId)).length;
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: other!.id }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: "not-a-uuid" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await auditRows(a.clinicId)).length).toBe(before);
    expect((await handoverRows(b.clinicId))[0]!.handled_at).toBeNull();
  }, 60_000);

  test("while the clinic closes, Bookings is read-only: no button, and a hand-made post changes nothing", async () => {
    const chat = await conversationRow(a.clinicId, { channel: "web_chat" });
    await raise(a.clinicId, { channel: "web_chat", conversationId: chat });
    const [row] = await handoverRows(a.clinicId);
    await getMigratorPool().query(`update clinics set offboarding_started_at = now() where id = $1`, [a.clinicId]);
    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    await stepUpWithPasskey(link);
    const page = text(await renderBookings(a.clinicSlug));
    expect(page).toContain("Someone asked for a person in your website chat");
    expect(page).not.toContain("Mark handled");
    expect(await markHandover(a.clinicSlug, { status: "idle" }, form({ handoverId: row!.id }))).toMatchObject({ status: "failed" });
    expect((await handoverRows(a.clinicId))[0]!.handled_at).toBeNull();
  }, 60_000);
});
