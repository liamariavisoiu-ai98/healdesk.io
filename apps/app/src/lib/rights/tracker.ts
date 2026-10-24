import { and, eq, sql } from "drizzle-orm";

import {
  patientRequests,
  PATIENT_REQUEST_KINDS,
  recordAmendments,
  rightsIntakes,
  type PatientRequestKind,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { listErasureRequests } from "@/lib/patient-rights/erasure";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  backupExpiresOn,
  businessDaysAfter,
  daysLeftFor,
  clockState,
  dueOnFor,
  RIGHTS_CLOCKS,
  utcDay,
  type RightsKind,
  type RightsStatus,
  type RightsVerification,
} from "./clocks";
import { NO_ROUTE, prepareCommand } from "./commands";

/**
 * What an open, unlinked patient-request intake shows beside its command.
 * Nothing pairs the intake with the request the command records on the host
 * (a pairing by clinic, kind and day could take another person's request):
 * the intake keeps its command and its own clock until the owner presses
 * Mark done, and the request the host records is its own row, chased by the
 * L32 sweep.
 */
export const RUN_THEN_MARK =
  "Run this on the host, then press Mark done here. The practice's own request is chased separately once it is recorded.";

/**
 * The patient-rights tracker's reads and writes (ops automation lane P6c;
 * design E6 item 16). It tracks; it never acts: nothing here runs an
 * erasure, an amendment, an export or a task, and nothing contacts anyone.
 *
 * One list across clinics, of every request with a clock:
 *
 *   - the intakes (rights_intakes): each request as it reached us, recorded
 *     the day it came, with the day its kind's clock gives;
 *   - erasure_requests: a deletion that has run, open until its
 *     subcontractor step (Retell) is stamped, due on its stored `due_by`,
 *     with the day its backups age out as a separate fact;
 *   - patient_requests: a request passed to the practice, open until the
 *     practice marks it received, due on its stored `reply_by`;
 *   - record_amendments: an amendment appended, which is done when it
 *     exists. No due day is stored for one, so it is derived from the day
 *     the practice directed it (`requested_at`), ten business days on, and
 *     the row says so (`dueDerived`). Listed only when done rows are asked for.
 *
 * An intake that names one of those records as the one it became is shown
 * once, as the intake, with the record's stored due day and state. Ids,
 * dates, closed words and the clinic's own name; never a person, a contact
 * id, an amendment's words or anything typed. Each clinic whose request
 * records were read writes one access row, attributed to the actor.
 */

export type RightsState = "on_time" | "due_soon" | "overdue" | "blocked" | "done";
export type RightsSource = "intake" | "erasure_request" | "patient_request" | "record_amendment";

export type RightsRow = {
  /** The intake's id when there is one, else the record's. */
  id: string;
  source: RightsSource;
  intakeId: string | null;
  recordId: string | null;
  clinicId: string;
  clinicName: string;
  kind: RightsKind;
  /** What a patient asked healdesk for: a patient request only. */
  askedFor: PatientRequestKind | null;
  verifiedVia: RightsVerification | null;
  receivedOn: string;
  dueOn: string;
  /** True when no due day is stored and it was derived from the request's date (an amendment). */
  dueDerived: boolean;
  /** Business days left (negative once past); null once done. */
  daysLeft: number | null;
  state: RightsState;
  /** The prepared run-task.sh line for the owner to run, or null. */
  command: string | null;
  /** Why there is no command, in a fixed sentence, when one was owed. */
  commandNote: string | null;
  /** An erasure's subcontractor step: null for every other kind. */
  retellStep: "stamped" | "outstanding" | null;
  /** The last day a backup can hold an erased person: an erasure that has run only. */
  backupExpiresOn: string | null;
  /** When it was closed or completed (UTC day), or null while open. */
  closedOn: string | null;
};

export type RightsFilter = "open" | "done" | "all";

export type RightsList = {
  rows: RightsRow[];
  /** Every row found for the filter, before the limit. */
  count: number;
  truncated: boolean;
  /** Clinics whose read failed: their requests are missing, never zero. */
  unreadClinics: number;
};

export const RIGHTS_LIST_DEFAULT = 100;
export const RIGHTS_LIST_MAX = 500;

type IntakeRecord = typeof rightsIntakes.$inferSelect;

/** What each kind's linked record must be: none for a correction or an export, which record nothing by id. */
export const LINKABLE: Readonly<Partial<Record<RightsKind, "erasure_request" | "record_amendment" | "patient_request">>> = {
  erasure: "erasure_request",
  amendment: "record_amendment",
  patient_request: "patient_request",
};

/** The row's state: done, else blocked when it has no route, else its clock. */
function stateOf(done: boolean, isBlocked: boolean, today: string, due: string): RightsState {
  if (done) return "done";
  if (isBlocked) return "blocked";
  return clockState(today, due);
}

type ClinicRead = {
  intakes: IntakeRecord[];
  erasures: { id: string; receivedAt: Date; dueBy: Date; erasedAt: Date; stamped: boolean }[];
  requests: { id: string; kind: PatientRequestKind; receivedAt: Date; replyBy: string; acknowledgedAt: Date | null }[];
  amendments: { id: string; requestedAt: Date; recordedAt: Date }[];
};

async function readClinic(tx: TenantTx, filter: RightsFilter): Promise<ClinicRead> {
  const intakes = await tx.db.select().from(rightsIntakes).where(eq(rightsIntakes.clinicId, tx.clinicId));
  // Through the erasure module's own reader, which returns no reference to anyone
  // (the deletion record's one reader outside it: tests/person-erasure.test.ts).
  const erasures = (await listErasureRequests(tx)).map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt,
    dueBy: r.dueBy,
    erasedAt: r.erasedAt,
    stamped: r.steps.every((step) => step.stamp !== null),
  }));
  const requests = await tx.db
    .select({
      id: patientRequests.id,
      kind: patientRequests.kind,
      receivedAt: patientRequests.receivedAt,
      replyBy: patientRequests.replyBy,
      acknowledgedAt: patientRequests.acknowledgedAt,
    })
    .from(patientRequests)
    .where(eq(patientRequests.clinicId, tx.clinicId));
  const amendments =
    filter === "open"
      ? []
      : await tx.db
          .select({ id: recordAmendments.id, requestedAt: recordAmendments.requestedAt, recordedAt: recordAmendments.recordedAt })
          .from(recordAmendments)
          .where(eq(recordAmendments.clinicId, tx.clinicId));
  const read = erasures.length + requests.length + amendments.length;
  if (read > 0) {
    tx.audit.record({
      action: "read",
      resourceType: "patient_rights",
      resourceId: tx.clinicId,
      resultCount: read,
      metadata: { purpose: "rights_tracker" },
    });
  }
  return { intakes, erasures, requests, amendments };
}

/** Every row of one clinic, merged, before the filter. Pure but for the operator address passed in. */
export function clinicRows(
  clinic: { id: string; name: string },
  read: ClinicRead,
  today: string,
  operator: string,
): RightsRow[] {
  const out: RightsRow[] = [];
  const erasures = new Map(read.erasures.map((r) => [r.id, r]));
  const requests = new Map(read.requests.map((r) => [r.id, r]));
  const amendments = new Map(read.amendments.map((r) => [r.id, r]));
  const linked = new Set<string>();
  for (const intake of read.intakes) if (intake.linkedRecordId) linked.add(intake.linkedRecordId);

  /** The agreement counts from receipt: the earlier of the intake's day and the record's. */
  const earlier = (a: string, b: string) => (a < b ? a : b);

  for (const intake of read.intakes) {
    const base = {
      id: intake.id,
      source: "intake" as const,
      intakeId: intake.id,
      clinicId: clinic.id,
      clinicName: clinic.name,
      kind: intake.kind,
      askedFor: intake.askedFor ?? null,
      verifiedVia: intake.verifiedVia,
      receivedOn: intake.receivedOn,
      dueDerived: false,
    };
    const closed = intake.status !== "open";
    const closedOn = intake.closedAt ? utcDay(intake.closedAt) : null;
    const link = intake.linkedRecordId;
    const erasure = link && intake.kind === "erasure" ? erasures.get(link) : undefined;
    const request = link && intake.kind === "patient_request" ? requests.get(link) : undefined;
    const amendment = link && intake.kind === "amendment" ? amendments.get(link) : undefined;
    if (erasure) {
      // Done only once the subcontractor step is stamped: closing the intake
      // never counts (closeIntake refuses it while the step is outstanding).
      const stamped = erasure.stamped;
      const done = stamped;
      const due = earlier(intake.dueOn, utcDay(erasure.dueBy));
      out.push({
        ...base,
        recordId: erasure.id,
        dueOn: due,
        daysLeft: done ? null : daysLeftFor(today, due),
        state: stateOf(done, false, today, due),
        command: null,
        commandNote: null,
        retellStep: stamped ? "stamped" : "outstanding",
        backupExpiresOn: backupExpiresOn(erasure.erasedAt),
        closedOn,
      });
      continue;
    }
    if (request) {
      // Done only once the practice marks it received, as the L32 sweep waits for.
      const done = request.acknowledgedAt !== null;
      const due = earlier(intake.dueOn, request.replyBy);
      out.push({
        ...base,
        recordId: request.id,
        dueOn: due,
        daysLeft: done ? null : daysLeftFor(today, due),
        state: stateOf(done, false, today, due),
        command: null,
        commandNote: null,
        retellStep: null,
        backupExpiresOn: null,
        closedOn: request.acknowledgedAt ? utcDay(request.acknowledgedAt) : closedOn,
      });
      continue;
    }
    // Linked to a record, it has run: an amendment is done once it exists,
    // and a record that is gone went by its own clock (an erasure's expiry
    // once its step was stamped, the purge, the clinic's destruction).
    const ran = link !== null;
    if (ran) {
      out.push({
        ...base,
        recordId: link,
        dueOn: intake.dueOn,
        daysLeft: null,
        state: "done",
        command: null,
        commandNote: null,
        retellStep: null,
        backupExpiresOn: null,
        closedOn: closedOn ?? (amendment ? utcDay(amendment.recordedAt) : null),
      });
      continue;
    }
    const prepared = closed
      ? null
      : prepareCommand({
          kind: intake.kind,
          clinicId: clinic.id,
          receivedOn: intake.receivedOn,
          askedFor: intake.askedFor,
          operator,
        });
    const isBlocked = prepared?.blocked === true;
    out.push({
      ...base,
      recordId: null,
      dueOn: intake.dueOn,
      daysLeft: closed ? null : daysLeftFor(today, intake.dueOn),
      state: stateOf(closed, isBlocked, today, intake.dueOn),
      command: prepared?.command ?? null,
      commandNote: prepared && !prepared.command ? prepared.note : prepared?.command && intake.kind === "patient_request" ? RUN_THEN_MARK : null,
      retellStep: null,
      backupExpiresOn: null,
      closedOn,
    });
  }

  for (const erasure of read.erasures) {
    if (linked.has(erasure.id)) continue;
    const stamped = erasure.stamped;
    const due = utcDay(erasure.dueBy);
    out.push({
      id: erasure.id,
      source: "erasure_request",
      intakeId: null,
      recordId: erasure.id,
      clinicId: clinic.id,
      clinicName: clinic.name,
      kind: "erasure",
      askedFor: null,
      verifiedVia: null,
      receivedOn: utcDay(erasure.receivedAt),
      dueOn: due,
      dueDerived: false,
      daysLeft: stamped ? null : daysLeftFor(today, due),
      state: stateOf(stamped, false, today, due),
      command: null,
      commandNote: null,
      retellStep: stamped ? "stamped" : "outstanding",
      backupExpiresOn: backupExpiresOn(erasure.erasedAt),
      // The stamp's own time is the vendor's record; the row says done, not when.
      closedOn: null,
    });
  }

  for (const request of read.requests) {
    if (linked.has(request.id)) continue;
    const done = request.acknowledgedAt !== null;
    out.push({
      id: request.id,
      source: "patient_request",
      intakeId: null,
      recordId: request.id,
      clinicId: clinic.id,
      clinicName: clinic.name,
      kind: "patient_request",
      askedFor: (PATIENT_REQUEST_KINDS as readonly string[]).includes(request.kind) ? request.kind : null,
      verifiedVia: null,
      receivedOn: utcDay(request.receivedAt),
      dueOn: request.replyBy,
      dueDerived: false,
      daysLeft: done ? null : daysLeftFor(today, request.replyBy),
      state: stateOf(done, false, today, request.replyBy),
      command: null,
      commandNote: null,
      retellStep: null,
      backupExpiresOn: null,
      closedOn: request.acknowledgedAt ? utcDay(request.acknowledgedAt) : null,
    });
  }

  for (const amendment of read.amendments) {
    if (linked.has(amendment.id)) continue;
    const requested = utcDay(amendment.requestedAt);
    out.push({
      id: amendment.id,
      source: "record_amendment",
      intakeId: null,
      recordId: amendment.id,
      clinicId: clinic.id,
      clinicName: clinic.name,
      kind: "amendment",
      askedFor: null,
      verifiedVia: null,
      receivedOn: requested,
      dueOn: businessDaysAfter(requested, RIGHTS_CLOCKS.amendment.businessDays),
      dueDerived: true,
      daysLeft: null,
      state: "done",
      command: null,
      commandNote: null,
      retellStep: null,
      backupExpiresOn: null,
      closedOn: utcDay(amendment.recordedAt),
    });
  }
  return out;
}

function keep(row: RightsRow, filter: RightsFilter): boolean {
  if (filter === "all") return true;
  return filter === "done" ? row.state === "done" : row.state !== "done";
}

/** Open first, the earliest due day first; done rows after, the latest closed first. */
function order(a: RightsRow, b: RightsRow): number {
  const doneA = a.state === "done" ? 1 : 0;
  const doneB = b.state === "done" ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB;
  if (doneA === 0 && a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
  if (doneA === 1 && (a.closedOn ?? a.dueOn) !== (b.closedOn ?? b.dueOn)) {
    return (a.closedOn ?? a.dueOn) > (b.closedOn ?? b.dueOn) ? -1 : 1;
  }
  return a.clinicName.localeCompare(b.clinicName) || a.id.localeCompare(b.id);
}

export type RightsReadOptions = {
  actor: ActorContext;
  request?: RequestContext;
  /** The operator's address, for the prepared commands only; never stored. */
  operator: string;
  filter?: RightsFilter;
  includeDemo?: boolean;
  now?: Date;
  /** Test seam and one clinic's page: the clinics to read instead of every clinic. */
  clinics?: readonly { id: string; name: string }[];
};

/** Every row for the filter across the clinics, ordered, with no limit: the list's and the watch's one read. */
export async function collectRights(options: RightsReadOptions): Promise<{ rows: RightsRow[]; unreadClinics: number }> {
  const filter = options.filter ?? "open";
  const today = utcDay(options.now ?? new Date());
  const clinics = options.clinics ?? (await listClinics()).map((c) => ({ id: c.id, name: c.name }));
  const found: RightsRow[] = [];
  let unreadClinics = 0;
  for (const clinic of clinics) {
    try {
      const read = await withTenant(
        { clinicId: clinic.id, actor: options.actor, request: options.request },
        async (tx) => {
          if (!options.includeDemo && (await isDemoClinic(tx))) return null;
          return readClinic(tx, filter);
        },
      );
      if (!read) continue;
      for (const row of clinicRows(clinic, read, today, options.operator)) {
        if (keep(row, filter)) found.push(row);
      }
    } catch (error) {
      unreadClinics += 1;
      log.error("rights tracker: a clinic could not be read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  found.sort(order);
  return { rows: found, unreadClinics };
}

export async function listRights(options: RightsReadOptions & { limit?: number }): Promise<RightsList> {
  const limit = Math.min(Math.max(1, options.limit ?? RIGHTS_LIST_DEFAULT), RIGHTS_LIST_MAX);
  const { rows, unreadClinics } = await collectRights(options);
  return { rows: rows.slice(0, limit), count: rows.length, truncated: rows.length > limit, unreadClinics };
}

// -----------------------------------------------------------------------------
// The writes: record and close, in the clinic's tenant
// -----------------------------------------------------------------------------

export type RecordIntakeInput = {
  /** The form's own key, generated once when it opened: the idempotency key. */
  requestKey: string;
  kind: RightsKind;
  receivedOn: string;
  verifiedVia: RightsVerification;
  askedFor: PatientRequestKind | null;
  linkedRecordId: string | null;
  recordedBy: string;
};

export type RecordIntakeOutcome =
  | { outcome: "recorded" | "already_recorded"; id: string; dueOn: string }
  | { outcome: "not_found" }
  /** The linked patient request asked for something other than `askedFor`. */
  | { outcome: "asked_for_mismatch" };

/**
 * The record an intake names, if it is this clinic's and of the kind's
 * table (RLS hides every other clinic's): for a patient request, with what
 * it asked for, so an intake cannot name one of another kind.
 */
async function linkedRecord(
  tx: TenantTx,
  kind: RightsKind,
  recordId: string,
): Promise<{ askedFor: PatientRequestKind | null } | null> {
  const target = LINKABLE[kind];
  if (target === "erasure_request") {
    return (await listErasureRequests(tx)).some((r) => r.id === recordId) ? { askedFor: null } : null;
  }
  if (target === "record_amendment") {
    const [row] = await tx.db
      .select({ id: recordAmendments.id })
      .from(recordAmendments)
      .where(and(eq(recordAmendments.clinicId, tx.clinicId), eq(recordAmendments.id, recordId)))
      .limit(1);
    return row ? { askedFor: null } : null;
  }
  if (target === "patient_request") {
    const [row] = await tx.db
      .select({ kind: patientRequests.kind })
      .from(patientRequests)
      .where(and(eq(patientRequests.clinicId, tx.clinicId), eq(patientRequests.id, recordId)))
      .limit(1);
    return row ? { askedFor: row.kind } : null;
  }
  return null;
}

/**
 * Record one intake, once per request key: the same key again returns the
 * first (`already_recorded`), changing nothing, while two people's requests
 * of one kind on one day, under two keys, are two rows. A record already
 * named by another intake returns that intake too, since one record came
 * from one request. The due day comes from the kind's clock. The audit row carries
 * the kind, how it was verified and whether it names a record: no date
 * (the audit's number check reads a date as digits) and nothing typed.
 */
export async function recordIntake(tx: TenantTx, input: RecordIntakeInput): Promise<RecordIntakeOutcome> {
  if (input.linkedRecordId) {
    const record = await linkedRecord(tx, input.kind, input.linkedRecordId);
    if (!record) return { outcome: "not_found" };
    if (input.kind === "patient_request" && record.askedFor !== input.askedFor) return { outcome: "asked_for_mismatch" };
  }
  const dueOn = dueOnFor(input.kind, input.receivedOn);
  const [inserted] = await tx.db
    .insert(rightsIntakes)
    .values({
      clinicId: tx.clinicId,
      requestKey: input.requestKey,
      kind: input.kind,
      askedFor: input.askedFor,
      receivedOn: input.receivedOn,
      verifiedVia: input.verifiedVia,
      dueOn,
      linkedRecordId: input.linkedRecordId,
      recordedBy: input.recordedBy,
    })
    // Either unique: rights_intakes_request_key (clinic, key) or
    // rights_intakes_linked_key (clinic, kind, linked record).
    .onConflictDoNothing()
    .returning({ id: rightsIntakes.id, dueOn: rightsIntakes.dueOn });
  if (inserted) {
    tx.audit.record({
      action: "create",
      resourceType: "rights_intake",
      resourceId: inserted.id,
      resourceIds: input.linkedRecordId ? [inserted.id, input.linkedRecordId] : [inserted.id],
      metadata: { kind: input.kind, verifiedVia: input.verifiedVia, linked: input.linkedRecordId !== null },
    });
    return { outcome: "recorded", id: inserted.id, dueOn: inserted.dueOn };
  }
  const [existing] = await tx.db
    .select({ id: rightsIntakes.id, dueOn: rightsIntakes.dueOn })
    .from(rightsIntakes)
    .where(
      and(
        eq(rightsIntakes.clinicId, tx.clinicId),
        input.linkedRecordId
          ? sql`(${rightsIntakes.requestKey} = ${input.requestKey}
                 or (${rightsIntakes.kind} = ${input.kind} and ${rightsIntakes.linkedRecordId} = ${input.linkedRecordId}))`
          : eq(rightsIntakes.requestKey, input.requestKey),
      ),
    )
    .orderBy(sql`${rightsIntakes.requestKey} = ${input.requestKey} desc`)
    .limit(1);
  if (!existing) throw new Error("The intake was neither recorded nor found.");
  return { outcome: "already_recorded", id: existing.id, dueOn: existing.dueOn };
}

export type CloseIntakeOutcome =
  | { outcome: "closed"; status: Exclude<RightsStatus, "open"> }
  | { outcome: "already_closed"; status: Exclude<RightsStatus, "open"> }
  | { outcome: "not_found" }
  /** It names a deletion whose Retell step is not stamped: closing it would hide that step. */
  | { outcome: "retell_outstanding" };

/** What closeRightsIntake says when the deletion an intake names still owes its Retell step. */
export const RETELL_OUTSTANDING = "The deletion at Retell is not recorded yet";

/**
 * Close an open intake as done or not applicable, once; a closed one is left
 * as it is. Refused for an intake that names a deletion whose subcontractor
 * step is not stamped: the deletion is done only once Retell's copy is, and
 * that is recorded on the clinic's Care tab. An intake that names a patient's
 * request may close: its row stays on the list, open, until the practice
 * marks the request received, and the L32 sweep keeps chasing it.
 */
export async function closeIntake(
  tx: TenantTx,
  input: { id: string; status: Exclude<RightsStatus, "open"> },
): Promise<CloseIntakeOutcome> {
  const [row] = await tx.db
    .select({ status: rightsIntakes.status, kind: rightsIntakes.kind, linkedRecordId: rightsIntakes.linkedRecordId })
    .from(rightsIntakes)
    .where(and(eq(rightsIntakes.clinicId, tx.clinicId), eq(rightsIntakes.id, input.id)))
    .for("update")
    .limit(1);
  if (!row) return { outcome: "not_found" };
  if (row.status !== "open") return { outcome: "already_closed", status: row.status };
  if (row.kind === "erasure" && row.linkedRecordId) {
    const erasure = (await listErasureRequests(tx)).find((r) => r.id === row.linkedRecordId);
    if (erasure && !erasure.steps.every((step) => step.stamp !== null)) return { outcome: "retell_outstanding" };
  }
  // closed_at is the database's clock (rights_intakes_guard).
  await tx.db
    .update(rightsIntakes)
    .set({ status: input.status, closedAt: sql`clock_timestamp()` })
    .where(and(eq(rightsIntakes.clinicId, tx.clinicId), eq(rightsIntakes.id, input.id)));
  tx.audit.record({
    action: "update",
    resourceType: "rights_intake",
    resourceId: input.id,
    metadata: { status: input.status },
  });
  return { outcome: "closed", status: input.status };
}

/** A blocked request's fixed sentence, re-exported for the alerts and the inbox. */
export { NO_ROUTE };
