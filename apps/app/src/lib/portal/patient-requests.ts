import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { contacts, patientRequests, type PatientRequestKind } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import {
  logPatientAccess,
  withPatientPage,
  type PatientPage,
  type PatientTx,
} from "./patient-page";

/**
 * The practice's side of L32, a patient's request passed to it
 * (lib/patient-rights/patient-requests.ts has the whole path):
 *
 *   - **Home's pointer** (`readOpenPatientRequests`): each request nobody has
 *     marked received, by its id and its reply-by day. Nothing about the
 *     person, nor even what they asked, so Home needs no step-up; the link
 *     goes to the request's own page, which does.
 *   - **The request's page** (`readPatientRequest`, /c/[slug]/patient-requests/
 *     [id]): what was asked, when it reached healdesk, the day to mark it
 *     received by, and who it is about as the contact it names reads, behind
 *     the passkey step-up, every open writing its access-log row.
 *   - **Mark as received** (`markPatientRequestReceived`): the practice's
 *     acknowledgement, once, from the device whose passkey stepped up,
 *     stamped by the database's clock (patient_requests_guard) and audited
 *     with the passkey's and the step-up's ids. It stops the reminders and
 *     the ops alerts.
 */

/** A request still waiting for the practice to mark it received: ids and a day, nothing else. */
export type OpenPatientRequest = { id: string; replyBy: string };

/** Home's pointer: the requests nobody has marked received, soonest reply-by day first. */
export async function readOpenPatientRequests(tx: TenantTx): Promise<OpenPatientRequest[]> {
  return tx.db
    .select({ id: patientRequests.id, replyBy: patientRequests.replyBy })
    .from(patientRequests)
    .where(and(eq(patientRequests.clinicId, tx.clinicId), isNull(patientRequests.acknowledgedAt)))
    .orderBy(asc(patientRequests.replyBy), asc(patientRequests.recordedAt));
}

/** Who the request is about, as the contact it names reads now. */
export type PatientRequestPerson = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

export type PatientRequestView = {
  id: string;
  kind: PatientRequestKind;
  /** ISO: when it reached healdesk. */
  receivedAt: string;
  /** YYYY-MM-DD: the day to mark it received by. */
  replyBy: string;
  /**
   * The person, when a contact is named; `none` when none was (healdesk
   * holds no record of them: its operator telephones who asked), `gone` when
   * the contact named has since been deleted.
   */
  person: PatientRequestPerson | "none" | "gone";
  /** ISO, and the device's name, once the practice has marked it received. */
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPatientRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

async function findRequest(tx: PatientTx, id: string): Promise<PatientRequestView | null> {
  const [row] = await tx.db
    .select({
      id: patientRequests.id,
      kind: patientRequests.kind,
      receivedAt: patientRequests.receivedAt,
      replyBy: patientRequests.replyBy,
      contactId: patientRequests.contactId,
      contactNamed: patientRequests.contactNamed,
      acknowledgedAt: patientRequests.acknowledgedAt,
      acknowledgedBy: patientRequests.acknowledgedBy,
      name: contacts.fullName,
      phone: contacts.phone,
      email: contacts.email,
    })
    .from(patientRequests)
    .leftJoin(
      contacts,
      and(
        eq(contacts.clinicId, patientRequests.clinicId),
        eq(contacts.id, patientRequests.contactId),
      ),
    )
    .where(and(eq(patientRequests.clinicId, tx.clinicId), eq(patientRequests.id, id)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    receivedAt: row.receivedAt.toISOString(),
    replyBy: row.replyBy,
    person: row.contactId
      ? { name: row.name, phone: row.phone, email: row.email }
      : row.contactNamed
        ? "gone"
        : "none",
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy,
  };
}

/**
 * One request, opened, with its access-log row in the transaction that reads
 * it. An id this clinic does not hold is null ("not found"), its open logged
 * all the same.
 */
export async function readPatientRequest(
  page: PatientPage,
  id: string,
): Promise<PatientRequestView | null> {
  if (!isPatientRequestId(id)) return null;
  return withPatientPage(page, async (tx) => {
    await logPatientAccess(tx, { action: "read", resourceType: "patient_request", resourceId: id });
    return findRequest(tx, id);
  });
}

export class PatientRequestNotFoundError extends Error {
  constructor() {
    super("No such patient request at this clinic.");
    this.name = "PatientRequestNotFoundError";
  }
}

export type MarkReceivedOutcome = { status: "marked" } | { status: "already" };

/**
 * The practice's acknowledgement, inside withPatientPage: the request opened
 * (its access row), then marked received from the page's device, once. A
 * second mark changes nothing and says so. Throws PatientRequestNotFoundError
 * for an id this clinic does not hold.
 */
export async function markPatientRequestReceived(
  tx: PatientTx,
  id: string,
): Promise<MarkReceivedOutcome> {
  if (!isPatientRequestId(id)) throw new PatientRequestNotFoundError();
  const [row] = await tx.db
    .select({ acknowledgedAt: patientRequests.acknowledgedAt })
    .from(patientRequests)
    .where(and(eq(patientRequests.clinicId, tx.clinicId), eq(patientRequests.id, id)))
    .for("update")
    .limit(1);
  if (!row) throw new PatientRequestNotFoundError();
  await logPatientAccess(tx, { action: "read", resourceType: "patient_request", resourceId: id });
  if (row.acknowledgedAt) return { status: "already" };
  await tx.db
    .update(patientRequests)
    // The guard stamps acknowledged_at with the database's clock.
    .set({ acknowledgedBy: tx.page.stepUp.deviceLabel, acknowledgedAt: sql`clock_timestamp()` })
    .where(and(eq(patientRequests.clinicId, tx.clinicId), eq(patientRequests.id, id)));
  tx.audit.record({
    action: "update",
    resourceType: "patient_request",
    resourceId: id,
    metadata: {
      outcome: "acknowledged",
      passkeyId: tx.page.stepUp.passkeyId,
      stepUpId: tx.page.stepUp.stepUpId,
    },
  });
  return { status: "marked" };
}
