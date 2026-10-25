import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The approval inbox's apps/web side (ops automation Phase 6, lane P6a),
 * against a stubbed upstream: the two reads and the decision each send
 * exactly the op and args apps/app reads (lib/ops/approval-ops.ts), each
 * answer is read strictly (a field missing, a field apps/app does not send,
 * or a value off its list is a malformed answer, never half a row), and the
 * decision goes only through the fresh-code wrapper. The signing, the
 * transport, the readers and the fresh-code check are the real ones.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import { fetchApprovalHistory, fetchApprovals } from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const REQUEST = "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const MALFORMED = { ok: false, code: "malformed" };

let replies: unknown[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];

function reply(data: unknown): void {
  replies.push({ data });
}

beforeEach(() => {
  replies = [];
  sent = [];
  session.operator = "ops@healdesk.test";
  __resetStepLedgerForTests();
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubEnv("HEALDESK_ADMIN_TOTP_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const next = replies.shift();
      if (next === undefined) throw new Error("no stubbed reply");
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const FACTS = {
  kind: "billing_request_retry",
  requestKind: "cancel_now",
  channel: null,
  reasonCode: "attempts_exhausted",
  lastErrorCode: "stripe:api_error",
  attempts: 10,
  maxAttempts: 10,
  billingStatus: "active",
  supersededBy: null,
  workerOn: false,
  closureOn: null,
};
const PACKET = {
  operation: "retryBillingRequest",
  irreversible: true,
  stillNeeded: true,
  effect: "Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with fresh tries.",
  facts: FACTS,
};
const ITEM_ROW = {
  id: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${REQUEST}:0`,
  urgency: "money",
  status: "waiting",
  proposedAt: "2026-11-02T10:00:00.000Z",
  dueAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-09T10:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "retryBillingRequest",
  hasDraft: false,
  packet: PACKET,
};
const EVENT_ROW = {
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  approvalId: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  event: "approved",
  actorLabel: "ops@healdesk.test",
  ip: "203.0.113.9",
  userAgent: "vitest",
  draftHashApproved: null,
  draftHashSent: null,
  outcomeCode: "cause_fixed",
  at: "2026-11-02T10:01:00.000Z",
};

describe("fetchApprovals", () => {
  test("asks for the waiting items by default, or a status and limit, and reads each item and packet", async () => {
    reply({ items: [ITEM_ROW], partial: [] });
    expect(await fetchApprovals()).toEqual({ ok: true, data: { items: [ITEM_ROW], partial: [] } });
    reply({ items: [{ ...ITEM_ROW, status: "rejected", decidedAt: "2026-11-02T11:00:00.000Z", outcomeCode: "not_needed", packet: null }], partial: [] });
    expect(await fetchApprovals({ status: "rejected", limit: 20 })).toMatchObject({ ok: true });
    expect(sent).toEqual([
      // The billing family only (lane P6i): the Approvals section never builds an incident packet.
      { op: "listApprovals", args: { family: "billing" } },
      { op: "listApprovals", args: { family: "billing", status: "rejected", limit: 20 } },
    ]);
    const overage = {
      ...ITEM_ROW,
      kind: "overage_invoice_retry",
      subjectRef: REQUEST,
      operation: "retryOverageInvoice",
      packet: {
        ...PACKET,
        operation: "retryOverageInvoice",
        facts: { kind: "overage_invoice_retry", windowStart: "2026-09-07T00:00:00.000Z", amountCents: 1250, lastErrorCode: "api_error" },
      },
    };
    const event = {
      ...ITEM_ROW,
      kind: "billing_event_replay",
      clinic: null,
      subjectRef: "evt_1AbCdEf",
      operation: "replayBillingEvent",
      packet: { ...PACKET, operation: "replayBillingEvent", facts: { kind: "billing_event_replay", eventType: "invoice.paid", failures: 3, maxFailures: 3 } },
    };
    reply({ items: [overage, event], partial: [ITEM] });
    expect(await fetchApprovals()).toEqual({ ok: true, data: { items: [overage, event], partial: [ITEM] } });
  });

  test("a field missing, an extra field, a value off its list or a packet of another kind is malformed", async () => {
    const { packet: _p, ...missing } = ITEM_ROW;
    const bad = [
      missing,
      { ...ITEM_ROW, phone: "+14155550142" },
      { ...ITEM_ROW, kind: "refund" },
      { ...ITEM_ROW, status: "approved_by_timeout" },
      { ...ITEM_ROW, subjectRef: "a b@c" },
      { ...ITEM_ROW, packet: { ...PACKET, note: "free text" } },
      { ...ITEM_ROW, packet: { ...PACKET, facts: { ...FACTS, lastErrorCode: "The card was declined by Jane's bank" } } },
      { ...ITEM_ROW, packet: { ...PACKET, facts: { ...FACTS, kind: "billing_event_replay" } } },
      { ...ITEM_ROW, packet: { ...PACKET, operation: "commitRefund" } },
      { ...ITEM_ROW, packet: { ...PACKET, facts: { ...FACTS, priceCents: 26_000 } } },
      { ...ITEM_ROW, packet: { ...PACKET, facts: { ...FACTS, workerOn: "off" } } },
    ];
    for (const item of bad) {
      reply({ items: [item], partial: [] });
      expect(await fetchApprovals(), JSON.stringify(item).slice(0, 80)).toMatchObject(MALFORMED);
    }
    reply({ items: [], partial: [], more: 1 });
    expect(await fetchApprovals()).toMatchObject(MALFORMED);
  });
});

describe("fetchApprovalHistory", () => {
  test("asks for the record and reads it strictly", async () => {
    reply({ events: [EVENT_ROW] });
    expect(await fetchApprovalHistory({ limit: 50, kind: "billing_request_retry" })).toEqual({ ok: true, data: [EVENT_ROW] });
    expect(sent).toEqual([{ op: "listApprovalHistory", args: { limit: 50, kind: "billing_request_retry" } }]);
    for (const row of [{ ...EVENT_ROW, draft: "Hi" }, { ...EVENT_ROW, event: "approved_by_timeout" }, { ...EVENT_ROW, draftHashSent: "abc" }]) {
      reply({ events: [row] });
      expect(await fetchApprovalHistory()).toMatchObject(MALFORMED);
    }
  });
});

describe("the decision goes only through the fresh code", () => {
  const fresh = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));

  test("a wrong or missing code, no session, a bad id or a reason off the list sends nothing", async () => {
    for (const code of ["000000", undefined, ""]) {
      expect(await decideApprovalWithCode(ITEM, "approve", "cause_fixed", code)).toMatchObject({ ok: true, data: { status: "code_refused" } });
    }
    expect(await decideApprovalWithCode("not-an-id", "approve", "cause_fixed", fresh())).toMatchObject({ ok: true, data: { status: "refused" } });
    expect(await decideApprovalWithCode(ITEM, "approve", "not_needed", fresh())).toMatchObject({ ok: true, data: { status: "refused" } });
    session.operator = null;
    expect(await decideApprovalWithCode(ITEM, "approve", "cause_fixed", fresh())).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(sent).toEqual([]);
  });

  test("a fresh code sends the decision with the mark, never the code, and reads each outcome strictly", async () => {
    reply({ status: "executed", outcomeCode: "rearmed", message: "Re-armed: the change is due again.", auditRecorded: true });
    const code = fresh();
    expect(await decideApprovalWithCode(ITEM, "approve", "cause_fixed", code)).toEqual({
      ok: true,
      data: { status: "executed", outcomeCode: "rearmed", message: "Re-armed: the change is due again.", auditRecorded: true },
    });
    expect(sent).toEqual([{ op: "decideApproval", args: { id: ITEM, action: "approve", reasonCode: "cause_fixed", codeChecked: true } }]);
    expect(JSON.stringify(sent)).not.toContain(code);
    // The code just used is spent.
    expect(await decideApprovalWithCode(ITEM, "reject", "not_needed", code)).toMatchObject({ ok: true, data: { status: "code_refused" } });

    const outcomes: [unknown, unknown][] = [
      [{ status: "rejected", outcomeCode: "not_needed", auditRecorded: true }, { status: "rejected", outcomeCode: "not_needed", auditRecorded: true }],
      [{ status: "failed", outcomeCode: "refused", message: "That event is not parked.", auditRecorded: true }, { status: "failed", outcomeCode: "refused", message: "That event is not parked.", auditRecorded: true }],
      [{ status: "error", message: "This has already been decided." }, { status: "refused", message: "This has already been decided." }],
    ];
    for (const [answer, read] of outcomes) {
      __resetStepLedgerForTests();
      reply(answer);
      expect(await decideApprovalWithCode(ITEM, "reject", "not_needed", fresh())).toEqual({ ok: true, data: read });
    }
    for (const answer of [
      { status: "executed", outcomeCode: "retried", message: null },
      { status: "executed", outcomeCode: "Retried!", message: null, auditRecorded: true },
      { status: "approved", outcomeCode: "retried", message: null, auditRecorded: true },
      { status: "rejected", outcomeCode: "not_needed", auditRecorded: true, extra: 1 },
    ]) {
      __resetStepLedgerForTests();
      reply(answer);
      expect(await decideApprovalWithCode(ITEM, "reject", "not_needed", fresh())).toMatchObject(MALFORMED);
    }
  });

  test("an edited draft crosses as its subject and body alone", async () => {
    reply({ status: "executed", outcomeCode: "sent", message: null, auditRecorded: true });
    await decideApprovalWithCode(ITEM, "approve", "owner_checked", fresh(), { subject: "A question", body: "Hi team." });
    expect(sent[0]!.args.editedDraft).toEqual({ subject: "A question", body: "Hi team." });
  });

  test("nothing in apps/web source names the raw decideApproval but ops-client.ts and approval-decide.ts", () => {
    // Any occurrence, however it got there: an import, an alias, a re-export,
    // a dynamic import, a namespace member. The gated entry is
    // decideApprovalWithCode, which the word boundary keeps apart. Test
    // files are allowed: they test the raw reader.
    const root = join(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules" && !name.startsWith(".")) walk(path);
        } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const allowed = [join("lib", "admin", "ops-client.ts"), join("lib", "admin", "approval-decide.ts")];
    const offenders = files.filter(
      (file) => !allowed.some((end) => file.endsWith(end)) && /\bdecideApproval\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
