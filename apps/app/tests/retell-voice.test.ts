import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";

import type { AssistantResponder } from "@/lib/assistant/turn";
import { addRecipient } from "@/lib/reporting/recipients";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { CLOSED_LINE, latestCallerWords, TRANSFER_LINE } from "@/lib/voice/retell";
import { createVoiceServer } from "@/voice/server";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedDemoClinic } from "./setup/factories";

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
    server = createVoiceServer({ secret: SECRET, responder, transport, realCalls: true });
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

  // Test mode (owner, 19 October 2026; lib/voice/test-calls.ts): with real
  // calls off, only a clinic app_clinic_is_demo() calls made up is answered.
  describe("with real calls off", () => {
    let testPort = 0;
    let testServer: ReturnType<typeof createVoiceServer>;

    beforeAll(async () => {
      testServer = createVoiceServer({ secret: SECRET, responder, transport, realCalls: false });
      await new Promise<void>((resolve) => testServer.server.listen(0, "127.0.0.1", () => resolve()));
      testPort = (testServer.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await testServer.drain();
    });

    const hangUp = async (c: Awaited<ReturnType<typeof call>>) => {
      await c.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all([...testServer.sessions].map((s) => s.finish()));
    };

    test("a synthetic clinic that is not the demo clinic is put through to its direct line, and nothing is kept", async () => {
      const clinic = await seedClinic("retell-test-real");
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => addRecipient(tx, { email: "desk@retell-test.test", addedBy: "test" }));
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550124')
           on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
          [clinic.clinicId],
        ),
      );
      let asked = false;
      modelAnswer = () => {
        asked = true;
        return { reply: "model" };
      };
      const mailed = transport.sent.length;
      const c = await call(testPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_test_real`);
      await c.waitFor((r) => responses(r).length >= 1);
      c.send({ interaction_type: "call_details", call: { call_id: "call_test_real", from_number: "+14155550193", direction: "inbound" } });
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "Could I book a consultation?" }] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(responses(c.received)).toEqual([
        { response_type: "response", response_id: 0, content: TRANSFER_LINE, content_complete: true, end_call: false, transfer_number: "+14155550124" },
      ]);
      await hangUp(c);
      expect(asked).toBe(false);
      const { rows } = await inTenant(clinic.clinicId, (client) => client.query(`select id from conversations`));
      expect(rows).toHaveLength(0);
      expect(transport.sent.length).toBe(mailed);
    });

    test("one with no direct line is refused politely and the call ends", async () => {
      const clinic = await seedClinic("retell-test-noline");
      const c = await call(testPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_test_noline`);
      await c.waitFor((r) => responses(r).length >= 1);
      expect(responses(c.received)).toEqual([{ response_type: "response", response_id: 0, content: CLOSED_LINE, content_complete: true, end_call: true }]);
      await hangUp(c);
      const { rows } = await inTenant(clinic.clinicId, (client) => client.query(`select id from conversations`));
      expect(rows).toHaveLength(0);
    });

    test("the demo clinic is answered as any call is: the AI line first, then the brain, and the call recorded", async () => {
      const demo = await seedDemoClinic("retell-test-demo");
      modelAnswer = () => ({ reply: "We're open weekdays nine to five." });
      const c = await call(testPort, `/llm-websocket/${SECRET}/${demo.clinicId}/call_test_demo`);
      await c.waitFor((r) => responses(r).length >= 1);
      expect(String(responses(c.received)[0]!.content)).toMatch(/^Hi, I'm an AI assistant for .* — not a human\. This call is transcribed/);
      c.send({ interaction_type: "call_details", call: { call_id: "call_test_demo", from_number: "+14155550194", direction: "inbound" } });
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "When are you open?" }] });
      await c.waitFor((r) => responses(r).length >= 2);
      expect(responses(c.received)[1]).toMatchObject({ response_id: 1, content: "We're open weekdays nine to five." });
      await hangUp(c);
      const { rows } = await inTenant(demo.clinicId, (client) => client.query<{ external_call_id: string }>(`select external_call_id from conversations`));
      expect(rows).toEqual([{ external_call_id: "call_test_demo" }]);
    });
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
