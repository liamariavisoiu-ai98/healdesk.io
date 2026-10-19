import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { contacts } from "@/db/schema";
import { flagForFrontDesk } from "@/lib/billing/deposits";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendCriticalNotices, sendPendingNotices } from "@/lib/email/outbox";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
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
});
