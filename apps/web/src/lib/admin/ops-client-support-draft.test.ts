import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's half of the support drafter (lane P7b; apps/app
 * lib/support/draft/store.ts readDraftView and lib/ops/support-draft-ops.ts)
 * against a stubbed upstream: getSupportCase's `draft` is read field by
 * field (a draft has a version and text and no failure; a failed run has a
 * failure and neither), and regenerateSupportDraft sends exactly its op and
 * case id, as a write. The DRAFT fixture has the keys apps/app's
 * tests/support-draft-db.test.ts holds the real reply to.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { fetchSupportCase, regenerateSupportDraft } from "@/lib/admin/ops-client";

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

const ROW = {
  id: CASE_ID,
  ref: "HD-6V104",
  clinicId: "7c0cd609-27e7-417c-880f-c75bde09790c",
  clinicName: "dump Med Spa LLC",
  source: "chat",
  category: "forwarding",
  symptom: "codes_not_working",
  urgency: "today",
  state: "drafted",
  assigneeLabel: null,
  openedAt: "2026-10-27T15:00:00.000Z",
  ageHours: 0,
  replyByOn: "2026-10-28",
  pastDue: false,
  snoozedUntil: null,
  lastInboundAt: "2026-10-27T15:00:00.000Z",
  lastOutboundAt: null,
  closedAt: null,
  closedReason: null,
  phiSuspected: false,
  hidden: { numbers: 0, emails: 0, treatments: 0, clinical: 0 },
  inboundCount: 1,
};

const CHECKS = ["facts", "screen", "names", "clinical", "promises", "claims", "shape", "other_clinics"].map((id) => ({
  id,
  ok: true,
  rule: `The rule for ${id}.`,
}));

const DRAFT = {
  messageId: "e733f661-692b-4f88-b121-20f00c6ff2b6",
  version: 1,
  text: "Hi, a person at healdesk will reply with the next step by Wednesday.",
  checks: CHECKS,
  factsUsed: [{ tool: "get_case_history", field: "A person replies by", value: "Wednesday 28 October 2026" }],
  questionsForOps: ["Has the carrier confirmed the codes?"],
  confidence: "medium",
  createdAt: "2026-10-27T15:00:00.000Z",
  failure: null,
};

const CASE = { case: ROW, messages: [], facts: null, draft: DRAFT, people: ["The Healdesk Team"] };

describe("getSupportCase's draft", () => {
  test("a draft is read whole: its text, its eight checks, its facts, the questions and the confidence", async () => {
    reply({ data: CASE });
    const result = await fetchSupportCase(CASE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.draft).toEqual(DRAFT);
  });

  test("a failed run has a reason and no version or text", async () => {
    const failed = { ...DRAFT, version: null, text: null, checks: [], factsUsed: [], questionsForOps: [], confidence: null, failure: "model_unavailable" };
    reply({ data: { ...CASE, draft: failed } });
    const result = await fetchSupportCase(CASE_ID);
    expect(result.ok && result.data.draft).toEqual(failed);
  });

  test("no draft yet is null", async () => {
    reply({ data: { ...CASE, draft: null } });
    const result = await fetchSupportCase(CASE_ID);
    expect(result.ok && result.data.draft).toBeNull();
  });

  test("a draft with a failure, a failure with text, an unknown check, tool, failure or extra field is malformed", async () => {
    const bad = [
      { ...DRAFT, failure: "model_failed" },
      { ...DRAFT, version: null, failure: "model_failed" },
      { ...DRAFT, version: null },
      { ...DRAFT, checks: [{ id: "vibes", ok: true, rule: "x" }] },
      { ...DRAFT, factsUsed: [{ tool: "get_everything", field: "x", value: "y" }] },
      { ...DRAFT, failure: "tired", version: null, text: null },
      { ...DRAFT, inboundText: "Marisol called" },
      { ...DRAFT, confidence: "certain" },
    ];
    for (const draft of bad) reply({ data: { ...CASE, draft } });
    for (let i = 0; i < bad.length; i += 1) expect((await fetchSupportCase(CASE_ID)).ok, String(i)).toBe(false);
  });
});

describe("regenerateSupportDraft", () => {
  test("sends only the case id, as a write, and reads the outcome strictly", async () => {
    reply({ data: { outcome: "done", ref: "HD-6V104", state: "new", auditRecorded: true } });
    reply({ data: { outcome: "unchanged", ref: "HD-6V104", state: "new", auditRecorded: true } });
    reply({ data: { outcome: "done", ref: "HD-6V104", state: "drafted", auditRecorded: true } });
    expect(await regenerateSupportDraft(CASE_ID)).toEqual({
      ok: true,
      data: { outcome: "done", ref: "HD-6V104", state: "new", auditRecorded: true },
    });
    expect((await regenerateSupportDraft(CASE_ID)).ok).toBe(true);
    expect((await regenerateSupportDraft(CASE_ID)).ok, "a regeneration leaves the case new").toBe(false);
    expect(sent).toEqual([
      { op: "regenerateSupportDraft", args: { caseId: CASE_ID } },
      { op: "regenerateSupportDraft", args: { caseId: CASE_ID } },
      { op: "regenerateSupportDraft", args: { caseId: CASE_ID } },
    ]);
  });

  test("a refusal reaches the console as apps/app's sentence", async () => {
    reply({ error: "HD-6V104 has had 5 drafts, the most a case gets. Edit the last one or write the reply yourself.", code: "invalid_args" }, 409);
    const result = await regenerateSupportDraft(CASE_ID);
    expect(result.ok).toBe(false);
  });
});
