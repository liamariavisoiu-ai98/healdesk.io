import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

const mocks = vi.hoisted(() => ({ scheduled: [] as Array<{ clinicId: string; callId: string }>, failSchedule: false }));
vi.mock("@/lib/voice/backstop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice/backstop")>();
  return {
    ...actual,
    scheduleCallBackstop: async (payload: { clinicId: string; callId: string }) => {
      if (mocks.failSchedule) throw new Error("queue down");
      mocks.scheduled.push(payload);
    },
  };
});

import { POST as retellWebhook } from "@/app/api/webhooks/retell/[clinicId]/route";
import { disclosureFor } from "@/lib/compliance/disclosure";
import { raiseHandover } from "@/lib/handovers/record";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { assertNoPhiInPayload, QUEUE_VOICE_CALL_BACKSTOP, QUEUES } from "@/lib/queue/boss";
import { addRecipient } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import {
  BACKSTOP_DELAY_SECONDS,
  callEventFromRetell,
  fetchRetellCall,
  handleCallBackstopJob,
  openedWithDisclosure,
  retellApiKey,
  runCallBackstop,
  turnsFromRetell,
  type RetellCall,
} from "@/lib/voice/backstop";
import { TROUBLE_TRANSFER_LINE } from "@/lib/voice/retell";
import { verifyRetellSignature } from "@/lib/voice/retell-signature";
import { createVoiceServer } from "@/voice/server";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { markDemo } from "./setup/calendar-db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The backstop for a voice call the live socket never recorded
 * (lib/voice/backstop.ts, app/api/webhooks/retell/[clinicId]): Retell's
 * signature, the one id that reaches the queue, the call read back and
 * checked against the clinic's own number, and the race with the live
 * socket, which always keeps its record and its request. Synthetic clinics,
 * a fake Retell, a fake mail transport.
 */

const KEY = "key_test_retell_engine_0123456789";
const CLINIC = "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f60";
const ASSISTANT = "+14155550100";

function sign(body: string, key = KEY, at = Date.now()): string {
  return `v=${at},d=${createHmac("sha256", key).update(body + String(at)).digest("hex")}`;
}

function webhook(body: string, options: { signature?: string | null; clinicId?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? sign(body) : options.signature;
  if (signature !== null) headers["x-retell-signature"] = signature;
  return retellWebhook(new Request(`http://localhost/api/webhooks/retell/${options.clinicId ?? CLINIC}`, { method: "POST", headers, body }), {
    params: Promise.resolve({ clinicId: options.clinicId ?? CLINIC }),
  });
}

function opening(clinicName: string): string {
  return `${disclosureFor({ clinicName, channel: "voice" })} How can I help?`;
}

function retellCall(overrides: Partial<RetellCall> & { call_id: string }): RetellCall {
  const start = Date.now() - 5 * 60_000;
  return {
    call_type: "phone_call",
    call_status: "ended",
    from_number: "+14155550192",
    to_number: ASSISTANT,
    direction: "inbound",
    start_timestamp: start,
    end_timestamp: start + 125_000,
    duration_ms: 125_000,
    transcript_object: [
      { role: "agent", content: opening("Backstop Clinic") },
      { role: "user", content: "Could I come in Thursday afternoon?" },
      { role: "agent", content: "I'll pass that to the team." },
    ],
    ...overrides,
  };
}

describe("Retell's signature on the engine's webhooks", () => {
  test("verifies the raw body with the key, and refuses anything else", () => {
    const body = '{"event":"call_ended"}';
    expect(verifyRetellSignature(body, sign(body), KEY)).toBe(true);
    expect(verifyRetellSignature(body + " ", sign(body), KEY)).toBe(false);
    expect(verifyRetellSignature(body, sign(body, "key_other"), KEY)).toBe(false);
    expect(verifyRetellSignature(body, sign(body, KEY, Date.now() - 6 * 60_000), KEY)).toBe(false);
    expect(verifyRetellSignature(body, sign(body, KEY, Date.now() + 6 * 60_000), KEY)).toBe(false);
    expect(verifyRetellSignature(body, "v=1,d=abcd", KEY)).toBe(false);
    expect(verifyRetellSignature(body, null, KEY)).toBe(false);
  });

  test("the key is the engine's own, and the placeholder reads as unset", () => {
    expect(retellApiKey({ HEALDESK_RETELL_API_KEY: " key_abc " })).toBe("key_abc");
    expect(retellApiKey({ HEALDESK_RETELL_API_KEY: "__unset__" })).toBeNull();
    expect(retellApiKey({ RETELL_API_KEY: "key_demo" })).toBeNull();
  });
});

describe("the webhook route", () => {
  const previous = process.env.HEALDESK_RETELL_API_KEY;
  beforeEach(() => {
    process.env.HEALDESK_RETELL_API_KEY = KEY;
    mocks.scheduled = [];
    mocks.failSchedule = false;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.HEALDESK_RETELL_API_KEY;
    else process.env.HEALDESK_RETELL_API_KEY = previous;
  });

  const ended = JSON.stringify({ event: "call_ended", call: { call_id: "call_abc123", transcript: "the caller's words", from_number: "+14155550192" } });

  test("a signed call_ended or call_analyzed queues the backstop with the clinic and the call id only", async () => {
    expect((await webhook(ended)).status).toBe(204);
    expect((await webhook(ended.replace("call_ended", "call_analyzed"))).status).toBe(204);
    expect(mocks.scheduled).toEqual([
      { clinicId: CLINIC, callId: "call_abc123" },
      { clinicId: CLINIC, callId: "call_abc123" },
    ]);
  });

  test("a bad, missing or stale signature queues nothing", async () => {
    expect((await webhook(ended, { signature: null })).status).toBe(401);
    expect((await webhook(ended, { signature: sign(ended, "key_wrong") })).status).toBe(401);
    expect((await webhook(ended, { signature: sign(ended, KEY, Date.now() - 10 * 60_000) })).status).toBe(401);
    expect(mocks.scheduled).toEqual([]);
  });

  test("other events are acknowledged and ignored; a malformed call id or clinic is refused", async () => {
    expect((await webhook(JSON.stringify({ event: "call_started", call: { call_id: "call_abc123" } }))).status).toBe(204);
    expect((await webhook(JSON.stringify({ event: "call_ended", call: { call_id: "../../x" } }))).status).toBe(400);
    expect((await webhook("not json")).status).toBe(400);
    expect((await webhook(ended, { clinicId: "not-a-clinic" })).status).toBe(404);
    expect(mocks.scheduled).toEqual([]);
  });

  test("with no key, or a queue that cannot take the job, Retell is told to retry", async () => {
    mocks.failSchedule = true;
    expect((await webhook(ended)).status).toBe(503);
    process.env.HEALDESK_RETELL_API_KEY = "__unset__";
    expect((await webhook(ended)).status).toBe(503);
  });
});

describe("the backstop's queue and mapping", () => {
  test("is a queue queue:install creates, and its payload passes the PHI allowlist", async () => {
    expect(QUEUES).toContain(QUEUE_VOICE_CALL_BACKSTOP);
    const sent: unknown[][] = [];
    // The real one: the route's tests above replace it.
    const { scheduleCallBackstop } = await vi.importActual<typeof import("@/lib/voice/backstop")>("@/lib/voice/backstop");
    await scheduleCallBackstop({ clinicId: CLINIC, callId: "call_abc123" }, (async (...args: unknown[]) => {
      sent.push(args);
      assertNoPhiInPayload(args[1] as Record<string, unknown>);
      return "job";
    }) as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(QUEUE_VOICE_CALL_BACKSTOP);
    expect(sent[0]![1]).toEqual({ clinicId: CLINIC, callId: "call_abc123" });
    expect(sent[0]![2]).toMatchObject({ startAfter: BACKSTOP_DELAY_SECONDS, singletonKey: `${CLINIC}:call_abc123` });

    // pg-boss declining the job: fine for a duplicate of one waiting, an error when the queue was never installed.
    const declined = (async () => null) as never;
    await expect(scheduleCallBackstop({ clinicId: CLINIC, callId: "call_abc123" }, declined, async () => true)).resolves.toBeUndefined();
    await expect(scheduleCallBackstop({ clinicId: CLINIC, callId: "call_abc123" }, declined, async () => false)).rejects.toThrow(/queue:install/);
  });

  test("Retell's call becomes the ingest's event: turns, times, minutes and the disclosure, never a request", () => {
    const mapped = callEventFromRetell(retellCall({ call_id: "call_1", to_number: "(415) 555-0100" }), { clinicId: CLINIC, callId: "call_1", assistantNumber: ASSISTANT });
    expect("event" in mapped).toBe(true);
    if (!("event" in mapped)) return;
    expect(mapped.event).toMatchObject({ externalCallId: "call_1", clinicId: CLINIC, callerPhone: "+14155550192", durationSeconds: 125, isCallback: false, answeredByAssistant: false, urgent: false });
    expect(mapped.event.outcome).toBeUndefined();
    expect(mapped.event.booking).toBeUndefined();
    expect(mapped.event.disclosurePlayedAt).toEqual(mapped.event.startedAt);
    expect(mapped.event.transcriptTurns).toEqual([
      { speaker: "assistant", text: opening("Backstop Clinic") },
      { speaker: "person", text: "Could I come in Thursday afternoon?" },
      { speaker: "assistant", text: "I'll pass that to the team." },
    ]);
  });

  test("refuses a call that is not this clinic's, not over, not a phone call, or not the one asked for", () => {
    const clinic = { clinicId: CLINIC, callId: "call_1", assistantNumber: ASSISTANT };
    expect(callEventFromRetell(retellCall({ call_id: "call_1", to_number: "+14155550111" }), clinic)).toEqual({ refused: "not_this_clinic" });
    expect(callEventFromRetell(retellCall({ call_id: "call_1" }), { ...clinic, assistantNumber: null })).toEqual({ refused: "not_this_clinic" });
    expect(callEventFromRetell(retellCall({ call_id: "call_1", call_status: "ongoing" }), clinic)).toEqual({ refused: "not_ended" });
    expect(callEventFromRetell(retellCall({ call_id: "call_1", call_type: "web_call" }), clinic)).toEqual({ refused: "not_a_phone_call" });
    expect(callEventFromRetell(retellCall({ call_id: "call_2" }), clinic)).toEqual({ refused: "wrong_call" });
  });

  test("refuses an outbound call, and a call our endpoint never spoke on; no disclosure claimed without the locked line", () => {
    const clinic = { clinicId: CLINIC, callId: "call_1", assistantNumber: ASSISTANT };
    expect(callEventFromRetell(retellCall({ call_id: "call_1", direction: "outbound", from_number: ASSISTANT, to_number: "+14155550192" }), clinic)).toEqual({ refused: "outbound" });
    // The socket never opened (Retell's error_llm_websocket_open): only the caller is in the transcript.
    expect(callEventFromRetell(retellCall({ call_id: "call_1", transcript_object: [{ role: "user", content: "Hello?" }] }), clinic)).toEqual({ refused: "never_answered" });
    expect(callEventFromRetell(retellCall({ call_id: "call_1", transcript_object: [] }), clinic)).toEqual({ refused: "never_answered" });
    expect(callEventFromRetell(retellCall({ call_id: "call_1", start_timestamp: undefined }), clinic)).toEqual({ refused: "no_start" });
    const mapped = callEventFromRetell(
      retellCall({ call_id: "call_1", transcript_object: [{ role: "agent", content: "Hello there." }, { role: "user", content: "Hi" }] }),
      clinic,
    );
    expect("event" in mapped && mapped.event.isCallback).toBe(false);
    expect("event" in mapped && mapped.event.disclosurePlayedAt).toBeUndefined();
    // A call cut before the caller spoke is still recorded, with no transcript to email.
    const silent = callEventFromRetell(retellCall({ call_id: "call_1", transcript_object: [{ role: "agent", content: opening("X") }] }), clinic);
    expect("event" in silent && silent.event.transcriptTurns).toBeUndefined();
    expect(openedWithDisclosure(turnsFromRetell([{ role: "user", content: "hi" }]))).toBe(false);
    expect(turnsFromRetell([{ role: "transfer_target", content: "x" }, { role: "user", content: "  " }, null, "x"])).toEqual([]);
  });

  test("the caller's words are joined between agent turns, and a card number is cut, even read out across two", () => {
    // 4242 4242 4242 4242 passes the Luhn check.
    const turns = turnsFromRetell([
      { role: "agent", content: "How can I help?" },
      { role: "user", content: "My card is 4242 4242" },
      { role: "user", content: "4242 4242, can I pay a deposit?" },
      { role: "agent", content: "I can't take card numbers on a call." },
      { role: "user", content: "Call me on 415 555 0192" },
    ]);
    expect(turns).toEqual([
      { speaker: "assistant", text: "How can I help?" },
      { speaker: "person", text: "My card is [card number removed], can I pay a deposit?" },
      { speaker: "assistant", text: "I can't take card numbers on a call." },
      { speaker: "person", text: "Call me on 415 555 0192" },
    ]);
  });

  test("a card number read across two utterances is cut when the recogniser ends the first with a full stop", () => {
    const turns = turnsFromRetell([
      { role: "agent", content: "How can I help?" },
      { role: "user", content: "My card is 4242 4242." },
      { role: "user", content: "4242 4242, can I pay a deposit?" },
    ]);
    expect(turns[1]).toEqual({ speaker: "person", text: "My card is [card number removed], can I pay a deposit?" });
  });

  test("an urgent alert or a handover the live session raised on the call marks it as the session would have", () => {
    const clinic = { clinicId: CLINIC, callId: "call_1", assistantNumber: ASSISTANT };
    const urgent = callEventFromRetell(retellCall({ call_id: "call_1" }), { ...clinic, raised: { urgent: true, handover: false } });
    expect("event" in urgent && { urgent: urgent.event.urgent, outcome: urgent.event.outcome }).toEqual({ urgent: true, outcome: "escalated_to_human" });
    const handover = callEventFromRetell(retellCall({ call_id: "call_1" }), { ...clinic, raised: { urgent: false, handover: true } });
    expect("event" in handover && { urgent: handover.event.urgent, outcome: handover.event.outcome }).toEqual({ urgent: false, outcome: "escalated_to_human" });
    const neither = callEventFromRetell(retellCall({ call_id: "call_1" }), { ...clinic, raised: { urgent: false, handover: false } });
    expect("event" in neither && { urgent: neither.event.urgent, outcome: neither.event.outcome }).toEqual({ urgent: false, outcome: undefined });
  });

  test("a card number said in its own utterance beside a phone number is still cut", () => {
    // Joined, "415 555 0192 4242 4242 4242 4242" is one run of digits that fails the Luhn check.
    const turns = turnsFromRetell([
      { role: "agent", content: "How can I help?" },
      { role: "user", content: "Call 415 555 0192" },
      { role: "user", content: "4242 4242 4242 4242" },
    ]);
    expect(turns[1]).toEqual({ speaker: "person", text: "Call 415 555 0192 [card number removed]" });
  });

  test("reads the call from Retell with the key, and throws on a failure so the job retries", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ call_id: "call_1" });
    }) as unknown as typeof fetch;
    expect(await fetchRetellCall("call_1", KEY, ok)).toEqual({ call_id: "call_1" });
    expect(seen).toEqual([{ url: "https://api.retellai.com/v2/get-call/call_1", auth: `Bearer ${KEY}` }]);
    const down = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    await expect(fetchRetellCall("call_1", KEY, down)).rejects.toThrow(/502/);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${crypto.randomUUID()}` };
  }
}

describeDb("the backstop against the database", () => {
  const transport = new FakeTransport();
  /**
   * Retell's delete-call, faked for every test here: once a call is
   * recorded the job deletes it at Retell (lib/voice/recording-alerts.ts),
   * and no test may reach the real Retell.
   */
  let deletes: string[] = [];

  beforeAll(async () => {
    await runMigrations();
  }, 180_000);
  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'transcript-emails'`);
    transport.sent = [];
    deletes = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "DELETE" || !url.startsWith("https://api.retellai.com/v2/delete-call/")) throw new Error(`unexpected fetch ${url}`);
      deletes.push(decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)));
      return new Response(null, { status: 204 });
    }) as typeof fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await closePools();
  });

  async function clinicWithNumber(label: string) {
    const clinic = await seedClinic(label);
    await getMigratorPool().query(`update clinics set assistant_number_e164 = $2 where id = $1`, [clinic.clinicId, ASSISTANT]);
    await withTenant({ clinicId: clinic.clinicId, actor: { type: "service", serviceName: "backstop-test" } }, (tx) => addRecipient(tx, { email: "desk@backstop.test", addedBy: "test" }));
    return clinic;
  }

  async function counts(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const one = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]!.n);
      return {
        conversations: await one(`select count(*) as n from conversations`),
        requests: await one(`select count(*) as n from booking_requests`),
        transcripts: await one(`select count(*) as n from transcript_emails`),
        usage: await one(`select count(*) as n from usage_events`),
      };
    });
  }

  test("a call nobody recorded is recorded once: the conversation, the transcript, no request; a second run does nothing", async () => {
    const clinic = await clinicWithNumber("backstop-lost");
    const fetchCall = vi.fn(async (callId: string) => retellCall({ call_id: callId }));

    const first = await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_lost" }, { apiKey: KEY, realCalls: true, fetchCall, transport });
    expect(first.status).toBe("recorded");
    expect(first.status === "recorded" && first.result.duplicate).toBe(false);

    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ external_call_id: string; outcome: string | null; disclosure_played_at: Date | null; contact_id: string | null }>(
        `select external_call_id, outcome, disclosure_played_at, contact_id from conversations`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_call_id: "call_lost", outcome: null });
    expect(rows[0]!.disclosure_played_at).toBeTruthy();
    expect(rows[0]!.contact_id).toBeTruthy();
    const after = await counts(clinic.clinicId);
    expect(after).toMatchObject({ conversations: 1, requests: 0, transcripts: 1 });
    const transcripts = transport.sent.filter((s) => s.message.phiClass === "may-carry-phi");
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.message.text).toContain("Caller: Could I come in Thursday afternoon?");

    // Recorded and its transcript sealed, so Retell's copy is deleted.
    expect(deletes).toEqual(["call_lost"]);

    const again = await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_lost" }, { apiKey: KEY, realCalls: true, fetchCall, transport });
    expect(again).toEqual({ status: "already_recorded" });
    expect(fetchCall).toHaveBeenCalledTimes(1);
    // A second run asks for the delete again, which Retell answers as done.
    expect(deletes).toEqual(["call_lost", "call_lost"]);
    expect(await counts(clinic.clinicId)).toEqual(after);
    expect(transport.sent.filter((s) => s.message.phiClass === "may-carry-phi")).toHaveLength(1);
  });

  test("a call the live socket recorded is left alone: no second request, transcript or minutes, Retell is not read, and its copy is deleted", async () => {
    const clinic = await clinicWithNumber("backstop-live");
    const SECRET = "test-retell-llm-secret-0123456789";
    const responder = async () => JSON.stringify({ reply: "Thanks Dana, I'll pass Thursday afternoon to the team.", booking: { wants: true, first_name: "Dana", window: "Thursday afternoon", service: "consultation" } });
    const voice = createVoiceServer({ secret: SECRET, responder, transport, realCalls: true });
    await new Promise<void>((resolve) => voice.server.listen(0, "127.0.0.1", () => resolve()));
    const port = (voice.server.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/llm-websocket/${SECRET}/${clinic.clinicId}/call_live`);
      const received: Record<string, unknown>[] = [];
      const answered = new Promise<void>((resolve) =>
        ws.on("message", (data) => {
          received.push(JSON.parse(String(data)) as Record<string, unknown>);
          if (received.filter((m) => m.response_type === "response").length >= 2) resolve();
        }),
      );
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      ws.send(JSON.stringify({ interaction_type: "call_details", call: { call_id: "call_live", from_number: "+14155550192", direction: "inbound", start_timestamp: Date.now() - 60_000 } }));
      ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "I'm Dana, could I come Thursday afternoon?" }] }));
      await answered;
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        ws.close();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all([...voice.sessions].map((s) => s.finish()));
    } finally {
      await voice.drain();
    }
    const live = await counts(clinic.clinicId);
    expect(live).toMatchObject({ conversations: 1, requests: 1, transcripts: 1 });
    const mailed = transport.sent.length;

    const fetchCall = vi.fn(async (callId: string) => retellCall({ call_id: callId }));
    expect(await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_live" }, { apiKey: KEY, realCalls: true, fetchCall, transport })).toEqual({ status: "already_recorded" });
    expect(fetchCall).not.toHaveBeenCalled();
    expect(deletes).toEqual(["call_live"]);
    expect(await counts(clinic.clinicId)).toEqual(live);
    expect(transport.sent.length).toBe(mailed);
  });

  test("two backstop runs at once record the call once", async () => {
    const clinic = await clinicWithNumber("backstop-race");
    const fetchCall = async (callId: string) => retellCall({ call_id: callId });
    const results = await Promise.all([
      runCallBackstop({ clinicId: clinic.clinicId, callId: "call_race" }, { apiKey: KEY, realCalls: true, fetchCall, transport }),
      runCallBackstop({ clinicId: clinic.clinicId, callId: "call_race" }, { apiKey: KEY, realCalls: true, fetchCall, transport }),
    ]);
    const recorded = results.filter((r) => r.status === "recorded" && !r.result.duplicate);
    expect(recorded).toHaveLength(1);
    expect(await counts(clinic.clinicId)).toMatchObject({ conversations: 1, requests: 0, transcripts: 1 });
    expect(transport.sent.filter((s) => s.message.phiClass === "may-carry-phi")).toHaveLength(1);
  });

  test("a failed job is retried with a described error, never the original, which pg-boss would store", async () => {
    const clinic = await clinicWithNumber("backstop-leak");
    // What drizzle throws when a statement fails: the parameters, the caller's number and name, in its message and on itself.
    const leaky = new DrizzleQueryError("insert into contacts (phone, full_name) values ($1, $2)", ["+14155550192", "Dana"], Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    const thrown = await handleCallBackstopJob(
      { clinicId: clinic.clinicId, callId: "call_leak" },
      { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id }), ingest: async () => { throw leaky; }, transport },
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(leaky);
    expect(Object.keys(thrown as object)).toEqual([]);
    expect((thrown as Error).message).not.toContain("4155550192");
    expect((thrown as Error).message).not.toContain("Dana");
    // The ingest failed, so Retell's copy is the only one: never deleted.
    expect(deletes).toEqual([]);
  });

  test("in test mode only the demo clinic's calls are backstopped; any other clinic's is dropped without asking Retell", async () => {
    const other = await clinicWithNumber("backstop-test-mode");
    const fetchCall = vi.fn(async (callId: string) => retellCall({ call_id: callId }));
    expect(await runCallBackstop({ clinicId: other.clinicId, callId: "call_other_clinic" }, { apiKey: KEY, realCalls: false, fetchCall, transport })).toEqual({ status: "test_mode" });
    expect(fetchCall).not.toHaveBeenCalled();
    expect(await counts(other.clinicId)).toMatchObject({ conversations: 0, transcripts: 0, usage: 0 });

    const demo = await clinicWithNumber("backstop-demo");
    await markDemo(demo.clinicId);
    const recorded = await runCallBackstop({ clinicId: demo.clinicId, callId: "call_demo_clinic" }, { apiKey: KEY, realCalls: false, fetchCall, transport });
    expect(recorded.status).toBe("recorded");
    expect(await counts(demo.clinicId)).toMatchObject({ conversations: 1, transcripts: 1 });
    expect(deletes).toEqual(["call_demo_clinic"]);
  });

  test("a call to another number is not this clinic's; a call still in progress is retried; an outbound call is refused once", async () => {
    const clinic = await clinicWithNumber("backstop-refusals");
    const other = await runCallBackstop(
      { clinicId: clinic.clinicId, callId: "call_other" },
      { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, to_number: "+14155550199" }), transport },
    );
    expect(other).toEqual({ status: "refused", reason: "not_this_clinic" });

    await expect(
      runCallBackstop({ clinicId: clinic.clinicId, callId: "call_ongoing" }, { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, call_status: "ongoing" }), transport }),
    ).rejects.toThrow(/in progress/);

    await expect(
      runCallBackstop({ clinicId: clinic.clinicId, callId: "call_registered" }, { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, call_status: "registered" }), transport }),
    ).rejects.toThrow(/in progress/);
    // A call that failed at Retell is final: refused, not retried.
    expect(
      await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_error" }, { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, call_status: "error" }), transport }),
    ).toEqual({ status: "refused", reason: "not_ended" });

    // Outbound: refused without the ingest, so the live socket's security event is not recorded twice.
    const ingest = vi.fn();
    const outbound = await runCallBackstop(
      { clinicId: clinic.clinicId, callId: "call_out" },
      { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, direction: "outbound", from_number: ASSISTANT, to_number: "+14155550192" }), ingest, transport },
    );
    expect(outbound).toEqual({ status: "refused", reason: "outbound" });
    expect(ingest).not.toHaveBeenCalled();

    // Our endpoint never answered: nothing recorded, counted or billed.
    expect(
      await runCallBackstop(
        { clinicId: clinic.clinicId, callId: "call_unanswered" },
        { apiKey: KEY, realCalls: true, fetchCall: async (id) => retellCall({ call_id: id, transcript_object: [{ role: "user", content: "Hello?" }] }), ingest, transport },
      ),
    ).toEqual({ status: "refused", reason: "never_answered" });

    expect(await runCallBackstop({ clinicId: "0f6c2b8e-2a4f-4c1e-9a77-0b2d3c4e5f61", callId: "call_x" }, { apiKey: KEY, realCalls: true, transport })).toEqual({ status: "unknown_clinic" });

    await expect(runCallBackstop({ clinicId: clinic.clinicId, callId: "call_nokey" }, { apiKey: null, realCalls: true, transport })).rejects.toThrow(/HEALDESK_RETELL_API_KEY/);
    expect(await counts(clinic.clinicId)).toMatchObject({ conversations: 0, requests: 0, transcripts: 0, usage: 0 });
    // Nothing recorded here, so nothing deleted at Retell.
    expect(deletes).toEqual([]);
  });

  async function stored(clinicId: string, callId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ urgent: boolean; outcome: string | null; recovery_reason: string | null; disclosure_played_at: Date | null }>(
        `select urgent, outcome, recovery_reason, disclosure_played_at from conversations where external_call_id = $1`,
        [callId],
      ),
    );
    return rows[0];
  }

  test("a call whose urgent alert went out is recorded urgent, so the URGENT email's link finds it marked", async () => {
    const clinic = await clinicWithNumber("backstop-urgent");
    const actor = { type: "agent" as const, serviceName: "retell-voice" };
    // What the live session queued when the urgent screen matched, before its task died.
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) => notifyBookingAlert(tx, "urgent", { callId: "call_urgent", channel: "voice" }));
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) => raiseHandover(tx, { channel: "voice", callId: "call_handover" }));
    const fetchCall = async (callId: string) => retellCall({ call_id: callId });

    for (const callId of ["call_urgent", "call_handover", "call_plain"]) {
      const outcome = await runCallBackstop({ clinicId: clinic.clinicId, callId }, { apiKey: KEY, realCalls: true, fetchCall, transport });
      expect(outcome.status, callId).toBe("recorded");
    }
    expect(await stored(clinic.clinicId, "call_urgent")).toMatchObject({ urgent: true, outcome: "escalated_to_human" });
    expect(await stored(clinic.clinicId, "call_handover")).toMatchObject({ urgent: false, outcome: "escalated_to_human" });
    expect(await stored(clinic.clinicId, "call_plain")).toMatchObject({ urgent: false, outcome: null });
  });

  test("a call AYA never spoke on, put through by the fall-through, is recorded but neither billed nor counted as answered", async () => {
    const clinic = await clinicWithNumber("backstop-trouble");
    await seedEntitled(clinic.clinicId);
    const fetchCall = async (callId: string) =>
      callId === "call_trouble"
        ? retellCall({
            call_id: callId,
            duration_ms: 40_000,
            transcript_object: [
              { role: "user", content: "Hello?" },
              { role: "agent", content: TROUBLE_TRANSFER_LINE },
            ],
          })
        : retellCall({ call_id: callId });

    const answered = await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_answered" }, { apiKey: KEY, realCalls: true, fetchCall, transport });
    expect(answered.status === "recorded" && answered.result.recoveryReason).not.toBeNull();
    expect(await counts(clinic.clinicId)).toMatchObject({ conversations: 1, usage: 1 });

    const trouble = await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_trouble" }, { apiKey: KEY, realCalls: true, fetchCall, transport });
    expect(trouble.status).toBe("recorded");
    expect(trouble.status === "recorded" && trouble.result.recoveryReason).toBeNull();
    expect(await stored(clinic.clinicId, "call_trouble")).toMatchObject({ recovery_reason: null, disclosure_played_at: null });
    // Recorded, its words emailed, and no minutes.
    expect(await counts(clinic.clinicId)).toMatchObject({ conversations: 2, transcripts: 2, usage: 1 });
  });

  test("a card number read out around an agent turn is cut before the transcript is sealed and emailed", async () => {
    const clinic = await clinicWithNumber("backstop-split-card");
    const fetchCall = async (callId: string) =>
      retellCall({
        call_id: callId,
        transcript_object: [
          { role: "agent", content: opening("Backstop Clinic") },
          { role: "user", content: "Can I pay the deposit? My card is 4242 4242." },
          { role: "agent", content: "Please don't read me card numbers." },
          { role: "user", content: "4242 4242, expiry 12/28." },
        ],
      });
    expect((await runCallBackstop({ clinicId: clinic.clinicId, callId: "call_split" }, { apiKey: KEY, realCalls: true, fetchCall, transport })).status).toBe("recorded");
    const transcripts = transport.sent.filter((s) => s.message.phiClass === "may-carry-phi");
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.message.text).not.toContain("4242");
    expect(transcripts[0]!.message.text).toContain("Caller: Can I pay the deposit? My card is [card number removed].");
    expect(transcripts[0]!.message.text).toContain("Caller: [card number removed], expiry 12/28.");
  });
});
