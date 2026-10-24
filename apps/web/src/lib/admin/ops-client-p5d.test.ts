import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's lane P5d operations against a stubbed upstream: the
 * machine queues (apps/app lib/ops/machine-queues-ops.ts), the lifecycle
 * ignore list (lib/ops/lifecycle-ops.ts) and one agreement's record
 * (opGetAgreement). Each call sends exactly the op and args apps/app reads,
 * and each reply is read field by field, so a shape apps/app does not send
 * is a malformed answer, never a half-read page. The session check and the
 * browser headers are stubbed; the signing, the transport and the readers
 * are the real ones, as in ops-client.test.ts.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  fetchAgreement,
  fetchLifecycle,
  fetchLifecycleIgnored,
  fetchMachineQueues,
  setLifecycleIgnored,
} from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const AGREEMENT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const HASH = "a".repeat(64);

let replies: { status?: number; body: unknown }[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];

function reply(body: unknown, status = 200): void {
  replies.push({ status, body });
}

beforeEach(() => {
  replies = [];
  sent = [];
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const next = replies.shift();
      if (!next) throw new Error("no stubbed reply");
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const QUEUE = {
  key: "outbox_dead",
  words: "Emails to clinics that could not be sent and will not be tried again, in the last 7 days",
  count: 2,
  oldestAgeMinutes: 1440,
  needsAttention: true,
  tone: "warn",
  href: `/admin/clinics/${CLINIC}/deliveries`,
  lowerBound: false,
};

describe("fetchMachineQueues", () => {
  test("sends no argument and reads every queue and every unread part", async () => {
    const watched = { ...QUEUE, key: "pgboss:send-email", words: "Background jobs waiting in send-email", count: 0, oldestAgeMinutes: null, needsAttention: false, tone: "ok", href: "/admin/system/jobs" };
    reply({ data: { queues: [QUEUE, watched], partial: ["pg-boss"] } });
    expect(await fetchMachineQueues()).toEqual({ ok: true, data: { queues: [QUEUE, watched], partial: ["pg-boss"] } });
    expect(sent).toEqual([{ op: "listMachineQueues", args: {} }]);
  });

  test("reads a count some clinic could not add to as a lower bound", async () => {
    reply({ data: { queues: [{ ...QUEUE, lowerBound: true }], partial: ["1 clinic(s)"] } });
    const result = await fetchMachineQueues();
    expect(result.ok && result.data.queues[0]!.lowerBound).toBe(true);
  });

  test.each([
    ["a missing lower-bound flag", { queues: [(({ lowerBound: _l, ...rest }) => rest)(QUEUE)], partial: [] }],
    ["a lower-bound flag that is not a boolean", { queues: [{ ...QUEUE, lowerBound: "maybe" }], partial: [] }],
    ["a missing partial", { queues: [QUEUE] }],
    ["an unknown tone", { queues: [{ ...QUEUE, tone: "red" }], partial: [] }],
    ["a negative count", { queues: [{ ...QUEUE, count: -1 }], partial: [] }],
    ["a fractional age", { queues: [{ ...QUEUE, oldestAgeMinutes: 1.5 }], partial: [] }],
    ["an absolute link", { queues: [{ ...QUEUE, href: "https://evil.test/admin/" }], partial: [] }],
    ["a key that is not a queue's", { queues: [{ ...QUEUE, key: "Outbox Dead" }], partial: [] }],
    ["an attention that is not a boolean", { queues: [{ ...QUEUE, needsAttention: "yes" }], partial: [] }],
  ])("refuses %s", async (_label, data) => {
    reply({ data });
    const result = await fetchMachineQueues();
    expect(result.ok).toBe(false);
  });
});

describe("the lifecycle ignore list", () => {
  test("setLifecycleIgnored sends the id, the flag and the closed reason, and reads the outcome", async () => {
    const outcome = { outcome: "saved", ignored: true, note: "internal_test_account", setAt: "2026-10-24T10:00:00.000Z", auditRecorded: true };
    reply({ data: outcome });
    expect(await setLifecycleIgnored(CLINIC, true, "internal_test_account")).toEqual({ ok: true, data: outcome });
    expect(sent.at(-1)).toEqual({ op: "setLifecycleIgnored", args: { clinicId: CLINIC, ignored: true, note: "internal_test_account" } });

    reply({ data: { ...outcome, ignored: false, note: null, auditRecorded: false } });
    expect(await setLifecycleIgnored(CLINIC, false)).toEqual({ ok: true, data: { ...outcome, ignored: false, note: null, auditRecorded: false } });
    expect(sent.at(-1)).toEqual({ op: "setLifecycleIgnored", args: { clinicId: CLINIC, ignored: false, note: null } });

    reply({ data: { ...outcome, note: "because I said so" } });
    expect((await setLifecycleIgnored(CLINIC, true)).ok).toBe(false);
  });

  test("an apps/app refusal arrives as its own sentence", async () => {
    reply({ error: "A location is watched with its account: set the account instead.", code: "invalid_args" }, 400);
    const result = await setLifecycleIgnored(CLINIC, true);
    expect(result.ok).toBe(false);
  });

  test("fetchLifecycleIgnored reads the list, with or without one clinic", async () => {
    const row = { clinicId: CLINIC, clinicSlug: "glow", clinicName: "Glow Clinic", note: null, setBy: "ops@healdesk.test", setAt: "2026-10-24T10:00:00.000Z" };
    reply({ data: { clinics: [row] } });
    expect(await fetchLifecycleIgnored()).toEqual({ ok: true, data: [row] });
    expect(sent.at(-1)).toEqual({ op: "listLifecycleIgnored", args: {} });
    reply({ data: { clinics: [] } });
    expect(await fetchLifecycleIgnored(CLINIC)).toEqual({ ok: true, data: [] });
    expect(sent.at(-1)).toEqual({ op: "listLifecycleIgnored", args: { clinicId: CLINIC } });
    reply({ data: { clinics: [{ ...row, setAt: "yesterday" }] } });
    expect((await fetchLifecycleIgnored()).ok).toBe(false);
  });

  test("fetchLifecycle reads the ignored flag, and an apps/app older than lane P5d as not ignored", async () => {
    const row = {
      clinicId: CLINIC,
      clinicSlug: "glow",
      clinicName: "Glow Clinic",
      stage: "in_setup",
      stageSince: "2026-10-01T10:00:00.000Z",
      stepsLeft: 2,
      channelsWaiting: 0,
      lastProgressAt: null,
      deadlineAt: "2026-10-31T04:00:00.000Z",
      remainingDays: 7,
      decision: "none",
      decidedBy: null,
      decidedAt: null,
      snoozedUntil: null,
      snoozedBy: null,
      undeliveredCount: 0,
      decisionOwed: false,
      recommendation: { action: "wait", days: null, reason: "Not watched (internal): one of healdesk's own test accounts, so there is nothing to decide." },
    };
    reply({ data: { clinics: [{ ...row, ignored: true }] } });
    const read = await fetchLifecycle();
    expect(read.ok && read.data[0]!.ignored).toBe(true);
    reply({ data: { clinics: [row] } });
    const older = await fetchLifecycle();
    expect(older.ok && older.data[0]!.ignored).toBe(false);
    reply({ data: { clinics: [{ ...row, ignored: "no" }] } });
    expect((await fetchLifecycle()).ok).toBe(false);
  });
});

describe("fetchAgreement", () => {
  const AGREEMENT_ROW = {
    id: AGREEMENT,
    version: "1.5.0",
    hash: HASH,
    text: "BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions.\n\tTerms used here keep their meaning.",
    signatoryName: "Alex Chen",
    signatoryEmail: "alex@glow.test",
    signatoryTitle: null,
    acceptedAt: "2026-10-01T10:00:00.000Z",
    bound: true,
    deliveries: [{ deliveredAt: "2026-10-01T10:00:05.000Z", sha256: "B".repeat(64), firstCopy: true, trigger: "signature" }],
  };

  test("sends the id and reads the record, keeping the text's line breaks exactly", async () => {
    reply({ data: { agreement: AGREEMENT_ROW } });
    const result = await fetchAgreement(AGREEMENT);
    expect(sent).toEqual([{ op: "getAgreement", args: { agreementId: AGREEMENT } }]);
    expect(result).toEqual({
      ok: true,
      data: { ...AGREEMENT_ROW, deliveries: [{ ...AGREEMENT_ROW.deliveries[0], sha256: "b".repeat(64) }] },
    });
  });

  test("an id that is not an agreement is null, not an error", async () => {
    reply({ data: { agreement: null } });
    expect(await fetchAgreement("nope")).toEqual({ ok: true, data: null });
  });

  test("removes only the characters that reorder or hide text", async () => {
    reply({ data: { agreement: { ...AGREEMENT_ROW, text: "Clause‮one\u0007 two" } } });
    const result = await fetchAgreement(AGREEMENT);
    expect(result.ok && result.data?.text).toBe("Clauseone two");
  });

  test.each([
    ["a hash that is not SHA-256", { ...AGREEMENT_ROW, hash: "abc" }],
    ["no text", { ...AGREEMENT_ROW, text: "" }],
    ["an unknown trigger", { ...AGREEMENT_ROW, deliveries: [{ ...AGREEMENT_ROW.deliveries[0], trigger: "magic" }] }],
    ["a missing bound", (({ bound: _bound, ...rest }) => rest)(AGREEMENT_ROW)],
    ["a date that is not an instant", { ...AGREEMENT_ROW, acceptedAt: "1 October" }],
  ])("refuses %s", async (_label, agreement) => {
    reply({ data: { agreement } });
    expect((await fetchAgreement(AGREEMENT)).ok).toBe(false);
  });
});
