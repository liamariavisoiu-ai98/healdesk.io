import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's compliance-pack operations (lane P6h; apps/app
 * lib/ops/pack-ops.ts) against a stubbed upstream: each call sends exactly
 * the op and args apps/app reads, and each reply is read field by field, so
 * a field apps/app does not send (free text, an address, a summary), a
 * section that is neither read nor `could_not_read`, or a zero hiding inside
 * a section that could not be read is a malformed answer, never a page. The
 * session check and the browser headers are stubbed; the signing, the
 * transport and the readers are the real ones.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  fetchCompliancePack,
  fetchCompliancePacks,
  generateCompliancePack,
  PACK_ACCESS_EVENTS,
  PACK_FAILURE_EVENTS,
  PACK_LIFECYCLE_JOBS,
  PACK_SUBJECTS,
  type CompliancePackView,
} from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INCIDENT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const PACK = "9a8b7c6d-1111-4222-8333-444455556666";
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

const HEADLINE = {
  incidentsOpen: 1,
  rightsOverdue: 0,
  resignsOpen: null,
  vendorsNeedingAttention: 4,
  transcriptCopiesPast30Days: 0,
};

/** A pack as apps/app's buildCompliancePack makes one: every section, one of them unread. */
const PAYLOAD: CompliancePackView = {
  schema: 1,
  week: {
    start: "2026-10-19",
    lastDay: "2026-10-25",
    timeZone: "America/New_York",
    from: "2026-10-19T04:00:00.000Z",
    to: "2026-10-26T04:00:00.000Z",
  },
  headline: HEADLINE,
  agreements: { status: "could_not_read", unreadClinics: 1 },
  vendors: {
    status: "ok",
    subjects: PACK_SUBJECTS.map((subject, i) => ({
      subject,
      kind: i < 4 ? ("vendor" as const) : ("readiness" as const),
      state: subject === "aws" ? ("in_force" as const) : ("not_attested" as const),
      effectiveOn: subject === "aws" ? "2026-10-19" : null,
      expiresOn: subject === "aws" ? "2026-11-08" : null,
      expiresWithin30Days: subject === "aws",
    })),
    recordedThisWeek: 1,
  },
  incidents: {
    status: "ok",
    openedThisWeek: 1,
    openedByClass: [{ class: "security_incident", count: 1 }],
    notifiedThisWeek: 0,
    reportedThisWeek: 0,
    notReportableThisWeek: 0,
    resolvedThisWeek: 0,
    openAtWeekEnd: 1,
    targetMissed: [{ clinicId: CLINIC, incidentId: INCIDENT }],
    agreementDeadlineAtRisk: [{ clinicId: CLINIC, incidentId: INCIDENT, agreementNotifyBy: "2026-10-31T04:00:00.000Z" }],
  },
  rights: {
    status: "ok",
    receivedThisWeek: 1,
    receivedByKind: [{ kind: "erasure", count: 1 }],
    closedThisWeek: 0,
    closedOnTimeThisWeek: 0,
    closedLateThisWeek: 0,
    openAtWeekEnd: 1,
    overdueAtWeekEnd: 0,
    dueSoonAtWeekEnd: 0,
    blockedNow: 1,
  },
  dataLifecycle: {
    status: "ok",
    transcripts: { queuedThisWeek: 3, deliveredThisWeek: 3, copiesPast30DaysNow: 0 },
    jobs: PACK_LIFECYCLE_JOBS.map((job) => ({ job, enabled: job !== "transcript-emails", lastRunAt: "2026-10-25T03:00:00.000Z", lastRunStatus: "ok" })),
    failureAlertsThisWeek: PACK_FAILURE_EVENTS.map((event) => ({ event, count: 0 })),
  },
  access: {
    status: "ok",
    events: PACK_ACCESS_EVENTS.map((event) => ({ event, count: event === "passkey_added" ? 2 : 0 })),
    freshCodeSteps: { approvalDecisions: 1, platformAttestations: 1, deviceRecoveriesIssued: 0 },
    operatorSignIns: "not_recorded_on_the_host",
  },
  approvals: {
    status: "ok",
    approvedThisWeek: 1,
    rejectedThisWeek: 0,
    executedThisWeek: 1,
    failedThisWeek: 0,
    expiredThisWeek: 0,
    medianMinutesToDecide: 90,
    waitingAtWeekEnd: 0,
  },
  launchPromises: { status: "read_on_the_console" },
};

const RECORD = {
  id: PACK,
  weekStart: "2026-10-19",
  generatedAt: "2026-10-26T11:00:00.000Z",
  generatedBy: "compliance-pack",
  payloadHash: HASH,
  payload: PAYLOAD,
};

describe("fetchCompliancePack", () => {
  test("sends the week and reads the whole pack, field by field", async () => {
    reply({ data: { status: "found", pack: RECORD } });
    expect(await fetchCompliancePack("2026-10-19")).toEqual({ ok: true, data: { status: "found", pack: RECORD } });
    expect(sent).toEqual([{ op: "getCompliancePack", args: { week: "2026-10-19" } }]);

    reply({ data: { status: "not_found" } });
    expect(await fetchCompliancePack("2026-10-12")).toEqual({ ok: true, data: { status: "not_found" } });
  });

  test("free text, an extra field or an unknown word anywhere in the pack is a malformed answer", async () => {
    const bad: unknown[] = [
      { ...PAYLOAD, note: "anything" },
      { ...PAYLOAD, incidents: { ...PAYLOAD.incidents, summary: "a laptop on a train" } },
      { ...PAYLOAD, incidents: { ...PAYLOAD.incidents, targetMissed: [{ clinicId: CLINIC, incidentId: "owner@clinic.test" }] } },
      { ...PAYLOAD, vendors: { status: "ok", subjects: [{ ...(PAYLOAD.vendors as { subjects: object[] }).subjects[0], documentRef: "doc" }], recordedThisWeek: 0 } },
      { ...PAYLOAD, access: { ...PAYLOAD.access, events: [{ event: "something_new", count: 1 }] } },
      { ...PAYLOAD, week: { ...PAYLOAD.week, timeZone: "UTC" } },
      { ...PAYLOAD, schema: 2 },
      { ...PAYLOAD, launchPromises: { status: "ok", open: ["x"] } },
      { ...PAYLOAD, agreements: { status: "ok" } },
      { ...PAYLOAD, approvals: { ...PAYLOAD.approvals, medianMinutesToDecide: -1 } },
      { ...PAYLOAD, dataLifecycle: { ...PAYLOAD.dataLifecycle, jobs: [{ job: "retention-purge", enabled: true, lastRunAt: null, lastRunStatus: "Ran at 3am for clinic 42" }] } },
    ];
    for (const payload of bad) {
      reply({ data: { status: "found", pack: { ...RECORD, payload } } });
      expect((await fetchCompliancePack("2026-10-19")).ok, JSON.stringify(payload).slice(0, 160)).toBe(false);
    }
  });

  test("a section that could not be read carries no numbers: a zero beside it is malformed", async () => {
    for (const section of [
      { status: "could_not_read", openedThisWeek: 0 },
      { status: "could_not_read", unreadClinics: -1 },
      { status: "partial", unreadClinics: 1 },
    ]) {
      reply({ data: { status: "found", pack: { ...RECORD, payload: { ...PAYLOAD, incidents: section } } } });
      expect((await fetchCompliancePack("2026-10-19")).ok, JSON.stringify(section)).toBe(false);
    }
    reply({ data: { status: "found", pack: { ...RECORD, payload: { ...PAYLOAD, incidents: { status: "could_not_read" } } } } });
    expect((await fetchCompliancePack("2026-10-19")).ok).toBe(true);
  });

  test("a bad id, hash, service name or day in the record is malformed", async () => {
    for (const record of [
      { ...RECORD, id: "1" },
      { ...RECORD, payloadHash: "xyz" },
      { ...RECORD, generatedBy: "Ops Console" },
      { ...RECORD, weekStart: "19 Oct" },
      { ...RECORD, generatedAt: "yesterday" },
      { ...RECORD, extra: true },
    ]) {
      reply({ data: { status: "found", pack: record } });
      expect((await fetchCompliancePack("2026-10-19")).ok, JSON.stringify(record).slice(0, 80)).toBe(false);
    }
  });
});

describe("fetchCompliancePacks", () => {
  test("sends only the limit asked for and reads each summary with its headline", async () => {
    const summary = { ...RECORD, headline: HEADLINE } as Record<string, unknown>;
    delete summary.payload;
    reply({ data: { packs: [summary, { ...summary, weekStart: "2026-10-12", headline: null }] } });
    expect(await fetchCompliancePacks()).toEqual({
      ok: true,
      data: [summary, { ...summary, weekStart: "2026-10-12", headline: null }],
    });
    expect(sent).toEqual([{ op: "listCompliancePacks", args: {} }]);
    reply({ data: { packs: [] } });
    await fetchCompliancePacks(26);
    expect(sent[1]).toEqual({ op: "listCompliancePacks", args: { limit: 26 } });

    reply({ data: { packs: [{ ...summary, headline: { ...HEADLINE, incidentsOpen: "1" } }] } });
    expect((await fetchCompliancePacks()).ok).toBe(false);
  });
});

describe("generateCompliancePack", () => {
  test("sends the week when given and reads a stored pack or a refusal", async () => {
    const stored = { status: "stored", weekStart: "2026-10-19", packId: PACK, payloadHash: HASH, unreadSections: 1, auditRecorded: true };
    reply({ data: stored });
    expect(await generateCompliancePack("2026-10-19")).toEqual({ ok: true, data: stored });
    expect(sent).toEqual([{ op: "generateCompliancePack", args: { week: "2026-10-19" } }]);

    reply({ data: { status: "refused", message: "That week's pack is already stored." } });
    expect(await generateCompliancePack()).toEqual({
      ok: true,
      data: { status: "refused", message: "That week's pack is already stored." },
    });
    expect(sent[1]).toEqual({ op: "generateCompliancePack", args: {} });

    reply({ data: { ...stored, payload: {} } });
    expect((await generateCompliancePack()).ok).toBe(false);
  });
});
