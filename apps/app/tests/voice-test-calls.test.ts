import { describe, expect, test } from "vitest";

import { CLOSED_LINE, RetellCallSession, TRANSFER_LINE, type RetellOutbound, type RetellSessionDeps } from "@/lib/voice/retell";
import { voiceRealCallsAllowed } from "@/lib/voice/test-calls";

/**
 * Test calls before the agreements are signed (owner, 19 October 2026;
 * lib/voice/test-calls.ts): while real calls are off, a call for a clinic
 * that is not made up is passed to its direct line or refused before AYA
 * speaks, before the answer gate runs, and is never recorded. No database:
 * the screen, the gate and the ingest are stand-ins. The database's own
 * marker is exercised end to end in retell-voice.test.ts.
 */

type Response = Extract<RetellOutbound, { response_type: "response" }>;

function session(deps: Partial<RetellSessionDeps>) {
  const said: RetellOutbound[] = [];
  const calls = { gate: 0, ingest: 0, model: 0 };
  const s = new RetellCallSession("00000000-0000-4000-8000-000000000001", "call_test", (m) => said.push(m), {
    responder: async () => {
      calls.model += 1;
      return JSON.stringify({ reply: "model" });
    },
    gate: async () => {
      calls.gate += 1;
      throw new Error("the gate must not run for a refused test call");
    },
    ingest: async () => {
      calls.ingest += 1;
      throw new Error("a refused test call must not be recorded");
    },
    ...deps,
  });
  const responses = () => said.filter((m): m is Response => m.response_type === "response");
  return { s, said, calls, responses };
}

describe("voiceRealCallsAllowed", () => {
  test("only HEALDESK_VOICE_REAL_CALLS=1 allows real calls; anything else is test mode", () => {
    expect(voiceRealCallsAllowed({ HEALDESK_VOICE_REAL_CALLS: "1" })).toBe(true);
    expect(voiceRealCallsAllowed({ HEALDESK_VOICE_REAL_CALLS: " 1 " })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", "__unset__", "11"]) {
      expect(voiceRealCallsAllowed({ HEALDESK_VOICE_REAL_CALLS: value })).toBe(false);
    }
  });
});

describe("a call in test mode", () => {
  test("for a real clinic with a direct line: put through to it, unanswered, ungated and unrecorded", async () => {
    const { s, said, calls, responses } = session({ realCalls: false, screen: async () => ({ madeUp: false, directLine: "+14155550123" }) });
    await s.open();
    await s.handle(JSON.stringify({ interaction_type: "call_details", call: { from_number: "+14155550199", direction: "inbound" } }));
    await s.handle(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "Hello?" }] }));
    expect(await s.finish()).toBeNull();
    // The caller who speaks again hears the transfer again, never AYA.
    expect(responses()).toEqual([
      { response_type: "response", response_id: 0, content: TRANSFER_LINE, content_complete: true, end_call: false, transfer_number: "+14155550123" },
      { response_type: "response", response_id: 1, content: TRANSFER_LINE, content_complete: true, end_call: false, transfer_number: "+14155550123" },
    ]);
    expect(calls).toEqual({ gate: 0, ingest: 0, model: 0 });
    // Retell is never asked for the caller's number.
    expect(said[0]).toEqual({ response_type: "config", config: { auto_reconnect: true, call_details: false } });
    expect(JSON.stringify(said)).not.toContain('"call_details":true');
  });

  test("for a real clinic with no direct line: refused politely, and the call ends", async () => {
    const { s, calls, responses } = session({ realCalls: false, screen: async () => ({ madeUp: false, directLine: null }) });
    await s.open();
    expect(await s.finish()).toBeNull();
    expect(responses()).toEqual([{ response_type: "response", response_id: 0, content: CLOSED_LINE, content_complete: true, end_call: true }]);
    expect(calls).toEqual({ gate: 0, ingest: 0, model: 0 });
  });

  test("a check that fails is a refusal, never an answer", async () => {
    const { s, calls, responses } = session({
      realCalls: false,
      screen: async () => {
        throw new Error("database down");
      },
    });
    await s.open();
    expect(await s.finish()).toBeNull();
    expect(responses().map((r) => [r.content, r.end_call])).toEqual([[CLOSED_LINE, true]]);
    expect(calls).toEqual({ gate: 0, ingest: 0, model: 0 });
  });

  test("a drain that records the call while the check is still out keeps nothing, whatever the check says", async () => {
    for (const madeUp of [false, true]) {
      let answer!: (screen: { madeUp: boolean; directLine: string | null }) => void;
      const { s, calls } = session({ realCalls: false, screen: () => new Promise((resolve) => (answer = resolve)) });
      const opening = s.open();
      await Promise.resolve();
      expect(await s.finish()).toBeNull();
      answer({ madeUp, directLine: null });
      await opening;
      expect(calls).toEqual({ gate: 0, ingest: 0, model: 0 });
    }
  });

  test("unset, the switch reads the environment, and the environment says test mode", async () => {
    const before = process.env.HEALDESK_VOICE_REAL_CALLS;
    delete process.env.HEALDESK_VOICE_REAL_CALLS;
    try {
      let screened = 0;
      const { s, responses } = session({
        screen: async () => {
          screened += 1;
          return { madeUp: false, directLine: null };
        },
      });
      await s.open();
      expect(screened).toBe(1);
      expect(responses()[0]!.content).toBe(CLOSED_LINE);
    } finally {
      if (before === undefined) delete process.env.HEALDESK_VOICE_REAL_CALLS;
      else process.env.HEALDESK_VOICE_REAL_CALLS = before;
    }
  });

  test("for a made-up clinic, and with real calls on, the screen lets the call through to the gate", async () => {
    for (const deps of [
      { realCalls: false, screen: async () => ({ madeUp: true, directLine: null }) },
      {
        realCalls: true,
        screen: async () => {
          throw new Error("with real calls on, nothing is screened");
        },
      },
    ]) {
      const { s, calls } = session(deps);
      await s.open();
      // The stand-in gate throws, so the call closes; what matters is that it ran.
      expect(calls.gate).toBe(1);
      await s.finish();
      expect(calls.ingest).toBe(1);
    }
  });
});
