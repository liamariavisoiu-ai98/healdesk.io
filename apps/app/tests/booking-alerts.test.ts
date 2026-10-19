import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { contacts } from "@/db/schema";
import { flagForFrontDesk } from "@/lib/billing/deposits";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { lateCriticalNotices, sendCriticalNotices, sendPendingNotices } from "@/lib/email/outbox";
import { quotaExhausted } from "@/lib/email/quota";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { ALERT_BURST_AFTER, notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { urgentAlertLive } from "@/lib/notices/urgent-alert-live";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { addRecipient } from "@/lib/reporting/recipients";
import { JOB_BILLING_NOTICES, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * The live alerts (lib/notices/booking-alerts.ts), against the real outbox:
 * one row per kind and key in the caller's own transaction, ids only; nothing
 * for work that rolls back; a failure that never costs the caller its own
 * writes; and the urgent alert sent to the clinic's one address, never to an
 * extra report recipient. Synthetic clinics and a fake transport: no email
 * leaves the machine.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "booking-alerts-test" } as const;
const ORIGIN = "https://app.healdesk.test";

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `msg_${this.sent.length}` };
  }
}

/** Resend's answer once the account's day is used up. */
class QuotaTransport implements EmailTransport {
  readonly name = "quota";
  async send(): Promise<DeliveryResult> {
    return { status: "failed", reason: "You have reached your daily email sending quota.", statusCode: 429, errorName: "daily_quota_exceeded" };
  }
}

type NoticeRow = { kind: string; dedupe_key: string; payload: Record<string, unknown>; sent_at: Date | null };

async function alerts(clinicId: string): Promise<NoticeRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<NoticeRow>(
      `select kind, dedupe_key, payload, sent_at from billing_notices
        where kind in ('booking_request', 'deposit_to_collect', 'handover', 'urgent', 'calendar_check')
        order by created_at, dedupe_key`,
    );
    return rows;
  });
}

let opsUser = "";

describeDb("the live alerts", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate email_daily_quota`);
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    opsUser = `usr_ops_${randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
      [opsUser, `${opsUser}@healdesk.test`],
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await setJobEnabled(JOB_BILLING_NOTICES, false, opsUser);
    // The quota refusal lasts the UTC day: leave none behind for the next file.
    await getMigratorPool().query(`truncate email_daily_quota`);
  });

  afterAll(async () => {
    await closePools();
  });

  test("each alert is one outbox row in the caller's transaction, keyed once, carrying ids and a portal link only", async () => {
    const c = await seedClinic("alerts-queue");
    const contactId = await seedContact(c.clinicId, "+15550100123");
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date(), contactId });

    const queued = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const request = await createBookingRequest(tx, {
        channel: "web_chat",
        contactId,
        conversationId,
        preferredWindow: "Thursday afternoon",
        treatment: "Lip filler",
      });
      return {
        request: request.id,
        results: [
          await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId }),
          await notifyBookingAlert(tx, "handover", { channel: "voice", callId: "call_alerts_1" }),
          // No channel or conversation given: both are read from the request.
          await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id }),
          await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: request.id }),
          await notifyBookingAlert(tx, "deposit_to_collect", { bookingRequestId: request.id, mayBePaid: true }),
        ],
      };
    });
    expect(queued.results).toEqual([true, true, true, true, true]);

    const rows = await alerts(c.clinicId);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
      [
        `urgent:web:${conversationId}`,
        "handover:voice:call_alerts_1",
        `booking_request:${queued.request}`,
        `calendar_check:${queued.request}`,
        `deposit_to_collect:${queued.request}`,
      ].sort(),
    );
    const conversation = `${ORIGIN}/c/${c.slug}/conversations/${conversationId}`;
    expect(byKind.urgent!.payload).toEqual({
      channel: "web",
      platform: null,
      conversationId,
      bookingRequestId: null,
      appointmentId: null,
      isPossiblyPaid: false,
      isBurst: false,
      portalUrl: conversation,
    });
    // A call still going on has no conversation yet: Conversations itself.
    expect(byKind.handover!.payload).toMatchObject({ channel: "voice", conversationId: null, portalUrl: `${ORIGIN}/c/${c.slug}/conversations` });
    // A request, a deposit and a calendar check open their row in Bookings,
    // where staff act on them; the conversation still travels as an id.
    const atRequest = `${ORIGIN}/c/${c.slug}/bookings#request-${queued.request}`;
    expect(byKind.booking_request!.payload).toMatchObject({ channel: "web", conversationId, bookingRequestId: queued.request, portalUrl: atRequest });
    // Package D's mayBePaid travels as the flag the allowlist reads, and only on L10.
    expect(byKind.deposit_to_collect!.payload).toMatchObject({ isPossiblyPaid: true, portalUrl: atRequest });
    expect(byKind.calendar_check!.payload).toMatchObject({ isPossiblyPaid: false, portalUrl: atRequest });
    for (const row of rows) expect(() => assertPayloadAllowed(row.payload, row.kind as "urgent")).not.toThrow();
    expect(JSON.stringify(rows)).not.toMatch(/Thursday|filler|Lip|0123|Synthetic|\/booking\//);

    // Asked again, the same keys queue nothing new, and say the alert is queued.
    const again = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => [
      await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId }),
      await notifyBookingAlert(tx, "booking_request", { bookingRequestId: queued.request }),
    ]);
    expect(again).toEqual([true, true]);
    expect(await alerts(c.clinicId)).toHaveLength(5);
  });

  test("a caller's transaction that rolls back leaves no alert", async () => {
    const c = await seedClinic("alerts-rollback");
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date() });
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
        expect(await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId })).toBe(true);
        throw new Error("the conversation's own write failed");
      }),
    ).rejects.toThrow("the conversation's own write failed");
    expect(await alerts(c.clinicId)).toEqual([]);
  });

  test("an alert that fails rolls back only itself: the caller's own writes commit", async () => {
    const c = await seedClinic("alerts-savepoint");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const contactId = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const [before] = await tx.db
        .insert(contacts)
        .values({ clinicId: tx.clinicId, phone: "+15550100124", fullName: "Synthetic Patient" })
        .returning({ id: contacts.id });
      // Not a uuid: the alert's own read fails inside its savepoint.
      expect(await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: "not-a-request" })).toBe(false);
      // The transaction is still usable after the failed alert.
      await tx.db.update(contacts).set({ fullName: "Synthetic Patient Two" }).where(eq(contacts.id, before!.id));
      return before!.id;
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("booking alert not queued");
    const kept = await inTenant(c.clinicId, (client) =>
      client.query<{ id: string; full_name: string }>(`select id, full_name from contacts`),
    );
    expect(kept.rows).toEqual([{ id: contactId, full_name: "Synthetic Patient Two" }]);
    expect(await alerts(c.clinicId)).toEqual([]);
  });

  test("no public origin: nothing is queued, and the caller hears so", async () => {
    const c = await seedClinic("alerts-origin");
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date() });
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        notifyBookingAlert(tx, "urgent", { channel: "voice", conversationId }),
      ),
    ).toBe(false);
    expect(await alerts(c.clinicId)).toEqual([]);
  });

  test("a deposit link nobody could check: L10 says it may already be paid", async () => {
    const c = await seedClinic("alerts-deposit");
    const contactId = await seedContact(c.clinicId, "+15550100125");
    const appointmentId = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, deposit_usd, deposit_status)
         values ($1, $2, now() + interval '2 days', 50, 'pending_link') returning id`,
        [c.clinicId, contactId],
      );
      return rows[0]!.id;
    });
    const moved = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      flagForFrontDesk(tx, appointmentId, { mayBePaid: true }),
    );
    expect(moved).toBe(true);
    const rows = await alerts(c.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "deposit_to_collect",
      dedupe_key: `deposit_to_collect:${appointmentId}`,
      // Its row in Deposits to collect, where staff mark it paid.
      payload: { appointmentId, isPossiblyPaid: true, portalUrl: `${ORIGIN}/c/${c.slug}/bookings#deposit-${appointmentId}` },
    });
    expect(rows[0]!.payload).not.toHaveProperty("mayBePaid");
  });

  test("the urgent alert goes at once to the clinic's one address, never to an extra report recipient", async () => {
    const c = await seedClinic("alerts-send");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      addRecipient(tx, { email: "front-desk@example-clinic.test", addedBy: "test" }),
    );
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date() });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId });
      await notifyBookingAlert(tx, "handover", { channel: "web", conversationId });
    });

    // The sender's switch is off: nothing goes, and the rows wait.
    const transport = new FakeTransport();
    expect(await sendCriticalNotices(c.clinicId, { transport })).toMatchObject({ sent: 0 });
    expect(transport.sent).toHaveLength(0);

    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    // In-process, the critical one only: the handover waits for the minute queue.
    expect(await sendCriticalNotices(c.clinicId, { transport })).toMatchObject({ sent: 1 });
    expect(transport.sent).toHaveLength(1);
    const urgent = transport.sent[0]!;
    expect(urgent.target.to).toBe(c.staffEmail);
    expect(urgent.message.phiClass).toBe("none");
    expect(urgent.message.subject).toBe("Urgent: someone wrote something urgent in your website chat");
    expect(urgent.message.text).toContain(`${ORIGIN}/c/${c.slug}/conversations/${conversationId}`);

    expect(await sendPendingNotices({ clinicId: c.clinicId, transport })).toMatchObject({ sent: 1 });
    expect(transport.sent.map((s) => s.target.to)).toEqual([c.staffEmail, c.staffEmail]);
    expect(transport.sent[1]!.message.subject).toBe("Someone asked to speak to a person");
    expect(transport.sent.some((s) => s.target.to === "front-desk@example-clinic.test")).toBe(false);
    expect((await alerts(c.clinicId)).every((r) => r.sent_at !== null)).toBe(true);
  });

  test("the urgent reply's fact: the sender switched on, Resend configured and a public origin, all three", async () => {
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
    expect(await urgentAlertLive()).toBe(false);

    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    expect(await urgentAlertLive()).toBe(true);
    const c = await seedClinic("alerts-live");
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => urgentAlertLive(tx.db))).toBe(true);

    vi.stubEnv("RESEND_API_KEY", "");
    expect(await urgentAlertLive()).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "");
    expect(await urgentAlertLive()).toBe(false);
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    expect(await urgentAlertLive()).toBe(false);
  });

  test("an urgent alert is never capped or combined: every urgent conversation past any count is its own email, at once", async () => {
    const c = await seedClinic("alerts-urgent-uncapped");
    const chats = await Promise.all(
      Array.from({ length: ALERT_BURST_AFTER + 3 }, async () => (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId),
    );
    const raise = (conversationId: string) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "urgent", { channel: "web", conversationId }));
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    const transport = new FakeTransport();
    // Half before a send, half after it: a sent email never swallows a later one.
    const results: boolean[] = [];
    for (const conversationId of chats.slice(0, ALERT_BURST_AFTER + 1)) results.push(await raise(conversationId));
    await sendCriticalNotices(c.clinicId, { transport });
    for (const conversationId of chats.slice(ALERT_BURST_AFTER + 1)) results.push(await raise(conversationId));
    await sendCriticalNotices(c.clinicId, { transport });
    expect(results.every(Boolean)).toBe(true);
    const rows = (await alerts(c.clinicId)).filter((r) => r.kind === "urgent");
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(chats.map((id) => `urgent:web:${id}`).sort());
    expect(rows.every((r) => r.payload.isBurst === false && r.sent_at !== null)).toBe(true);
    // One email each, each opening its own conversation.
    expect(transport.sent).toHaveLength(chats.length);
    for (const id of chats) expect(transport.sent.some((s) => s.message.text.includes(`/conversations/${id}`))).toBe(true);
    expect(new Set(transport.sent.map((s) => s.message.subject))).toEqual(new Set(["Urgent: someone wrote something urgent in your website chat"]));
  });

  test("past the hour's cap, handovers on a call or in the website chat share an email that is sent after them, and the cap re-arms once it has gone", async () => {
    const c = await seedClinic("alerts-burst");
    const chats = await Promise.all(
      Array.from({ length: ALERT_BURST_AFTER + 5 }, async () => (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId),
    );
    const raise = (conversationId: string, channel: "web" | "meta" = "web") =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        notifyBookingAlert(tx, "handover", { channel, conversationId, ...(channel === "meta" ? { platform: "messenger" as const } : {}) }),
      );
    const bursts = async () =>
      (await alerts(c.clinicId)).filter((r) => r.kind === "handover" && r.dedupe_key.startsWith("handover:web:burst:"));

    // Three on their own, then two that share one email still to go.
    const results: boolean[] = [];
    for (const conversationId of chats.slice(0, ALERT_BURST_AFTER + 2)) results.push(await raise(conversationId));
    expect(results.every(Boolean)).toBe(true);
    let rows = (await alerts(c.clinicId)).filter((r) => r.kind === "handover");
    expect(rows.filter((r) => !r.dedupe_key.includes(":burst:")).map((r) => r.dedupe_key).sort()).toEqual(
      chats.slice(0, ALERT_BURST_AFTER).map((id) => `handover:web:${id}`).sort(),
    );
    expect(await bursts()).toHaveLength(1);
    // The shared email names no conversation: it opens Conversations.
    expect((await bursts())[0]!.payload).toMatchObject({ isBurst: true, conversationId: null, portalUrl: `${ORIGIN}/c/${c.slug}/conversations` });
    // A second request in a chat already alerted is that chat's own row, as before.
    expect(await raise(chats[0]!)).toBe(true);
    // Meta's handovers are never capped: each thread is its own email.
    const threads = Array.from({ length: ALERT_BURST_AFTER + 1 }, () => randomUUID());
    for (const id of threads) expect(await raise(id, "meta")).toBe(true);
    rows = await alerts(c.clinicId);
    expect(rows.filter((r) => r.dedupe_key.startsWith("handover:meta:")).map((r) => r.dedupe_key).sort()).toEqual(
      threads.map((id) => `handover:meta:${id}`).sort(),
    );
    // Urgent alerts and other channels count on their own.
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "urgent", { channel: "voice", callId: "call_burst_1" }))).toBe(true);
    expect((await alerts(c.clinicId)).map((r) => r.dedupe_key)).toContain("urgent:voice:call_burst_1");

    // Sent, the shared email covers the handovers before it.
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    const transport = new FakeTransport();
    await sendPendingNotices({ clinicId: c.clinicId, transport });
    const shared = () => transport.sent.filter((s) => s.message.subject === "More people asked to speak to a person this hour");
    expect(shared()).toHaveLength(1);

    // The cap re-arms: a handover after that email has gone starts another,
    // and that one is sent too. Nothing is left without an email.
    expect(await raise(chats[ALERT_BURST_AFTER + 2]!)).toBe(true);
    expect(await bursts()).toHaveLength(2);
    // A shared email the sender has already claimed (its attempt counted,
    // not yet sent) is never joined: the next handover starts its own.
    await inTenant(c.clinicId, (client) =>
      client.query(`update billing_notices set attempts = 1 where sent_at is null and dedupe_key like 'handover:web:burst:%'`),
    );
    expect(await raise(chats[ALERT_BURST_AFTER + 3]!)).toBe(true);
    expect(await bursts()).toHaveLength(3);
    await inTenant(c.clinicId, (client) =>
      client.query(`update billing_notices set attempts = 0 where sent_at is null and dedupe_key like 'handover:web:burst:%'`),
    );
    await sendPendingNotices({ clinicId: c.clinicId, transport });
    expect(shared()).toHaveLength(3);
    expect((await bursts()).every((r) => r.sent_at !== null)).toBe(true);
  });

  test("a handover that joins a shared email holds it until it commits: the sender's claim waits, so the email goes after it", async () => {
    const c = await seedClinic("alerts-burst-lock");
    const chats = await Promise.all(
      Array.from({ length: ALERT_BURST_AFTER + 2 }, async () => (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId),
    );
    const raise = (tx: Parameters<Parameters<typeof withTenant>[1]>[0], conversationId: string) =>
      notifyBookingAlert(tx, "handover", { channel: "web", conversationId });
    for (const conversationId of chats.slice(0, ALERT_BURST_AFTER + 1)) {
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => raise(tx, conversationId));
    }
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    const transport = new FakeTransport();

    let joined!: () => void;
    const hasJoined = new Promise<void>((resolve) => (joined = resolve));
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    const writer = withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const queued = await raise(tx, chats.at(-1)!);
      joined();
      await mayCommit;
      return queued;
    });
    await hasJoined;
    // The writer holds the shared row: the sender cannot claim it yet.
    const sending = sendPendingNotices({ clinicId: c.clinicId, transport });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(transport.sent.filter((s) => s.message.subject === "More people asked to speak to a person this hour")).toHaveLength(0);
    commit();
    expect(await writer).toBe(true);
    await sending;
    // One shared email, sent once the handover that joined it had committed.
    expect(transport.sent.filter((s) => s.message.subject === "More people asked to speak to a person this hour")).toHaveLength(1);
    expect((await alerts(c.clinicId)).filter((r) => r.dedupe_key.startsWith("handover:web:burst:"))).toHaveLength(1);
  });

  test("Resend refusing the day's quota takes the urgent reply's promise away until the day ends", async () => {
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    expect(await urgentAlertLive()).toBe(true);

    const c = await seedClinic("alerts-quota");
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date() });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "urgent", { channel: "web", conversationId }));
    await sendCriticalNotices(c.clinicId, { transport: new QuotaTransport() });
    expect(await quotaExhausted()).toBe(true);
    expect(await urgentAlertLive()).toBe(false);
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => urgentAlertLive(tx.db))).toBe(false);
    // Tomorrow, UTC, is a new quota day.
    expect(await quotaExhausted(undefined, new Date(Date.now() + 24 * 60 * 60 * 1000))).toBe(false);
    // The alert waits for the reset, unsent.
    expect((await alerts(c.clinicId))[0]!.sent_at).toBeNull();
  });

  test("while the sender is off nothing is late; turned on, a day-old urgent alert closes unsent and a fresh one goes", async () => {
    const c = await seedClinic("alerts-backlog");
    const fresh = (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId;
    const old = (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId;
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId: fresh });
      await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId: old });
    });
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update billing_notices set created_at = now() - interval '25 hours', send_after = now() - interval '25 hours' where dedupe_key = $1`,
        [`urgent:web:${old}`],
      ),
    );
    // The seeded state of a new deployment: no red health, no ops alert.
    expect(await lateCriticalNotices()).toEqual([]);

    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    expect((await lateCriticalNotices()).map((n) => n.kind)).toEqual(["urgent"]);
    const transport = new FakeTransport();
    await sendCriticalNotices(c.clinicId, { transport });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.message.text).toContain(`/conversations/${fresh}`);
    const { rows } = await inTenant(c.clinicId, (client) =>
      client.query<{ dedupe_key: string; sent_at: Date | null; recipients_count: number | null; last_error: string | null }>(
        `select dedupe_key, sent_at, recipients_count, last_error from billing_notices where dedupe_key = $1`,
        [`urgent:web:${old}`],
      ),
    );
    expect(rows[0]).toMatchObject({ recipients_count: 0, last_error: "not sent: a day old; the conversation is marked in Conversations" });
    expect(rows[0]!.sent_at).not.toBeNull();
    expect(await lateCriticalNotices()).toEqual([]);
  });
});

