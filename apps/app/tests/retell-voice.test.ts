import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { SCREENED_TURN, type AssistantMessage, type AssistantResponder } from "@/lib/assistant/turn";
import { addRecipient } from "@/lib/reporting/recipients";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { CLOSED_LINE, latestCallerWords, RetellCallSession, TRANSFER_LINE, TROUBLE_TRANSFER_LINE } from "@/lib/voice/retell";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { createVoiceServer } from "@/voice/server";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedDemoClinic } from "./setup/factories";
import { attestPlatform, withdrawPlatform } from "./setup/platform";
import { spokenAfterAcknowledgement } from "./setup/retell-responses";

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

const responses = (r: Received[]) => spokenAfterAcknowledgement(r.filter((m) => m.response_type === "response"));

describeDb("the Retell voice endpoint", () => {
  let port = 0;
  let server: ReturnType<typeof createVoiceServer>;
  const transport = new FakeTransport();
  let modelAnswer: (last: string) => Record<string, unknown> = () => ({ reply: "Happy to help." });
  /** Every conversation the model was sent, in order. */
  const modelSaw: AssistantMessage[][] = [];
  const responder: AssistantResponder = async ({ messages }) => {
    modelSaw.push(messages);
    return JSON.stringify(modelAnswer(messages[messages.length - 1]!.content));
  };

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
    expect(opening.content).toMatch(/^Hi! I'm the AI assistant at retell-call Clinic, and this call's transcribed/);
    expect(opening.content).not.toMatch(/recording|audio|a day/);

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
    expect(transcripts[0]!.message.text).toContain("Assistant: Hi! I'm the AI assistant at");
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

  test("a direct line that is the clinic's AYA number is never transferred to: the caller would come straight back", async () => {
    const clinic = await seedClinic("retell-loop");
    await bindAgreementInEffect(clinic.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), assistant_number_e164 = '+14155550127' where id = $1`,
      [clinic.clinicId],
    );
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550127')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [clinic.clinicId],
      ),
    );
    // Passed through (no billing row), with no line to pass to: the safe
    // script. The vendors are in force for this call only: a later test reads
    // this file as having attested nothing, and a withdrawal reads the same.
    await attestPlatform(COVERAGE_VENDORS);
    try {
      const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_loop`);
      await c.waitFor((r) => responses(r).length >= 1);
      expect(responses(c.received)[0]).not.toHaveProperty("transfer_number");
      expect(String(responses(c.received)[0]!.content)).toMatch(/^Hi! I'm the AI assistant at .*,/);
      await c.close();
    } finally {
      await withdrawPlatform(COVERAGE_VENDORS);
    }
  });

  test("a practice whose agreement no longer covers it goes to its direct line, and with none the call is closed, never the assistant", async () => {
    // A DPA practice that has told us it is now a covered entity: the
    // database refuses its patient rows until it signs the BAA.
    const coveredDpa = async (name: string) => {
      const clinic = await seedClinic(name);
      await bindAgreementInEffect(clinic.clinicId);
      await getMigratorPool().query(
        `update clinics
            set data_classification = 'production', baa_signed_at = now(),
                regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = true
          where id = $1`,
        [clinic.clinicId],
      );
      return clinic;
    };
    let asked = false;
    modelAnswer = () => {
      asked = true;
      return { reply: "model" };
    };

    const withLine = await coveredDpa("retell-kind-line");
    await inTenant(withLine.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550124')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [withLine.clinicId],
      ),
    );
    const transferred = await call(port, `/llm-websocket/${SECRET}/${withLine.clinicId}/call_kind_line`);
    await transferred.waitFor((r) => responses(r).length >= 1);
    expect(responses(transferred.received)[0]).toMatchObject({ response_id: 0, content: TRANSFER_LINE, transfer_number: "+14155550124" });
    await transferred.close();

    const withoutLine = await coveredDpa("retell-kind-closed");
    const closed = await call(port, `/llm-websocket/${SECRET}/${withoutLine.clinicId}/call_kind_closed`);
    await closed.waitFor((r) => responses(r).length >= 1);
    expect(responses(closed.received)[0]).toMatchObject({ response_id: 0, content: CLOSED_LINE, end_call: true });
    // Nothing a caller says reaches the model afterwards: Retell keeps only
    // the latest response, so a later request hears the closing line again.
    closed.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "Hello?" }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responses(closed.received).map((r) => r.content)).toEqual([CLOSED_LINE, CLOSED_LINE]);
    expect(asked).toBe(false);
    await closed.close();
  });

  test("a clinic with no agreement in effect still goes to its direct line, and with none the call is closed", async () => {
    // Production with no agreement: the Services are not in effect
    // (no_agreement). The Terms still pass a forwarded call straight through.
    const ended = async (name: string) => {
      const clinic = await seedClinic(name);
      await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`, [clinic.clinicId]);
      return clinic;
    };
    const withLine = await ended("retell-ended-line");
    await inTenant(withLine.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550125')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [withLine.clinicId],
      ),
    );
    const transferred = await call(port, `/llm-websocket/${SECRET}/${withLine.clinicId}/call_ended_line`);
    await transferred.waitFor((r) => responses(r).length >= 1);
    expect(responses(transferred.received)[0]).toMatchObject({ response_id: 0, content: TRANSFER_LINE, transfer_number: "+14155550125" });
    await transferred.close();

    const withoutLine = await ended("retell-ended-closed");
    const closed = await call(port, `/llm-websocket/${SECRET}/${withoutLine.clinicId}/call_ended_closed`);
    await closed.waitFor((r) => responses(r).length >= 1);
    expect(responses(closed.received)[0]).toMatchObject({ response_id: 0, content: CLOSED_LINE, end_call: true });
    await closed.close();
  });

  test("a call whose start fails goes to the direct line when it can be read, and is closed when it cannot", async () => {
    const failingGate = async () => {
      throw new Error("settings could not be read");
    };
    const opened = async (clinicId: string) => {
      const sent: Received[] = [];
      const session = new RetellCallSession(clinicId, `call_${clinicId.slice(0, 8)}`, (m) => sent.push(m as Received), {
        responder,
        transport,
        gate: failingGate,
        ingest: async () => ({ conversationId: null }) as never,
        realCalls: true,
        // The places that hold the line without the database hold nothing
        // here: this is the line read on its own, or nothing.
        fallbackLine: async () => null,
        callDetailsWaitMs: 0,
      });
      await session.open();
      // The fall-through runs beside the message chain: wait for it to speak.
      for (let i = 0; i < 60 && responses(sent).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      return responses(sent);
    };
    const withLine = await seedClinic("retell-start-line");
    await inTenant(withLine.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550126')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [withLine.clinicId],
      ),
    );
    expect(await opened(withLine.clinicId)).toEqual([
      expect.objectContaining({ response_id: 0, content: TROUBLE_TRANSFER_LINE, transfer_number: "+14155550126" }),
    ]);
    const withoutLine = await seedClinic("retell-start-closed");
    expect(await opened(withoutLine.clinicId)).toEqual([
      expect.objectContaining({ response_id: 0, content: CLOSED_LINE, end_call: true }),
    ]);
  });

  test("a lapsed vendor's agreement: Retell's sends calls to the direct line or closes them; the host's also keeps no record", async () => {
    try {
      // A production practice under its agreement, as go-live leaves one.
      const live = async (name: string, line: string | null) => {
        const clinic = await seedClinic(name);
        await bindAgreementInEffect(clinic.clinicId);
        await getMigratorPool().query(`update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`, [clinic.clinicId]);
        if (line) {
          await inTenant(clinic.clinicId, (client) =>
            client.query(
              `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
               on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
              [clinic.clinicId, line],
            ),
          );
        }
        return clinic;
      };
      const opening = async (clinicId: string, callId: string) => {
        const c = await call(port, `/llm-websocket/${SECRET}/${clinicId}/${callId}`);
        await c.waitFor((r) => responses(r).length >= 1);
        c.send({ interaction_type: "call_details", call: { call_id: callId, from_number: "+14155550177", direction: "inbound", start_timestamp: Date.now() - 30_000 } });
        const first = responses(c.received)[0];
        await c.close();
        return first;
      };
      let asked = false;
      modelAnswer = () => {
        asked = true;
        return { reply: "model" };
      };

      // Nothing attested yet in this file: the host's agreement is not in force.
      const hostLapsed = await live("retell-host-lapsed", "+14155550127");
      expect(await opening(hostLapsed.clinicId, "call_host_lapsed")).toMatchObject({ content: TRANSFER_LINE, transfer_number: "+14155550127" });

      // Every vendor in force but Retell: phone's own vendor.
      await attestPlatform(["anthropic", "aws", "database_host"]);
      const retellLine = await live("retell-vendor-line", "+14155550128");
      expect(await opening(retellLine.clinicId, "call_vendor_line")).toMatchObject({ content: TRANSFER_LINE, transfer_number: "+14155550128" });
      const retellNone = await live("retell-vendor-closed", null);
      expect(await opening(retellNone.clinicId, "call_vendor_closed")).toMatchObject({ content: CLOSED_LINE, end_call: true });
      expect(asked).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all([...server.sessions].map((s) => s.finish()));
      // The host's lapse keeps nothing: no conversation for its call. Retell's
      // alone leaves the host covering the record, so the transferred call is kept.
      const count = async (clinicId: string) =>
        (await inTenant(clinicId, (client) => client.query(`select id from conversations`))).rows.length;
      expect(await count(hostLapsed.clinicId)).toBe(0);
      expect(await count(retellLine.clinicId)).toBe(1);
    } finally {
      // Put back as the file found it: nothing attested.
      await getMigratorPool().query(`truncate platform_compliance`);
    }
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
    expect(String(responses(c.received)[1]!.content)).toMatch(/call 9-1-1/);
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

  // The 19 October audit: answerTurn short-circuited only the urgent turn
  // itself, and the session kept every turn's words in the history it sends
  // the model on the next one.
  test("an urgent caller's words never reach the model on a later turn, and the clinic's transcript still has them", async () => {
    const clinic = await seedClinic("retell-urgent-later");
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => addRecipient(tx, { email: "desk@retell-later.test", addedBy: "test" }));
    modelAnswer = () => ({ reply: "We're open weekdays nine to five." });
    modelSaw.length = 0;
    const urgent = "I'm having a severe reaction to my filler";
    const c = await call(port, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_urgent_later`);
    await c.waitFor((r) => responses(r).length >= 1);
    // As Retell sends it: the opening line, spoken, is in the transcript.
    const opening = String(responses(c.received)[0]!.content);
    c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "agent", content: opening }, { role: "user", content: urgent }] });
    await c.waitFor((r) => responses(r).length >= 2);
    expect(String(responses(c.received)[1]!.content)).toMatch(/call 9-1-1/);
    expect(modelSaw).toHaveLength(0);
    c.send({
      interaction_type: "response_required",
      response_id: 2,
      transcript: [
        { role: "agent", content: opening },
        { role: "user", content: urgent },
        { role: "agent", content: String(responses(c.received)[1]!.content) },
        { role: "user", content: "When are you open?" },
      ],
    });
    await c.waitFor((r) => responses(r).length >= 3);
    expect(responses(c.received)[2]).toMatchObject({ response_id: 2, content: "We're open weekdays nine to five." });
    expect(modelSaw).toHaveLength(1);
    expect(JSON.stringify(modelSaw[0])).not.toContain("severe reaction");
    expect(modelSaw[0]![0]).toEqual({ role: "user", content: SCREENED_TURN });
    await c.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));
    const transcripts = transport.sent.filter((s) => s.message.phiClass === "may-carry-phi" && s.target.clinicId === clinic.clinicId);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.message.text).toContain(`Caller: ${urgent}`);
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
      expect(c.received[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: false } });
      // The caller who speaks before the transfer hears it again, never AYA.
      expect(responses(c.received)).toEqual([
        { response_type: "response", response_id: 0, content: TRANSFER_LINE, content_complete: true, end_call: false, transfer_number: "+14155550124" },
        { response_type: "response", response_id: 1, content: TRANSFER_LINE, content_complete: true, end_call: false, transfer_number: "+14155550124" },
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

    test("a clinic whose direct line is its published number is refused with the closing line, never put through to it", async () => {
      const clinic = await seedClinic("retell-test-loop");
      await getMigratorPool().query(`update clinics set published_phone_e164 = '+14155550128' where id = $1`, [clinic.clinicId]);
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550128')
           on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
          [clinic.clinicId],
        ),
      );
      const c = await call(testPort, `/llm-websocket/${SECRET}/${clinic.clinicId}/call_test_loop`);
      await c.waitFor((r) => responses(r).length >= 1);
      expect(responses(c.received)).toEqual([{ response_type: "response", response_id: 0, content: CLOSED_LINE, content_complete: true, end_call: true }]);
      await hangUp(c);
    });

    test("the demo clinic with a direct line is still answered by AYA, never transferred, and its call is no first answer", async () => {
      const demo = await seedDemoClinic("retell-test-demo-line");
      await inTenant(demo.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550129')
           on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
          [demo.clinicId],
        ),
      );
      const billingRequests = async () =>
        (await getMigratorPool().query<{ n: number }>(`select count(*)::int as n from billing_requests where clinic_id = $1`, [demo.clinicId])).rows[0]!.n;
      const before = await billingRequests();
      modelAnswer = () => ({ reply: "We're open weekdays nine to five." });
      const c = await call(testPort, `/llm-websocket/${SECRET}/${demo.clinicId}/call_test_demo_line`);
      await c.waitFor((r) => responses(r).length >= 1);
      const opening = responses(c.received)[0]!;
      expect(opening).not.toHaveProperty("transfer_number");
      expect(String(opening.content)).toMatch(/^Hi! I'm the AI assistant at .*, and this call's transcribed/);
      c.send({ interaction_type: "call_details", call: { call_id: "call_test_demo_line", from_number: "+14155550195", direction: "inbound" } });
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "agent", content: String(opening.content) }, { role: "user", content: "When are you open?" }] });
      await c.waitFor((r) => responses(r).length >= 2);
      expect(responses(c.received)[1]).toMatchObject({ response_id: 1, content: "We're open weekdays nine to five." });
      await hangUp(c);
      const { rows } = await inTenant(demo.clinicId, (client) =>
        client.query<{ external_call_id: string }>(`select external_call_id from conversations where external_call_id = 'call_test_demo_line'`),
      );
      expect(rows).toHaveLength(1);
      // Never live, so never a first answer: no plan start, no billing request.
      const { rows: channel } = await inTenant(demo.clinicId, (client) =>
        client.query<{ live_at: Date | null; first_answer_at: Date | null }>(`select live_at, first_answer_at from clinic_channels where channel = 'voice'`),
      );
      expect(channel).toEqual([{ live_at: null, first_answer_at: null }]);
      expect(await billingRequests()).toBe(before);
      const { rows: alerts } = await getMigratorPool().query(
        `select 1 from ops_alerts where event = 'voice_fallback_no_direct_line' and fields->>'clinicId' = $1`,
        [demo.clinicId],
      );
      expect(alerts).toHaveLength(0);
    });

    test("the demo clinic is answered as any call is: the AI line first, then the brain, and the call recorded", async () => {
      const demo = await seedDemoClinic("retell-test-demo");
      modelAnswer = () => ({ reply: "We're open weekdays nine to five." });
      const c = await call(testPort, `/llm-websocket/${SECRET}/${demo.clinicId}/call_test_demo`);
      await c.waitFor((r) => responses(r).length >= 1);
      expect(c.received[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
      const opening = String(responses(c.received)[0]!.content);
      expect(opening).toMatch(/^Hi! I'm the AI assistant at .*, and this call's transcribed/);
      c.send({ interaction_type: "call_details", call: { call_id: "call_test_demo", from_number: "+14155550194", direction: "inbound" } });
      // As Retell sends it: the opening line, spoken, is in the transcript.
      c.send({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "agent", content: opening }, { role: "user", content: "When are you open?" }] });
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
