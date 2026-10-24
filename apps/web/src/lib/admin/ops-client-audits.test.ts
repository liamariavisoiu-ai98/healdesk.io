import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's clinic audits and availability changes (ops automation E3
 * and E4), against a stubbed upstream: each call sends exactly the op and
 * args apps/app's lib/ops/audit-ops.ts and change-ops.ts read, and each
 * reply is read field by field, so a shape apps/app does not send is a
 * malformed answer, never a half-read page. The session check and the
 * browser headers are stubbed; the signing, the transport and the readers
 * are the real ones, as in ops-client.test.ts.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  acknowledgeClinicChange,
  fetchClinicAudits,
  fetchClinicChanges,
  runClinicAudit,
} from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const AUDIT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const CHANGE = "7d1e2f3a-2222-4c2a-9a8b-1f2e3d4c5b6b";

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

const RUN = {
  id: AUDIT,
  pack: "availability",
  trigger: "manual",
  changeKind: null,
  result: "warn",
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:00:02.000Z",
  checks: [
    { id: "hours_valid", result: "pass", hint: null, counts: { openDays: 5 }, code: null, side: null },
    {
      id: "bookings_on_closed_days",
      result: "warn",
      hint: "Bookings or requests fall on a day the clinic has closed.",
      counts: { bookings: 2, liveHolds: 0, closedDays: 1 },
      code: null,
      side: null,
    },
  ],
};

describe("runClinicAudit", () => {
  test("sends the clinic and the pack, and reads the stored runs", async () => {
    reply({ data: { status: "ran", result: "warn", audits: [RUN], auditRecorded: true } });
    const result = await runClinicAudit(CLINIC, "availability");
    expect(sent).toEqual([{ op: "runClinicAudit", args: { clinicId: CLINIC, pack: "availability" } }]);
    expect(result).toEqual({ ok: true, data: { status: "ran", result: "warn", audits: [RUN], auditRecorded: true } });
  });

  test("with no pack, sends the clinic alone; a cool-down reads its time", async () => {
    reply({ data: { status: "too_soon", notBefore: "2026-10-23T10:01:00.000Z" } });
    const result = await runClinicAudit(CLINIC);
    expect(sent[0]).toEqual({ op: "runClinicAudit", args: { clinicId: CLINIC } });
    expect(result).toEqual({ ok: true, data: { status: "too_soon", notBefore: "2026-10-23T10:01:00.000Z" } });
    reply({ data: { status: "busy" } });
    expect(await runClinicAudit(CLINIC)).toEqual({ ok: true, data: { status: "busy" } });
    reply({ data: { status: "closed" } });
    expect(await runClinicAudit(CLINIC)).toEqual({ ok: true, data: { status: "closed" } });
  });

  test("a check result off the list is a malformed answer", async () => {
    reply({
      data: {
        status: "ran",
        result: "warn",
        audits: [{ ...RUN, checks: [{ ...RUN.checks[0], result: "maybe" }] }],
        auditRecorded: true,
      },
    });
    expect(await runClinicAudit(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("fetchClinicAudits", () => {
  test("reads each clinic's packs, overall and last change, and one clinic's history", async () => {
    const summary = {
      clinicId: CLINIC,
      name: "Radiance Med Spa",
      overall: "warn",
      lastChange: { kind: "closures", at: "2026-10-23T09:58:00.000Z" },
      packs: {
        availability: {
          result: "warn",
          at: "2026-10-23T10:00:00.000Z",
          trigger: "change",
          failing: [{ id: "bookings_on_closed_days", hint: "Bookings or requests fall on a day the clinic has closed." }],
        },
      },
    };
    reply({ data: { clinics: [summary], history: [RUN] } });
    const result = await fetchClinicAudits(CLINIC);
    expect(sent).toEqual([{ op: "clinicAudits", args: { clinicId: CLINIC } }]);
    expect(result).toEqual({ ok: true, data: { clinics: [summary], history: [RUN] } });
  });

  test("an overall state off the list is a malformed answer", async () => {
    reply({ data: { clinics: [{ clinicId: CLINIC, name: "x", overall: "great", lastChange: null, packs: {} }], history: null } });
    expect(await fetchClinicAudits()).toMatchObject({ ok: false, code: "malformed" });
    expect(sent[0]).toEqual({ op: "clinicAudits", args: {} });
  });
});

describe("the availability changes", () => {
  const ROW = {
    id: CHANGE,
    clinicId: CLINIC,
    clinicName: "Radiance Med Spa",
    locationId: null,
    kind: "closures",
    source: "portal",
    actorKind: "clinic_device",
    summary: { closuresAdded: ["2026-11-26", "2026-11-27"], closuresRemoved: [], closuresUpcoming: 2, holdsReleased: 0 },
    changedAt: "2026-10-23T09:58:00.000Z",
    alertedAt: "2026-10-23T09:59:00.000Z",
    auditStatus: "passed",
    auditId: AUDIT,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };

  test("listClinicChanges sends the filter and reads every field", async () => {
    reply({ data: { since: "2026-10-01T00:00:00.000Z", changes: [ROW] } });
    const result = await fetchClinicChanges({ clinicId: CLINIC, since: "2026-10-01T00:00:00.000Z" });
    expect(sent).toEqual([
      { op: "listClinicChanges", args: { clinicId: CLINIC, since: "2026-10-01T00:00:00.000Z" } },
    ]);
    expect(result).toEqual({ ok: true, data: { since: "2026-10-01T00:00:00.000Z", changes: [ROW] } });
  });

  test("a device's own label in place of the actor's kind is a malformed answer", async () => {
    reply({ data: { since: "2026-10-01T00:00:00.000Z", changes: [{ ...ROW, actorKind: "Front desk iPad" }] } });
    expect(await fetchClinicChanges()).toMatchObject({ ok: false, code: "malformed" });
  });

  test("a closed day that is not a date is a malformed answer", async () => {
    reply({ data: { since: "2026-10-01T00:00:00.000Z", changes: [{ ...ROW, summary: { closuresAdded: ["Thanksgiving"] } }] } });
    expect(await fetchClinicChanges()).toMatchObject({ ok: false, code: "malformed" });
  });

  test("acknowledgeClinicChange sends the change's id and reads the outcome", async () => {
    reply({ data: { status: "acknowledged", acknowledgedAt: "2026-10-23T10:05:00.000Z", auditRecorded: true } });
    const result = await acknowledgeClinicChange(CHANGE, CLINIC);
    expect(sent).toEqual([{ op: "acknowledgeClinicChange", args: { id: CHANGE, clinicId: CLINIC } }]);
    expect(result).toEqual({
      ok: true,
      data: { status: "acknowledged", acknowledgedAt: "2026-10-23T10:05:00.000Z", auditRecorded: true },
    });
    reply({ data: { status: "not_found" } });
    expect(await acknowledgeClinicChange(CHANGE)).toEqual({ ok: true, data: { status: "not_found" } });
  });
});
