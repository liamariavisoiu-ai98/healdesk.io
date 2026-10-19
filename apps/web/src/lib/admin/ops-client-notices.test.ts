import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's operator notices and incidents page (WP7), against a
 * stubbed upstream: every write sends exactly the catalog's codes, dates and
 * ids (a code off the list stops here, unsent), and every read is checked
 * field by field, the incidents' two deadlines included.
 *
 * The session check and the browser headers are stubbed; the signing, the
 * transport and the readers are the real ones, as in ops-client.test.ts.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  fetchIncidentRegister,
  fetchOperatorNotices,
  markIncidentNotReportable,
  recordGuaranteeClaim,
  sendGuaranteeFinding,
  sendIncidentReport,
  sendProductUpdate,
  sendSubprocessorNotice,
  sendTermsNotice,
  suspendForCause,
} from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INCIDENT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";

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

const REGISTER_ROW = {
  id: INCIDENT,
  clinicId: CLINIC,
  clinicSlug: "radiance",
  clinicName: "Radiance Med Spa",
  class: "breach",
  summary: "Notice 7f3a went to a second inbox.",
  conversationId: null,
  discoveredAt: "2026-10-05T12:00:00.000Z",
  agreementNotifyBy: "2026-12-04T12:00:00.000Z",
  agreementVersion: "1.5.0",
  targetNotifyBy: "2026-10-06T12:00:00.000Z",
  ftcNotifyBy: null,
  notifiedAt: null,
  notifiedHow: null,
  reportedAt: null,
  reportsSent: 0,
  notReportableAt: null,
  notReportableReason: null,
  decidedBy: null,
  resolvedAt: null,
  openedBy: "ops@healdesk.test",
};

describe("the incidents page", () => {
  test("reads each incident with the agreement's deadline and the internal target, kept apart", async () => {
    reply({ data: { incidents: [REGISTER_ROW] } });
    const read = await fetchIncidentRegister();
    expect(sent).toEqual([{ op: "listIncidentRegister", args: {} }]);
    expect(read.ok && read.data[0]).toMatchObject({
      agreementNotifyBy: "2026-12-04 12:00 UTC",
      agreementNotifyByIso: "2026-12-04T12:00:00.000Z",
      agreementVersion: "1.5.0",
      targetNotifyBy: "2026-10-06 12:00 UTC",
      targetNotifyByIso: "2026-10-06T12:00:00.000Z",
      reportsSent: 0,
    });
  });

  test("an incident without its internal target, or with a class it doesn't know, is not shown half-read", async () => {
    reply({ data: { incidents: [{ ...REGISTER_ROW, targetNotifyBy: undefined }] } });
    expect((await fetchIncidentRegister()).ok).toBe(false);
    reply({ data: { incidents: [{ ...REGISTER_ROW, class: "rumour" }] } });
    expect((await fetchIncidentRegister()).ok).toBe(false);
  });

  test("Send report sends exactly the fixed fields: codes, counts and a date", async () => {
    reply({ data: { status: "sent", report: 1, auditRecorded: true } });
    const result = await sendIncidentReport(CLINIC, INCIDENT, {
      event: "misdirected_email",
      occurredOn: "2026-10-04",
      info: [{ type: "phone_number", count: 3 }],
      mitigations: ["fault_fixed"],
    });
    expect(result).toEqual({ ok: true, data: { status: "sent", report: 1, auditRecorded: true } });
    expect(sent).toEqual([
      {
        op: "sendIncidentReport",
        args: {
          clinicId: CLINIC,
          incidentId: INCIDENT,
          event: "misdirected_email",
          occurredOn: "2026-10-04",
          info: [{ type: "phone_number", count: 3 }],
          mitigations: ["fault_fixed"],
        },
      },
    ]);
  });

  test("a code off the catalog's lists, or a stray field, never leaves the console", async () => {
    const offList = await sendIncidentReport(CLINIC, INCIDENT, {
      event: "the caller's name leaked" as never,
      info: [],
      mitigations: [],
    });
    expect(offList.ok).toBe(false);
    const withWords = await sendIncidentReport(CLINIC, INCIDENT, {
      event: "other",
      info: [],
      mitigations: ["we called Jane" as never],
    });
    expect(withWords.ok).toBe(false);
    expect(sent).toEqual([]);

    // A field the form never had is dropped, not carried.
    reply({ data: { status: "sent", report: 1, auditRecorded: true } });
    await sendIncidentReport(CLINIC, INCIDENT, {
      event: "other",
      info: [{ type: "first_name", count: 1, value: "Jane" } as never],
      mitigations: [],
    });
    expect(sent[0]!.args.info).toEqual([{ type: "first_name", count: 1 }]);
    expect(JSON.stringify(sent)).not.toContain("Jane");
  });

  test("Not reportable sends the reason, and reads a refusal's sentence", async () => {
    reply({
      data: { status: "refused", message: "The reason looks like it carries patient details." },
    });
    const result = await markIncidentNotReportable(CLINIC, INCIDENT, "Blocked sign-ins only.");
    expect(result).toEqual({
      ok: true,
      data: { status: "refused", message: "The reason looks like it carries patient details." },
    });
    expect(sent).toEqual([
      {
        op: "markIncidentNotReportable",
        args: { clinicId: CLINIC, incidentId: INCIDENT, reason: "Blocked sign-ins only." },
      },
    ]);
  });
});

describe("the notices", () => {
  const QUEUED = {
    status: "queued",
    queued: 3,
    alreadyQueued: 1,
    noAddress: 0,
    failed: 0,
    auditRecorded: true,
  };

  test("each broadcast sends the catalog's codes and a date, and reads how many it reached", async () => {
    reply({ data: QUEUED });
    reply({ data: QUEUED });
    reply({ data: QUEUED });
    expect(
      await sendTermsNotice({
        version: "2026-11-30.1",
        effectiveOn: "2026-11-30",
        topics: ["fees"],
        isPublished: true,
      }),
    ).toEqual({ ok: true, data: QUEUED });
    await sendSubprocessorNotice({ provider: "retell", startsAt: "2026-11-01T15:00:00.000Z" });
    await sendProductUpdate("transcripts_by_email");
    expect(sent).toEqual([
      {
        op: "sendTermsNotice",
        args: {
          version: "2026-11-30.1",
          effectiveOn: "2026-11-30",
          topics: ["fees"],
          isPublished: true,
        },
      },
      {
        op: "sendSubprocessorNotice",
        args: { provider: "retell", startsAt: "2026-11-01T15:00:00.000Z" },
      },
      { op: "sendProductUpdate", args: { code: "transcripts_by_email" } },
    ]);
  });

  test("a subcontractor, a topic, an update or a version off the list is refused here", async () => {
    expect(
      (
        await sendSubprocessorNotice({
          provider: "acme" as never,
          startsAt: "2026-11-01T15:00:00.000Z",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await sendTermsNotice({
          version: "v2 <b>",
          effectiveOn: "2026-11-30",
          topics: ["fees"],
          isPublished: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await sendTermsNotice({
          version: "2026-11-30.1",
          effectiveOn: "2026-11-30",
          topics: ["all" as never],
          isPublished: true,
        })
      ).ok,
    ).toBe(false);
    expect((await sendProductUpdate("free_month" as never)).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test("the guarantee and the suspension send ids, dates and codes", async () => {
    reply({ data: { status: "queued", findingByOn: "2026-11-26", auditRecorded: true } });
    reply({ data: { status: "queued", auditRecorded: true } });
    reply({ data: { status: "suspended", auditRecorded: true } });
    expect(await recordGuaranteeClaim(CLINIC, "2026-11-12")).toEqual({
      ok: true,
      data: { status: "queued", findingByOn: "2026-11-26", auditRecorded: true },
    });
    await sendGuaranteeFinding(CLINIC, {
      claimReceivedOn: "2026-11-12",
      outcome: "miss_found",
      refundByOn: "2026-12-03",
      failure: "hosting",
    });
    expect(await suspendForCause(CLINIC, "legal_order")).toEqual({
      ok: true,
      data: { status: "suspended", auditRecorded: true },
    });
    expect(sent).toEqual([
      { op: "recordGuaranteeClaim", args: { clinicId: CLINIC, claimReceivedOn: "2026-11-12" } },
      {
        op: "sendGuaranteeFinding",
        args: {
          clinicId: CLINIC,
          claimReceivedOn: "2026-11-12",
          outcome: "miss_found",
          refundByOn: "2026-12-03",
          failure: "hosting",
        },
      },
      { op: "suspendForCause", args: { clinicId: CLINIC, cause: "legal_order" } },
    ]);
    expect((await suspendForCause(CLINIC, "late again" as never)).ok).toBe(false);
    expect((await suspendForCause("not-a-clinic", "legal_order")).ok).toBe(false);
    expect(sent).toHaveLength(3);
  });

  test("the record reads states and counts only", async () => {
    reply({
      data: {
        broadcasts: [
          {
            kind: "product_update",
            subject: "transcripts_by_email",
            firstQueuedAt: "2026-10-14T15:00:00.000Z",
            counts: { sent: 2, switched_off: 1, not_sent: 0, dead: 0, pending: 0 },
          },
        ],
        notices: [
          {
            clinicId: CLINIC,
            clinicSlug: "radiance",
            clinicName: "Radiance Med Spa",
            kind: "incident_report",
            subject: `${INCIDENT}:1`,
            queuedAt: "2026-10-14T15:00:00.000Z",
            state: "dead",
          },
        ],
        openClaims: [
          {
            clinicId: CLINIC,
            clinicSlug: "radiance",
            clinicName: "Radiance Med Spa",
            claimReceivedOn: "2026-11-12",
            findingByOn: "2026-11-26",
          },
        ],
      },
    });
    const read = await fetchOperatorNotices();
    expect(read.ok && read.data.broadcasts[0]!.counts).toEqual({
      sent: 2,
      switched_off: 1,
      not_sent: 0,
      dead: 0,
      pending: 0,
    });
    expect(read.ok && read.data.notices[0]!.state).toBe("dead");
    expect(read.ok && read.data.openClaims[0]!.findingByOn).toBe("2026-11-26");

    reply({ data: { broadcasts: [], notices: [{ state: "lost" }], openClaims: [] } });
    expect((await fetchOperatorNotices()).ok).toBe(false);
  });
});
