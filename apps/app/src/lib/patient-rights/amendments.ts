import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  conversations,
  recordAmendments,
  type AmendmentTargetKind,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Amendments to the records that must stay as they were made.
 *
 * BAA 1.3.0's clause 14(b), and the DPA's Clients' requests clause in its own
 * words: healdesk incorporates any amendment Practice directs. Where the
 * record can be changed, healdesk corrects its own copy (`amendContact` in
 * ./export.ts, for a contact's name, number or address, each of which can
 * also be cleared). Where a record must stay as it was made, such as a
 * booking request or the record of a conversation, healdesk appends the
 * amendment to it and links the two, as 45 CFR 164.526(c)(1) provides, and
 * every later use and export of that record then carries the amendment. An
 * appointment takes an amendment too: it is the booking as the clinic's
 * calendar holds it, which a sync or a reschedule may move, so a correction
 * of its service, practitioner or time is appended beside it rather than
 * written over the calendar's. Release gate 8 (PT-17) is this file and
 * `record_amendments` (drizzle/0060).
 *
 * A booking request's facts never change (the no-rewrite trigger, 0039 and
 * 0041), and a conversation is the record of what was said, so neither is
 * edited: the amendment is a row of its own, pointing at the record by a
 * foreign key that also carries the clinic, so it can only ever point at a
 * record of the same clinic. The runtime role may add one and read them, and
 * nothing else: no role may change one once written (a trigger), and one
 * leaves only with the record it amends, through the functions that delete
 * those records (erasure, the purge, destruction; drizzle/0060).
 *
 * Who writes them:
 *
 *   - the operator, on Practice's direction, through the signed ops envelope
 *     (`amendRecord` in lib/ops/api.ts; docs/handover.md, "Amendments");
 *   - the clinic portal, with M5. Its path calls `appendAmendment` inside the
 *     clinic's own tenant with the member as `recordedBy`, and it must show
 *     the amendments beside each record wherever the portal shows or exports
 *     that record, as `exportPatient` and `exportClinic` do here: the clause
 *     promises that every later use carries them.
 *
 * The amendment's text is Practice's words about a patient, so it is PHI: it
 * is stored here and nowhere else, never written to the audit trail or a
 * log line, and never sent back to the console that wrote it.
 */

/** The longest amendment accepted, in characters: a paragraph, not a document. */
export const AMENDMENT_MAX_LENGTH = 4000;

export type AmendmentTarget = { kind: AmendmentTargetKind; id: string };

export type AppendAmendmentInput = {
  target: AmendmentTarget;
  /** The amendment as Practice directed it. */
  amendment: string;
  /** Who asked, by role or ticket ("the practice, ticket 1182"); never the patient. */
  requestedBy: string;
  /**
   * When Practice directed it. Omitted, now; a moment later than the
   * database's clock counts as now.
   */
  requestedAt?: Date;
  /** Who appended it: the operator's address, or (M5) the portal member. */
  recordedBy: string;
};

export type AppendAmendmentOutcome =
  { status: "appended"; id: string; recordedAt: Date } | { status: "not_found" };

function tableOf(kind: AmendmentTargetKind) {
  if (kind === "booking_request") return bookingRequests;
  if (kind === "appointment") return appointments;
  return conversations;
}

function columnOf(kind: AmendmentTargetKind) {
  if (kind === "booking_request") return recordAmendments.bookingRequestId;
  if (kind === "appointment") return recordAmendments.appointmentId;
  return recordAmendments.conversationId;
}

function targetIdOf(kind: AmendmentTargetKind, row: RecordAmendment): string | null {
  if (kind === "booking_request") return row.bookingRequestId;
  if (kind === "appointment") return row.appointmentId;
  return row.conversationId;
}

/** Whether the record exists inside this tenant. RLS hides every other clinic's. */
async function targetExists(tx: TenantTx, target: AmendmentTarget): Promise<boolean> {
  const table = tableOf(target.kind);
  const [row] = await tx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.clinicId, tx.clinicId), eq(table.id, target.id)))
    .limit(1);
  return Boolean(row);
}

/**
 * Append one amendment to one record of this clinic. "not_found" for a record
 * this tenant does not hold, another clinic's included; the composite foreign
 * key refuses one all the same if anything gets past this read.
 */
export async function appendAmendment(
  tx: TenantTx,
  input: AppendAmendmentInput,
): Promise<AppendAmendmentOutcome> {
  const amendment = input.amendment.trim();
  if (!amendment) throw new Error("An amendment needs its text.");
  if (amendment.length > AMENDMENT_MAX_LENGTH) {
    throw new Error(`An amendment is at most ${AMENDMENT_MAX_LENGTH} characters.`);
  }
  if (!(await targetExists(tx, input.target))) return { status: "not_found" };

  const requestedAt = input.requestedAt
    ? sql`least(${input.requestedAt.toISOString()}::timestamptz, clock_timestamp())`
    : sql`clock_timestamp()`;
  const [row] = await tx.db
    .insert(recordAmendments)
    .values({
      clinicId: tx.clinicId,
      targetKind: input.target.kind,
      bookingRequestId: input.target.kind === "booking_request" ? input.target.id : null,
      conversationId: input.target.kind === "conversation" ? input.target.id : null,
      appointmentId: input.target.kind === "appointment" ? input.target.id : null,
      amendment,
      requestedBy: input.requestedBy,
      requestedAt,
      recordedBy: input.recordedBy,
    })
    .returning({ id: recordAmendments.id, recordedAt: recordAmendments.recordedAt });
  if (!row) throw new Error("The amendment was not recorded.");

  // The accounting of disclosures finds it by the record it amends; the text
  // stays out of the audit trail.
  tx.audit.record({
    action: "create",
    resourceType: "record_amendment",
    resourceId: row.id,
    resourceIds: [row.id, input.target.id],
    metadata: { requestedBy: input.requestedBy, targetKind: input.target.kind },
  });
  return { status: "appended", id: row.id, recordedAt: row.recordedAt };
}

export type RecordAmendment = typeof recordAmendments.$inferSelect;

/**
 * The amendments of the given records of one kind, oldest first, by the id
 * of the record each amends. What an export, or any later use, puts beside
 * the record.
 */
export async function amendmentsFor(
  tx: TenantTx,
  kind: AmendmentTargetKind,
  ids: readonly string[],
): Promise<Map<string, RecordAmendment[]>> {
  const out = new Map<string, RecordAmendment[]>();
  if (ids.length === 0) return out;
  const column = columnOf(kind);
  const rows = await tx.db
    .select()
    .from(recordAmendments)
    .where(
      and(
        eq(recordAmendments.clinicId, tx.clinicId),
        eq(recordAmendments.targetKind, kind),
        inArray(column, [...ids]),
      ),
    )
    .orderBy(asc(recordAmendments.recordedAt), asc(recordAmendments.id));
  for (const row of rows) {
    const id = targetIdOf(kind, row)!;
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  }
  return out;
}

/** Each row with its amendments beside it: an empty list for a record nothing amends. */
export function withAmendments<T extends { id: string }>(
  rows: readonly T[],
  amendments: ReadonlyMap<string, RecordAmendment[]>,
): (T & { amendments: RecordAmendment[] })[] {
  return rows.map((row) => ({ ...row, amendments: amendments.get(row.id) ?? [] }));
}
