import { and, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, contacts, patientRequests, type PatientRequestKind } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { hostCoversPatientData } from "@/lib/compliance/vendor-coverage";
import { addBusinessDays } from "@/lib/incidents/reporting-rules";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { notifyOpsOnce, type OpsEvent } from "@/lib/ops/notify";
import { PublicUrlError, publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { patientRequestPath } from "./request-kinds";

export {
  isPatientRequestKind,
  PATIENT_REQUEST_KIND_LABELS,
  PATIENT_REQUEST_KINDS,
  patientRequestPath,
  type PatientRequestKind,
} from "./request-kinds";

/**
 * L32, a request from a patient (Annex X5 of the funnel and portal plan; BAA
 * 1.5.1 clause 14, its last paragraph): "If a patient makes one of these
 * requests, or any other request about their information, to healdesk itself
 * rather than to Practice, healdesk will not act on it. It will pass the
 * request to Practice within five business days and, in its reply to the
 * patient, tell them that healdesk cannot act on it and has passed it to
 * Practice."
 *
 * The whole path, and who does each part:
 *
 *   1. **The operator records it** from the app's own shell, never through
 *      apps/web (`npm run ops:patient-request -w @healdesk/app`,
 *      scripts/ops-patient-request.ts; on the AWS host a one-off task). By
 *      ids and closed choices only: the clinic, what was asked
 *      (PATIENT_REQUEST_KINDS), the contact it is about when the operator can
 *      name one, and when it reached us. Nothing of the patient's is typed or
 *      passed: on the AWS host nothing turns a number or an address into a
 *      contact's id, so a request there usually names none, and the operator
 *      tells the practice who asked by telephone (the script says so).
 *   2. **`recordPatientRequest`** writes the row (patient_requests, PHI,
 *      behind the BAA gate) and, in the same transaction, queues L32 to the
 *      clinic's one address: a pointer naming the clinic, what kind of
 *      request it is and the reply-by day, with a link to the request's page.
 *   3. **The practice opens it** on its own patient page
 *      (/c/[slug]/patient-requests/[id], lib/portal/patient-requests.ts),
 *      behind the passkey step-up, every open writing an access-log row.
 *      Home points at each request still unmarked.
 *   4. **The practice marks it received** there. That mark is the
 *      acknowledgement (see below), and it stops what follows.
 *   5. **The hourly sweep** (`sweepPatientRequests`, from the tick) sends a
 *      reminder on the second business day and on the fourth, the day before
 *      the reply-by day, while it is unmarked; on the fourth it also tells ops
 *      (`patient_request_due_soon`), so a person can telephone the practice
 *      with a day to spare; and once the reply-by day has passed unmarked it
 *      tells ops again (`patient_request_past_due`).
 *
 * The reply to the patient (Annex X0) is written by a person, never by this
 * code: v1 contacts no patient.
 *
 * ## The acknowledgement mark: "Mark as received", by the practice, behind step-up
 *
 * The BAA's duty is to pass the request ON, so what counts is the practice
 * having it, said by the practice. The mark is a button on the request's
 * own page, behind the passkey step-up, stamped with the database's clock
 * and the name of the device whose passkey stepped up, once, and audited
 * with the passkey's and the step-up's ids. Not the alternatives:
 *
 *   - **an email delivered**, or opened: open tracking is off (X1.7), and a
 *     message in an inbox is not a person who has read it, which is exactly
 *     the case the reminders and the ops call exist for;
 *   - **the page opened**: every open writes an access-log row already, but
 *     an open is not a statement that the practice will answer the patient:
 *     anyone with the passkey may glance at it and close it, and the reminders
 *     would stop on a glance;
 *   - **an operator's mark** (as L25's replies are marked, lib/ops/
 *     support-replies.ts): that records what healdesk believes, not what the
 *     practice has. The operator's telephone call is the fallback the ops
 *     alerts ask for, not the evidence.
 *
 * It is the practice's word, made deliberately, by a known device, and it is
 * what the reminders and the ops alerts wait for.
 *
 * ## The days
 *
 * Business days are weekdays (addBusinessDays, lib/incidents/reporting-rules;
 * no public holidays, as the erasure and incident clocks count them), counted
 * from the clinic-local day the request reached healdesk. The reply-by day is
 * the fifth: the BAA's own limit, which is why the day before it is the last
 * reminder and ops's call to make. Every mark is a clinic-local day, so the
 * sweep acts at the first hourly run of that day; L32 waits for the clinic's
 * daytime in the outbox (its kind is `daytime`, lib/email/kinds.ts).
 */

/** The BAA's five business days: the request is passed on by the fifth after it reached us. */
export const PASS_ON_BUSINESS_DAYS = 5;

/** The reminders, by business day after the request reached us: the second, and the fourth (the day before). */
export const REMINDER_BUSINESS_DAYS = [2, 4] as const;

/** `days` business days after a calendar day (YYYY-MM-DD), as a calendar day. */
export function businessDaysAfter(isoDay: string, days: number): string {
  return addBusinessDays(new Date(`${isoDay}T12:00:00Z`), days)
    .toISOString()
    .slice(0, 10);
}

/** The reply-by day: the fifth business day after the clinic-local day the request reached us. */
export function replyByFor(receivedAt: Date, timeZone: string): string {
  return businessDaysAfter(clinicLocalDate(receivedAt, timeZone), PASS_ON_BUSINESS_DAYS);
}

/**
 * AWS's or the database host's own business associate agreement is not in
 * force (platform_compliance; lib/compliance/vendor-coverage.ts), so nothing
 * new is kept where patient data lives, as the answer gate's
 * `host_agreement_lapsed` has it: the request is passed on by telephone.
 */
export class PatientRequestHostLapsed extends Error {
  constructor() {
    super("The host's business associate agreement is not in force: nothing new is kept.");
    this.name = "PatientRequestHostLapsed";
  }
}

/** The contact named is not one of this clinic's. */
export class PatientRequestContactNotFound extends Error {
  constructor() {
    super("No such contact at this clinic.");
    this.name = "PatientRequestContactNotFound";
  }
}

export type RecordedPatientRequest = {
  id: string;
  /** The reply-by day, YYYY-MM-DD in the clinic's time zone. */
  replyBy: string;
  /** Whether a contact was named: when not, the operator tells the practice who asked, by telephone. */
  contactNamed: boolean;
  /** Whether L32 carries its link: false only where no public origin is set. */
  linked: boolean;
};

/** The link L32 and its reminders carry, or null (and a log line) where no public origin is set. */
function requestUrl(clinicId: string, slug: string, requestId: string): string | null {
  try {
    return publicUrl(patientRequestPath(slug, requestId));
  } catch (error) {
    if (!(error instanceof PublicUrlError)) throw error;
    log.error("patient request notice queued without a link: no public origin", {
      clinicId,
      requestId,
    });
    return null;
  }
}

/** The database's clock: the bound the received time is held to, never the shell's. */
async function databaseNow(tx: TenantTx): Promise<Date> {
  const result = await tx.db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  return new Date(result.rows[0]!.now);
}

async function clinicOf(tx: TenantTx): Promise<{ slug: string; timezone: string }> {
  const [clinic] = await tx.db
    .select({ slug: clinics.slug, timezone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) throw new Error("The clinic of this transaction was not found.");
  return clinic;
}

/**
 * Record a patient's request and queue L32, in the clinic's own tenant
 * transaction. The contact, when named, must be this clinic's; the received
 * time is held to the database's clock. Writes the audit row (ids and the
 * kind only). Refused, with nothing written: for a production clinic while
 * the host's own agreement has lapsed (PatientRequestHostLapsed, checked
 * first, as `patientDataRefused` refuses every write of patient data then);
 * and by the BAA gate for a production clinic without an agreement in effect,
 * or one that has started to leave.
 */
export async function recordPatientRequest(
  tx: TenantTx,
  input: {
    kind: PatientRequestKind;
    contactId?: string | null;
    receivedAt?: Date;
    recordedBy: string;
  },
): Promise<RecordedPatientRequest> {
  if (!(await hostCoversPatientData(tx))) throw new PatientRequestHostLapsed();
  const clinic = await clinicOf(tx);
  const contactId = input.contactId ?? null;
  if (contactId) {
    const [found] = await tx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)))
      .limit(1);
    if (!found) throw new PatientRequestContactNotFound();
  }
  const now = await databaseNow(tx);
  const receivedAt =
    input.receivedAt && input.receivedAt.getTime() < now.getTime() ? input.receivedAt : now;
  const replyBy = replyByFor(receivedAt, clinic.timezone);
  const [row] = await tx.db
    .insert(patientRequests)
    .values({
      clinicId: tx.clinicId,
      kind: input.kind,
      contactId,
      receivedAt,
      replyBy,
      recordedBy: input.recordedBy,
    })
    .returning({ id: patientRequests.id });
  if (!row) throw new Error("The patient request was not recorded.");

  const portalUrl = requestUrl(tx.clinicId, clinic.slug, row.id);
  await enqueuePlanNotice(tx.db, tx.clinicId, "patient_request", `patient_request:${row.id}`, {
    requestId: row.id,
    kind: input.kind,
    replyByOn: replyBy,
    isReminder: false,
    portalUrl,
  });
  tx.audit.record({
    action: "create",
    resourceType: "patient_request",
    resourceId: row.id,
    // No reply-by day: an ISO date is digits enough for the audit's number check.
    metadata: { kind: input.kind, contactNamed: contactId !== null },
  });
  return { id: row.id, replyBy, contactNamed: contactId !== null, linked: portalUrl !== null };
}

// -----------------------------------------------------------------------------
// The sweep: reminders, and ops alerts as the five business days run out
// -----------------------------------------------------------------------------

export type PatientRequestStep = {
  /** The reminder due now, by its number (1 on the second business day, 2 on the fourth), or null. */
  reminder: 1 | 2 | null;
  /** The ops alert due now, or null. */
  alert: Extract<OpsEvent, "patient_request_due_soon" | "patient_request_past_due"> | null;
};

/**
 * What an unmarked request is owed at `now`, in the clinic's own days.
 * Pure. A reminder is owed only for a day after the one the request was
 * recorded on: a request recorded late (its received time set back) has its
 * L32 for the days already gone, and the alerts tell ops the clock is short.
 * Once the reply-by day has passed, ops is told and the practice gets no
 * more reminders: a person telephones it instead.
 */
export function patientRequestStep(
  request: { receivedAt: Date; recordedAt: Date; replyBy: string },
  now: Date,
  timeZone: string,
): PatientRequestStep {
  const today = clinicLocalDate(now, timeZone);
  if (today > request.replyBy) return { reminder: null, alert: "patient_request_past_due" };
  const received = clinicLocalDate(request.receivedAt, timeZone);
  const recorded = clinicLocalDate(request.recordedAt, timeZone);
  const [first, last] = REMINDER_BUSINESS_DAYS.map((n) => businessDaysAfter(received, n)) as [
    string,
    string,
  ];
  if (today >= last) {
    return { reminder: last > recorded ? 2 : null, alert: "patient_request_due_soon" };
  }
  if (today >= first && first > recorded) return { reminder: 1, alert: null };
  return { reminder: null, alert: null };
}

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "patient-requests" };

export type PatientRequestSweep = {
  /** Requests no practice has marked received. */
  open: number;
  /** Reminders queued by this run (each once, by its dedupe key). */
  reminded: number;
  /** Requests whose alert was raised (each once, ever, by notifyOpsOnce). */
  dueSoon: number;
  pastDue: number;
  /** Requests that could not be read or reminded: logged, and retried next hour. */
  failures: number;
};

/**
 * Every unmarked request, across clinics (app_open_patient_requests, ids
 * only): its reminder, queued in its clinic's tenant transaction, and its ops
 * alert, after commit. Not a switched job, like the re-sign reminders
 * (lib/agreements/resign.ts): the BAA's five business days wait for no
 * switch. One request failing is logged and counted; the rest still run.
 */
export async function sweepPatientRequests(now: Date = new Date()): Promise<PatientRequestSweep> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_open_patient_requests()`,
  );
  const out: PatientRequestSweep = {
    open: result.rows.length,
    reminded: 0,
    dueSoon: 0,
    pastDue: 0,
    failures: 0,
  };
  for (const { clinic_id: clinicId, id } of result.rows) {
    try {
      const step = await withTenant({ clinicId, actor: SWEEP_ACTOR }, async (tx) => {
        const [request] = await tx.db
          .select({
            kind: patientRequests.kind,
            receivedAt: patientRequests.receivedAt,
            recordedAt: patientRequests.recordedAt,
            replyBy: patientRequests.replyBy,
            acknowledgedAt: patientRequests.acknowledgedAt,
          })
          .from(patientRequests)
          .where(and(eq(patientRequests.clinicId, clinicId), eq(patientRequests.id, id)))
          .limit(1);
        if (!request || request.acknowledgedAt) return null;
        const clinic = await clinicOf(tx);
        const due = patientRequestStep(request, now, clinic.timezone);
        if (due.reminder !== null) {
          const queued = await enqueuePlanNotice(
            tx.db,
            clinicId,
            "patient_request",
            `patient_request:${id}:reminder:${due.reminder}`,
            {
              requestId: id,
              kind: request.kind,
              replyByOn: request.replyBy,
              isReminder: true,
              portalUrl: requestUrl(clinicId, clinic.slug, id),
            },
          );
          if (queued) out.reminded += 1;
        }
        return due;
      });
      if (step?.alert) {
        await notifyOpsOnce(step.alert, { clinicId, requestId: id });
        if (step.alert === "patient_request_due_soon") out.dueSoon += 1;
        else out.pastDue += 1;
      }
    } catch (error) {
      out.failures += 1;
      log.error("patient request not swept", {
        clinicId,
        requestId: id,
        error: describeError(error),
      });
    }
  }
  return out;
}
