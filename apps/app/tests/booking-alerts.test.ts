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
      conversationId,
      bookingRequestId: null,
      appointmentId: null,
      isPossiblyPaid: false,
      isBurst: false,
      portalUrl: conversation,
    });
    // A call still going on has no conversation yet: Conversations itself.
    expect(byKind.handover!.payload).toMatchObject({ channel: "voice", conversationId: null, portalUrl: `${ORIGIN}/c/${c.slug}/conversations` });
    expect(byKind.booking_request!.payload).toMatchObject({ channel: "web", conversationId, bookingRequestId: queued.request, portalUrl: conversation });
    // Package D's mayBePaid travels as the flag the allowlist reads, and only on L10.
    expect(byKind.deposit_to_collect!.payload).toMatchObject({ isPossiblyPaid: true });
    expect(byKind.calendar_check!.payload).toMatchObject({ isPossiblyPaid: false });
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
      payload: { appointmentId, isPossiblyPaid: true, portalUrl: `${ORIGIN}/c/${c.slug}/conversations` },
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

  test("past the hour's cap on one channel, urgent alerts share one email; a later one is not claimed once it has gone", async () => {
    const c = await seedClinic("alerts-burst");
    const chats = await Promise.all(
      Array.from({ length: ALERT_BURST_AFTER + 3 }, async () => (await seedConversation(c.clinicId, { startedAt: new Date() })).conversationId),
    );
    const raise = (conversationId: string, kind: "urgent" | "handover" = "urgent", channel: "web" | "voice" = "web") =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, kind, { channel, conversationId }));

    const results: boolean[] = [];
    for (const conversationId of chats.slice(0, ALERT_BURST_AFTER + 2)) results.push(await raise(conversationId));
    expect(results.every(Boolean)).toBe(true);
    const hour = new Date().toISOString().slice(0, 13);
    let rows = (await alerts(c.clinicId)).filter((r) => r.kind === "urgent");
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      ...chats.slice(0, ALERT_BURST_AFTER).map((id) => `urgent:web:${id}`),
      `urgent:web:burst:${hour}`,
    ]);
    // The burst names no conversation: it opens Conversations.
    expect(rows.at(-1)!.payload).toMatchObject({ isBurst: true, conversationId: null, portalUrl: `${ORIGIN}/c/${c.slug}/conversations` });
    // A second message in a chat already alerted is that chat's own row, as before.
    expect(await raise(chats[0]!)).toBe(true);
    // Another channel and another kind count on their own.
    expect(await raise(chats[0]!, "handover")).toBe(true);
    expect(await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "urgent", { channel: "voice", callId: "call_burst_1" }))).toBe(true);
    rows = await alerts(c.clinicId);
    expect(rows.map((r) => r.dedupe_key)).toEqual(
      expect.arrayContaining([`handover:web:${chats[0]}`, "urgent:voice:call_burst_1"]),
    );

    // Sent, the burst covers the messages before it, not one after it.
    await setJobEnabled(JOB_BILLING_NOTICES, true, opsUser);
    const transport = new FakeTransport();
    await sendCriticalNotices(c.clinicId, { transport });
    expect(transport.sent.map((s) => s.message.subject)).toContain("Urgent: more urgent messages in your website chat this hour");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await raise(chats.at(-1)!)).toBe(false);
    expect((await alerts(c.clinicId)).filter((r) => r.kind === "urgent" && r.dedupe_key.startsWith("urgent:web:"))).toHaveLength(ALERT_BURST_AFTER + 1);
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

