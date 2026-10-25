import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's incident assistant operations (lane P6i; apps/app
 * lib/ops/incident-assistant-ops.ts and lib/approvals/incident-kinds.ts)
 * against a stubbed upstream: each call sends exactly the op and args
 * apps/app reads, each reply is read field by field (a key apps/app does not
 * send, or a value off its list, is a malformed answer), the Approvals
 * section's reads leave the incident items to their own reader, and a
 * report's choices cross the fresh-code wrapper as list codes only. The
 * session check and the browser headers are stubbed; the signing, the
 * transport, the readers and the fresh-code check are the real ones.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import {
  fetchApprovalHistory,
  fetchApprovals,
  fetchIncidentApprovalHistory,
  fetchIncidentApprovals,
  fetchIncidentChecklist,
  fetchIncidentScope,
  proposeIncidentBatch,
  proposeIncidentReport,
  tickIncidentStep,
  type IncidentReportChoices,
} from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INCIDENT = "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const MALFORMED = { ok: false, code: "malformed" };

let replies: unknown[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];

function reply(data: unknown): void {
  replies.push({ data });
}

const fresh = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));

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

const CLOCKS = {
  internalTarget: "2026-11-02T12:00:00.000Z",
  agreementDeadline: "2026-12-31T12:00:00.000Z",
  agreementRule: "sixty_calendar_days",
  ownerNoticeBy: null,
};

const SCOPE_CLINIC = {
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  billingClinicId: null,
  conversations: { voice: 2, web: 1, meta: 1 },
  total: 4,
  holdsData: null,
  agreementVersion: "1.5.0",
  coveredEntity: true,
  demo: false,
  offboarding: false,
  clocks: CLOCKS,
};

const SCOPE = {
  source: "vendor",
  value: "anthropic",
  reach: "window_only",
  channels: ["voice", "web", "meta"],
  from: "2026-10-29T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  clinics: [SCOPE_CLINIC],
  clinicsWithNone: 3,
  unread: 0,
};

const CHOICES: IncidentReportChoices = {
  event: "subcontractor_incident",
  occurredOn: "2026-10-29",
  info: [{ type: "conversation_transcript", count: 4 }],
  mitigations: ["investigating"],
  steps: [],
  recommendations: ["keep_record"],
  delayedByLawEnforcement: false,
  delayEndedOn: null,
};

const REPORT_ITEM = {
  id: ITEM,
  kind: "incident_report_send",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${INCIDENT}:1`,
  urgency: "legal_clock",
  status: "waiting",
  proposedAt: "2026-11-01T12:05:00.000Z",
  dueAt: "2026-12-31T12:00:00.000Z",
  expiresAt: null,
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "sendIncidentReport",
  hasDraft: false,
  packet: {
    operation: "sendIncidentReport",
    irreversible: true,
    stillNeeded: true,
    effect: "Emails the practice's address this incident's report, built only from the choices below, and records the practice as told. It cannot be taken back.",
    facts: {
      kind: "incident_report_send",
      incidentId: INCIDENT,
      incidentClass: "security_incident",
      report: 1,
      discoveredAt: "2026-11-01T12:00:00.000Z",
      internalTarget: "2026-11-02T12:00:00.000Z",
      agreementDeadline: "2026-12-31T12:00:00.000Z",
      agreementVersion: "1.5.0",
      ownerNoticeBy: null,
      affectedRecorded: 0,
      ticked: ["contain", "open"],
      fields: CHOICES,
    },
  },
};

const BATCH_ITEM = {
  ...REPORT_ITEM,
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  kind: "incident_open_batch",
  clinic: null,
  subjectRef: "vendor:anthropic:2026-10-29T00:00:00.000Z:2026-10-31T00:00:00.000Z:security_incident",
  operation: "openIncident",
  packet: {
    operation: "openIncident",
    irreversible: true,
    stillNeeded: true,
    effect: "Opens an incident at the 1 clinic below, classed as a security incident, and puts each one's report in this list for your yes. Nothing is sent to any clinic.",
    facts: {
      kind: "incident_open_batch",
      source: "vendor",
      value: "anthropic",
      reach: "window_only",
      from: "2026-10-29T00:00:00.000Z",
      to: "2026-10-31T00:00:00.000Z",
      incidentClass: "security_incident",
      discoveredAt: "2026-11-01T12:00:00.000Z",
      clinicsTotal: 1,
      toOpen: 1,
      alreadyOpen: 0,
      outOfService: 0,
      clinics: [
        {
          clinicId: CLINIC,
          clinicName: "Radiance Med Spa",
          conversations: 4,
          agreementVersion: "1.5.0",
          clocks: CLOCKS,
          opened: false,
          inService: true,
        },
      ],
    },
  },
};

describe("fetchIncidentScope", () => {
  test("sends the vendor or the channel with the window, and reads each clinic strictly", async () => {
    reply(SCOPE);
    const read = await fetchIncidentScope({
      vendor: "anthropic",
      from: SCOPE.from,
      to: SCOPE.to,
      class: "security_incident",
      discoveredAt: "2026-11-01T12:00:00.000Z",
    });
    expect(read).toEqual({ ok: true, data: SCOPE });
    expect(sent).toEqual([
      {
        op: "incidentScope",
        args: { vendor: "anthropic", from: SCOPE.from, to: SCOPE.to, class: "security_incident", discoveredAt: "2026-11-01T12:00:00.000Z" },
      },
    ]);
    reply({ ...SCOPE, value: "voice", source: "channel" });
    await fetchIncidentScope({ channel: "voice", from: SCOPE.from, to: SCOPE.to });
    expect(sent[1]).toEqual({ op: "incidentScope", args: { channel: "voice", from: SCOPE.from, to: SCOPE.to } });
  });

  test("a clinic with a field apps/app does not send, a vendor off the list or a count as words is malformed", async () => {
    for (const bad of [
      { ...SCOPE, value: "stripe" },
      { ...SCOPE, clinics: [{ ...SCOPE_CLINIC, phone: "+15550100123" }] },
      { ...SCOPE, clinics: [{ ...SCOPE_CLINIC, conversations: { voice: "two", web: 1, meta: 1 } }] },
      { ...SCOPE, clinics: [{ ...SCOPE_CLINIC, clocks: { ...CLOCKS, agreementRule: "whenever" } }] },
      { ...SCOPE, extra: true },
      { ...SCOPE, reach: "everyone" },
    ]) {
      reply(bad);
      expect(await fetchIncidentScope({ vendor: "anthropic", from: SCOPE.from, to: SCOPE.to })).toMatchObject(MALFORMED);
    }
  });
});

describe("the checklist", () => {
  test("reads every step, and a tick sends the step alone", async () => {
    reply({
      incidentId: INCIDENT,
      steps: [
        { step: "contain", tickedAt: "2026-11-01T12:10:00.000Z", tickedBy: "ops@healdesk.test", affectedCount: null, fromBatch: false },
        { step: "open", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
      ],
    });
    expect(await fetchIncidentChecklist(CLINIC, INCIDENT)).toMatchObject({ ok: true, data: { status: "read" } });
    expect(sent[0]).toEqual({ op: "incidentChecklist", args: { clinicId: CLINIC, incidentId: INCIDENT } });

    reply({ status: "ticked", step: "notify_phone", tickedAt: "2026-11-01T13:00:00.000Z", affectedCount: null, auditRecorded: true });
    expect(await tickIncidentStep(CLINIC, INCIDENT, "notify_phone")).toEqual({
      ok: true,
      data: { status: "ticked", step: "notify_phone", tickedAt: "2026-11-01T13:00:00.000Z", affectedCount: null, auditRecorded: true },
    });
    expect(sent[1]).toEqual({ op: "tickIncidentStep", args: { clinicId: CLINIC, incidentId: INCIDENT, step: "notify_phone" } });

    reply({ status: "refused", message: "This incident is not resolved yet." });
    expect(await tickIncidentStep(CLINIC, INCIDENT, "resolve")).toEqual({
      ok: true,
      data: { status: "refused", message: "This incident is not resolved yet." },
    });
    reply({ status: "ticked", step: "called the patient", tickedAt: "2026-11-01T13:00:00.000Z", affectedCount: null, auditRecorded: true });
    expect(await tickIncidentStep(CLINIC, INCIDENT, "contain")).toMatchObject(MALFORMED);
  });
});

describe("the proposals", () => {
  test("a batch sends the scope and its class and discovery; a report its incident; both read the item's id", async () => {
    reply({ status: "proposed", approvalId: ITEM, clinics: 1, auditRecorded: true });
    expect(
      await proposeIncidentBatch({
        vendor: "retell",
        from: SCOPE.from,
        to: SCOPE.to,
        class: "breach",
        discoveredAt: "2026-11-01T12:00:00.000Z",
      }),
    ).toEqual({ ok: true, data: { status: "proposed", approvalId: ITEM, clinics: 1, auditRecorded: true } });
    expect(sent[0]).toEqual({
      op: "proposeIncidentBatch",
      args: { vendor: "retell", from: SCOPE.from, to: SCOPE.to, class: "breach", discoveredAt: "2026-11-01T12:00:00.000Z" },
    });
    reply({ status: "already_waiting", approvalId: ITEM, auditRecorded: true });
    expect(await proposeIncidentReport(CLINIC, INCIDENT)).toEqual({
      ok: true,
      data: { status: "already_waiting", approvalId: ITEM, clinics: null, auditRecorded: true },
    });
    expect(sent[1]).toEqual({ op: "proposeIncidentReport", args: { clinicId: CLINIC, incidentId: INCIDENT } });
    reply({ status: "proposed", approvalId: "not-an-id", auditRecorded: true });
    expect(await proposeIncidentReport(CLINIC, INCIDENT)).toMatchObject(MALFORMED);
  });
});

describe("the inbox's incident items", () => {
  test("are read by their own reader, and left out of the Approvals section's reads", async () => {
    reply({ items: [REPORT_ITEM, BATCH_ITEM], partial: [] });
    const read = await fetchIncidentApprovals();
    expect(read).toEqual({ ok: true, data: { items: [REPORT_ITEM, { ...BATCH_ITEM }], partial: [] } });
    expect(sent[0]).toEqual({ op: "listApprovals", args: { family: "incident" } });

    reply({ items: [REPORT_ITEM, BATCH_ITEM], partial: [] });
    expect(await fetchApprovals()).toEqual({ ok: true, data: { items: [], partial: [] } });

    const event = {
      id: "0b5e1c2d-3f40-4a51-8b62-7c83d94ea5f6",
      approvalId: ITEM,
      kind: "incident_report_send",
      clinic: { id: CLINIC, name: "Radiance Med Spa" },
      event: "executed",
      actorLabel: "ops@healdesk.test",
      ip: "203.0.113.9",
      userAgent: "vitest",
      draftHashApproved: "a".repeat(64),
      draftHashSent: "a".repeat(64),
      outcomeCode: "sent",
      at: "2026-11-01T13:00:00.000Z",
    };
    reply({ events: [event] });
    expect(await fetchApprovalHistory()).toEqual({ ok: true, data: [] });
    reply({ events: [event] });
    expect(await fetchIncidentApprovalHistory()).toEqual({ ok: true, data: [event] });
  });

  test("a report's draft with a sentence for a code, an extra key, or the facts of another kind is malformed", async () => {
    const facts = REPORT_ITEM.packet.facts;
    for (const bad of [
      { ...facts, fields: { ...CHOICES, event: "Jane's number was emailed" } },
      { ...facts, fields: { ...CHOICES, note: "free text" } },
      { ...facts, fields: { ...CHOICES, info: [{ type: "phone_number", count: 0 }] } },
      { ...facts, fields: { ...CHOICES, mitigations: ["investigating", "investigating"] } },
      { ...facts, ticked: ["called_the_patient"] },
      { ...facts, kind: "incident_open_batch" },
    ]) {
      reply({ items: [{ ...REPORT_ITEM, packet: { ...REPORT_ITEM.packet, facts: bad } }], partial: [] });
      expect(await fetchIncidentApprovals(), JSON.stringify(bad).slice(0, 60)).toMatchObject(MALFORMED);
    }
  });
});

describe("a report's choices through the fresh-code wrapper", () => {
  test("cross as list codes alone, after the code is checked; nothing crosses without it", async () => {
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", "000000", undefined, CHOICES)).toMatchObject({
      ok: true,
      data: { status: "code_refused" },
    });
    expect(sent).toEqual([]);

    reply({ status: "executed", outcomeCode: "sent", message: "Sent.", auditRecorded: true });
    const code = fresh();
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", code, undefined, CHOICES)).toMatchObject({
      ok: true,
      data: { status: "executed", outcomeCode: "sent" },
    });
    expect(sent).toEqual([
      { op: "decideApproval", args: { id: ITEM, action: "approve", reasonCode: "owner_checked", codeChecked: true, editedFields: CHOICES } },
    ]);
    expect(JSON.stringify(sent)).not.toContain(code);

    // A choice off the lists is refused here and never sent.
    __resetStepLedgerForTests();
    const hostile = { ...CHOICES, event: "Jane's number leaked", extra: "x" } as unknown as IncidentReportChoices;
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", fresh(), undefined, hostile)).toEqual({
      ok: true,
      data: { status: "refused", message: "Each choice must come from its list. Nothing was sent." },
    });
    expect(sent).toHaveLength(1);
  });
});
