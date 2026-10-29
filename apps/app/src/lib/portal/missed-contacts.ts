import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { answerOutages, missedContacts, type MissedContact } from "@/db/schema";
import { MISSED_CONTACT_RETENTION_DAYS, type MissedOutcome } from "@/lib/channels/routed-words";
import type { TenantTx } from "@/lib/tenant";

import { logPatientAccess, withPatientPage, type PatientPage, type PatientTx } from "./patient-page";

/**
 * The practice's side of the 30-day missed-contact record (missed_contacts;
 * lib/channels/routed-answered.ts writes it): each call or chat routed to
 * AYA that she did not answer, so the clinic can follow up.
 *
 *   - **Home's card** (`readAnswerAttention`): whether an outage is open and
 *     how many missed contacts nobody has ticked as called back. Counts, so
 *     Home needs no step-up; the link goes to the list, which does.
 *   - **The list** (`readMissedContacts`, /c/[slug]/missed) and **one**
 *     (`readMissedContact`, /c/[slug]/missed/[id]): when, which channel,
 *     where it went, the caller's number when it was known, the "Called back"
 *     tick and the owner's closing note, behind the passkey step-up, every
 *     open writing its access-log row naming the passkey.
 *   - **Called back** (`markCalledBack`): the clinic's tick, once, from the
 *     device whose passkey stepped up, audited with its passkey and step-up.
 */

const DAY_MS = 86_400_000;
const LISTED = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The 30 days (owner, 29 October 2026): every missed contact of the clinic
 * `tx` is scoped to whose miss is more than MISSED_CONTACT_RETENTION_DAYS
 * old is deleted. Run by the routed/answered minute sweep, which no switch
 * turns off, and by the nightly retention purge. Returns how many went.
 */
export async function purgeMissedContacts(tx: TenantTx, now: Date = new Date()): Promise<number> {
  const rows = await tx.db
    .delete(missedContacts)
    .where(
      and(
        eq(missedContacts.clinicId, tx.clinicId),
        lt(missedContacts.missedAt, new Date(now.getTime() - MISSED_CONTACT_RETENTION_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: missedContacts.id });
  return rows.length;
}

export type AnswerAttention = { outageOpen: boolean; notCalledBack: number };

/** Home's card: an open outage, and the missed contacts still to call back. Counts only. */
export async function readAnswerAttention(tx: TenantTx, now: Date = new Date()): Promise<AnswerAttention> {
  const since = new Date(now.getTime() - MISSED_CONTACT_RETENTION_DAYS * DAY_MS);
  const [open] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(answerOutages)
    .where(and(eq(answerOutages.clinicId, tx.clinicId), eq(answerOutages.status, "open")));
  const [waiting] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(missedContacts)
    .where(and(eq(missedContacts.clinicId, tx.clinicId), isNull(missedContacts.calledBackAt), gte(missedContacts.missedAt, since)));
  return { outageOpen: Number(open?.n ?? 0) > 0, notCalledBack: Number(waiting?.n ?? 0) };
}

export type MissedContactView = {
  id: string;
  channel: "voice" | "web" | "meta";
  /** ISO. */
  missedAt: string;
  outcome: MissedOutcome;
  /** ⚠️ PHI: the caller's number, E.164, when it was known. */
  callerPhone: string | null;
  /** ISO, once the clinic ticked it. */
  calledBackAt: string | null;
  /** The owner's one or two lines, once the miss was explained. */
  closingNote: string | null;
};

function view(row: MissedContact): MissedContactView {
  return {
    id: row.id,
    channel: row.channel,
    missedAt: row.missedAt.toISOString(),
    outcome: row.outcome,
    callerPhone: row.callerPhone,
    calledBackAt: row.calledBackAt?.toISOString() ?? null,
    closingNote: row.closingNote,
  };
}

export function isMissedContactId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The list, newest first, the last 30 days: its access row names every record shown. */
export async function readMissedContacts(page: PatientPage, now: Date = new Date()): Promise<MissedContactView[]> {
  const since = new Date(now.getTime() - MISSED_CONTACT_RETENTION_DAYS * DAY_MS);
  return withPatientPage(page, async (tx) => {
    const rows = await tx.db
      .select()
      .from(missedContacts)
      .where(and(eq(missedContacts.clinicId, tx.clinicId), gte(missedContacts.missedAt, since)))
      .orderBy(desc(missedContacts.missedAt))
      .limit(LISTED);
    await logPatientAccess(tx, { action: "read", resourceType: "missed_contact", resourceIds: rows.map((r) => r.id) });
    return rows.map(view);
  });
}

async function findMissedContact(tx: PatientTx, id: string): Promise<MissedContact | null> {
  const [row] = await tx.db
    .select()
    .from(missedContacts)
    .where(and(eq(missedContacts.clinicId, tx.clinicId), eq(missedContacts.id, id)))
    .limit(1);
  return row ?? null;
}

/** One, opened, with its access row. An id this clinic does not hold is null, its open logged all the same. */
export async function readMissedContact(page: PatientPage, id: string): Promise<MissedContactView | null> {
  if (!isMissedContactId(id)) return null;
  return withPatientPage(page, async (tx) => {
    await logPatientAccess(tx, { action: "read", resourceType: "missed_contact", resourceId: id });
    const row = await findMissedContact(tx, id);
    return row ? view(row) : null;
  });
}

export type CalledBackOutcome = { status: "marked" | "already" | "not_found" };

/** The clinic's "Called back" tick, inside withPatientPage, once. */
export async function markCalledBack(tx: PatientTx, id: string, now: Date = new Date()): Promise<CalledBackOutcome> {
  if (!isMissedContactId(id)) return { status: "not_found" };
  await logPatientAccess(tx, { action: "read", resourceType: "missed_contact", resourceId: id });
  const row = await findMissedContact(tx, id);
  if (!row) return { status: "not_found" };
  if (row.calledBackAt) return { status: "already" };
  await tx.db
    .update(missedContacts)
    .set({ calledBackAt: now })
    .where(and(eq(missedContacts.clinicId, tx.clinicId), eq(missedContacts.id, id), isNull(missedContacts.calledBackAt)));
  tx.audit.record({
    action: "update",
    resourceType: "missed_contact",
    resourceId: id,
    metadata: { outcome: "called_back", passkeyId: tx.page.stepUp.passkeyId, stepUpId: tx.page.stepUp.stepUpId },
  });
  return { status: "marked" };
}
