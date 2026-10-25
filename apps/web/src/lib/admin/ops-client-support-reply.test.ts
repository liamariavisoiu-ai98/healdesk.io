import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's support-reply operations (lane P7c; apps/app
 * lib/ops/support-reply-ops.ts, lib/approvals/support-reply.ts) against a
 * stubbed upstream: each call sends exactly the op and args apps/app reads,
 * and each reply is read field by field, so an answer carrying a field
 * apps/app never sends is malformed, never a half-read page. The shapes are
 * the ones apps/app's tests/support-send.test.ts produces. The decision
 * itself goes only through lib/admin/approval-decide.ts, with a fresh code
 * (approval-decide.test.ts holds the raw client's name to that file).
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  APPROVAL_KINDS,
  fetchApprovalHistory,
  fetchApprovals,
  fetchSupportReplyApprovals,
  fetchSupportReplyHistory,
  previewSupportReply,
  proposeSupportReply,
  saveSupportDraft,
  SUPPORT_APPROVAL_KINDS,
} from "@/lib/admin/ops-client";

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

const CASE_ID = "8c584284-535b-403e-a40c-7ca25c7dee15";
const APPROVAL_ID = "5d1f6a2e-9c3b-4f7a-8e21-3b4c5d6e7f80";
const MESSAGE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CHECKS = [
  { id: "names", ok: true, rule: "Names no person" },
  { id: "send_tone", ok: false, rule: "No exclamation mark, no emoji and none of the banned phrases" },
];
const BODY = "Hi, forwarding isn't set yet.\n\nThe codes are in Settings, under Channels.";

const ITEM = {
  id: APPROVAL_ID,
  kind: "support_reply_send",
  clinic: { id: "7c0cd609-27e7-417c-880f-c75bde09790c", name: "Glow Med Spa" },
  subjectRef: `${MESSAGE_ID}:v1`,
  urgency: "routine",
  status: "waiting",
  proposedAt: "2026-10-14T15:00:00.000Z",
  dueAt: "2026-10-16T04:00:00.000Z",
  expiresAt: "2026-10-28T15:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "sendSupportReply",
  hasDraft: true,
  packet: {
    operation: "sendSupportReply",
    irreversible: true,
    stillNeeded: true,
    effect: "Sends this reply to the practice's one sign-in address.",
    facts: {
      kind: "support_reply_send",
      ref: "HD-6V104",
      caseId: CASE_ID,
      topic: "forwarding",
      symptom: "codes_not_working",
      caseUrgency: "today",
      caseState: "drafted",
      replyByOn: "2026-10-15",
      draftVersion: 1,
      currentDraftVersion: 1,
      checks: [{ id: "names", ok: true, rule: "Names no person" }],
    },
    draft: { subject: "Re: Your call forwarding (ref HD-6V104)", body: BODY },
  },
};

describe("the support reply's clients", () => {
  test("previewSupportReply sends the case and the text, and reads the rules back, never words", async () => {
    reply({ data: { ref: "HD-6V104", ok: false, checks: CHECKS, failed: [CHECKS[1]!.rule] } });
    const result = await previewSupportReply(CASE_ID, "Great news!");
    expect(sent).toEqual([{ op: "previewSupportReply", args: { caseId: CASE_ID, text: "Great news!" } }]);
    expect(result).toEqual({ ok: true, data: { ref: "HD-6V104", ok: false, checks: CHECKS, failed: [CHECKS[1]!.rule] } });
    reply({ data: { ref: "HD-6V104", ok: true, checks: [], failed: [], text: "Great news!" } });
    expect((await previewSupportReply(CASE_ID, "x")).ok).toBe(false);
  });

  test("saveSupportDraft and proposeSupportReply send exactly their args and read their outcomes strictly", async () => {
    reply({
      data: { ref: "HD-6V104", draftVersion: 2, state: "drafted", approvalId: APPROVAL_ID, ok: true, checks: [], failed: [], auditRecorded: true },
    });
    const saved = await saveSupportDraft(CASE_ID, BODY);
    expect(sent.at(-1)).toEqual({ op: "saveSupportDraft", args: { caseId: CASE_ID, text: BODY } });
    expect(saved.ok && saved.data).toMatchObject({ draftVersion: 2, state: "drafted", approvalId: APPROVAL_ID });

    reply({ data: { outcome: "checks_failed", ref: "HD-6V104", approvalId: null, draftVersion: 2, failed: ["Names no person"], auditRecorded: true } });
    const proposed = await proposeSupportReply(CASE_ID);
    expect(sent.at(-1)).toEqual({ op: "proposeSupportReply", args: { caseId: CASE_ID } });
    expect(proposed.ok && proposed.data).toMatchObject({ outcome: "checks_failed", failed: ["Names no person"] });

    reply({ data: { outcome: "sent", ref: "HD-6V104", approvalId: null, draftVersion: 2, failed: [], auditRecorded: true } });
    expect((await proposeSupportReply(CASE_ID)).ok).toBe(false);
    reply({ error: "This case is closed. A clinic that writes again opens a new case.", code: "invalid_args" }, 409);
    expect((await proposeSupportReply(CASE_ID)).ok).toBe(false);
  });

  test("fetchSupportReplyApprovals asks for the support family and reads the packet with its draft", async () => {
    reply({ data: { items: [ITEM], partial: [] } });
    const result = await fetchSupportReplyApprovals();
    expect(sent.at(-1)).toEqual({ op: "listApprovals", args: { family: "support" } });
    expect(result.ok && result.data.items[0]!.packet!.draft).toEqual({ subject: "Re: Your call forwarding (ref HD-6V104)", body: BODY });
    expect(result.ok && result.data.items[0]!.packet!.facts.ref).toBe("HD-6V104");
    reply({ data: { items: [{ ...ITEM, packet: { ...ITEM.packet, facts: { ...ITEM.packet.facts, text: "hi" } } }], partial: [] } });
    expect((await fetchSupportReplyApprovals()).ok).toBe(false);
  });

  test("the Approvals section's reads leave support items to their own reader, and the history splits the same way", async () => {
    reply({ data: { items: [ITEM], partial: [] } });
    const approvals = await fetchApprovals();
    expect(approvals.ok && approvals.data.items).toEqual([]);
    const event = {
      id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      approvalId: APPROVAL_ID,
      kind: "support_reply_send",
      clinic: null,
      event: "executed",
      actorLabel: "ops@healdesk.test",
      ip: "203.0.113.9",
      userAgent: "vitest",
      draftHashApproved: "a".repeat(64),
      draftHashSent: "a".repeat(64),
      outcomeCode: "sent",
      at: "2026-10-14T15:10:00.002Z",
    };
    reply({ data: { events: [event] } });
    const history = await fetchApprovalHistory();
    expect(history.ok && history.data).toEqual([]);
    reply({ data: { events: [event] } });
    const own = await fetchSupportReplyHistory();
    expect(sent.at(-1)).toEqual({ op: "listApprovalHistory", args: { kind: "support_reply_send" } });
    expect(own.ok && own.data[0]).toMatchObject({ kind: "support_reply_send", draftHashSent: "a".repeat(64), outcomeCode: "sent" });
  });

  test("apps/app's kind list is the Approvals section's kinds, the incident pair and the support reply", () => {
    const schema = readFileSync(join(__dirname, "../../../../app/src/db/schema.ts"), "utf8");
    const block = /export const APPROVAL_KINDS = \[([\s\S]*?)\] as const;/.exec(schema)![1]!;
    const theirs = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(theirs).toContain(SUPPORT_APPROVAL_KINDS[0]);
    expect([...APPROVAL_KINDS, "incident_open_batch", "incident_report_send", ...SUPPORT_APPROVAL_KINDS].sort()).toEqual(theirs.sort());
  });
});
