import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's support-case operations (lane P7a; apps/app
 * lib/ops/support-case-ops.ts) against a stubbed upstream: each call sends
 * exactly the op and args apps/app reads, and each reply is read field by
 * field, so a shape apps/app does not send, a field with words in it, or a
 * draft before lane P7b writes one, is a malformed answer, never a half-read
 * page. The GET fixture is a reply apps/app produced for a real provisioned
 * clinic (tests/support-case-ops.test.ts's shape). The session check and
 * the browser headers are stubbed; the signing, the transport and the
 * readers are the real ones.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  assignSupportCase,
  closeSupportCase,
  fetchSupportCase,
  fetchSupportCases,
  matchSupportCase,
  snoozeSupportCase,
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

const CASE = {
  "case": {
    "id": "8c584284-535b-403e-a40c-7ca25c7dee15",
    "ref": "HD-6V104",
    "clinicId": "7c0cd609-27e7-417c-880f-c75bde09790c",
    "clinicName": "dump Med Spa LLC",
    "source": "chat",
    "category": "forwarding",
    "symptom": "calls_ring_out",
    "urgency": "now",
    "state": "new",
    "assigneeLabel": null,
    "openedAt": "2026-10-25T15:34:42.171Z",
    "ageHours": 0,
    "replyByOn": "2026-10-15",
    "pastDue": true,
    "snoozedUntil": null,
    "lastInboundAt": "2026-10-25T15:34:42.171Z",
    "lastOutboundAt": null,
    "closedAt": null,
    "closedReason": null,
    "phiSuspected": false,
    "hidden": {
      "numbers": 0,
      "emails": 0,
      "treatments": 0,
      "clinical": 0
    },
    "inboundCount": 1
  },
  "messages": [
    {
      "id": "e733f661-692b-4f88-b121-20f00c6ff2b6",
      "direction": "in",
      "kind": "chat_escalation",
      "at": "2026-10-25T15:34:42.171Z",
      "fields": {
        "mode": "all_calls",
        "topic": "forwarding",
        "carrier": "verizon",
        "channel": null,
        "symptom": "calls_ring_out",
        "phoneSystem": "landline"
      },
      "hasDraft": false,
      "draftVersion": null,
      "approvedAt": null,
      "sentAt": null
    }
  ],
  "facts": {
    "days": 14,
    "account": {
      "clinicId": "7c0cd609-27e7-417c-880f-c75bde09790c",
      "isClosed": false,
      "isSetupFinished": false,
      "setupStepsLeftCount": 4,
      "setupDeadlineAt": "2026-11-25T04:59:59.999Z",
      "stageRows": [
        {
          "code": "agreement",
          "status": "done"
        },
        {
          "code": "payment",
          "status": "done"
        },
        {
          "code": "website",
          "status": "not_done"
        },
        {
          "code": "answers",
          "status": "not_done"
        },
        {
          "code": "calendar",
          "status": "info"
        },
        {
          "code": "built",
          "status": "not_done"
        },
        {
          "code": "practice_questions",
          "status": "not_done"
        }
      ],
      "channelRows": [
        {
          "channel": "web",
          "status": "setting_up",
          "waitingOn": "finish_setup",
          "isEnabled": true,
          "liveAt": null
        },
        {
          "channel": "voice",
          "status": "setting_up",
          "waitingOn": "finish_setup",
          "isEnabled": true,
          "liveAt": null
        }
      ],
      "isPaused": false,
      "pausedUntilAt": null,
      "mode": "overflow_after_hours",
      "carrier": null,
      "phoneSystem": "unknown",
      "isUrgentHelpSet": false,
      "isTransferOn": false,
      "isDailySummaryOn": true,
      "isDepositsOn": false,
      "connectionRows": [
        {
          "resource": "google_calendar",
          "status": "not_connected"
        },
        {
          "resource": "payment_account",
          "status": "not_connected"
        }
      ],
      "planId": "voice-webchat-500-300",
      "interval": "month",
      "status": "active",
      "isPlanStarted": false,
      "planStartedAt": null,
      "isAutoRenewOn": true,
      "closesOn": null,
      "overageMode": "allow",
      "isUsageAlertsOn": true,
      "hasOpenInvoice": false,
      "graceEndsAt": null,
      "usageRows": [
        {
          "meter": "voice_minutes",
          "used": 0,
          "included": 500
        },
        {
          "meter": "chat_conversations",
          "used": 0,
          "included": 300
        }
      ],
      "isAddressUndeliverable": false,
      "isPublishedPhoneSet": false,
      "isDirectLineSet": false
    },
    "alerts": [],
    "transcripts": {
      "open": 0,
      "pending": 0,
      "sent": 0,
      "bounced": 0,
      "delivered": 0,
      "expired": 0,
      "unconfirmed": 0
    }
  },
  "draft": null,
  "people": [
    "The Healdesk Team"
  ]
} as const;

const ROW = CASE.case;
const CASE_ID = ROW.id;

describe("listSupportCases", () => {
  test("sends the filter it was given and reads every row strictly", async () => {
    reply({ data: { rows: [ROW], count: 1, truncated: false } });
    const result = await fetchSupportCases({ state: "needs_us", limit: 50 });
    expect(sent).toEqual([{ op: "listSupportCases", args: { state: "needs_us", limit: 50 } }]);
    expect(result).toEqual({ ok: true, data: { rows: [ROW], count: 1, truncated: false } });
  });

  test("no filter sends no args; demo clinics only when asked", async () => {
    reply({ data: { rows: [], count: 0, truncated: false } });
    reply({ data: { rows: [], count: 0, truncated: false } });
    await fetchSupportCases();
    await fetchSupportCases({ includeDemo: true });
    expect(sent.map((s) => s.args)).toEqual([{}, { includeDemo: true }]);
  });

  test("a row with a field apps/app never sends (text) is a malformed answer", async () => {
    reply({ data: { rows: [{ ...ROW, text: "Marisol called" }], count: 1, truncated: false } });
    const result = await fetchSupportCases();
    expect(result.ok).toBe(false);
  });

  test("a ref that is not HD- and five Crockford characters is malformed", async () => {
    reply({ data: { rows: [{ ...ROW, ref: "HD-ILOU1" }], count: 1, truncated: false } });
    expect((await fetchSupportCases()).ok).toBe(false);
  });
});

describe("getSupportCase", () => {
  test("reads the case, its messages, its facts panel and the people, from a real reply", async () => {
    reply({ data: CASE });
    const result = await fetchSupportCase(CASE_ID);
    expect(sent).toEqual([{ op: "getSupportCase", args: { caseId: CASE_ID } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.case.ref).toBe(ROW.ref);
    expect(result.data.messages[0]!.fields).toMatchObject({ topic: "forwarding", symptom: "calls_ring_out" });
    expect(result.data.facts?.account?.isDirectLineSet).toBe(false);
    expect(result.data.facts?.transcripts).toMatchObject({ delivered: 0 });
    expect(result.data.draft).toBeNull();
    expect(result.data.people).toEqual(["The Healdesk Team"]);
  });

  test("a phone number in the facts, fields on an email, or a draft before P7b is malformed", async () => {
    reply({ data: { ...CASE, facts: { ...CASE.facts, account: { ...CASE.facts.account, directLineE164: "+15125550100" } } } });
    reply({ data: { ...CASE, messages: [{ ...CASE.messages[0], kind: "email" }] } });
    reply({ data: { ...CASE, draft: { text: "Hi" } } });
    reply({ data: { ...CASE, messages: [{ ...CASE.messages[0], fields: { ...CASE.messages[0].fields, carrier: "call 5125550100" } }] } });
    for (let i = 0; i < 4; i += 1) expect((await fetchSupportCase(CASE_ID)).ok, String(i)).toBe(false);
  });

  test("a case with no clinic has no facts", async () => {
    reply({ data: { ...CASE, case: { ...ROW, clinicId: null, clinicName: null, source: "email" }, messages: [], facts: null } });
    const result = await fetchSupportCase(CASE_ID);
    expect(result.ok && result.data.facts).toBeNull();
  });
});

describe("the moves", () => {
  const DONE = { outcome: "done", ref: ROW.ref, state: "snoozed", auditRecorded: true };

  test("each sends exactly its op and args, as writes, and reads the outcome strictly", async () => {
    reply({ data: DONE });
    reply({ data: { ...DONE, state: "new" } });
    reply({ data: { ...DONE, outcome: "unchanged", state: "new" } });
    reply({ data: { ...DONE, state: "closed" } });
    expect((await snoozeSupportCase(CASE_ID, "2026-10-28T13:00:00.000Z")).ok).toBe(true);
    expect((await assignSupportCase(CASE_ID, "Liam")).ok).toBe(true);
    expect((await matchSupportCase(CASE_ID, ROW.clinicId)).ok).toBe(true);
    const closed = await closeSupportCase(CASE_ID, "replied_by_hand");
    expect(closed).toEqual({ ok: true, data: { ...DONE, state: "closed" } });
    expect(sent).toEqual([
      { op: "snoozeSupportCase", args: { caseId: CASE_ID, until: "2026-10-28T13:00:00.000Z" } },
      { op: "assignSupportCase", args: { caseId: CASE_ID, label: "Liam" } },
      { op: "matchSupportCase", args: { caseId: CASE_ID, clinicId: ROW.clinicId } },
      { op: "closeSupportCase", args: { caseId: CASE_ID, reason: "replied_by_hand" } },
    ]);
  });

  test("a refusal reaches the console as one, with apps/app's sentence", async () => {
    reply({ error: "HD-6V104 is closed. A clinic that writes again opens a new case.", code: "invalid_args" }, 409);
    const result = await closeSupportCase(CASE_ID, "duplicate");
    expect(result.ok).toBe(false);
  });

  test("an outcome with an unknown state is malformed", async () => {
    reply({ data: { ...DONE, state: "archived" } });
    expect((await closeSupportCase(CASE_ID, "spam")).ok).toBe(false);
  });
});
