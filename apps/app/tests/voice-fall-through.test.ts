import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

const notified = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/ops/notify", () => ({
  notifyOps: async (event: string, fields: Record<string, unknown>) => {
    notified.push({ event, fields });
  },
  notifyOpsOnce: async () => {},
}));
// No database here: any tenant read fails as one that refuses would,
// unless a test hands back what the read would have returned.
const tenant = vi.hoisted(() => ({ result: undefined as unknown, hang: false }));
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    if (tenant.hang) return new Promise(() => {});
    if (tenant.result !== undefined) return tenant.result;
    throw new Error("connect ECONNREFUSED");
  },
}));
// The urgent alert's email, sent once its row has committed: counted here.
const outbox = vi.hoisted(() => ({ delivered: 0 }));
vi.mock("@/lib/email/outbox", () => ({
  deliverCriticalAfterCommit: async () => {
    outbox.delivered += 1;
  },
}));
const turn = vi.hoisted(() => ({ throws: false }));
vi.mock("@/lib/assistant/turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant/turn")>();
  return {
    ...actual,
    answerTurn: (...args: Parameters<typeof actual.answerTurn>) => {
      if (turn.throws) throw new Error("boom");
      return actual.answerTurn(...args);
    },
  };
});

import type { AssistantFacts } from "@/lib/assistant/facts";
import { FAILURE_LINE } from "@/lib/assistant/turn";
import { fallbackLineFor, forgetDirectLines, rememberDirectLine, usableLine } from "@/lib/voice/fallback-line";
import { CLOSED_LINE, RetellCallSession, TRANSFER_LINE, TROUBLE_TRANSFER_LINE, type RetellOutbound } from "@/lib/voice/retell";
import type { VoiceCallEvent } from "@/lib/voice/ingest";
import { getRetellPhoneNumber, setRetellFallbackNumber } from "@/lib/voice/retell-api";
import { syncRetellFallbacks, wantedFallback } from "@/lib/voice/retell-fallback-sync";
import { createVoiceServer } from "@/voice/server";

/**
 * The voice fall-through (T14): a call that cannot start because the
 * database cannot be read still reaches the clinic's direct line, known from
 * this process's memory or from the fallback number Retell holds for the AYA
 * number; a turn that throws still reaches a person; and the hourly sync that
 * keeps Retell's fallback on the direct line. No database, no Retell: the
 * gate fails on purpose and Retell's API is a fake fetch.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-00000000f411";
const AYA = "+15125550142";
const DIRECT = "+15125550199";
const KEY = "key_test_retell";
const PUBLISHED = "+15125550100";

/** The clinic's facts, as the start reads them (the tenant read is a stand-in here). */
const FACTS: AssistantFacts = {
  clinicId: CLINIC,
  clinicName: "Fall Clinic",
  specialty: "med-spa",
  timeZone: "America/Chicago",
  phone: PUBLISHED,
  urgentPhone: null,
  vetReferralPhone: null,
  directLine: DIRECT,
  address: null,
  hours: [],
  openingHours: null,
  services: [],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: [],
  requirements: [],
  greeting: { phone: "How can I help today?", chat: "How can I help?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};
const OPENING = /^Hi, I'm an AI assistant for Fall Clinic — not a human\. This call is transcribed/;
const URGENT_WORDS = "Hello? I'm having a severe reaction to my filler";

type Recorded = Pick<VoiceCallEvent, "urgent" | "disclosurePlayedAt" | "transcriptTurns">;
const said = (id: number, transcript: { role: string; content: string }[]) =>
  JSON.stringify({ interaction_type: "response_required", response_id: id, transcript });

const down = async () => {
  throw new Error("connect ECONNREFUSED");
};

type Fetched = { url: string; method: string; body: string | null; auth: string | null };

function fakeRetell(numbers: Record<string, { fallback_number?: string | null }>, options: { status?: number; ignoresPatch?: boolean } = {}) {
  const calls: Fetched[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", body: (init?.body as string | undefined) ?? null, auth: headers.get("authorization") });
    if (options.status) return new Response("{}", { status: options.status });
    const number = decodeURIComponent(url.split("/").pop()!);
    const known = numbers[number];
    // Retell's own "no such number" answer: a 404 with a JSON body whose
    // status is "error" (live, 22 October 2026). A bare 404 is not it.
    if (!known) return Response.json({ status: "error", message: "Not Found" }, { status: 404 });
    if (init?.method === "PATCH" && !options.ignoresPatch) {
      known.fallback_number = (JSON.parse(String(init.body)) as { fallback_number: string }).fallback_number;
      return Response.json({ phone_number: number, ...known });
    }
    return Response.json({ phone_number: number, ...known });
  }) as typeof fetch;
  return { fetcher, calls };
}

function session(deps: Partial<ConstructorParameters<typeof RetellCallSession>[3]> = {}) {
  const sent: RetellOutbound[] = [];
  const s = new RetellCallSession(CLINIC, "call_fall_through", (m) => sent.push(m), {
    responder: null,
    gate: down,
    ingest: async () => ({ conversationId: "c", duplicate: false }) as never,
    callDetailsWaitMs: 50,
    realCalls: true,
    ...deps,
  });
  const responses = () => sent.filter((m): m is Extract<RetellOutbound, { response_type: "response" }> => m.response_type === "response");
  return { s, sent, responses };
}

/** The call ends once the fall-through has spoken: finish() is the hang-up. */
async function settled(s: RetellCallSession): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await s.finish();
}

const details = (to: string | null) =>
  JSON.stringify({ interaction_type: "call_details", call: { from_number: "+15125550100", ...(to ? { to_number: to } : {}), direction: "inbound" } });

beforeEach(() => {
  tenant.result = undefined;
  tenant.hang = false;
  forgetDirectLines();
  notified.length = 0;
  outbox.delivered = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("a call that cannot read the database", () => {
  test("goes to the direct line this process remembers from the clinic's last call", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([
      expect.objectContaining({ response_id: 0, content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT, end_call: false }),
    ]);
    expect(notified).toEqual([{ event: "voice_call_start_failed", fields: { clinicId: CLINIC, code: "transferred_memory" } }]);
  });

  test("with nothing remembered, reads the fallback Retell holds for the number called", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: DIRECT } });
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: KEY, fetch: retell.fetcher }) });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(retell.calls).toEqual([
      { url: "https://api.retellai.com/get-phone-number/%2B15125550142", method: "GET", body: null, auth: `Bearer ${KEY}` },
    ]);
    expect(responses()[0]).toMatchObject({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT });
    expect(notified[0]!.fields.code).toBe("transferred_retell");
  });

  test("never sends the caller back to the number they called", async () => {
    rememberDirectLine(CLINIC, AYA);
    const retell = fakeRetell({ [AYA]: { fallback_number: AYA } });
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: KEY, fetch: retell.fetcher }) });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
    expect(responses()[0]).not.toHaveProperty("transfer_number");
  });

  test("closes with the fixed line only when nowhere holds a line, Retell failing included", async () => {
    const retell = fakeRetell({}, { status: 503 });
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: KEY, fetch: retell.fetcher }) });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
    expect(notified[0]!.fields.code).toBe("closed");
  });

  test("still falls through when Retell's call details never come", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await settled(s);
    expect(responses()[0]).toMatchObject({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT });
  });

  test("an outbound call is ended, never put through", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(JSON.stringify({ interaction_type: "call_details", call: { to_number: AYA, direction: "outbound" } }));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: "", end_call: true })]);
  });

  test("a gate that named the line before the facts read failed transfers there at once", async () => {
    const { s, responses } = session({
      gate: async () => ({ decision: "pass_through", reason: "ai_paused", directLine: DIRECT }) as never,
      fallbackLine: async () => {
        throw new Error("not asked");
      },
    });
    await s.open();
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
    expect(notified[0]!.fields.code).toBe("transferred_gate");
  });

  test("a database that hangs rather than refuses still falls through, within the deadline", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const hang = () => new Promise<never>(() => {});
    const { s, responses } = session({ gate: hang, startDeadlineMs: 30, fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
  });

  test("a start that was slow, not dead, answers the call normally once it is in", async () => {
    tenant.result = { clinicId: CLINIC, directLine: DIRECT, phone: null };
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "pass_through", reason: "ai_paused", directLine: DIRECT } as never), 80)),
      fallbackLine: async () => null,
    });
    await s.open();
    await s.handle(details(AYA));
    await new Promise((r) => setTimeout(r, 150));
    expect(responses()).toEqual([expect.objectContaining({ content: TRANSFER_LINE, transfer_number: DIRECT })]);
    await settled(s);
    expect(notified).toEqual([]);
  });

  test("a line the gate names after the deadline is still used when the facts never come", async () => {
    let gateDone: (d: unknown) => void = () => {};
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => (gateDone = resolve)) as never,
      fallbackLine: async () => {
        // The gate answers while the lookup runs; the facts read then fails.
        gateDone({ decision: "pass_through", reason: "ai_paused", directLine: DIRECT });
        return null;
      },
    });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
    expect(notified[0]!.fields.code).toBe("transferred_gate");
  });

  test("a caller who hangs up before the fall-through speaks hears nothing, and ops is told so", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const events: { disclosurePlayedAt?: Date }[] = [];
    const { s, responses } = session({
      fallbackLine: (input) => fallbackLineFor(input, { key: null }),
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    await s.finish();
    expect(responses()).toEqual([]);
    expect(notified).toEqual([{ event: "voice_call_start_failed", fields: { clinicId: CLINIC, code: "hung_up" } }]);
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
  });

  test("a gate line that arrives while the lookup runs is used at once, without waiting out the grace", async () => {
    let gateDone: (d: unknown) => void = () => {};
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => (gateDone = resolve)) as never,
      fallbackLine: async () => {
        gateDone({ decision: "pass_through", reason: "ai_paused", directLine: DIRECT });
        await new Promise((r) => setTimeout(r, 5));
        return null;
      },
    });
    // The facts read then hangs, so the late start would hold this for five seconds.
    tenant.hang = true;
    const started = Date.now();
    await s.open();
    await s.handle(details(AYA));
    await new Promise((r) => setTimeout(r, 200));
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
    expect(Date.now() - started).toBeLessThan(1_000);
    await s.finish();
  });

  test("a caller who hangs up during a slow start is recorded as having heard nothing", async () => {
    tenant.result = { clinicId: CLINIC, directLine: DIRECT, phone: null };
    const events: { disclosurePlayedAt?: Date }[] = [];
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "answer" } as never), 80)),
      fallbackLine: async () => null,
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    await s.handle(details(AYA));
    await s.finish();
    expect(events).toHaveLength(1);
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
    expect(responses().some((r) => r.content === TRANSFER_LINE || /AI assistant/.test(r.content))).toBe(false);
  });

  test("a caller who speaks into the silence of a slow start is answered on those words once it lands, urgent ones included", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "answer" } as never), 80)),
      fallbackLine: async () => null,
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    await s.handle(details(AYA));
    await s.handle(said(1, [{ role: "user", content: URGENT_WORDS }]));
    expect(responses()).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    // The urgent screen saw the words: the fixed reply, on the request
    // they came with, and the clinic's alert queued. Not the bare opening.
    expect(responses()).toHaveLength(1);
    expect(responses()[0]).toMatchObject({ response_id: 1, end_call: false });
    expect(responses()[0]!.content).toMatch(/call 911/);
    expect(outbox.delivered).toBe(1);
    await s.finish();
    expect(events[0]).toMatchObject({ urgent: true });
    expect(events[0]!.transcriptTurns?.[0]).toEqual({ speaker: "person", text: URGENT_WORDS });
    // The opening line was owed, not said: the record does not claim it.
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
    expect(notified).toEqual([]);
  });

  test("words said into the silence of a slow start get the opening line first, then the answer, once", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const { s, responses } = session({
      startDeadlineMs: 20,
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "answer" } as never), 80)),
      fallbackLine: async () => null,
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    await s.handle(details(AYA));
    await s.handle(said(1, [{ role: "user", content: "Hello? When are you open?" }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(responses()).toHaveLength(1);
    expect(responses()[0]!.response_id).toBe(1);
    expect(responses()[0]!.content).toMatch(OPENING);
    // No model here: the failure line, after the opening.
    expect(responses()[0]!.content.endsWith(FAILURE_LINE)).toBe(true);
    await s.handle(said(2, [{ role: "user", content: "Hello? When are you open?" }, { role: "agent", content: responses()[0]!.content }, { role: "user", content: "Hello?" }]));
    expect(responses()[1]!.content).not.toMatch(/AI assistant/);
    await s.finish();
    expect(events[0]!.disclosurePlayedAt).toBeInstanceOf(Date);
  });

  test("a caller who speaks before the transfer is said gets it on the newest request, and again after", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: DIRECT } });
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { s, responses } = session({
      fallbackLine: async (input) => {
        await slow;
        return fallbackLineFor(input, { key: KEY, fetch: retell.fetcher });
      },
    });
    await s.open();
    await s.handle(details(AYA));
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "hello?" }] }));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(responses()).toEqual([expect.objectContaining({ response_id: 1, transfer_number: DIRECT })]);
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "user", content: "hello??" }] }));
    expect(responses()[1]).toMatchObject({ response_id: 2, content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT });
    await settled(s);
  });

  test("never remembers a line equal to the clinic's published number", async () => {
    rememberDirectLine(CLINIC, DIRECT, DIRECT);
    expect(await fallbackLineFor({ clinicId: CLINIC, calledNumber: AYA }, { key: null })).toBeNull();
  });

  test("a lookup that throws closes the call rather than leaving it silent", async () => {
    const { s, responses } = session({ fallbackLine: down });
    await s.open();
    await s.handle(details(AYA));
    await settled(s);
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
  });
});

describe("a call whose socket closes while the start is read", () => {
  const capture = (events: Recorded[]) => async (event: VoiceCallEvent) => {
    events.push(event);
    return {} as never;
  };

  test("says nothing, and is recorded as having heard nothing, though the start lands inside its deadline", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const { s, responses } = session({
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "answer" } as never), 40)),
      ingest: capture(events),
    });
    const opening = s.open();
    s.socketClosed();
    await opening;
    await s.finish();
    expect(responses()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
  });

  test("the server tells the session the moment the socket closes, not in turn behind the start", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const secret = "test-retell-llm-secret-0123456789";
    const voice = createVoiceServer({
      secret,
      responder: null,
      realCalls: true,
      sessionDeps: {
        gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "answer" } as never), 80)),
        ingest: capture(events),
      },
    });
    await new Promise<void>((resolve) => voice.server.listen(0, "127.0.0.1", () => resolve()));
    const port = (voice.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/llm-websocket/${secret}/${CLINIC}/call_hung_up`);
    const received: { response_type?: string }[] = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as { response_type?: string }));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    await new Promise((r) => setTimeout(r, 200));
    await voice.drain();
    expect(received.filter((m) => m.response_type === "response")).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
  });
});

describe("the opening line", () => {
  test("left unsaid by an urgent first reply is said before the next reply, and the record says when", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const { s, responses } = session({
      gate: async () => ({ decision: "answer" }) as never,
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    expect(responses()[0]!.content).toMatch(OPENING);
    // Retell dropped it: the caller spoke first, and urgently.
    await s.handle(said(1, [{ role: "user", content: URGENT_WORDS }]));
    const urgent = responses()[1]!.content;
    expect(urgent).toMatch(/call 911/);
    expect(urgent).not.toMatch(/transcribed/);
    await s.handle(said(2, [{ role: "user", content: URGENT_WORDS }, { role: "agent", content: urgent }, { role: "user", content: "Okay, thank you" }]));
    expect(responses()[2]!.content).toMatch(OPENING);
    await s.handle(
      said(3, [
        { role: "agent", content: responses()[2]!.content },
        { role: "user", content: "Thanks" },
      ]),
    );
    expect(responses()[3]!.content).not.toMatch(/AI assistant/);
    await s.finish();
    expect(events[0]!.disclosurePlayedAt).toBeInstanceOf(Date);
  });

  test("a call that ends on the urgent reply is recorded as not having heard the transcription notice", async () => {
    tenant.result = FACTS;
    const events: Recorded[] = [];
    const { s } = session({
      gate: async () => ({ decision: "answer" }) as never,
      ingest: async (event) => {
        events.push(event);
        return {} as never;
      },
    });
    await s.open();
    await s.handle(said(1, [{ role: "user", content: URGENT_WORDS }]));
    await s.finish();
    expect(events[0]).toMatchObject({ urgent: true });
    expect(events[0]!.disclosurePlayedAt).toBeUndefined();
  });
});

describe("a transfer number that reaches us", () => {
  test("usableLine: E.164, and none of the numbers given", () => {
    expect(usableLine(DIRECT, [AYA, PUBLISHED])).toBe(DIRECT);
    expect(usableLine(PUBLISHED, [AYA, PUBLISHED])).toBeNull();
    expect(usableLine(AYA, [null, AYA])).toBeNull();
    expect(usableLine("555-0199", [])).toBeNull();
    expect(usableLine(null, [])).toBeNull();
  });

  test("a gate that names the published number does not transfer the call: AYA answers it", async () => {
    tenant.result = { ...FACTS, directLine: PUBLISHED };
    const { s, responses } = session({
      gate: async () => ({ decision: "pass_through", reason: "ai_paused", fallback: "direct_line", directLine: PUBLISHED }) as never,
    });
    await s.open();
    expect(responses()).toHaveLength(1);
    expect(responses()[0]).not.toHaveProperty("transfer_number");
    expect(responses()[0]!.content).toMatch(OPENING);
  });

  test("nor one that names the number the call came in on", async () => {
    tenant.result = { ...FACTS, directLine: AYA };
    const { s, responses } = session({
      gate: async () => ({ decision: "pass_through", reason: "suspended", fallback: "direct_line", directLine: AYA }) as never,
    });
    await s.handle(details(AYA));
    await s.open();
    expect(responses()[0]).not.toHaveProperty("transfer_number");
  });

  test("a model that fails twice is never put through to the number called", async () => {
    tenant.result = { ...FACTS, directLine: AYA };
    const { s, responses } = session({ gate: async () => ({ decision: "answer" }) as never });
    await s.open();
    await s.handle(details(AYA));
    const opening = responses()[0]!.content;
    await s.handle(said(1, [{ role: "agent", content: opening }, { role: "user", content: "When are you open?" }]));
    await s.handle(said(2, [{ role: "agent", content: FAILURE_LINE }, { role: "user", content: "When are you open?" }]));
    expect(responses().map((r) => r.content)).toEqual([opening, FAILURE_LINE, FAILURE_LINE]);
    expect(responses().some((r) => "transfer_number" in r)).toBe(false);
  });
});

describe("a turn that throws", () => {
  const event = (id: number) => JSON.stringify({ interaction_type: "response_required", response_id: id, transcript: [{ role: "user", content: "hello" }] });
  // A session as open() leaves it after a normal start, set by hand because
  // there is no database here, and a turn that throws.
  const broken = (directLine: string | null) => {
    turn.throws = true;
    const made = session();
    Object.assign(made.s as unknown as Record<string, unknown>, { facts: { clinicId: CLINIC }, directLine });
    return made;
  };
  afterEach(() => {
    turn.throws = false;
  });

  test("goes to the direct line", async () => {
    const { s, responses } = broken(DIRECT);
    await s.handle(event(1));
    expect(responses()).toEqual([expect.objectContaining({ response_id: 1, content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
  });

  test("never to a line that is the number the call came in on", async () => {
    const { s, responses } = broken(AYA);
    await s.handle(details(AYA));
    await s.handle(event(1));
    expect(responses()).toEqual([expect.objectContaining({ response_id: 1, content: FAILURE_LINE, end_call: false })]);
  });

  test("without one, says the failure line rather than nothing", async () => {
    const { s, responses } = broken(null);
    await s.handle(event(1));
    expect(responses()).toEqual([expect.objectContaining({ response_id: 1, content: FAILURE_LINE, end_call: false })]);
  });
});

describe("the Retell API", () => {
  test("Retell's JSON 404 is no such number, and the path carries the + encoded", async () => {
    const retell = fakeRetell({});
    expect(await getRetellPhoneNumber(AYA, { key: KEY, fetch: retell.fetcher })).toBeNull();
    expect(retell.calls[0]!.url).toBe("https://api.retellai.com/get-phone-number/%2B15125550142");
  });

  test("a 404 without Retell's JSON body (a wrong route) is an error, not no such number", async () => {
    for (const body of ["{}", "<html>Cannot GET /get-phone-number/x</html>", ""]) {
      const fetcher = (async () => new Response(body, { status: 404 })) as unknown as typeof fetch;
      await expect(getRetellPhoneNumber(AYA, { key: KEY, fetch: fetcher })).rejects.toThrow(/404/);
    }
  });

  test("a fallback Retell answers 200 to but does not keep is a failure, not a success", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: null } }, { ignoresPatch: true });
    await expect(setRetellFallbackNumber(AYA, DIRECT, { key: KEY, fetch: retell.fetcher })).rejects.toThrow(/did not keep/);
  });

  test("refuses a fallback equal to the number itself, and a malformed one", async () => {
    const retell = fakeRetell({ [AYA]: {} });
    await expect(setRetellFallbackNumber(AYA, AYA, { key: KEY, fetch: retell.fetcher })).rejects.toThrow();
    await expect(setRetellFallbackNumber(AYA, "555-0199", { key: KEY, fetch: retell.fetcher })).rejects.toThrow();
    expect(retell.calls).toEqual([]);
  });
});

describe("the hourly fallback sync", () => {
  const clinic = { id: CLINIC, assistantNumber: AYA, publishedPhone: "+15125550100" };

  test("does nothing without a key", async () => {
    const result = await syncRetellFallbacks({ key: null, list: async () => [clinic] });
    expect(result.status).toBe("skipped");
  });

  test("sets the AYA number's fallback to the direct line, once", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: null } });
    const opts = { key: KEY, fetch: retell.fetcher, list: async () => [clinic], directLineOf: async () => DIRECT };
    expect(await syncRetellFallbacks(opts)).toMatchObject({ status: "ok", set: 1, unchanged: 0 });
    expect(retell.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(JSON.parse(retell.calls[1]!.body!)).toEqual({ fallback_number: DIRECT });
    expect(await syncRetellFallbacks(opts)).toMatchObject({ status: "ok", set: 0, unchanged: 1 });
  });

  test("never sets a line that forwards back to us, and clears one that cannot be this clinic's", async () => {
    expect(wantedFallback({ assistantNumber: AYA, publishedPhone: "+15125550100", directLine: "+15125550100" })).toBeNull();
    expect(wantedFallback({ assistantNumber: AYA, publishedPhone: null, directLine: AYA })).toBeNull();
    expect(wantedFallback({ assistantNumber: AYA, publishedPhone: null, directLine: null })).toBeNull();
    // A previous holder's line, on a number whose clinic has none yet.
    const retell = fakeRetell({ [AYA]: { fallback_number: DIRECT } });
    const opts = { key: KEY, fetch: retell.fetcher, list: async () => [clinic], directLineOf: async () => null };
    expect(await syncRetellFallbacks(opts)).toMatchObject({ status: "ok", set: 1 });
    expect(JSON.parse(retell.calls[1]!.body!)).toEqual({ fallback_number: null });
    expect(await syncRetellFallbacks(opts)).toMatchObject({ status: "ok", set: 0, unchanged: 1 });
  });

  test("clears the fallback of a number two clinics name, and says so", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: DIRECT } });
    const other = { ...clinic, id: "0c1d2e3f-0000-4000-8000-00000000f412" };
    const result = await syncRetellFallbacks({ key: KEY, fetch: retell.fetcher, list: async () => [clinic, other], directLineOf: async () => DIRECT });
    expect(result).toMatchObject({ status: "failed", failures: 2, set: 0, unchanged: 0 });
    expect(retell.calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body!))).toEqual([{ fallback_number: null }]);
    expect(notified.map((n) => n.fields.code)).toEqual(["duplicate", "duplicate"]);
  });

  test("a PATCH Retell does not keep, or a rate limit, is named for what it is", async () => {
    const ignored = fakeRetell({ [AYA]: { fallback_number: null } }, { ignoresPatch: true });
    await syncRetellFallbacks({ key: KEY, fetch: ignored.fetcher, list: async () => [clinic], directLineOf: async () => DIRECT });
    const limited = fakeRetell({}, { status: 429 });
    await syncRetellFallbacks({ key: KEY, fetch: limited.fetcher, list: async () => [clinic], directLineOf: async () => DIRECT });
    expect(notified.map((n) => n.fields.code)).toEqual(["not_kept", "unreachable"]);
  });

  test("a number Retell does not have, or a refused key, tells ops by clinic and reason", async () => {
    const missing = fakeRetell({});
    const one = await syncRetellFallbacks({ key: KEY, fetch: missing.fetcher, list: async () => [clinic], directLineOf: async () => DIRECT });
    expect(one).toMatchObject({ status: "failed", failures: 1 });
    expect(notified).toEqual([{ event: "retell_fallback_unsynced", fields: { clinicId: CLINIC, code: "missing" } }]);
  });

  test("a refused key stops the run with one alert, not one per clinic", async () => {
    const refused = fakeRetell({}, { status: 401 });
    const many = [1, 2, 3, 4].map((n) => ({ id: `0c1d2e3f-0000-4000-8000-00000000f42${n}`, assistantNumber: `+1512555020${n}`, publishedPhone: null }));
    const result = await syncRetellFallbacks({ key: KEY, fetch: refused.fetcher, list: async () => many, directLineOf: async () => DIRECT });
    expect(result).toMatchObject({ status: "failed", failures: 1 });
    expect(refused.calls).toHaveLength(1);
    expect(notified).toEqual([{ event: "retell_fallback_unsynced", fields: { code: "key_refused" } }]);
  });

  test("Retell not answering stops the run after three numbers, with one alert", async () => {
    const down503 = fakeRetell({}, { status: 503 });
    const many = [1, 2, 3, 4, 5].map((n) => ({ id: `0c1d2e3f-0000-4000-8000-00000000f43${n}`, assistantNumber: `+1512555030${n}`, publishedPhone: null }));
    const result = await syncRetellFallbacks({ key: KEY, fetch: down503.fetcher, list: async () => many, directLineOf: async () => DIRECT });
    expect(result.failures).toBe(3);
    expect(notified.map((n) => n.fields.code)).toEqual(["unreachable", "unreachable", "retell_unreachable"]);
  });
});
