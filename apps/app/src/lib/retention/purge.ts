import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  appointments,
  clinics,
  contacts,
  conversations,
  reconciliationExceptions,
  suppressions,
  syncRuns,
  transactions,
  webhookEvents,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Retention: the delete the agreements already promise.
 *
 * Until this existed nothing in the product deleted anything. Every
 * conversation, transcript reference and appointment accumulated for as long
 * as the database did, which meant a breach in year five disclosed five years
 * of calls instead of two, and the BAA's "return or destroy" clause had no
 * code behind it.
 *
 * ## Two clocks, per clinic
 *
 * `clinics.retention_media_days` (default 90) removes the transcript and
 * recording REFERENCES from a conversation. The audio itself lives with the
 * voice vendor under its own retention setting, which must be at most this
 * window and is verified in the vendor console (docs/hipaa-risk-analysis.md
 * T5). Nulling the reference here is what stops the product from ever
 * pointing at it again; it is not, and does not claim to be, the deletion of
 * the bytes.
 *
 * `clinics.retention_record_days` (default 730) deletes the conversation,
 * appointment and transaction rows themselves, and then any contact that no
 * longer has a row of any kind. Two years is what a year-over-year revenue
 * report needs and no more.
 *
 * ## What is never purged, and why
 *
 * `consent_records`, `suppressions` and `contact_attempts` are the evidence
 * that an outbound call was lawful and that "stop" was honoured. The TCPA's
 * limitation period is four years and an opt-out is honoured forever, so
 * deleting these would be destroying the defence, not protecting anyone.
 * `audit_log` is append-only by grant. `baa_acceptances` has its own
 * six-year floor (0025) and is never swept by anything.
 *
 * ## Tenant isolation is the API, not a check
 *
 * Every function here takes a `TenantTx`: it cannot be called without a
 * tenant transaction, and inside one RLS scopes every statement to that
 * clinic. tests/retention.test.ts asserts both that a purge leaves the other
 * clinic untouched and that the same statements with no tenant set delete
 * nothing at all.
 */

export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 30;

export type PurgeResult = {
  clinicId: string;
  skipped: "sync_running" | null;
  mediaCleared: number;
  transactionsDeleted: number;
  appointmentsDeleted: number;
  conversationsDeleted: number;
  contactsDeleted: number;
  webhookEventsDeleted: number;
};

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * One clinic, one transaction, on its own two clocks.
 *
 * Refuses to touch a clinic with a sync run in flight: the reconciler joins
 * appointments to transactions, and deleting one side of a pair it is about
 * to match creates the very exception the report then has to explain.
 */
export async function purgeClinic(tx: TenantTx, now: Date = new Date()): Promise<PurgeResult> {
  const result: PurgeResult = {
    clinicId: tx.clinicId,
    skipped: null,
    mediaCleared: 0,
    transactionsDeleted: 0,
    appointmentsDeleted: 0,
    conversationsDeleted: 0,
    contactsDeleted: 0,
    webhookEventsDeleted: 0,
  };

  const [running] = await tx.db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.clinicId, tx.clinicId), eq(syncRuns.status, "running")))
    .limit(1);
  if (running) {
    result.skipped = "sync_running";
    return result;
  }

  const [clinic] = await tx.db
    .select({
      mediaDays: clinics.retentionMediaDays,
      recordDays: clinics.retentionRecordDays,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return result;

  const mediaBefore = daysAgo(now, clinic.mediaDays);
  const recordBefore = daysAgo(now, clinic.recordDays);

  // 1. Media references.
  const cleared = await tx.db
    .update(conversations)
    .set({ transcriptUri: null, recordingUri: null })
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        lt(conversations.startedAt, mediaBefore),
        or(sql`${conversations.transcriptUri} is not null`, sql`${conversations.recordingUri} is not null`),
      ),
    )
    .returning({ id: conversations.id });
  result.mediaCleared = cleared.length;

  // 2. Records, children first. Exceptions reference transactions and
  //    appointments; they go with the rows they were about.
  const oldTransactions = await tx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.clinicId, tx.clinicId), lt(transactions.collectedAt, recordBefore)));
  const oldAppointments = await tx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.clinicId, tx.clinicId), lt(appointments.scheduledFor, recordBefore)));
  const transactionIds = oldTransactions.map((r) => r.id);
  const appointmentIds = oldAppointments.map((r) => r.id);

  if (transactionIds.length || appointmentIds.length) {
    await tx.db.delete(reconciliationExceptions).where(
      and(
        eq(reconciliationExceptions.clinicId, tx.clinicId),
        or(
          transactionIds.length
            ? inArray(reconciliationExceptions.transactionId, transactionIds)
            : sql`false`,
          appointmentIds.length
            ? inArray(reconciliationExceptions.appointmentId, appointmentIds)
            : sql`false`,
        ),
      ),
    );
  }
  if (transactionIds.length) {
    const gone = await tx.db
      .delete(transactions)
      .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.id, transactionIds)))
      .returning({ id: transactions.id });
    result.transactionsDeleted = gone.length;
  }
  if (appointmentIds.length) {
    // A newer transaction may still point at an old appointment; detach it
    // rather than lose the money event.
    await tx.db
      .update(transactions)
      .set({ appointmentId: null })
      .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.appointmentId, appointmentIds)));
    const gone = await tx.db
      .delete(appointments)
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.id, appointmentIds)))
      .returning({ id: appointments.id });
    result.appointmentsDeleted = gone.length;
  }

  const oldConversations = await tx.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.clinicId, tx.clinicId), lt(conversations.startedAt, recordBefore)));
  const conversationIds = oldConversations.map((r) => r.id);
  if (conversationIds.length) {
    await tx.db
      .update(appointments)
      .set({ conversationId: null })
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.conversationId, conversationIds)));
    const gone = await tx.db
      .delete(conversations)
      .where(and(eq(conversations.clinicId, tx.clinicId), inArray(conversations.id, conversationIds)))
      .returning({ id: conversations.id });
    result.conversationsDeleted = gone.length;
  }

  // 3. Contacts nothing refers to any more, and that are themselves old.
  const orphaned = await tx.db
    .delete(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        lt(contacts.updatedAt, recordBefore),
        sql`not exists (select 1 from ${conversations} c where c.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${appointments} a where a.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${transactions} t where t.contact_id = ${contacts.id})`,
      ),
    )
    .returning({ id: contacts.id });
  result.contactsDeleted = orphaned.length;

  // 4. Processed vendor payloads: raw bodies, PHI by the migration's own
  //    admission, and useless once processed.
  const payloads = await tx.db
    .delete(webhookEvents)
    .where(
      and(
        eq(webhookEvents.clinicId, tx.clinicId),
        sql`${webhookEvents.processedAt} is not null`,
        lt(webhookEvents.receivedAt, daysAgo(now, WEBHOOK_PAYLOAD_RETENTION_DAYS)),
      ),
    )
    .returning({ id: webhookEvents.id });
  result.webhookEventsDeleted = payloads.length;

  // The audit row says what kind and how many — never which person.
  const total =
    result.mediaCleared +
    result.transactionsDeleted +
    result.appointmentsDeleted +
    result.conversationsDeleted +
    result.contactsDeleted +
    result.webhookEventsDeleted;
  if (total > 0) {
    tx.audit.record({
      action: "delete",
      resourceType: "retention_purge",
      resultCount: total,
      metadata: {
        mediaCleared: result.mediaCleared,
        transactions: result.transactionsDeleted,
        appointments: result.appointmentsDeleted,
        conversations: result.conversationsDeleted,
        contacts: result.contactsDeleted,
        webhookEvents: result.webhookEventsDeleted,
        mediaDays: clinic.mediaDays,
        recordDays: clinic.recordDays,
      },
    });
  }

  return result;
}

export type ErasureRequest = {
  /** E.164, as stored on contacts.phone. */
  phone?: string;
  /** Lower-cased. */
  email?: string;
  /** Who asked, for the audit row: "patient", "clinic", or a ticket id. */
  requestedBy: string;
};

export type ErasureResult = {
  contactsMatched: number;
  conversationsDeleted: number;
  appointmentsDeleted: number;
  transactionsDeleted: number;
  suppressed: boolean;
};

/**
 * The single-patient path: "delete everything you hold about me".
 *
 * Deletes, not de-identifies: a conversation row with the contact detached
 * still carries a treatment interest and a time, which is a re-identification
 * waiting for a join. What remains afterwards is a suppression row for the
 * phone number — deliberately. The number is kept so the request itself is
 * honoured forever; keeping it is what the law expects of a do-not-contact
 * list, and it is the one thing an erasure must not erase.
 */
export async function eraseContact(tx: TenantTx, request: ErasureRequest): Promise<ErasureResult> {
  if (!request.phone && !request.email) {
    throw new Error("An erasure request needs a phone number or an email address.");
  }

  const matches = await tx.db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        or(
          request.phone ? eq(contacts.phone, request.phone) : sql`false`,
          request.email ? eq(contacts.email, request.email) : sql`false`,
        ),
      ),
    );
  const ids = matches.map((m) => m.id);
  const result: ErasureResult = {
    contactsMatched: ids.length,
    conversationsDeleted: 0,
    appointmentsDeleted: 0,
    transactionsDeleted: 0,
    suppressed: false,
  };

  if (ids.length) {
    const theirTransactions = await tx.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.contactId, ids)));
    const theirAppointments = await tx.db
      .select({ id: appointments.id, conversationId: appointments.conversationId })
      .from(appointments)
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.contactId, ids)));
    const tIds = theirTransactions.map((r) => r.id);
    const aIds = theirAppointments.map((r) => r.id);
    const theirAppointmentConversations = theirAppointments
      .map((r) => r.conversationId)
      .filter((id): id is string => id !== null);

    if (tIds.length || aIds.length) {
      await tx.db.delete(reconciliationExceptions).where(
        and(
          eq(reconciliationExceptions.clinicId, tx.clinicId),
          or(
            tIds.length ? inArray(reconciliationExceptions.transactionId, tIds) : sql`false`,
            aIds.length ? inArray(reconciliationExceptions.appointmentId, aIds) : sql`false`,
          ),
        ),
      );
    }
    if (tIds.length) {
      const gone = await tx.db
        .delete(transactions)
        .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.id, tIds)))
        .returning({ id: transactions.id });
      result.transactionsDeleted = gone.length;
    }
    if (aIds.length) {
      const gone = await tx.db
        .delete(appointments)
        .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.id, aIds)))
        .returning({ id: appointments.id });
      result.appointmentsDeleted = gone.length;
    }
    // Their conversations: the ones tied to them directly, and the ones
    // that produced their appointments — a call that led to a booking is
    // about the person who booked, whether or not the caller was matched.
    const viaAppointments = theirAppointmentConversations;
    const convos = await tx.db
      .delete(conversations)
      .where(
        and(
          eq(conversations.clinicId, tx.clinicId),
          or(
            inArray(conversations.contactId, ids),
            viaAppointments.length ? inArray(conversations.id, viaAppointments) : sql`false`,
          ),
        ),
      )
      .returning({ id: conversations.id });
    result.conversationsDeleted = convos.length;

    await tx.db
      .delete(contacts)
      .where(and(eq(contacts.clinicId, tx.clinicId), inArray(contacts.id, ids)));
  }

  // The do-not-contact row outlives the erasure, on purpose.
  const phone = request.phone ?? matches.find((m) => m.phone)?.phone ?? null;
  if (phone) {
    const [existing] = await tx.db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.clinicId, tx.clinicId), eq(suppressions.phone, phone), isNull(suppressions.channel)))
      .limit(1);
    if (!existing) {
      await tx.db.insert(suppressions).values({
        clinicId: tx.clinicId,
        phone,
        channel: null,
        reason: "erasure_request",
        note: `Erasure requested by ${request.requestedBy}`,
      });
    }
    result.suppressed = true;
  }

  tx.audit.record({
    action: "delete",
    resourceType: "contact_erasure",
    resourceIds: ids,
    resultCount: ids.length,
    metadata: {
      requestedBy: request.requestedBy,
      conversations: result.conversationsDeleted,
      appointments: result.appointmentsDeleted,
      transactions: result.transactionsDeleted,
      suppressed: result.suppressed,
    },
  });

  return result;
}
