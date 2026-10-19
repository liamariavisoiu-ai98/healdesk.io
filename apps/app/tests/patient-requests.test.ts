import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { TENANT_SCOPED_TABLES } from "@/db/schema";
import { auth } from "@/lib/auth";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  PayloadNotAllowedError,
  subjectProblems,
} from "@/lib/email/lint";
import { NOTICE_KIND_REGISTRY } from "@/lib/email/kinds";
import { clinicReason } from "@/lib/email/templates/context";
import {
  PATIENT_REQUEST_ENTRY,
  renderPatientRequest,
  type PatientRequestPayload,
} from "@/lib/email/templates/patient_request";
import { PENDING_TEMPLATES, templateFor } from "@/lib/email/templates/registry";
import type { TemplateContext } from "@/lib/email/templates/types";
import {
  finishPasskeyAuthentication,
  startPasskeyAuthentication,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";
import {
  destroyDueClinics,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { erasePersonFromShell, recordPatientRequestFromShell } from "@/lib/ops/patient-entry";
import {
  businessDaysAfter,
  patientRequestStep,
  replyByFor,
  sweepPatientRequests,
} from "@/lib/patient-rights/patient-requests";
import { PATIENT_REQUEST_KIND_LABELS } from "@/lib/patient-rights/request-kinds";
import { readHomeFacts, readHomePatientRequests } from "@/lib/portal/home";
import { PATIENT_RECORD_TYPES } from "@/lib/portal/patient-page";
import { purgeClinic } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";

import { PatientRequestsCard } from "@/app/c/[slug]/PatientRequestsCard";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  queuedNotices,
  seedClinic,
  seedContact,
  type SeededClinic,
} from "./setup/factories";
import { attestPlatform, withdrawPlatform } from "./setup/platform";

/**
 * L32, a request from a patient (Annex X5; BAA 1.5.1 clause 14: "healdesk
 * will not act on it. It will pass the request to Practice within five
 * business days"), end to end: the table and its guarantees (FORCE RLS, the
 * BAA gate, the grants, the guard, the contact's own key), the operator's
 * shell entry and its script by ids alone, L32 as a pointer, Home's pointer,
 * the request's patient page and its "Mark as received", the sweep's
 * reminders and ops alerts, and the request's place in erasure, the purge
 * and destruction. Synthetic clinics and people only.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    headers: new Headers(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: mocks.verifyAuthenticationResponse };
});

const { default: PatientRequestPage } = await import("@/app/c/[slug]/patient-requests/[id]/page");
const { markReceived } = await import("@/app/c/[slug]/patient-requests/actions");

const describeDb = hasTestDatabase ? describe : describe.skip;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/cli");
const ORIGIN = "http://localhost:3001";
const SHELL = { label: "ops@healdesk.test" };
const NY = "America/New_York";
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The scripts as a one-off task on the AWS host runs them; the database is never reached. */
const AWS_HOST = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://unused:unused@localhost:1/unused?sslmode=verify-full",
};

function runScript(env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [TSX, "scripts/ops-patient-request.ts", ...args], {
    cwd: APP_DIR,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

/** The text a React element tree carries, without rendering it (the guard renders nothing on a server). */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function ctx(audience: "patients" | "clients" = "patients"): TemplateContext {
  return {
    clinicName: "Radiance Med Spa",
    audience,
    reason: clinicReason("Radiance Med Spa"),
    raisedAt: new Date("2026-10-20T15:00:00Z"),
    timeZone: NY,
  };
}

// -----------------------------------------------------------------------------
// The days, the steps and the email: pure
// -----------------------------------------------------------------------------

describe("the five business days", () => {
  test("the reply-by day is the fifth weekday after the clinic-local day the request reached us", () => {
    // Monday to Monday, Friday to Friday; a Saturday or a Sunday counts from Monday.
    expect(businessDaysAfter("2026-10-19", 5)).toBe("2026-10-26");
    expect(businessDaysAfter("2026-10-23", 5)).toBe("2026-10-30");
    expect(businessDaysAfter("2026-10-24", 5)).toBe("2026-10-30");
    expect(businessDaysAfter("2026-10-25", 5)).toBe("2026-10-30");
    // 00:30 UTC on a Tuesday is Monday evening in New York: counted from Monday.
    expect(replyByFor(new Date("2026-10-20T00:30:00Z"), NY)).toBe("2026-10-26");
    expect(replyByFor(new Date("2026-10-20T00:30:00Z"), "UTC")).toBe("2026-10-27");
  });

  test("an unmarked request is reminded on the second and fourth business days, and ops told on the fourth and after the fifth", () => {
    const received = new Date("2026-10-12T15:00:00Z"); // Monday, 11:00 in New York
    const request = {
      receivedAt: received,
      recordedAt: received,
      replyBy: replyByFor(received, NY),
    };
    expect(request.replyBy).toBe("2026-10-19");
    const at = (iso: string) => patientRequestStep(request, new Date(iso), NY);
    expect(at("2026-10-13T16:00:00Z")).toEqual({ reminder: null, alert: null });
    expect(at("2026-10-14T16:00:00Z")).toEqual({ reminder: 1, alert: null });
    expect(at("2026-10-15T16:00:00Z")).toEqual({ reminder: 1, alert: null });
    expect(at("2026-10-16T16:00:00Z")).toEqual({ reminder: 2, alert: "patient_request_due_soon" });
    // The weekend and the reply-by day itself: still the last reminder, still due.
    expect(at("2026-10-18T16:00:00Z")).toEqual({ reminder: 2, alert: "patient_request_due_soon" });
    expect(at("2026-10-19T23:00:00Z")).toEqual({ reminder: 2, alert: "patient_request_due_soon" });
    // The day after (still the 19th in New York until 04:00 UTC).
    expect(at("2026-10-20T03:30:00Z")).toEqual({ reminder: 2, alert: "patient_request_due_soon" });
    expect(at("2026-10-20T05:00:00Z")).toEqual({
      reminder: null,
      alert: "patient_request_past_due",
    });
  });

  test("a request recorded late gets no reminder for days already gone, and ops hears the clock is short", () => {
    const received = new Date("2026-10-12T15:00:00Z");
    const recorded = new Date("2026-10-16T14:00:00Z"); // the fourth business day
    const request = { receivedAt: received, recordedAt: recorded, replyBy: "2026-10-19" };
    expect(patientRequestStep(request, recorded, NY)).toEqual({
      reminder: null,
      alert: "patient_request_due_soon",
    });
    const second = {
      receivedAt: received,
      recordedAt: new Date("2026-10-14T14:00:00Z"),
      replyBy: "2026-10-19",
    };
    expect(patientRequestStep(second, new Date("2026-10-14T20:00:00Z"), NY).reminder).toBeNull();
    expect(patientRequestStep(second, new Date("2026-10-16T13:00:00Z"), NY).reminder).toBe(2);
  });
});

describe("L32, the email: a pointer", () => {
  test("it has a template, is no longer owed by any package, and waits for daytime", () => {
    expect(templateFor("patient_request")).toBe(PATIENT_REQUEST_ENTRY);
    expect(Object.keys(PENDING_TEMPLATES)).not.toContain("patient_request");
    expect(NOTICE_KIND_REGISTRY.patient_request).toMatchObject({
      annex: "L32",
      class: "transactional",
      quietHours: "daytime",
    });
  });

  test("it names the clinic, what was asked and the day to mark it received by, and links to the request's page", () => {
    const payload = PATIENT_REQUEST_ENTRY.fixture;
    assertPayloadAllowed(payload, "patient_request");
    const email = renderPatientRequest(payload, ctx());
    expect(email.subject).toBe("A request from a patient for your team");
    expect(subjectProblems(email.subject)).toEqual([]);
    expect(email.text).toContain(
      "A patient asked healdesk to see or get a copy of their information at Radiance Med Spa.",
    );
    expect(email.text).toContain("Tuesday 27 October");
    expect(email.text).toContain(payload.portalUrl!);
    expect(payload.portalUrl).toMatch(/\/c\/radiance-med-spa\/patient-requests\/[0-9a-f-]{36}$/);
    expect(copyProblems([email.subject, email.preheader, email.text].join("\n"))).toEqual([]);
    expect(linkProblems(email, "patient_request")).toEqual([]);
    expect(email.text).toContain("carries no patient details on purpose");
  });

  test("the reminder says it is still waiting; a clinic for animals reads 'client'; no link says where to look", () => {
    const reminder = renderPatientRequest(
      { ...PATIENT_REQUEST_ENTRY.fixture, isReminder: true, kind: "deletion" },
      ctx("clients"),
    );
    expect(reminder.subject).toBe("Reminder: a request from a client is waiting");
    expect(reminder.text).toContain("is still waiting for your team to mark it received");
    expect(reminder.text).toContain("To delete their information");
    // The body, less its link's path; the footer's "Please leave out patient
    // details" is every email's.
    expect(reminder.text.split("\n—\n")[0]).not.toMatch(/\bpatient\b(?!-requests)/);
    expect(copyProblems([reminder.subject, reminder.preheader, reminder.text].join("\n"))).toEqual(
      [],
    );
    const unlinked = renderPatientRequest(
      { ...PATIENT_REQUEST_ENTRY.fixture, portalUrl: null },
      ctx(),
    );
    expect(unlinked.text).toContain("Sign in to healdesk: Home links to it.");
  });

  test("the payload has no field for who asked, and a kind outside the closed set is refused", () => {
    for (const extra of [
      { fullName: "Dana" },
      { phone: "+15550138501" },
      { note: "her records" },
    ]) {
      expect(() =>
        assertPayloadAllowed({ ...PATIENT_REQUEST_ENTRY.fixture, ...extra }, "patient_request"),
      ).toThrow(PayloadNotAllowedError);
    }
    expect(() =>
      renderPatientRequest(
        { ...PATIENT_REQUEST_ENTRY.fixture, kind: "her chart" as PatientRequestPayload["kind"] },
        ctx(),
      ),
    ).toThrow(/not a kind of patient request/);
  });
});

describe("Home's pointer", () => {
  test("one line per unmarked request, its day and its page, and nothing of what was asked", () => {
    const id = "8a3f4d5e-6f70-4182-9d9e-0f1a2b3c4d5e";
    const html = renderToStaticMarkup(
      PatientRequestsCard({
        slug: "glow",
        requests: [{ id, replyBy: "2026-10-26" }],
        audience: "patients",
        timeZone: NY,
        now: new Date("2026-10-20T15:00:00Z"),
      })!,
    );
    expect(html).toContain("A request from a patient");
    expect(html).toContain("Please mark it received by Monday 26 October.");
    expect(html).toContain(`href="/c/glow/patient-requests/${id}"`);
    for (const label of Object.values(PATIENT_REQUEST_KIND_LABELS))
      expect(html).not.toContain(label);
    expect(
      PatientRequestsCard({
        slug: "glow",
        requests: [],
        audience: "patients",
        timeZone: NY,
        now: new Date(),
      }),
    ).toBeNull();
    expect(PATIENT_RECORD_TYPES).toContain("patient_request");
  });
});

describe("ops:patient-request takes ids only", () => {
  test("a number or an address in its environment or on its command line is refused before anything is read", () => {
    const base = {
      ...AWS_HOST,
      HEALDESK_PATIENT_REQUEST_CLINIC_ID: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      HEALDESK_PATIENT_REQUEST_KIND: "access",
      HEALDESK_OPS_OPERATOR: "ops@healdesk.test",
    };
    for (const env of [
      { ...base, HEALDESK_PATIENT_REQUEST_CONTACT_ID: "+15550138501" },
      { ...base, HEALDESK_PATIENT_REQUEST_KIND: "dana@example-patient.test" },
    ]) {
      const run = runScript(env);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/command line/);
      expect(run.stderr).not.toMatch(/0138501|dana@/);
    }
    const argv = runScript(base, ["--note", "call 555 013 8501"]);
    expect(argv.status).toBe(1);
    expect(argv.stderr).toMatch(/command line/);
    const noOperator = runScript({ ...base, HEALDESK_OPS_OPERATOR: "" });
    expect(noOperator.status).toBe(1);
    expect(noOperator.stderr).toMatch(/--operator/);
  }, 120_000);
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** As the runtime role, in the clinic's tenant (or none), rolled back. */
async function asApp<T>(clinicId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

type RequestRow = {
  id: string;
  kind: string;
  contact_id: string | null;
  contact_named: boolean;
  received_at: Date;
  recorded_at: Date;
  reply_by: string;
  recorded_by: string;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
};

async function requestsOf(clinicId: string): Promise<RequestRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<RequestRow>(
      `select id, kind, contact_id, contact_named, received_at, recorded_at, reply_by::text as reply_by,
              recorded_by, acknowledged_at, acknowledged_by
         from patient_requests order by recorded_at, id`,
    );
    return rows;
  });
}

async function record(
  clinicId: string,
  input: { kind?: string; contactId?: string; receivedAt?: string } = {},
): Promise<string> {
  const outcome = await recordPatientRequestFromShell({
    clinicId,
    kind: input.kind ?? "access",
    contactId: input.contactId,
    receivedAt: input.receivedAt,
    operator: SHELL,
  });
  if (outcome.status !== "recorded") throw new Error(outcome.message);
  return outcome.requestId;
}

/**
 * Time passing for one request: when it reached us and was recorded, and its
 * reply-by day, as the migrator with the row's triggers off for the one
 * statement (the guard keeps recorded_at the database's clock).
 */
async function backdate(clinicId: string, id: string, at: Date): Promise<void> {
  await inTenant(clinicId, async (client) => {
    await client.query(`alter table patient_requests disable trigger user`);
    await client.query(
      `update patient_requests set received_at = $2, recorded_at = $2, reply_by = $3::date where id = $1`,
      [id, at, replyByFor(at, NY)],
    );
    await client.query(`alter table patient_requests enable trigger user`);
  });
}

async function alertsFor(requestId: string): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ event: string }>(
    `select event from ops_alerts where fields->>'requestId' = $1 order by raised_at, event`,
    [requestId],
  );
  return rows.map((r) => r.event);
}

async function production(c: SeededClinic, agreement = true): Promise<void> {
  if (agreement) await bindAgreementInEffect(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`,
    [c.clinicId],
  );
}

describeDb("patient_requests, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    // The vendors' agreements in force, as a launched platform holds them.
    await attestPlatform(COVERAGE_VENDORS);
  });

  afterAll(async () => {
    await closePools();
  });

  test("tenant-scoped and forced, with its policy, and the runtime role keeps only the verbs it needs", async () => {
    expect(TENANT_SCOPED_TABLES).toContain("patient_requests");
    const pool = getMigratorPool();
    const { rows: rls } = await pool.query<{ on: boolean; forced: boolean }>(
      `select relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = 'patient_requests'`,
    );
    expect(rls).toEqual([{ on: true, forced: true }]);
    const { rows: policies } = await pool.query<{ policyname: string }>(
      `select policyname from pg_policies where tablename = 'patient_requests'`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["patient_requests_tenant_isolation"]);
    const { rows: grants } = await pool.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'healdesk_app' and table_name = 'patient_requests' order by privilege_type`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT"]);
    const { rows: columns } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'healdesk_app' and table_name = 'patient_requests' and privilege_type = 'UPDATE'
        order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(["acknowledged_at", "acknowledged_by"]);

    // With no tenant the runtime role sees nothing, another clinic's least of all.
    const c = await seedClinic("pr-rls");
    await record(c.clinicId);
    expect((await asApp(null, (q) => q.query(`select id from patient_requests`))).rows).toEqual([]);
    const other = await seedClinic("pr-rls-other");
    expect(
      (await asApp(other.clinicId, (q) => q.query(`select id from patient_requests`))).rows,
    ).toEqual([]);
  });

  test("recording one keeps ids and closed words, queues L32 once in the same transaction, and audits it", async () => {
    const c = await seedClinic("pr-record");
    const contactId = await seedContact(c.clinicId, "+15550139101");
    const id = await record(c.clinicId, { kind: "amendment", contactId });
    const [row] = await requestsOf(c.clinicId);
    expect(row).toMatchObject({
      id,
      kind: "amendment",
      contact_id: contactId,
      contact_named: true,
      recorded_by: "ops@healdesk.test",
      acknowledged_at: null,
      acknowledged_by: null,
    });
    expect(row!.reply_by).toBe(replyByFor(row!.received_at, NY));
    expect(Math.abs(row!.recorded_at.getTime() - Date.now())).toBeLessThan(60_000);

    const notices = await queuedNotices(c.clinicId, ["patient_request"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.dedupe_key).toBe(`patient_request:${id}`);
    expect(notices[0]!.payload).toEqual({
      requestId: id,
      kind: "amendment",
      replyByOn: row!.reply_by,
      isReminder: false,
      portalUrl: `${ORIGIN}/c/${c.slug}/patient-requests/${id}`,
    });
    assertPayloadAllowed(notices[0]!.payload, "patient_request");

    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{
        action: string;
        resource_type: string;
        resource_id: string;
        metadata: unknown;
      }>(
        `select action, resource_type, resource_id, metadata from audit_log where resource_type = 'patient_request'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        action: "create",
        resource_type: "patient_request",
        resource_id: id,
        metadata: { kind: "amendment", contactNamed: true },
      },
    ]);
    const events = await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = 'patient_request_recorded' and metadata->>'requestId' = $1`,
      [id],
    );
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows)).not.toMatch(/0139101|Synthetic Patient/);

    // A received time in the past is kept; one in the future is the database's now.
    const earlier = await record(c.clinicId, { receivedAt: "2026-10-01T09:00:00Z" });
    const kept = (await requestsOf(c.clinicId)).find((r) => r.id === earlier)!;
    expect(kept.received_at.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(kept.reply_by).toBe("2026-10-08");
    expect(kept.contact_named).toBe(false);
  });

  test("the shell refuses what it cannot record, and says how to pass the request on instead", async () => {
    const c = await seedClinic("pr-refuse");
    const other = await seedClinic("pr-refuse-other");
    const theirs = await seedContact(other.clinicId, "+15550139201");
    const call = (input: Partial<Parameters<typeof recordPatientRequestFromShell>[0]>) =>
      recordPatientRequestFromShell({
        clinicId: c.clinicId,
        kind: "access",
        operator: SHELL,
        ...input,
      });

    expect(await call({ kind: "her chart" })).toMatchObject({
      status: "error",
      message: expect.stringMatching(/access \(To see or get a copy of their information\).*other/),
    });
    expect(await call({ contactId: "not-a-uuid" })).toEqual({
      status: "error",
      message: "A contact's id is a uuid.",
    });
    expect(await call({ contactId: theirs })).toEqual({
      status: "error",
      message: "No such contact at this clinic.",
    });
    expect(await call({ receivedAt: "2099-01-01" })).toMatchObject({ status: "error" });
    expect(await call({ clinicId: randomUUID() })).toEqual({
      status: "error",
      message: "No such clinic.",
    });

    // A production clinic with no agreement in effect: the BAA gate.
    const bare = await seedClinic("pr-no-agreement");
    await production(bare, false);
    expect(
      await recordPatientRequestFromShell({
        clinicId: bare.clinicId,
        kind: "access",
        operator: SHELL,
      }),
    ).toEqual({
      status: "error",
      message: expect.stringMatching(/takes no new patient data.*by telephone/),
    });
    expect(await requestsOf(bare.clinicId)).toEqual([]);
    expect(await requestsOf(c.clinicId)).toEqual([]);
  });

  test("while the host's own agreement has lapsed nothing is recorded, cleanly, and the request goes by telephone", async () => {
    const c = await seedClinic("pr-host-lapse");
    await production(c);
    await withdrawPlatform(["database_host"]);
    const refused = await recordPatientRequestFromShell({
      clinicId: c.clinicId,
      kind: "deletion",
      operator: SHELL,
    });
    expect(refused).toEqual({
      status: "error",
      message: expect.stringMatching(
        /database host's business associate agreement is not in force.*by telephone/,
      ),
    });
    expect(await requestsOf(c.clinicId)).toEqual([]);
    expect(await queuedNotices(c.clinicId, ["patient_request"])).toEqual([]);
    // The model provider's lapse alone keeps nothing back: no model is in this.
    await attestPlatform(["database_host"]);
    await withdrawPlatform(["anthropic"]);
    expect(
      (
        await recordPatientRequestFromShell({
          clinicId: c.clinicId,
          kind: "deletion",
          operator: SHELL,
        })
      ).status,
    ).toBe("recorded");
    // A synthetic clinic is never held back by the platform's agreements.
    await withdrawPlatform(["aws"]);
    const synthetic = await seedClinic("pr-host-synthetic");
    expect(
      (
        await recordPatientRequestFromShell({
          clinicId: synthetic.clinicId,
          kind: "other",
          operator: SHELL,
        })
      ).status,
    ).toBe("recorded");
  });

  test("the guard: the database's clocks, nothing rewritten, the mark once, and only a contact of the clinic's own", async () => {
    const c = await seedClinic("pr-guard");
    const other = await seedClinic("pr-guard-other");
    const contactId = await seedContact(c.clinicId, "+15550139301");
    const theirs = await seedContact(other.clinicId, "+15550139302");
    const id = await record(c.clinicId, { contactId });
    const update = (set: string, values: unknown[] = []) =>
      asApp(c.clinicId, (q) =>
        q.query(`update patient_requests set ${set} where id = $1`, [id, ...values]),
      );

    for (const set of [
      "kind = 'other'",
      "recorded_at = now() - interval '1 day'",
      "reply_by = reply_by + 1",
      "contact_id = null",
    ]) {
      await expect(update(set), set).rejects.toMatchObject({ code: "42501" });
    }
    // Not a grant only: the guard holds the owner to it too.
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update patient_requests set kind = 'other' where id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/never rewritten/) });
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update patient_requests set contact_id = $2 where id = $1`, [id, contactId]),
      ),
    ).resolves.toBeDefined();
    // The mark needs the device; its time is the database's, whatever is sent.
    await expect(update("acknowledged_at = now()")).rejects.toMatchObject({ code: "42501" });
    const marked = await asApp(c.clinicId, async (q) => {
      await q.query(
        `update patient_requests set acknowledged_by = 'Front desk Mac', acknowledged_at = '2020-01-01' where id = $1`,
        [id],
      );
      const { rows } = await q.query<{ at: Date }>(
        `select acknowledged_at as at from patient_requests where id = $1`,
        [id],
      );
      // Once marked, never again.
      await expect(
        q.query(`update patient_requests set acknowledged_by = 'Another device' where id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      return rows[0]!.at;
    });
    expect(Math.abs(marked.getTime() - Date.now())).toBeLessThan(60_000);

    const insert = (values: string, params: unknown[]) =>
      asApp(c.clinicId, (q) =>
        q.query(
          `insert into patient_requests (clinic_id, kind, contact_id, received_at, reply_by, recorded_by, acknowledged_by)
           values ($1, ${values})`,
          [c.clinicId, ...params],
        ),
      );
    const today = new Date().toISOString().slice(0, 10);
    const replyBy = replyByFor(new Date(), NY);
    // Recorded marked: refused. Another clinic's contact: no such key. A
    // reply-by day nowhere near five business days: refused.
    await expect(
      insert(`'access', null, now(), $2::date, 'ops@healdesk.test', 'Front desk Mac'`, [replyBy]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      insert(`'access', $2, now(), $3::date, 'ops@healdesk.test', null`, [theirs, replyBy]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(`'access', null, now(), $2::date, 'ops@healdesk.test', null`, [today]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(`'chart', null, now(), $2::date, 'ops@healdesk.test', null`, [replyBy]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("a data-only restore of a marked request loads once patient_requests_guard is off, as docs/handover.md says, and keeps its times", async () => {
    const handover = readFileSync(join(APP_DIR, "..", "..", "docs", "handover.md"), "utf8");
    expect(handover).toContain(
      "ALTER TABLE patient_requests DISABLE TRIGGER patient_requests_guard;",
    );
    expect(handover).toContain(
      "ALTER TABLE patient_requests ENABLE TRIGGER patient_requests_guard;",
    );
    const c = await seedClinic("pr-restore");
    const id = await record(c.clinicId);
    await inTenant(c.clinicId, (client) =>
      client.query(`update patient_requests set acknowledged_by = 'Front desk Mac' where id = $1`, [
        id,
      ]),
    );
    const client = await getMigratorPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      const read = async () =>
        (
          await client.query<{ row: Record<string, unknown> }>(
            `select to_jsonb(r) as row from patient_requests r where id = $1`,
            [id],
          )
        ).rows[0]?.row;
      const dump = await read();
      expect(dump?.acknowledged_by).toBe("Front desk Mac");
      await client.query(`delete from patient_requests where id = $1`, [id]);
      const load = () =>
        client.query(
          `insert into patient_requests select * from jsonb_populate_record(null::patient_requests, $1)`,
          [dump],
        );
      await client.query("savepoint plain");
      await expect(load()).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint plain");
      await client.query(`alter table patient_requests disable trigger patient_requests_guard`);
      await load();
      await client.query(`alter table patient_requests enable trigger patient_requests_guard`);
      expect(await read()).toEqual(dump);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  test("a contact's deletion takes the person and leaves the request, which still knows one was named", async () => {
    const c = await seedClinic("pr-erase");
    const contactId = await seedContact(c.clinicId, "+15550139401");
    const id = await record(c.clinicId, { kind: "deletion", contactId });
    const erased = await erasePersonFromShell({
      clinicId: c.clinicId,
      contactId,
      requestedBy: "person_via_practice",
      operator: SHELL,
    });
    expect(erased.status).toBe("erased");
    expect(await requestsOf(c.clinicId)).toEqual([
      expect.objectContaining({ id, contact_id: null, contact_named: true, kind: "deletion" }),
    ]);
  });

  test("the sweep reminds on the second and fourth business days, once each, tells ops on the fourth and after the fifth, and stops at the mark", async () => {
    const c = await seedClinic("pr-sweep");
    const id = await record(c.clinicId);
    const marked = await record(c.clinicId, { kind: "other" });
    const monday = new Date("2026-10-12T15:00:00Z");
    await backdate(c.clinicId, id, monday);
    await backdate(c.clinicId, marked, monday);
    await inTenant(c.clinicId, (client) =>
      client.query(`update patient_requests set acknowledged_by = 'Front desk Mac' where id = $1`, [
        marked,
      ]),
    );
    const open = await getMigratorPool().query<{ id: string }>(
      `select id from app_open_patient_requests()`,
    );
    expect(open.rows.map((r) => r.id)).toEqual([id]);

    const keys = async () =>
      (await queuedNotices(c.clinicId, ["patient_request"])).map((n) => n.dedupe_key).sort();

    expect(await sweepPatientRequests(new Date("2026-10-13T16:00:00Z"))).toMatchObject({
      open: 1,
      reminded: 0,
    });
    expect(await keys()).toEqual([`patient_request:${id}`, `patient_request:${marked}`].sort());

    for (const at of ["2026-10-14T16:00:00Z", "2026-10-14T17:00:00Z"]) {
      await sweepPatientRequests(new Date(at));
    }
    expect(await keys()).toContain(`patient_request:${id}:reminder:1`);
    expect(await alertsFor(id)).toEqual([]);

    const fourth = await sweepPatientRequests(new Date("2026-10-16T16:00:00Z"));
    expect(fourth).toMatchObject({ open: 1, reminded: 1, dueSoon: 1, pastDue: 0, failures: 0 });
    await sweepPatientRequests(new Date("2026-10-16T17:00:00Z"));
    expect(await alertsFor(id)).toEqual(["patient_request_due_soon"]);

    const late = await sweepPatientRequests(new Date("2026-10-20T16:00:00Z"));
    expect(late).toMatchObject({ reminded: 0, pastDue: 1 });
    expect((await alertsFor(id)).sort()).toEqual([
      "patient_request_due_soon",
      "patient_request_past_due",
    ]);

    const notices = await queuedNotices(c.clinicId, ["patient_request"]);
    expect(notices.map((n) => n.dedupe_key).sort()).toEqual(
      [
        `patient_request:${id}`,
        `patient_request:${id}:reminder:1`,
        `patient_request:${id}:reminder:2`,
        `patient_request:${marked}`,
      ].sort(),
    );
    for (const n of notices.filter((n) => n.dedupe_key.includes("reminder"))) {
      expect(n.payload).toMatchObject({ requestId: id, isReminder: true, replyByOn: "2026-10-19" });
      assertPayloadAllowed(n.payload, "patient_request");
    }
    // The marked one was never reminded nor raised.
    expect(await alertsFor(marked)).toEqual([]);
  });

  test("Home lists the unmarked requests by id and day only", async () => {
    const c = await seedClinic("pr-home");
    const contactId = await seedContact(c.clinicId, "+15550139501");
    const open = await record(c.clinicId, { contactId });
    const done = await record(c.clinicId, { kind: "other" });
    await inTenant(c.clinicId, (client) =>
      client.query(`update patient_requests set acknowledged_by = 'Front desk Mac' where id = $1`, [
        done,
      ]),
    );
    const facts = await readHomeFacts({
      clinicId: c.clinicId,
      address: null,
      actor: { type: "service", serviceName: "patient-requests-test" },
    });
    expect(facts.patientRequests).toEqual([
      { id: open, replyBy: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    ]);
    // A closed account's Home reads the same pointer, and nothing else.
    expect(
      await readHomePatientRequests({
        clinicId: c.clinicId,
        actor: { type: "service", serviceName: "patient-requests-test" },
      }),
    ).toEqual(facts.patientRequests);
  });

  test("the purge takes a request at the record clock, and destruction takes every one before the stamp", async () => {
    const c = await seedClinic("pr-purge");
    const old = await record(c.clinicId);
    const fresh = await record(c.clinicId);
    await backdate(c.clinicId, old, new Date(Date.now() - 100 * 86_400_000));
    const actor = { type: "service", serviceName: "patient-requests-test" } as const;
    const purged = await withTenant({ clinicId: c.clinicId, actor }, (tx) => purgeClinic(tx));
    expect(purged.patientRequestsDeleted).toBe(1);
    expect((await requestsOf(c.clinicId)).map((r) => r.id)).toEqual([fresh]);

    // Destruction: while a request stands the stamp refuses; destroyClinicData deletes it first.
    await withTenant({ clinicId: c.clinicId, actor }, (tx) => startOffboarding(tx, "operator"));
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = offboarding_started_at - interval '31 days',
              destroy_after = destroy_after - interval '31 days'
        where id = $1`,
      [c.clinicId],
    );
    await withTenant({ clinicId: c.clinicId, actor }, (tx) =>
      markExportDelivered(tx, "bundle handed to the practice manager"),
    );
    await expect(
      asApp(c.clinicId, (q) => q.query(`select app_mark_clinic_destroyed($1::uuid)`, [c.clinicId])),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });
    const results = (await destroyDueClinics()).filter((r) => r.clinicId === c.clinicId);
    expect(results).toHaveLength(1);
    expect(results[0]!.deleted.patient_requests).toBe(1);
    expect(await requestsOf(c.clinicId)).toEqual([]);
  });

  test("ops:patient-request runs from a one-off task's environment alone, with or without a contact, and prints ids and days only", async () => {
    const c = await seedClinic("pr-script");
    const contactId = await seedContact(c.clinicId, "+15550139601");
    const env = {
      HEALDESK_PATIENT_REQUEST_CLINIC_ID: c.clinicId,
      HEALDESK_PATIENT_REQUEST_KIND: "accounting",
      HEALDESK_OPS_OPERATOR: "Ops@Healdesk.test",
    };
    const bare = runScript(env);
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout).toMatch(
      /recorded: patient request [0-9a-f-]{36}, to be marked received by \w+day \d{1,2} \w+/,
    );
    expect(bare.stdout).toMatch(/names no contact: telephone the practice/);
    const named = runScript({ ...env, HEALDESK_PATIENT_REQUEST_CONTACT_ID: contactId });
    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout).toMatch(/It names the contact/);
    expect(`${bare.stdout}${named.stdout}${named.stderr}`).not.toMatch(/0139601|Synthetic Patient/);
    const rows = await requestsOf(c.clinicId);
    expect(rows.map((r) => [r.kind, r.contact_id, r.recorded_by])).toEqual([
      ["accounting", null, "ops@healdesk.test"],
      ["accounting", contactId, "ops@healdesk.test"],
    ]);
    expect(await queuedNotices(c.clinicId, ["patient_request"])).toHaveLength(2);

    const unknown = runScript({ ...env, HEALDESK_PATIENT_REQUEST_KIND: "records" });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(
      /patient-request failed: .*What did they ask for\? One of: access/,
    );
  }, 180_000);
});

// -----------------------------------------------------------------------------
// The request's page and its mark, behind the passkey step-up
// -----------------------------------------------------------------------------

type Signed = { cookie: string; binding: SessionBinding };

async function signIn(userId: string): Promise<Signed> {
  const started = await auth.api.startLinkSession({
    body: { userId },
    headers: new Headers(),
    asResponse: true,
  });
  const cookie = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("hd.session_token="))!
    .split(";")[0]!;
  const token = decodeURIComponent(cookie.slice("hd.session_token=".length)).split(".")[0]!;
  return { cookie, binding: { userId, sessionTokenHash: hashSessionToken(token) } };
}

function browse(who: Signed | null, path: string): void {
  mocks.headers = new Headers({
    ...(who ? { cookie: who.cookie } : {}),
    "x-healdesk-path": path,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "x-forwarded-for": "203.0.113.7",
  });
}

async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; redirect: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false, redirect: error.url };
    throw error;
  }
}

async function addPasskey(userId: string, label: string) {
  const credentialId = b64(randomBytes(16));
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, label, credentialId],
  );
  return { factorId: rows[0]!.id, credentialId };
}

async function stepUp(session: SessionBinding, credentialId: string) {
  const started = await startPasskeyAuthentication({ session });
  if (!started.ok) throw new Error(started.reason);
  mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter: 0,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  });
  const finished = await finishPasskeyAuthentication({
    session,
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64(
          JSON.stringify({
            type: "webauthn.get",
            challenge: started.options.challenge,
            origin: ORIGIN,
          }),
        ),
        authenticatorData: b64(randomBytes(37)),
        signature: b64(randomBytes(64)),
      },
      clientExtensionResults: {},
    },
  });
  if (!finished.ok) throw new Error(finished.reason);
  return finished.stepUp;
}

type AuditRow = {
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
};

async function requestAudit(clinicId: string): Promise<AuditRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<AuditRow>(
      `select actor_label, action, resource_type, resource_id, metadata
         from audit_log where clinic_id = $1 and resource_type = 'patient_request' and action <> 'create'
        order by occurred_at, id`,
      [clinicId],
    );
    return rows;
  });
}

describeDb("the request's page", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
  });

  afterAll(async () => {
    await closePools();
  });

  test("it opens only behind the passkey step-up, logs every open, shows the request, and is marked received once", async () => {
    const clinic = await seedClinic("pr-page");
    const contactId = await seedContact(clinic.clinicId, "+15550139701");
    const id = await record(clinic.clinicId, { kind: "access", contactId });
    const path = `/c/${clinic.slug}/patient-requests/${id}`;
    const link = await signIn(clinic.staffUserId);
    const { factorId, credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");

    // Signed in, no step-up: to the step-up page and back here; nothing logged.
    browse(link, path);
    const toStepUp = `/c/${clinic.slug}/step-up?next=${encodeURIComponent(path)}`;
    expect(
      await outcome(() =>
        PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id }) }),
      ),
    ).toEqual({ ok: false, redirect: toStepUp });
    expect(await outcome(() => markReceived(clinic.slug, id))).toEqual({
      ok: false,
      redirect: toStepUp,
    });
    expect(await requestAudit(clinic.clinicId)).toEqual([]);

    const granted = await stepUp(link.binding, credentialId);
    browse(link, path);
    const element = await PatientRequestPage({
      params: Promise.resolve({ slug: clinic.slug, id }),
    });
    const text = textOf(element);
    expect(text).toContain("A request from a patient");
    expect(text).toContain(PATIENT_REQUEST_KIND_LABELS.access);
    expect(text).toContain("Synthetic Patient · (555) 013-9701");
    expect(text).toContain("Mark as received");
    const opened = await requestAudit(clinic.clinicId);
    expect(opened).toEqual([
      {
        actor_label: "Front desk Mac",
        action: "read",
        resource_type: "patient_request",
        resource_id: id,
        metadata: { passkeyId: factorId, stepUpId: granted.id },
      },
    ]);

    // Not this clinic's, or not an id: not found, the attempt logged by the id asked for.
    const nobody = randomUUID();
    await expect(
      PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id: nobody }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id: "not-a-uuid" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(
      (await requestAudit(clinic.clinicId)).filter((r) => r.resource_id === nobody),
    ).toHaveLength(1);
    await expect(markReceived(clinic.slug, nobody)).rejects.toThrow("NEXT_NOT_FOUND");

    // Marked received: back to the page, stamped from this device, audited with the passkey.
    expect(await outcome(() => markReceived(clinic.slug, id))).toEqual({
      ok: false,
      redirect: path,
    });
    const [row] = await requestsOf(clinic.clinicId);
    expect(row!.acknowledged_by).toBe("Front desk Mac");
    expect(row!.acknowledged_at).toBeInstanceOf(Date);
    const updates = (await requestAudit(clinic.clinicId)).filter((r) => r.action === "update");
    expect(updates).toEqual([
      {
        actor_label: "Front desk Mac",
        action: "update",
        resource_type: "patient_request",
        resource_id: id,
        metadata: { outcome: "acknowledged", passkeyId: factorId, stepUpId: granted.id },
      },
    ]);
    // A second mark changes nothing.
    expect(await outcome(() => markReceived(clinic.slug, id))).toEqual({
      ok: false,
      redirect: path,
    });
    expect((await requestAudit(clinic.clinicId)).filter((r) => r.action === "update")).toHaveLength(
      1,
    );
    const after = textOf(
      await PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id }) }),
    );
    expect(after).toContain("Marked received");
    expect(after).toContain("from Front desk Mac");
    expect(after).not.toContain("Mark as received");

    // Marked: the sweep owes it nothing, and Home no longer points at it.
    expect(
      (await getMigratorPool().query(`select id from app_open_patient_requests()`)).rows,
    ).toEqual([]);
  });

  test("with no contact named it says healdesk telephones; with the contact since deleted, that they are gone", async () => {
    const clinic = await seedClinic("pr-page-who");
    const link = await signIn(clinic.staffUserId);
    const { credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    await stepUp(link.binding, credentialId);
    const none = await record(clinic.clinicId, { kind: "other" });
    const contactId = await seedContact(clinic.clinicId, "+15550139801");
    const gone = await record(clinic.clinicId, { kind: "deletion", contactId });
    await erasePersonFromShell({
      clinicId: clinic.clinicId,
      contactId,
      requestedBy: "practice",
      operator: SHELL,
    });

    browse(link, `/c/${clinic.slug}/patient-requests/${none}`);
    const unnamed = textOf(
      await PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id: none }) }),
    );
    expect(unnamed).toMatch(/healdesk holds no record of them\. We.ll telephone you by \w+day/);
    browse(link, `/c/${clinic.slug}/patient-requests/${gone}`);
    const erased = textOf(
      await PatientRequestPage({ params: Promise.resolve({ slug: clinic.slug, id: gone }) }),
    );
    expect(erased).toContain("Their details have since been deleted from healdesk.");
    expect(erased).not.toMatch(/0139801|Synthetic Patient/);
  });

  test("another clinic's sign-in gets not found, and nothing of the request is read", async () => {
    const mine = await seedClinic("pr-page-mine");
    const theirs = await seedClinic("pr-page-theirs");
    const id = await record(theirs.clinicId);
    const link = await signIn(mine.staffUserId);
    const { credentialId } = await addPasskey(mine.staffUserId, "Front desk Mac");
    await stepUp(link.binding, credentialId);
    browse(link, `/c/${mine.slug}/patient-requests/${id}`);
    await expect(
      PatientRequestPage({ params: Promise.resolve({ slug: mine.slug, id }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(markReceived(mine.slug, id)).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await requestsOf(theirs.clinicId))[0]!.acknowledged_at).toBeNull();
    // Their own slug from this sign-in: not found before anything is read.
    browse(link, `/c/${theirs.slug}/patient-requests/${id}`);
    await expect(
      PatientRequestPage({ params: Promise.resolve({ slug: theirs.slug, id }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await requestAudit(theirs.clinicId)).toEqual([]);
  });
});
