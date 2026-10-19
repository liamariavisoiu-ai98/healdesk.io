import type { AddressInfo } from "node:net";

import { URGENT_TEAM_TOLD_LINE } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

// A switch for the one case the database cannot be made to show on demand:
// an urgent alert that could not be queued.
const alertQueue = vi.hoisted(() => ({ fails: false }));
vi.mock("@/lib/notices/booking-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notices/booking-alerts")>();
  return {
    ...actual,
    notifyBookingAlert: async (...args: Parameters<typeof actual.notifyBookingAlert>) =>
      alertQueue.fails ? false : actual.notifyBookingAlert(...args),
  };
});

import type { AssistantResponder } from "@/lib/assistant/turn";
import { addRecipient } from "@/lib/reporting/recipients";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { JOB_BILLING_NOTICES, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";
import { latestCallerWords, TRANSFER_LINE } from "@/lib/voice/retell";
import { createVoiceServer } from "@/voice/server";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic } from "./setup/factories";

/**
 * The Retell voice endpoint (src/voice/server.ts, lib/voice/retell.ts), end to
 * end over a real WebSocket on a local port: the secret before the upgrade,
 * the locked AI line first, the shared brain's answers, the transfer to a
 * person when the gate refuses, and the call recorded at hang-up with its
 * request for the desk and its transcript emailed. Synthetic clinics, a fake
 * model, a fake mail transport; nothing reaches Retell, Anthropic or SES.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SECRET = "test-retell-llm-secret-0123456789";
const ACTOR = { type: "service", serviceName: "retell-test" } as const;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${crypto.randomUUID()}` };
  }
}

type Received = Record<string, unknown>;

/** A Retell stand-in: connects, collects what the endpoint says, and waits for a predicate. */
async function call(port: number, path: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const received: Received[] = [];
  const waiters: { until: (r: Received[]) => boolean; resolve: () => void }[] = [];
  ws.on("message", (data) => {
    received.push(JSON.parse(String(data)) as Received);
    for (const w of [...waiters]) if (w.until(received)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  });
  const opened = await new Promise<boolean>((resolve) => {
    ws.on("open", () => resolve(true));
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
  return {
    opened,
    received,
    send: (message: object) => ws.send(JSON.stringify(message)),
    waitFor: (until: (r: Received[]) => boolean) =>
      until(received) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ until, resolve })),
    close: () => new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    }),
  };
}

const responses = (r: Received[]) => r.filter((m) => m.response_type === "response");

describeDb("the Retell voice endpoint", () => {
  let port = 0;
  let server: ReturnType<typeof createVoiceServer>;
  const transport = new FakeTransport();
  let modelAnswer: (last: string) => Record<string, unknown> = () => ({ reply: "Happy to help." });
  const responder: AssistantResponder = async ({ messages }) => JSON.stringify(modelAnswer(messages[messages.length - 1]!.content));

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'transcript-emails'`);
    server = createVoiceServer({ secret: SECRET, responder, transport });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await server.drain();
    await closePools();
  });

  test("health answers, and a wrong or missing secret never upgrades", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const clinic = await seedClinic("retell-secret");
    expect((await call(port, `/llm-websocket/wrong-secret-0123456789/${clinic.clinicId}/call_1`)).opened).toBe(false);
    expect((await call(port, `/llm-websocket/${SECRET}/not-a-uuid/call_1`)).opened).toBe(false);

    const closed = createVoiceServer({ secret: null, responder, transport });
    await new Promise<void>((resolve) => closed.server.listen(0, "127.0.0.1", () => resolve()));
    const closedPort = (closed.server.address() as AddressInfo).port;
    expect((await call(closedPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_1`)).opened).toBe(false);
    await closed.drain();
  });

  test("a call: the AI line first, answers from the brain, and at hang-up a request, the minutes and the transcript", async () => {
    const clinic = await seedClinic("retell-call");
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => addRecipient(tx, { email: "desk@retell.test", addedBy: "test" }));
    modelAnswer = (last) =>
      last.includes("Thursday")
        ? { reply: "Thanks Dana. I'll pass Thursday afternoon to the team, who will confirm within a day.", booking: { wants: true, first_name: "Dana", window: "Thursday afternoon", service: "consultation" } }
        : { reply: "We're open weekdays nine to five." };

    const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_abc123`);
    expect(c.opened).toBe(true);
    await c.waitFor((r) => responses(r).length >= 1);
    expect(c.received[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    const opening = responses(c.received)[0]!;
    expect(opening.response_id).toBe(0);
    expect(opening.content).toMatch(/^Hi, I'm an AI assistant for retell-call Clinic — not a human\. This call is transcribed/);
    expect(opening.content).toMatch(/no audio recording is kept/);

    c.send({ interaction_type: "call_details", call: { call_id: "call_abc123", from_number: "+14155550192", direction: "inbound", start_timestamp: Date.now() - 60_000 } });
    c.send({ interaction_type: "ping_pong", timestamp: 1234 });
    await c.waitFor((r) => r.some((m) => m.response_type === "ping_pong"));

    c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "agent", content: String(opening.content) }, { role: "user", content: "When are you open?" }] });
    await c.waitFor((r) => responses(r).length >= 2);
    expect(responses(c.received)[1]).toMatchObject({ response_id: 1, content: "We're open weekdays nine to five.", end_call: false, content_complete: true });

    c.send({
      interaction_type: "response_required",
      response_id: 2,
      transcript: [{ role: "agent", content: "We're open weekdays nine to five." }, { role: "user", content: "I'm Dana, could I come Thursday afternoon?" }],
    });
    await c.waitFor((r) => responses(r).length >= 3);

    c.send({ interaction_type: "reminder_required", response_id: 3, transcript: [] });
    await c.waitFor((r) => responses(r).length >= 4);

    await c.close();
    // The ingest runs as the socket closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));

    const { rows: convos } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ id: string; channel: string; external_call_id: string; disclosure_played_at: Date | null; outcome: string; urgent: boolean }>(
        `select id, channel, external_call_id, disclosure_played_at, outcome, urgent from conversations`,
      ),
    );
    expect(convos).toHaveLength(1);
    expect(convos[0]).toMatchObject({ channel: "voice", external_call_id: "call_abc123", outcome: "booked", urgent: false });
    expect(convos[0]!.disclosure_played_at).toBeTruthy();

    const { rows: requests } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ channel: string; preferred_window: string }>(`select channel, preferred_window from booking_requests`),
    );
    expect(requests).toEqual([{ channel: "voice", preferred_window: "Thursday afternoon" }]);

    const transcripts = transport.sent.filter((s) => s.message.phiClass === "may-carry-phi");
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.message.text).toContain("Caller: When are you open?");
    expect(transcripts[0]!.message.text).toContain("Assistant: Hi, I'm an AI assistant");
  });

  test("a refused call with a direct line is transferred to a person, never left in silence", async () => {
    const clinic = await seedClinic("retell-refused");
    await bindAgreementInEffect(clinic.clinicId);
    await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`, [clinic.clinicId]);
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550123')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [clinic.clinicId],
      ),
    );
    const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_refused`);
    await c.waitFor((r) => responses(r).length >= 1);
    expect(responses(c.received)[0]).toMatchObject({ response_id: 0, content: TRANSFER_LINE, transfer_number: "+14155550123" });
    await c.close();
  });

  test("an urgent caller hears 911 and the urgent number, and the model is never asked", async () => {
    const clinic = await seedClinic("retell-urgent");
    let asked = false;
    modelAnswer = () => {
      asked = true;
      return { reply: "model" };
    };
    const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_urgent`);
    await c.waitFor((r) => responses(r).length >= 1);
    c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "I'm having a severe reaction to my filler" }] });
    await c.waitFor((r) => responses(r).length >= 2);
    expect(String(responses(c.received)[1]!.content)).toMatch(/call 911/);
    expect(asked).toBe(false);
    await c.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));
    // Recorded as urgent, not only as escalated, so Conversations can tell it from a handover.
    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ outcome: string; urgent: boolean }>(`select outcome, urgent from conversations`),
    );
    expect(rows).toEqual([{ outcome: "escalated_to_human", urgent: true }]);
  });

  test("an urgent caller: one alert per call, keyed on the call and sent once it commits, and a request for a person alerts once too", async () => {
    const clinic = await seedClinic("retell-alert");
    const ops = `usr_ops_${crypto.randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
      [ops, `${ops}@healdesk.test`],
    );
    // The urgent alert is live: the sender switched on, Resend configured, a public origin.
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    // What the send saw: from another connection, the alert is there only once its transaction has committed.
    const delivered: { clinicId: string; committed: number }[] = [];
    const deliverCritical = async (clinicId: string) => {
      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{ n: number }>(`select count(*)::int as n from billing_notices where kind = 'urgent'`),
      );
      delivered.push({ clinicId, committed: rows[0]!.n });
    };
    const alerting = createVoiceServer({ secret: SECRET, responder, transport, sessionDeps: { deliverCritical } });
    await new Promise<void>((resolve) => alerting.server.listen(0, "127.0.0.1", () => resolve()));
    const alertingPort = (alerting.server.address() as AddressInfo).port;
    try {
      modelAnswer = (last) => (last.includes("person") ? { reply: "I'll pass that to the team.", handoff: true } : { reply: "model" });
      const c = await call(alertingPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_alert_1`);
      await c.waitFor((r) => responses(r).length >= 1);
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "I'm having a severe reaction to my filler" }] });
      await c.waitFor((r) => responses(r).length >= 2);
      expect(String(responses(c.received)[1]!.content)).toMatch(/call 911/);
      expect(String(responses(c.received)[1]!.content)).toContain(URGENT_TEAM_TOLD_LINE);
      // Urgent again on the same call: the same alert, still told.
      c.send({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "agent", content: "..." }, { role: "user", content: "I'm having a severe reaction to my filler, it's worse" }] });
      await c.waitFor((r) => responses(r).length >= 3);
      expect(String(responses(c.received)[2]!.content)).toContain(URGENT_TEAM_TOLD_LINE);
      // A request for a person, twice.
      for (const id of [3, 4]) {
        c.send({ interaction_type: "response_required", response_id: id, transcript: [{ role: "agent", content: "..." }, { role: "user", content: "Can I speak to a person?" }] });
        await c.waitFor((r) => responses(r).length >= id + 1);
      }
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      await c.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all([...alerting.sessions].map((s) => s.finish()));

      // Sent after the commit, once.
      expect(delivered).toEqual([{ clinicId: clinic.clinicId, committed: 1 }]);
      const { rows } = await inTenant(clinic.clinicId, (client) =>
        client.query<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }>(
          `select kind, dedupe_key, payload from billing_notices where kind in ('urgent', 'handover') order by kind`,
        ),
      );
      expect(rows).toMatchObject([
        { kind: "handover", dedupe_key: "handover:voice:call_alert_1", payload: { channel: "voice", conversationId: null } },
        { kind: "urgent", dedupe_key: "urgent:voice:call_alert_1", payload: { channel: "voice", conversationId: null } },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/reaction|filler|person\?/);
    } finally {
      await alerting.drain();
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
      vi.unstubAllEnvs();
    }
  });

  test("an urgent alert that could not be queued: the caller still hears 911 and the number, never that the team was told", async () => {
    const clinic = await seedClinic("retell-alert-failed");
    const ops = `usr_ops_${crypto.randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
      [ops, `${ops}@healdesk.test`],
    );
    await setJobEnabled(JOB_BILLING_NOTICES, true, ops);
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    let sends = 0;
    const alerting = createVoiceServer({ secret: SECRET, responder, transport, sessionDeps: { deliverCritical: async () => void (sends += 1) } });
    await new Promise<void>((resolve) => alerting.server.listen(0, "127.0.0.1", () => resolve()));
    const alertingPort = (alerting.server.address() as AddressInfo).port;
    alertQueue.fails = true;
    try {
      const c = await call(alertingPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_alert_2`);
      await c.waitFor((r) => responses(r).length >= 1);
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "I'm having a severe reaction to my filler" }] });
      await c.waitFor((r) => responses(r).length >= 2);
      const said = String(responses(c.received)[1]!.content);
      expect(said).toMatch(/call 911/);
      expect(said).not.toContain(URGENT_TEAM_TOLD_LINE);
      expect(sends).toBe(0);
      await c.close();
    } finally {
      alertQueue.fails = false;
      await alerting.drain();
      await setJobEnabled(JOB_BILLING_NOTICES, false, ops);
      vi.unstubAllEnvs();
    }
  });

  test("an outbound call is ended at once, and recorded as refused", async () => {
    const clinic = await seedClinic("retell-outbound");
    const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_out`);
    await c.waitFor((r) => responses(r).length >= 1);
    c.send({ interaction_type: "call_details", call: { direction: "outbound", from_number: "+14155550100" } });
    await c.waitFor((r) => responses(r).some((m) => m.end_call === true));
    await c.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));
    const { rows } = await inTenant(clinic.clinicId, (client) => client.query(`select id from conversations`));
    expect(rows).toHaveLength(0);
  });
});

describe("latestCallerWords", () => {
  test("the caller's words since the agent last spoke", () => {
    expect(
      latestCallerWords([
        { role: "agent", content: "Hi" },
        { role: "user", content: "one" },
        { role: "agent", content: "Sure" },
        { role: "user", content: "two" },
        { role: "user", content: "three" },
      ]),
    ).toBe("two three");
    expect(latestCallerWords("nope")).toBe("");
  });
});
