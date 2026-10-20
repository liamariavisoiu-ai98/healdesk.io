import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { deliverNotice, MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { openIncident, overdueIncidents } from "@/lib/incidents/incidents";
import { runOperation, type Operator } from "@/lib/ops/api";
import type { IncidentRegisterRow } from "@/lib/notices/operator-notices";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The operator's notices and the incidents page (WP7), through the ops
 * envelope as /admin drives them, against the real tables: who a broadcast
 * reaches and how often, each agreement's notice period, the incident's two
 * deadlines and its one decision, the report's fixed fields, a dead letter
 * raising notifyOps, the product-updates switch and its stop link, the
 * guarantee's claim and finding, and a suspension a payment cannot lift.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "127.0.0.1" } };
const ACTOR = { type: "service", serviceName: "operator-notices-test" } as const;
const ORIGIN = "https://app.healdesk.test";
const DAY = 24 * 60 * 60 * 1000;

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly calls: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(private readonly result: DeliveryResult = { status: "sent", messageId: "msg_1" }) {}
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.calls.push({ target, message });
    return this.result;
  }
}

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (outcome.status !== 200)
    throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { data: T }).data;
}

type NoticeRow = {
  id: string;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
};

async function notices(clinicId: string, kind?: string): Promise<NoticeRow[]> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<NoticeRow>(
      `select id, kind, dedupe_key, payload, sent_at, attempts, last_error
         from billing_notices where clinic_id = $1 ${kind ? "and kind = $2" : ""} order by created_at`,
      kind ? [clinicId, kind] : [clinicId],
    );
    return rows;
  });
}

async function opsAlerts(event: string): Promise<{ fields: Record<string, unknown> }[]> {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1 order by raised_at`,
    [event],
  );
  return rows;
}

async function open(
  clinicId: string,
  cls: "breach" | "security_incident" | "improper_use_or_disclosure" | "service_complaint",
  discoveredAt = new Date(Date.now() - 2 * 60 * 60 * 1000),
) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) =>
    openIncident(tx, {
      class: cls,
      summary: "Notice 7f3a went to a second inbox; 1 conversation id on file.",
      openedBy: "ops@healdesk.test",
      isCoveredEntity: true,
      discoveredAt,
    }),
  );
}

async function setJobs(enabled: boolean): Promise<void> {
  await getMigratorPool().query(
    `update scheduled_jobs set enabled = $1 where name = 'billing-notices'`,
    [enabled],
  );
}

describeDb("the operator's notices and the incidents page (WP7)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
    // The sender stays off: these tests deliver by hand with a fake transport.
    await setJobs(false);
    process.env.BETTER_AUTH_URL = ORIGIN;
  });

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // The incidents page
  // ---------------------------------------------------------------------------

  describe("an incident's two deadlines", () => {
    test("the agreement's is stamped at opening from the agreement in effect, beside the internal 24-hour target", async () => {
      const current = await seedClinic("inc-150");
      await bindAgreementInEffect(current.clinicId, "1.5.0");
      const old = await seedClinic("inc-121");
      await bindAgreementInEffect(old.clinicId, "1.2.1");
      const none = await seedClinic("inc-none");
      const discovered = new Date("2026-10-09T15:00:00Z"); // a Friday

      const a = await open(current.clinicId, "security_incident", discovered);
      expect(a.agreementVersion).toBe("1.5.0");
      expect(a.agreementNotifyBy?.toISOString()).toBe("2026-12-08T15:00:00.000Z");
      expect(a.notifyBy.toISOString()).toBe("2026-10-10T15:00:00.000Z");

      const b = await open(old.clinicId, "breach", discovered);
      expect(b.agreementVersion).toBe("1.2.1");
      expect(b.agreementNotifyBy?.toISOString()).toBe("2026-10-14T15:00:00.000Z");
      const c = await open(old.clinicId, "security_incident", discovered);
      expect(c.agreementNotifyBy?.toISOString()).toBe("2026-10-16T15:00:00.000Z");

      const d = await open(none.clinicId, "breach", discovered);
      expect(d.agreementVersion).toBeNull();
      expect(d.agreementNotifyBy?.toISOString()).toBe("2026-10-14T15:00:00.000Z");
      expect(
        (await open(current.clinicId, "service_complaint", discovered)).agreementNotifyBy,
      ).toBeNull();
    });

    test("the cross-practice register shows both, every practice's, open first by the agreement's deadline", async () => {
      const one = await seedClinic("reg-one");
      await bindAgreementInEffect(one.clinicId, "1.5.0");
      const two = await seedClinic("reg-two");
      await bindAgreementInEffect(two.clinicId, "1.2.1");
      const late = await open(one.clinicId, "breach");
      const soon = await open(two.clinicId, "breach");
      const resolvedLongAgo = await open(
        two.clinicId,
        "security_incident",
        new Date(Date.now() - 200 * DAY),
      );
      await inTenant(two.clinicId, (c) =>
        c.query(
          `update incidents set resolved_at = now() - interval '120 days', resolution = 'done' where id = $1`,
          [resolvedLongAgo.id],
        ),
      );

      const view = data<{ incidents: IncidentRegisterRow[] }>(
        await runOperation("listIncidentRegister", {}, OPERATOR),
      );
      expect(view.incidents.map((i) => i.id)).toEqual([soon.id, late.id]);
      const first = view.incidents[0]!;
      expect(first.clinicName).toBe("reg-two Clinic");
      expect(first.agreementVersion).toBe("1.2.1");
      expect(first.agreementNotifyBy).toBe(soon.agreementNotifyBy!.toISOString());
      expect(first.targetNotifyBy).toBe(soon.notifyBy.toISOString());
      expect(first.reportsSent).toBe(0);
    });

    test("the care view carries the agreement's deadline too", async () => {
      const c = await seedClinic("care-deadline");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const i = await open(c.clinicId, "breach");
      const view = data<{
        incidents: { id: string; agreementNotifyBy: string | null; notifyBy: string }[];
      }>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
      expect(view.incidents[0]).toMatchObject({
        id: i.id,
        agreementNotifyBy: i.agreementNotifyBy!.toISOString(),
        notifyBy: i.notifyBy.toISOString(),
      });
    });
  });

  describe("Send report (L29)", () => {
    const FIELDS = {
      event: "misdirected_email",
      occurredOn: "2026-10-04",
      info: [
        { type: "first_name", count: 2 },
        { type: "phone_number", count: 2 },
      ],
      mitigations: ["recipient_confirmed_deletion", "fault_fixed"],
      steps: ["unexpected_contact", "unexpected_contact"],
      recommendations: ["assess_notice_duty"],
    };

    test("queues a critical report from the fixed fields only, records the decision and that the practice was told", async () => {
      const c = await seedClinic("report");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const i = await open(c.clinicId, "breach", new Date("2026-10-05T12:00:00Z"));

      const sent = data<{ status: string; report: number; auditRecorded: boolean }>(
        await runOperation(
          "sendIncidentReport",
          // Anything else in the envelope is ignored: a typed summary never reaches the payload.
          {
            clinicId: c.clinicId,
            incidentId: i.id,
            ...FIELDS,
            summary: "Jane's number +1 555 010 0123",
          },
          OPERATOR,
        ),
      );
      expect(sent).toMatchObject({
        status: "sent",
        report: 1,
        steps: 1,
        recommendations: 1,
        auditRecorded: true,
      });

      const [row] = await notices(c.clinicId, "incident_report");
      expect(row!.dedupe_key).toBe(`incident_report:${i.id}:1`);
      expect(row!.payload).toEqual({
        kind: "breach",
        event: "misdirected_email",
        occurredOn: "2026-10-04",
        discoveredOn: "2026-10-05",
        infoRows: [
          { type: "first_name", count: 2 },
          { type: "phone_number", count: 2 },
        ],
        mitigationRows: [{ code: "recipient_confirmed_deletion" }, { code: "fault_fixed" }],
        // What the people affected can do, and what we recommend, in the
        // written report itself (BAA Reporting and Notices clauses; wave 2 R11).
        stepRows: [{ code: "unexpected_contact" }],
        recommendationRows: [{ code: "assess_notice_duty" }],
        isUpdate: false,
        // A breach's report points to the incident's page, where the list of
        // who it affected is read behind the passkey (wave 2 R11).
        listUrl: `${ORIGIN}/c/${c.slug}/incidents/${i.id}`,
      });
      // Not the typed summary's words (the link's random ids may hold any digits).
      expect(JSON.stringify(row!.payload)).not.toMatch(/Jane|555 010 0123/);

      const [stored] = await inTenant(
        c.clinicId,
        async (cl) =>
          (
            await cl.query<{
              reported_at: Date | null;
              reports_sent: number;
              notified_at: Date | null;
              notified_how: string | null;
              decided_by: string | null;
            }>(
              `select reported_at, reports_sent, notified_at, notified_how, decided_by from incidents where id = $1`,
              [i.id],
            )
          ).rows,
      );
      expect(stored!.reports_sent).toBe(1);
      expect(stored!.reported_at).not.toBeNull();
      expect(stored!.notified_at).not.toBeNull();
      expect(stored!.notified_how).toContain(row!.id);
      expect(stored!.decided_by).toBe("ops@healdesk.test");
      // The internal target's alert no longer chases it.
      expect(
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          overdueIncidents(tx, new Date(Date.now() + 3 * DAY)),
        ),
      ).toEqual([]);

      // An update goes under its own key, marked as one; "Not reportable" is now refused.
      data(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, ...FIELDS, mitigations: ["investigating"] },
          OPERATOR,
        ),
      );
      const rows = await notices(c.clinicId, "incident_report");
      expect(rows.map((r) => r.dedupe_key)).toEqual([
        `incident_report:${i.id}:1`,
        `incident_report:${i.id}:2`,
      ]);
      expect(rows[1]!.payload.isUpdate).toBe(true);
      const refused = data<{ status: string; message: string }>(
        await runOperation(
          "markIncidentNotReportable",
          { clinicId: c.clinicId, incidentId: i.id, reason: "Blocked sign-ins only." },
          OPERATOR,
        ),
      );
      expect(refused.status).toBe("refused");
    });

    test("refuses a code the catalog doesn't list, a date after discovery, a service complaint and a resolved incident", async () => {
      const c = await seedClinic("report-refused");
      const i = await open(c.clinicId, "security_incident", new Date("2026-10-05T12:00:00Z"));
      const tryIt = async (args: Record<string, unknown>) =>
        data<{ status: string; message?: string }>(
          await runOperation(
            "sendIncidentReport",
            { clinicId: c.clinicId, incidentId: i.id, ...FIELDS, ...args },
            OPERATOR,
          ),
        );
      expect((await tryIt({ event: "the caller's name leaked" })).status).toBe("refused");
      expect((await tryIt({ info: [{ type: "diagnosis", count: 1 }] })).status).toBe("refused");
      expect((await tryIt({ info: [{ type: "first_name", count: 0 }] })).status).toBe("refused");
      expect((await tryIt({ occurredOn: "2026-10-06" })).message).toMatch(
        /after it was discovered/,
      );
      expect((await tryIt({ mitigations: ["we called Jane"] })).status).toBe("refused");
      expect((await tryIt({ steps: ["call Jane back"] })).message).toMatch(
        /what the people affected can do/,
      );
      expect((await tryIt({ recommendations: "notify_people" })).status).toBe("refused");

      const complaint = await open(c.clinicId, "service_complaint");
      const r = data<{ status: string; message: string }>(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: complaint.id, ...FIELDS },
          OPERATOR,
        ),
      );
      expect(r.message).toMatch(/service complaint/);
      await inTenant(c.clinicId, (cl) =>
        cl.query(`update incidents set resolved_at = now(), resolution = 'x' where id = $1`, [
          i.id,
        ]),
      );
      expect((await tryIt({})).message).toMatch(/resolved/);
      expect(await notices(c.clinicId, "incident_report")).toEqual([]);
    });

    test("refuses steps the rest of the report contradicts, and a pointer to the list in a report that has none", async () => {
      const c = await seedClinic("report-consistent");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const breach = await open(c.clinicId, "breach", new Date("2026-10-05T12:00:00Z"));
      const security = await open(
        c.clinicId,
        "security_incident",
        new Date("2026-10-05T12:00:00Z"),
      );
      const tryIt = async (incidentId: string, args: Record<string, unknown>) =>
        data<{ status: string; message?: string }>(
          await runOperation(
            "sendIncidentReport",
            { clinicId: c.clinicId, incidentId, ...FIELDS, ...args },
            OPERATOR,
          ),
        );

      // "Nothing they need to do" beside a step they should take.
      expect(
        await tryIt(breach.id, { steps: ["nothing_needed", "unexpected_contact"] }),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/other steps/) });
      // Or claiming a deletion the report never records.
      expect(
        await tryIt(breach.id, { steps: ["nothing_needed"], mitigations: ["investigating"] }),
      ).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/recipient confirmed deleting it/),
      });
      // A security incident's report has no list to point to.
      expect(await tryIt(security.id, { recommendations: ["notify_people"] })).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/only a breach's report/),
      });
      expect(await notices(c.clinicId, "incident_report")).toEqual([]);

      // Borne out by the rest: sent.
      expect(
        await tryIt(breach.id, {
          steps: ["nothing_needed"],
          mitigations: ["recipient_confirmed_deletion"],
          recommendations: ["notify_people"],
        }),
      ).toMatchObject({ status: "sent", steps: 1, recommendations: 1 });
    });

    test("a console that predates the steps sends none, and the report says they follow in an update", async () => {
      const c = await seedClinic("report-older-console");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const i = await open(c.clinicId, "breach", new Date("2026-10-05T12:00:00Z"));
      const { steps: _s, recommendations: _r, ...older } = FIELDS;
      const sent = data<{ status: string; steps: number; recommendations: number }>(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, ...older },
          OPERATOR,
        ),
      );
      expect(sent).toMatchObject({ status: "sent", steps: 0, recommendations: 0 });
      const [row] = await notices(c.clinicId, "incident_report");
      expect(row!.payload).toMatchObject({ stepRows: [], recommendationRows: [] });
    });

    test("a practice with no address to send to is refused before anything is queued", async () => {
      const c = await seedClinic("report-no-address");
      await inTenant(c.clinicId, (cl) =>
        cl.query(`delete from clinic_memberships where clinic_id = $1`, [c.clinicId]),
      );
      const i = await open(c.clinicId, "breach");
      const r = data<{ status: string; message: string }>(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, ...FIELDS },
          OPERATOR,
        ),
      );
      expect(r.message).toMatch(/no address on its account/);
      expect(await notices(c.clinicId)).toEqual([]);
    });

    test("a report that cannot be delivered is a dead letter, and ops is told", async () => {
      const c = await seedClinic("report-dead");
      const i = await open(c.clinicId, "breach");
      data(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, ...FIELDS },
          OPERATOR,
        ),
      );
      const [row] = await notices(c.clinicId, "incident_report");
      const transport = new FakeTransport({
        status: "failed",
        reason: "Resend refused (validation_error)",
        statusCode: 422,
        errorName: "validation_error",
      } as DeliveryResult);
      expect(await deliverNotice(c.clinicId, row!.id, { transport })).toBe("dead");
      expect((await notices(c.clinicId, "incident_report"))[0]!.attempts).toBe(MAX_NOTICE_ATTEMPTS);
      const alerts = await opsAlerts("critical_notice_undelivered");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.fields).toMatchObject({ kind: "incident_report", status: "dead" });
    });

    test("a delivered report renders from the stored codes and names no one", async () => {
      const c = await seedClinic("report-sent");
      const i = await open(c.clinicId, "breach");
      data(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, ...FIELDS },
          OPERATOR,
        ),
      );
      const [row] = await notices(c.clinicId, "incident_report");
      const transport = new FakeTransport();
      expect(await deliverNotice(c.clinicId, row!.id, { transport })).toBe("sent");
      const message = transport.calls[0]!.message;
      expect(message.subject).toBe("healdesk incident report: a breach");
      expect(message.text).toContain("2 phone numbers");
      expect(message.text).toContain("This email names no one.");
      expect(transport.calls[0]!.target.to).toBe(c.staffEmail);
    });
  });

  describe("Not reportable", () => {
    test("records the reason, refuses one with a patient's details, and stops the internal target's alert", async () => {
      const c = await seedClinic("not-reportable");
      const i = await open(c.clinicId, "security_incident", new Date(Date.now() - 3 * DAY));
      expect(
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => overdueIncidents(tx)),
      ).toHaveLength(1);

      const phi = data<{ status: string; message: string }>(
        await runOperation(
          "markIncidentNotReportable",
          { clinicId: c.clinicId, incidentId: i.id, reason: "Caller +1 555 010 0123 retried" },
          OPERATOR,
        ),
      );
      expect(phi.status).toBe("refused");
      expect(phi.message).toMatch(/patient details/);

      const ok = data<{ status: string }>(
        await runOperation(
          "markIncidentNotReportable",
          {
            clinicId: c.clinicId,
            incidentId: i.id,
            reason: "Blocked sign-ins from 3 addresses: a routine unsuccessful attempt.",
          },
          OPERATOR,
        ),
      );
      expect(ok).toEqual({ status: "updated", auditRecorded: true });
      expect(
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => overdueIncidents(tx)),
      ).toEqual([]);

      const register = data<{ incidents: IncidentRegisterRow[] }>(
        await runOperation("listIncidentRegister", {}, OPERATOR),
      );
      expect(register.incidents[0]).toMatchObject({
        notReportableReason: "Blocked sign-ins from 3 addresses: a routine unsuccessful attempt.",
        decidedBy: "ops@healdesk.test",
      });
      // One decision: no report after it, and nothing was ever queued.
      const after = data<{ status: string }>(
        await runOperation(
          "sendIncidentReport",
          { clinicId: c.clinicId, incidentId: i.id, event: "other", info: [], mitigations: [] },
          OPERATOR,
        ),
      );
      expect(after.status).toBe("refused");
      expect(await notices(c.clinicId)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Broadcasts
  // ---------------------------------------------------------------------------

  describe("the terms notice (L28)", () => {
    const effectiveOn = () => new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);

    test("goes once to every account with an agreement in effect, and to no location, unsigned or leaving practice", async () => {
      const signed = await seedClinic("terms-signed");
      await bindAgreementInEffect(signed.clinicId, "1.5.0");
      const unsigned = await seedClinic("terms-unsigned");
      const location = await seedClinic("terms-location");
      await bindAgreementInEffect(location.clinicId, "1.5.0");
      await getMigratorPool().query(`update clinics set billing_clinic_id = $1 where id = $2`, [
        signed.clinicId,
        location.clinicId,
      ]);
      const leaving = await seedClinic("terms-leaving");
      await bindAgreementInEffect(leaving.clinicId, "1.5.0");
      await getMigratorPool().query(
        `update clinics set offboarding_started_at = now() where id = $1`,
        [leaving.clinicId],
      );

      const args = {
        version: "2026-11-30.1",
        effectiveOn: effectiveOn(),
        topics: ["fees", "renewal"],
        isPublished: true,
      };
      const first = data<{ status: string; queued: number; alreadyQueued: number }>(
        await runOperation("sendTermsNotice", args, OPERATOR),
      );
      expect(first).toMatchObject({
        status: "queued",
        queued: 1,
        alreadyQueued: 0,
        auditRecorded: true,
      });
      const [row] = await notices(signed.clinicId, "terms_notice");
      expect(row!.dedupe_key).toBe("terms_notice:2026-11-30.1");
      expect(row!.payload).toEqual({
        version: "2026-11-30.1",
        effectiveOn: args.effectiveOn,
        topicRows: [{ code: "fees" }, { code: "renewal" }],
        billingUrl: `${ORIGIN}/c/${signed.slug}/billing`,
      });
      for (const other of [unsigned, location, leaving])
        expect(await notices(other.clinicId)).toEqual([]);

      // Sent again, it reaches nobody twice.
      const again = data<{ queued: number; alreadyQueued: number }>(
        await runOperation("sendTermsNotice", args, OPERATOR),
      );
      expect(again).toMatchObject({ queued: 0, alreadyQueued: 1 });
    });

    test("refuses a change less than 30 days out, one not yet published, and a topic off the list", async () => {
      const c = await seedClinic("terms-refused");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      const base = {
        version: "2026-11-30.1",
        effectiveOn: effectiveOn(),
        topics: ["fees"],
        isPublished: true,
      };
      const soon = new Date(Date.now() + 29 * DAY).toISOString().slice(0, 10);
      const r1 = data<{ status: string; message: string }>(
        await runOperation("sendTermsNotice", { ...base, effectiveOn: soon }, OPERATOR),
      );
      expect(r1.message).toMatch(/at least 30 days/);
      const r2 = data<{ status: string; message: string }>(
        await runOperation("sendTermsNotice", { ...base, isPublished: false }, OPERATOR),
      );
      expect(r2.message).toMatch(/healdesk\.io\/terms/);
      const r3 = data<{ status: string }>(
        await runOperation(
          "sendTermsNotice",
          { ...base, topics: ["we changed everything"] },
          OPERATOR,
        ),
      );
      expect(r3.status).toBe("refused");
      expect(await notices(c.clinicId)).toEqual([]);
    });

    test("goes without a stop link, whatever the product-updates switch says", async () => {
      const c = await seedClinic("terms-mandatory");
      await bindAgreementInEffect(c.clinicId, "1.5.0");
      await inTenant(c.clinicId, (cl) =>
        cl.query(`insert into clinic_settings (clinic_id, product_updates) values ($1, false)`, [
          c.clinicId,
        ]),
      );
      data(
        await runOperation(
          "sendTermsNotice",
          {
            version: "2026-11-30.1",
            effectiveOn: effectiveOn(),
            topics: ["fees"],
            isPublished: true,
          },
          OPERATOR,
        ),
      );
      const [row] = await notices(c.clinicId, "terms_notice");
      const transport = new FakeTransport();
      // A weekday morning in the clinic's zone: terms notices wait for daytime.
      expect(
        await deliverNotice(c.clinicId, row!.id, {
          transport,
          now: new Date("2027-01-05T15:00:00Z"),
        }),
      ).toBe("sent");
      expect(transport.calls[0]!.message.headers?.["List-Unsubscribe"]).toBeUndefined();
      expect(transport.calls[0]!.message.text).not.toContain("Stop these emails");
    });
  });

  describe("a new subcontractor's notice (L29)", () => {
    test("is checked against each practice's own agreement: fifteen days where one promises it, 24 hours where all do", async () => {
      const current = await seedClinic("sub-current");
      await bindAgreementInEffect(current.clinicId, "1.5.0");
      const older = await seedClinic("sub-older");
      await bindAgreementInEffect(older.clinicId, "1.2.2");

      const inTwoDays = new Date(Date.now() + 2 * DAY).toISOString();
      const tooSoon = data<{ status: string; message: string }>(
        await runOperation(
          "sendSubprocessorNotice",
          { provider: "retell", startsAt: inTwoDays },
          OPERATOR,
        ),
      );
      expect(tooSoon.status).toBe("refused");
      expect(tooSoon.message).toMatch(/1 practice's agreement promises fifteen days' notice/);
      expect(await notices(current.clinicId)).toEqual([]);

      const inSixteenDays = new Date(Date.now() + 16 * DAY).toISOString();
      const sent = data<{ status: string; queued: number }>(
        await runOperation(
          "sendSubprocessorNotice",
          { provider: "retell", startsAt: inSixteenDays },
          OPERATOR,
        ),
      );
      expect(sent).toMatchObject({ status: "queued", queued: 2, auditRecorded: true });
      const [row] = await notices(current.clinicId, "subprocessor_notice");
      expect(row!.payload).toEqual({ provider: "retell", startsAt: inSixteenDays });

      // With only practices on the 24-hour clause, two days ahead is enough.
      await getMigratorPool().query(
        `update clinics set offboarding_started_at = now() where id = $1`,
        [older.clinicId],
      );
      const ok = data<{ status: string; queued: number }>(
        await runOperation(
          "sendSubprocessorNotice",
          { provider: "anthropic", startsAt: inTwoDays },
          OPERATOR,
        ),
      );
      expect(ok).toMatchObject({ status: "queued", queued: 1 });
      // Less than 24 hours and an hour for the email is refused even then.
      const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const r = data<{ status: string }>(
        await runOperation(
          "sendSubprocessorNotice",
          { provider: "aws", startsAt: inAnHour },
          OPERATOR,
        ),
      );
      expect(r.status).toBe("refused");
    });

    test("refuses a subcontractor the catalog doesn't list", async () => {
      const r = data<{ status: string }>(
        await runOperation(
          "sendSubprocessorNotice",
          { provider: "acme-ai", startsAt: new Date(Date.now() + 30 * DAY).toISOString() },
          OPERATOR,
        ),
      );
      expect(r.status).toBe("refused");
    });
  });

  describe("product updates (L33)", () => {
    test("go to every account still with us, signed or not, honour the switch, and carry the one-click stop link", async () => {
      const on = await seedClinic("update-on");
      const off = await seedClinic("update-off");
      await inTenant(off.clinicId, (cl) =>
        cl.query(`insert into clinic_settings (clinic_id, product_updates) values ($1, false)`, [
          off.clinicId,
        ]),
      );
      const sent = data<{ status: string; queued: number }>(
        await runOperation("sendProductUpdate", { code: "transcripts_by_email" }, OPERATOR),
      );
      expect(sent).toMatchObject({ status: "queued", queued: 2, auditRecorded: true });
      const [onRow] = await notices(on.clinicId, "product_update");
      expect(onRow!.payload).toEqual({
        code: "transcripts_by_email",
        actionUrl: `${ORIGIN}/c/${on.slug}/conversations`,
      });

      const now = new Date("2027-01-05T15:00:00Z");
      const transport = new FakeTransport();
      expect(await deliverNotice(on.clinicId, onRow!.id, { transport, now })).toBe("sent");
      const headers = transport.calls[0]!.message.headers ?? {};
      expect(headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${ORIGIN}/email/stop/`));
      expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(transport.calls[0]!.message.text).toContain(
        `Stop these emails: ${ORIGIN}/email/stop/`,
      );

      const [offRow] = await notices(off.clinicId, "product_update");
      expect(await deliverNotice(off.clinicId, offRow!.id, { transport, now })).toBe(
        "switched_off",
      );
      expect(transport.calls).toHaveLength(1);
    });

    test("refuses an update the catalog doesn't list", async () => {
      await seedClinic("update-refused");
      const r = data<{ status: string }>(
        await runOperation("sendProductUpdate", { code: "free_month" }, OPERATOR),
      );
      expect(r.status).toBe("refused");
    });
  });

  // ---------------------------------------------------------------------------
  // One practice
  // ---------------------------------------------------------------------------

  describe("the first-month guarantee (L30)", () => {
    test("the claim is acknowledged with the finding's day; the finding goes once, on a recorded claim, with its refund date", async () => {
      const c = await seedClinic("guarantee");
      const today = new Date().toISOString().slice(0, 10);
      const noClaim = data<{ status: string; message: string }>(
        await runOperation(
          "sendGuaranteeFinding",
          { clinicId: c.clinicId, claimReceivedOn: today, outcome: "no_miss_found" },
          OPERATOR,
        ),
      );
      expect(noClaim.message).toMatch(/record the claim first/);

      const claim = data<{ status: string; findingByOn: string }>(
        await runOperation(
          "recordGuaranteeClaim",
          { clinicId: c.clinicId, claimReceivedOn: today },
          OPERATOR,
        ),
      );
      expect(claim).toMatchObject({ status: "queued", auditRecorded: true });
      const [claimRow] = await notices(c.clinicId, "guarantee_claim_received");
      expect(claimRow!.payload).toEqual({ claimReceivedOn: today, findingByOn: claim.findingByOn });
      // Ten business days: two weeks of weekdays.
      expect(Date.parse(claim.findingByOn) - Date.parse(today)).toBeGreaterThanOrEqual(12 * DAY);
      expect(Date.parse(claim.findingByOn) - Date.parse(today)).toBeLessThanOrEqual(14 * DAY);

      let view = data<{
        openClaims: { clinicId: string; claimReceivedOn: string; findingByOn: string }[];
      }>(await runOperation("getOperatorNotices", {}, OPERATOR));
      expect(view.openClaims).toEqual([
        expect.objectContaining({
          clinicId: c.clinicId,
          claimReceivedOn: today,
          findingByOn: claim.findingByOn,
        }),
      ]);

      const farRefund = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
      const late = data<{ status: string; message: string }>(
        await runOperation(
          "sendGuaranteeFinding",
          {
            clinicId: c.clinicId,
            claimReceivedOn: today,
            outcome: "miss_found",
            refundByOn: farRefund,
            failure: "hosting",
          },
          OPERATOR,
        ),
      );
      expect(late.message).toMatch(/within 14 days/);
      const noFailure = data<{ status: string }>(
        await runOperation(
          "sendGuaranteeFinding",
          {
            clinicId: c.clinicId,
            claimReceivedOn: today,
            outcome: "miss_found",
            refundByOn: today,
          },
          OPERATOR,
        ),
      );
      expect(noFailure.status).toBe("refused");

      const refundBy = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
      const finding = data<{ status: string }>(
        await runOperation(
          "sendGuaranteeFinding",
          {
            clinicId: c.clinicId,
            claimReceivedOn: today,
            outcome: "miss_found",
            refundByOn: refundBy,
            failure: "telephony_and_speech",
          },
          OPERATOR,
        ),
      );
      expect(finding).toEqual({ status: "queued", auditRecorded: true });
      const [findingRow] = await notices(c.clinicId, "guarantee_finding");
      expect(findingRow!.payload).toEqual({
        claimReceivedOn: today,
        outcome: "miss_found",
        refundByOn: refundBy,
        code: "telephony_and_speech",
      });
      const twice = data<{ status: string; message: string }>(
        await runOperation(
          "sendGuaranteeFinding",
          { clinicId: c.clinicId, claimReceivedOn: today, outcome: "no_miss_found" },
          OPERATOR,
        ),
      );
      expect(twice.message).toMatch(/already gone/);

      view = data(await runOperation("getOperatorNotices", {}, OPERATOR));
      expect(view.openClaims).toEqual([]);
    });

    test("a claim dated in the future is refused", async () => {
      const c = await seedClinic("guarantee-future");
      const tomorrow = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
      const r = data<{ status: string }>(
        await runOperation(
          "recordGuaranteeClaim",
          { clinicId: c.clinicId, claimReceivedOn: tomorrow },
          OPERATOR,
        ),
      );
      expect(r.status).toBe("refused");
    });
  });

  describe("a suspension for a legal or security reason (L31)", () => {
    test("suspends the account through the billing state machine and queues the email that says why", async () => {
      const c = await seedClinic("suspend");
      await seedEntitled(c.clinicId);
      const r = data<{ status: string }>(
        await runOperation(
          "suspendForCause",
          { clinicId: c.clinicId, cause: "account_compromised" },
          OPERATOR,
        ),
      );
      expect(r).toEqual({ status: "suspended", auditRecorded: true });

      const [state] = await inTenant(
        c.clinicId,
        async (cl) =>
          (
            await cl.query<{ status: string }>(
              `select status from entitlements where clinic_id = $1`,
              [c.clinicId],
            )
          ).rows,
      );
      expect(state!.status).toBe("suspended");
      const transitions = await inTenant(
        c.clinicId,
        async (cl) =>
          (
            await cl.query<{ to_status: string; actor: string; reason: string }>(
              `select to_status, actor, reason from billing_transitions where clinic_id = $1 order by created_at`,
              [c.clinicId],
            )
          ).rows,
      );
      expect(transitions.at(-1)).toEqual({
        to_status: "suspended",
        actor: "support",
        reason: "legal_or_security",
      });
      const [row] = await notices(c.clinicId, "suspended_for_cause");
      expect(row!.payload).toMatchObject({ code: "account_compromised" });

      // Not twice, and not for a cause off the list.
      const again = data<{ status: string; message: string }>(
        await runOperation(
          "suspendForCause",
          { clinicId: c.clinicId, cause: "account_compromised" },
          OPERATOR,
        ),
      );
      expect(again.message).toMatch(/already suspended/);
    });

    test("refuses a cause off the list and a practice with no billing account", async () => {
      const c = await seedClinic("suspend-refused");
      const noBilling = data<{ status: string; message: string }>(
        await runOperation(
          "suspendForCause",
          { clinicId: c.clinicId, cause: "legal_order" },
          OPERATOR,
        ),
      );
      expect(noBilling.message).toMatch(/no billing account/);
      await seedEntitled(c.clinicId);
      const offList = data<{ status: string }>(
        await runOperation(
          "suspendForCause",
          { clinicId: c.clinicId, cause: "late again" },
          OPERATOR,
        ),
      );
      expect(offList.status).toBe("refused");
    });
  });

  describe("the record of what was sent", () => {
    test("counts each broadcast per announcement and lists each practice's notices, never a payload", async () => {
      const a = await seedClinic("record-a");
      const b = await seedClinic("record-b");
      data(await runOperation("sendProductUpdate", { code: "transcripts_by_email" }, OPERATOR));
      const i = await open(a.clinicId, "breach");
      data(
        await runOperation(
          "sendIncidentReport",
          { clinicId: a.clinicId, incidentId: i.id, event: "other", info: [], mitigations: [] },
          OPERATOR,
        ),
      );
      const view = data<{
        broadcasts: { kind: string; subject: string; counts: Record<string, number> }[];
        notices: { clinicId: string; kind: string; subject: string; state: string }[];
      }>(await runOperation("getOperatorNotices", {}, OPERATOR));
      expect(view.broadcasts).toEqual([
        expect.objectContaining({
          kind: "product_update",
          subject: "transcripts_by_email",
          counts: { sent: 0, switched_off: 0, not_sent: 0, dead: 0, pending: 2 },
        }),
      ]);
      expect(view.notices).toEqual([
        expect.objectContaining({
          clinicId: a.clinicId,
          kind: "incident_report",
          subject: `${i.id}:1`,
          state: "pending",
        }),
      ]);
      expect(JSON.stringify(view)).not.toContain("payload");
      void b;
    });
  });

  // ---------------------------------------------------------------------------
  // The migration
  // ---------------------------------------------------------------------------

  test("the migration's backfill stamps each open incident's agreement deadline from its practice's agreement", async () => {
    const current = await seedClinic("backfill-150");
    await bindAgreementInEffect(current.clinicId, "1.5.0");
    const older = await seedClinic("backfill-121");
    await bindAgreementInEffect(older.clinicId, "1.2.1");
    const discovered = new Date("2026-10-09T15:00:00Z"); // a Friday
    const ids: Record<string, string> = {};
    for (const [label, clinicId, cls] of [
      ["current", current.clinicId, "breach"],
      ["olderBreach", older.clinicId, "breach"],
      ["olderIncident", older.clinicId, "security_incident"],
      ["complaint", older.clinicId, "service_complaint"],
    ] as const) {
      const id = randomUUID();
      ids[label] = id;
      await inTenant(clinicId, (cl) =>
        cl.query(
          `insert into incidents (id, clinic_id, class, summary, discovered_at, notify_by, opened_by)
           values ($1, $2, $3, 'x', $4, $4::timestamptz + interval '1 day', 'test')`,
          [id, clinicId, cls, discovered],
        ),
      );
    }

    const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(drizzleDir).filter((name) =>
      /^\d{4}_operator_notices\.sql$/.test(name),
    );
    expect(files).toHaveLength(1);
    const backfill = readFileSync(`${drizzleDir}${files[0]!}`, "utf8").match(
      /DO \$\$[\s\S]*?END;\n\$\$;/,
    )?.[0];
    expect(backfill).toContain("UPDATE incidents");
    await getMigratorPool().query(backfill!);
    await getMigratorPool().query(backfill!);

    const read = async (clinicId: string, id: string) =>
      (
        await inTenant(
          clinicId,
          async (cl) =>
            (
              await cl.query<{
                agreement_notify_by: Date | null;
                agreement_version: string | null;
              }>(`select agreement_notify_by, agreement_version from incidents where id = $1`, [id])
            ).rows,
        )
      )[0]!;
    expect(await read(current.clinicId, ids.current!)).toEqual({
      agreement_notify_by: new Date("2026-12-08T15:00:00Z"),
      agreement_version: "1.5.0",
    });
    expect((await read(older.clinicId, ids.olderBreach!)).agreement_notify_by).toEqual(
      new Date("2026-10-14T15:00:00Z"),
    );
    // Five business days from a Friday, as openIncident counts them.
    expect((await read(older.clinicId, ids.olderIncident!)).agreement_notify_by).toEqual(
      new Date("2026-10-16T15:00:00Z"),
    );
    expect((await read(older.clinicId, ids.complaint!)).agreement_notify_by).toBeNull();
  });
});
