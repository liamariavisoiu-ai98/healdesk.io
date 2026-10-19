import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { readAccountState } from "@/lib/support/account-reader";
import { escalateToSupport } from "@/lib/support/escalate";
import { readForwardingSteps } from "@/lib/support/forwarding";
import { SupportLimiter } from "@/lib/support/limits";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The support chat against a real clinic (plan Part H): get_account_state's
 * reader gives facts the email allowlist accepts; an escalation sends I3 to
 * hello@ with the clinic's address as reply-to and only then queues L25 to
 * that address through the outbox, which renders it with the reply date; and
 * get_forwarding_steps reads nothing until voice is ready for the clinic.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "support-chat-test" } as const;
const NOW = new Date("2026-10-14T15:00:00Z");

type Sent = { to: string; message: OutgoingEmail };

function capture(): EmailTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    name: "capture",
    sent,
    async send(recipient, message): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, message });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: Sent[] };
}

const SAVED: Record<string, string | undefined> = {};

let clinic: PortalClinic;

describeDb("the support chat, on a real clinic", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("support", { plan: "voice-webchat-500-300" });
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinics set carrier = 'verizon', phone_system_type = 'landline' where id = $1`,
        [clinic.clinicId],
      );
    });
  }, 180_000);

  beforeEach(() => {
    for (const key of ["BETTER_AUTH_URL", "HEALDESK_SUPPORT_PHONE"]) SAVED[key] = process.env[key];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_SUPPORT_PHONE = "+18886889404";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string>)[key] = value;
    }
  });

  afterAll(async () => {
    await closePools();
  });

  test("get_account_state: business facts only, which the email allowlist accepts as they are", async () => {
    const read = await readAccountState({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: ACTOR,
      now: NOW,
    });
    expect(read).not.toBeNull();
    const { account, state } = read!;
    expect(state.address).toBe(clinic.email);
    expect(account.clinicId).toBe(clinic.clinicId);
    expect(account.channelRows.map((c) => c.channel)).toEqual(["web", "voice"]);
    expect(account.channelRows.every((c) => c.status === "setting_up")).toBe(true);
    expect(account.mode).toBe("overflow_after_hours");
    expect(account.carrier).toBe("verizon");
    expect(account.planId).toBe("voice-webchat-500-300");
    expect(account.isPlanStarted).toBe(false);
    expect(account.connectionRows).toEqual([
      { resource: "google_calendar", status: "not_connected" },
      { resource: "payment_account", status: "not_connected" },
    ]);
    // Nothing a person typed: the account's address is not in it either.
    expect(JSON.stringify(account)).not.toContain(clinic.email);
    expect(() =>
      assertPayloadAllowed(
        {
          requestId: "6f1e2d3c-4b5a-4968-8776-655443322110",
          topic: "other",
          symptom: "other",
          carrier: null,
          phoneSystem: null,
          mode: null,
          channel: null,
          replyByOn: "2026-10-15",
          hasReplyAddress: true,
          accountRows: [account],
        },
        "support_escalation",
      ),
    ).not.toThrow();
  });

  test("an escalation: I3 to hello@ with the clinic's address as reply-to, then L25 to that address through the outbox", async () => {
    const transport = capture();
    const requestId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const result = await escalateToSupport(
      {
        clinicId: clinic.clinicId,
        deviceKey: "device-a",
        actor: ACTOR,
        limiter: new SupportLimiter(),
        readAccount: async () => {
          const read = await readAccountState({
            clinicId: clinic.clinicId,
            userId: clinic.userId,
            actor: ACTOR,
            now: NOW,
          });
          return read ? { account: read.account, address: read.state.address } : null;
        },
        email: { transport },
        now: NOW,
        newId: () => requestId,
      },
      {
        category: "calendar",
        symptom: "wont_connect",
        fields: { carrier: "verizon", phone_system: "landline", mode: "all_calls", channel: "web" },
      },
    );
    expect(result).toEqual({
      status: "sent",
      requestId,
      topic: "calendar",
      replyByOn: "2026-10-15",
      to: clinic.email,
    });

    expect(transport.sent).toHaveLength(1);
    const i3 = transport.sent[0]!;
    expect(i3.to).toBe("hello@healdesk.io");
    expect(i3.message.replyTo).toBe(clinic.email);
    expect(i3.message.subject).toBe("Support request: Calendar connection");
    // A calendar topic carries none of the forwarding fields the model sent.
    expect(i3.message.text).not.toMatch(/Carrier: Verizon\nPhone system/);
    expect(i3.message.text).toContain("What's wrong: Google Calendar won't connect");
    expect(i3.message.text).toContain(`Practice id: ${clinic.clinicId}`);

    const rows = await inTenant(clinic.clinicId, async (c) => {
      const found = await c.query<{
        id: string;
        kind: string;
        dedupe_key: string;
        payload: unknown;
      }>(
        `select id, kind, dedupe_key, payload from billing_notices
          where clinic_id = $1 and kind = 'support_request'`,
        [clinic.clinicId],
      );
      return found.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: `support_request:${requestId}`,
      payload: {
        requestId,
        topic: "calendar",
        replyByOn: "2026-10-15",
        helpPhoneE164: "+18886889404",
      },
    });

    const sent = capture();
    // The row's send_after is the database's own clock, not this test's.
    const later = new Date(Date.now() + 60_000);
    expect(await deliverNotice(clinic.clinicId, rows[0]!.id, { now: later, transport: sent })).toBe(
      "sent",
    );
    expect(sent.sent).toHaveLength(1);
    expect(sent.sent[0]!.to).toBe(clinic.email);
    expect(sent.sent[0]!.message.subject).toBe("We've got your request");
    expect(sent.sent[0]!.message.text).toContain(
      "A person at healdesk will reply to this address by Thursday 15 October.",
    );
  });

  test("an escalation whose I3 fails tells nobody a person will reply: no L25 is queued", async () => {
    const failing: EmailTransport = {
      name: "failing",
      async send(): Promise<DeliveryResult> {
        return { status: "failed", reason: "503 from the provider", statusCode: 503 };
      },
    } as EmailTransport;
    const requestId = "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const result = await escalateToSupport(
      {
        clinicId: clinic.clinicId,
        deviceKey: "device-b",
        actor: ACTOR,
        limiter: new SupportLimiter(),
        readAccount: async () => {
          const read = await readAccountState({
            clinicId: clinic.clinicId,
            userId: clinic.userId,
            actor: ACTOR,
            now: NOW,
          });
          return read ? { account: read.account, address: read.state.address } : null;
        },
        email: { transport: failing },
        now: NOW,
        newId: () => requestId,
      },
      { category: "other", symptom: "other", fields: {} },
    );
    expect(result).toEqual({ status: "failed" });
    const count = await inTenant(clinic.clinicId, async (c) => {
      const found = await c.query<{ n: string }>(
        `select count(*)::text as n from billing_notices where dedupe_key = $1`,
        [`support_request:${requestId}`],
      );
      return Number(found.rows[0]!.n);
    });
    expect(count).toBe(0);
  });

  test("get_forwarding_steps reads nothing until voice is ready: ready on our side and AYA's number given", async () => {
    const read = () => readForwardingSteps({ clinicId: clinic.clinicId, actor: ACTOR });
    expect(await read()).toBeNull();

    // AYA's number alone is not readiness.
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update clinics set assistant_number_e164 = '+15125550142' where id = $1`, [
        clinic.clinicId,
      ]);
    });
    expect(await read()).toBeNull();

    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update clinic_channels set ready_at = now(), waiting_on = 'forwarding'
          where clinic_id = $1 and channel = 'voice'`,
        [clinic.clinicId],
      );
    });
    const steps = await read();
    expect(steps).toMatchObject({ closed: false, ayaNumberE164: "+15125550142", carrier: "Verizon" });
    if (!steps || steps.closed) throw new Error("expected the forwarding steps");
    // Verizon's home-phone and mobile codes, then the two steps with nothing
    // to dial (a machine answering first, and the test call).
    expect(steps.steps.map((s) => s.dial)).toEqual(["*425125550142", "*715125550142", "", ""]);

    // Once the account closes, the way back alone: never "nothing yet".
    await getMigratorPool().query(`update clinics set offboarding_started_at = now() where id = $1`, [
      clinic.clinicId,
    ]);
    const closed = await read();
    expect(closed).toMatchObject({ closed: true, carrier: "Verizon" });
    expect(closed!.undo.map((s) => s.dial)).toEqual(["*43", "", "*73"]);
    await getMigratorPool().query(`update clinics set offboarding_started_at = null where id = $1`, [
      clinic.clinicId,
    ]);
  });
});
