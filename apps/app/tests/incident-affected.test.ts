import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import {
  finishPasskeyAuthentication,
  startPasskeyAuthentication,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";

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
  seedClinic,
  seedContact,
  type SeededClinic,
} from "./setup/factories";

/**
 * Who an incident affected (wave 2, R11; plan Annex X5, L29: "The list of
 * individuals is never emailed. It sits on a page behind step-up."). The
 * operator records the list from the app's own shell by contact id; the
 * practice reads it on the incident's page behind its passkey step-up, once a
 * report has gone, each person by the contact's id and the contact fields
 * healdesk holds, with an access row naming every one shown; a breach's
 * report points there and never names anyone. The table is the tenant's,
 * forced, behind the BAA gate, and goes with the contacts it names.
 *
 * Driven through the real Better Auth and passkey ceremony, as
 * tests/conversations-screen.test.ts is; only the WebAuthn library's verdict
 * is stubbed. Synthetic clinics and people only.
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
    emails: [] as { kind: string; text: string }[],
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
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: mocks.verifyAuthenticationResponse };
});

const { openIncident } = await import("@/lib/incidents/incidents");
const { recordAffectedFromShell } = await import("@/lib/incidents/affected-entry");
const { refusePatientDataInArgs, optionsFrom } = await import("@/lib/ops/patient-entry");
const { runOperation } = await import("@/lib/ops/api");
const { readAffectedList } = await import("@/lib/portal/incidents");
const { requirePatientPage } = await import("@/lib/portal/patient-page");
const { erasePersonFromShell } = await import("@/lib/ops/patient-entry");
const { withTenant } = await import("@/lib/tenant");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";
const ACTOR = { type: "service", serviceName: "incident-affected-test" } as const;
const OPERATOR = { label: "ops@healdesk.test" };
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

describe("the shell's arguments", () => {
  test("a list of contact ids passes the patient-data check; a number does not", () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].join(",");
    const args = optionsFrom(
      [],
      {
        HEALDESK_INCIDENT_CLINIC_ID: randomUUID(),
        HEALDESK_INCIDENT_ID: randomUUID(),
        HEALDESK_INCIDENT_CONTACT_IDS: ids,
        HEALDESK_OPS_OPERATOR: "ops@healdesk.test",
      },
      {
        clinic: "HEALDESK_INCIDENT_CLINIC_ID",
        incident: "HEALDESK_INCIDENT_ID",
        contacts: "HEALDESK_INCIDENT_CONTACT_IDS",
        operator: "HEALDESK_OPS_OPERATOR",
      },
    );
    expect(args.get("contacts")).toBe(ids);
    expect(() => refusePatientDataInArgs(args)).not.toThrow();
    args.set("contacts", "+1 415 555 0123");
    expect(() => refusePatientDataInArgs(args)).toThrow(/telephone number or an email address/);
  });

  test("anything but ids is refused before the database is asked", async () => {
    const clinicId = randomUUID();
    const incidentId = randomUUID();
    expect(
      await recordAffectedFromShell({
        clinicId,
        incidentId,
        contactIds: "jane@example.test",
        operator: OPERATOR,
      }),
    ).toMatchObject({ status: "error", message: expect.stringMatching(/by its id, a uuid/) });
    expect(
      await recordAffectedFromShell({ clinicId, incidentId, contactIds: "", operator: OPERATOR }),
    ).toMatchObject({ status: "error", message: expect.stringMatching(/--contacts/) });
    expect(
      await recordAffectedFromShell({
        clinicId,
        incidentId,
        contactIds: randomUUID(),
        action: "replace",
        operator: OPERATOR,
      }),
    ).toMatchObject({ status: "error", message: "--action is add or remove." });
  });
});

describeDb("who an incident affected", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.verifyAuthenticationResponse.mockReset();
    mocks.headers = new Headers();
    mocks.emails.length = 0;
    delete process.env.BETTER_AUTH_URL;
  });

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // Signing in and stepping up, as tests/conversations-screen.test.ts does
  // ---------------------------------------------------------------------------

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

  async function steppedUp(clinic: SeededClinic, path: string) {
    const credentialId = b64(randomBytes(16));
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
       values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true) returning id`,
      [clinic.staffUserId, credentialId],
    );
    const link = await signIn(clinic.staffUserId);
    const started = await startPasskeyAuthentication({ session: link.binding });
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
      session: link.binding,
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
    browse(link, path);
    return { link, factorId: rows[0]!.id, stepUpId: finished.stepUp.id };
  }

  async function open(clinicId: string, cls: "breach" | "service_complaint" = "breach") {
    return withTenant({ clinicId, actor: ACTOR }, (tx) =>
      openIncident(tx, {
        class: cls,
        summary: "Notice 7f3a went to a second inbox.",
        openedBy: "ops@healdesk.test",
        isCoveredEntity: true,
      }),
    );
  }

  /** The decision ops takes from /admin/incidents: a report queued, recorded on the incident. */
  async function reported(clinicId: string, incidentId: string) {
    await inTenant(clinicId, (client) =>
      client.query(`update incidents set reported_at = now(), reports_sent = 1 where id = $1`, [
        incidentId,
      ]),
    );
  }

  async function listed(clinicId: string, incidentId: string): Promise<string[]> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ contact_id: string }>(
        `select contact_id from incident_affected_contacts where incident_id = $1 order by contact_id`,
        [incidentId],
      ),
    );
    return rows.map((r) => r.contact_id);
  }

  test("the shell records the list by contact id, once each, refuses anyone not the clinic's, and takes off one named in error", async () => {
    const clinic = await seedClinic("affected");
    const other = await seedClinic("affectedother");
    const incident = await open(clinic.clinicId);
    const complaint = await open(clinic.clinicId, "service_complaint");
    const [a, b] = [
      await seedContact(clinic.clinicId, "+15550190201"),
      await seedContact(clinic.clinicId, "+15550190202"),
    ];
    const stranger = await seedContact(other.clinicId, "+15550190203");

    const added = await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: `${a},${b}`,
      operator: OPERATOR,
    });
    expect(added).toEqual({
      status: "recorded",
      action: "add",
      changed: 2,
      unchanged: 0,
      total: 2,
    });
    expect(await listed(clinic.clinicId, incident.id)).toEqual([a!, b!].sort());

    // Again: nothing doubles.
    expect(
      await recordAffectedFromShell({
        clinicId: clinic.clinicId,
        incidentId: incident.id,
        contactIds: `${a} ${a}`,
        operator: OPERATOR,
      }),
    ).toMatchObject({ status: "recorded", changed: 0, unchanged: 1, total: 2 });

    // Another clinic's contact, or one that does not exist: nothing at all is written.
    expect(
      await recordAffectedFromShell({
        clinicId: clinic.clinicId,
        incidentId: incident.id,
        contactIds: `${stranger},${randomUUID()}`,
        operator: OPERATOR,
      }),
    ).toMatchObject({
      status: "error",
      message: expect.stringMatching(/not a contact of this clinic/),
    });
    expect(await listed(clinic.clinicId, incident.id)).toHaveLength(2);

    // A service complaint affects no one an agreement reports, nor does another clinic's incident.
    expect(
      await recordAffectedFromShell({
        clinicId: clinic.clinicId,
        incidentId: complaint.id,
        contactIds: a!,
        operator: OPERATOR,
      }),
    ).toMatchObject({ status: "error", message: expect.stringMatching(/service complaint/) });
    expect(
      await recordAffectedFromShell({
        clinicId: other.clinicId,
        incidentId: incident.id,
        contactIds: stranger,
        operator: OPERATOR,
      }),
    ).toMatchObject({ status: "error", message: "No such incident at this clinic." });

    expect(
      await recordAffectedFromShell({
        clinicId: clinic.clinicId,
        incidentId: incident.id,
        contactIds: b!,
        action: "remove",
        operator: OPERATOR,
      }),
    ).toEqual({ status: "recorded", action: "remove", changed: 1, unchanged: 0, total: 1 });
    expect(await listed(clinic.clinicId, incident.id)).toEqual([a]);

    // Each change is a security event naming the operator, in counts.
    const { rows } = await getMigratorPool().query<{
      event: string;
      metadata: Record<string, unknown>;
    }>(
      `select event, metadata from security_events
        where event like 'incident_affected_%' order by occurred_at, id`,
    );
    expect(rows.map((r) => r.event)).toContain("incident_affected_removed");
    expect(rows.every((r) => !JSON.stringify(r.metadata).includes("5550190"))).toBe(true);
  });

  test("the table: the tenant's own, never rewritten, a contact of the incident's own clinic, and gone with the contact", async () => {
    const clinic = await seedClinic("affectedtable");
    const other = await seedClinic("affectedtable2");
    const incident = await open(clinic.clinicId);
    const contact = await seedContact(clinic.clinicId, "+15550190211");
    const stranger = await seedContact(other.clinicId, "+15550190212");

    // Another clinic's contact cannot be named, whoever writes.
    await expect(
      inTenant(clinic.clinicId, (client) =>
        client.query(
          `insert into incident_affected_contacts (clinic_id, incident_id, contact_id, recorded_by)
           values ($1, $2, $3, 'ops@healdesk.test')`,
          [clinic.clinicId, incident.id, stranger],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: contact,
      operator: OPERATOR,
    });
    const asApp = async (clinicId: string, text: string, values: unknown[] = []) => {
      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
        const result = await client.query(text, values);
        await client.query("commit");
        return result.rows;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    // The runtime role sees only its tenant's, and rewrites nothing.
    expect(await asApp(other.clinicId, `select * from incident_affected_contacts`)).toEqual([]);
    await expect(
      asApp(
        clinic.clinicId,
        `update incident_affected_contacts set recorded_by = 'someone@else.test'`,
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // An erasure of the person takes them off the list with them.
    const erased = await erasePersonFromShell({
      clinicId: clinic.clinicId,
      contactId: contact,
      requestedBy: "practice",
      operator: OPERATOR,
    });
    expect(erased.status).toBe("erased");
    expect(await listed(clinic.clinicId, incident.id)).toEqual([]);
  });

  test("the practice reads the list behind its passkey, once a report has gone, with an access row naming each contact", async () => {
    const clinic = await seedClinic("affectedpage");
    await bindAgreementInEffect(clinic.clinicId, "1.5.1");
    const incident = await open(clinic.clinicId);
    const contacts = [
      await seedContact(clinic.clinicId, "+15550190221"),
      await seedContact(clinic.clinicId, "+15550190222"),
    ];
    await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: contacts.join(","),
      operator: OPERATOR,
    });
    const desk = await steppedUp(clinic, `/c/${clinic.slug}/incidents/${incident.id}`);

    // Before any report has gone: nothing to read, and the open is still logged.
    const before = await requirePatientPage(clinic.slug);
    expect(await readAffectedList(before, incident.id)).toBeNull();

    await reported(clinic.clinicId, incident.id);
    const page = await requirePatientPage(clinic.slug);
    const view = await readAffectedList(page, incident.id);
    expect(view).toMatchObject({
      incidentId: incident.id,
      class: "breach",
      total: 2,
      page: 1,
      pages: 1,
    });
    expect(view!.people.map((p) => p.contactId).sort()).toEqual([...contacts].sort());
    // Ids and the contact fields healdesk holds, nothing more.
    for (const person of view!.people) {
      expect(Object.keys(person).sort()).toEqual(["contactId", "email", "fullName", "phone"]);
      expect(person.fullName).toBe("Synthetic Patient");
    }

    const { rows } = await inTenant(clinic.clinicId, (client) =>
      client.query<{
        actor_label: string;
        resource_type: string;
        resource_id: string | null;
        resource_ids: string[] | null;
        metadata: Record<string, unknown>;
      }>(
        `select actor_label, resource_type, resource_id, resource_ids, metadata from audit_log
          where clinic_id = $1 and resource_type = 'incident_affected' order by occurred_at, id`,
        [clinic.clinicId],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ resource_id: incident.id, resource_ids: null });
    expect([...rows[1]!.resource_ids!].sort()).toEqual([...contacts].sort());
    for (const row of rows) {
      expect(row.actor_label).toBe("Front desk Mac");
      expect(row.metadata).toEqual({ passkeyId: desk.factorId, stepUpId: desk.stepUpId });
    }

    // Another clinic's sign-in opens nothing of it.
    const elsewhere = await seedClinic("affectedelsewhere");
    await steppedUp(elsewhere, `/c/${elsewhere.slug}/incidents/${incident.id}`);
    const theirs = await requirePatientPage(elsewhere.slug);
    expect(await readAffectedList(theirs, incident.id)).toBeNull();
  });

  test("without a passkey step-up the page sends the browser to step up, and reads nothing", async () => {
    const clinic = await seedClinic("affectedgate");
    const link = await signIn(clinic.staffUserId);
    browse(link, `/c/${clinic.slug}/incidents/${randomUUID()}`);
    await expect(requirePatientPage(clinic.slug)).rejects.toMatchObject({
      url: expect.stringContaining("/step-up"),
    });
  });

  test("the register counts each incident's list, and never says who", async () => {
    const clinic = await seedClinic("affectedregister");
    const incident = await open(clinic.clinicId);
    await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: (await seedContact(clinic.clinicId, "+15550190231"))!,
      operator: OPERATOR,
    });
    const outcome = await runOperation(
      "listIncidentRegister",
      {},
      {
        email: "ops@healdesk.test",
        request: {},
      },
    );
    const body = JSON.stringify(outcome.body);
    expect(body).toContain('"affectedCount":1');
    expect(body).not.toContain("5550190231");
    expect(body).not.toContain("Synthetic Patient");
  });

  test("the count recorded stays on the incident when a person on the list is erased; the list itself keeps no trace of them", async () => {
    const clinic = await seedClinic("affectedkept");
    const incident = await open(clinic.clinicId);
    const people = [
      await seedContact(clinic.clinicId, "+15550190241"),
      await seedContact(clinic.clinicId, "+15550190242"),
    ];
    await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: people.join(","),
      operator: OPERATOR,
    });
    const erased = await erasePersonFromShell({
      clinicId: clinic.clinicId,
      contactId: people[0]!,
      requestedBy: "practice",
      operator: OPERATOR,
    });
    expect(erased.status).toBe("erased");
    expect(await listed(clinic.clinicId, incident.id)).toEqual([people[1]]);
    const outcome = await runOperation(
      "listIncidentRegister",
      {},
      { email: "ops@healdesk.test", request: {} },
    );
    const row = (
      outcome.body as { data: { incidents: { id: string; affectedCount: number }[] } }
    ).data.incidents.find((i) => i.id === incident.id);
    // Recorded as two; the erasure does not make it one.
    expect(row?.affectedCount).toBe(2);
    // The operator's own correction moves it, by what it removes: the erased
    // person stays counted.
    await recordAffectedFromShell({
      clinicId: clinic.clinicId,
      incidentId: incident.id,
      contactIds: people[1]!,
      action: "remove",
      operator: OPERATOR,
    });
    const after = await runOperation(
      "listIncidentRegister",
      {},
      { email: "ops@healdesk.test", request: {} },
    );
    expect(
      (
        after.body as { data: { incidents: { id: string; affectedCount: number }[] } }
      ).data.incidents.find((i) => i.id === incident.id)?.affectedCount,
    ).toBe(1);
  });
});
