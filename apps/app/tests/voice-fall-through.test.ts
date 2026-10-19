import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const notified = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/ops/notify", () => ({
  notifyOps: async (event: string, fields: Record<string, unknown>) => {
    notified.push({ event, fields });
  },
  notifyOpsOnce: async () => {},
}));
// No database here: any tenant read fails as one that refuses would.
vi.mock("@/lib/tenant", () => ({
  withTenant: async () => {
    throw new Error("connect ECONNREFUSED");
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

import { FAILURE_LINE } from "@/lib/assistant/turn";
import { fallbackLineFor, forgetDirectLines, rememberDirectLine } from "@/lib/voice/fallback-line";
import { CLOSED_LINE, RetellCallSession, TROUBLE_TRANSFER_LINE, type RetellOutbound } from "@/lib/voice/retell";
import { getRetellPhoneNumber, setRetellFallbackNumber } from "@/lib/voice/retell-api";
import { syncRetellFallbacks, wantedFallback } from "@/lib/voice/retell-fallback-sync";

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
    if (!known) return new Response("{}", { status: 404 });
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
    ...deps,
  });
  const responses = () => sent.filter((m): m is Extract<RetellOutbound, { response_type: "response" }> => m.response_type === "response");
  return { s, sent, responses };
}

const details = (to: string | null) =>
  JSON.stringify({ interaction_type: "call_details", call: { from_number: "+15125550100", ...(to ? { to_number: to } : {}), direction: "inbound" } });

beforeEach(() => {
  forgetDirectLines();
  notified.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("a call that cannot read the database", () => {
  test("goes to the direct line this process remembers from the clinic's last call", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(details(AYA));
    await s.finish();
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
    await s.finish();
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
    await s.finish();
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
    expect(responses()[0]).not.toHaveProperty("transfer_number");
  });

  test("closes with the fixed line only when nowhere holds a line, Retell failing included", async () => {
    const retell = fakeRetell({}, { status: 503 });
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: KEY, fetch: retell.fetcher }) });
    await s.open();
    await s.handle(details(AYA));
    await s.finish();
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
    expect(notified[0]!.fields.code).toBe("closed");
  });

  test("still falls through when Retell's call details never come", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.finish();
    expect(responses()[0]).toMatchObject({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT });
  });

  test("an outbound call is ended, never put through", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const { s, responses } = session({ fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(JSON.stringify({ interaction_type: "call_details", call: { to_number: AYA, direction: "outbound" } }));
    await s.finish();
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
    await s.finish();
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
    expect(notified[0]!.fields.code).toBe("transferred_gate");
  });

  test("a database that hangs rather than refuses still falls through, within the deadline", async () => {
    rememberDirectLine(CLINIC, DIRECT);
    const hang = () => new Promise<never>(() => {});
    const { s, responses } = session({ gate: hang, startDeadlineMs: 30, fallbackLine: (input) => fallbackLineFor(input, { key: null }) });
    await s.open();
    await s.handle(details(AYA));
    await s.finish();
    expect(responses()).toEqual([expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT })]);
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
    await s.finish();
  });

  test("never remembers a line equal to the clinic's published number", async () => {
    rememberDirectLine(CLINIC, DIRECT, DIRECT);
    expect(await fallbackLineFor({ clinicId: CLINIC, calledNumber: AYA }, { key: null })).toBeNull();
  });

  test("a lookup that throws closes the call rather than leaving it silent", async () => {
    const { s, responses } = session({ fallbackLine: down });
    await s.open();
    await s.handle(details(AYA));
    await s.finish();
    expect(responses()).toEqual([expect.objectContaining({ content: CLOSED_LINE, end_call: true })]);
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

  test("without one, says the failure line rather than nothing", async () => {
    const { s, responses } = broken(null);
    await s.handle(event(1));
    expect(responses()).toEqual([expect.objectContaining({ response_id: 1, content: FAILURE_LINE, end_call: false })]);
  });
});

describe("the Retell API", () => {
  test("404 is no such number, and the path carries the + encoded", async () => {
    const retell = fakeRetell({});
    expect(await getRetellPhoneNumber(AYA, { key: KEY, fetch: retell.fetcher })).toBeNull();
    expect(retell.calls[0]!.url).toBe("https://api.retellai.com/get-phone-number/%2B15125550142");
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

  test("leaves alone a number two clinics name, and says so", async () => {
    const retell = fakeRetell({ [AYA]: { fallback_number: null } });
    const other = { ...clinic, id: "0c1d2e3f-0000-4000-8000-00000000f412" };
    const result = await syncRetellFallbacks({ key: KEY, fetch: retell.fetcher, list: async () => [clinic, other], directLineOf: async () => DIRECT });
    expect(result).toMatchObject({ status: "failed", failures: 2, set: 0 });
    expect(retell.calls).toEqual([]);
    expect(notified.map((n) => n.fields.code)).toEqual(["duplicate", "duplicate"]);
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
