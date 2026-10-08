import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  clinics,
  contacts,
  conversations,
  metaBookingDrafts,
  reconciliationExceptions,
  suppressions,
  syncRuns,
  transactions,
  webhookEvents,
} from "@/db/schema";
import { DRAFT_TTL_HOURS } from "@/lib/meta/booking-requests";
import type { TenantTx } from "@/lib/tenant";

/**
 * Retention: the delete the agreements already promise.
 *
 * Until this existed nothing in the product deleted anything. Every
 * conversation, transcript reference and appointment accumulated for as long
 * as the database did, which meant a breach in year five disclosed five years
 * of calls instead of the last ninety days, and the BAA's "return or destroy"
 * clause had no code behind it.
 *
 * ## Two clocks, per clinic
 *
 * `clinics.retention_media_days` (default 90) removes the transcript
 * REFERENCE from a conversation. No audio is kept anywhere (decision of
 * 21 September 2026; the vendor's recording storage is off in its console,
 * docs/hipaa-risk-analysis.md T5). The transcript text itself lives with the
 * voice vendor under its own retention setting, which must be at most this
 * window. Nulling the reference here is what stops the product from ever
 * pointing at it again; it is not, and does not claim to be, the deletion of
 * the bytes.
 *
 * `clinics.retention_record_days` (default 90) deletes the conversation,
 * appointment, booking request and transaction rows themselves, and then any
 * contact that no longer has a row of any kind. 90 days because the BAA says
 * "healdesk keeps transcripts and conversation records for 90 days, which
 * Practice may shorten in its portal" (TRANSCRIPT_RETENTION_DAYS in
 * @healdesk/catalog). Until 0048 the default was 730, for a year-over-year
 * revenue report that is phase two, so every clinic left at the default kept
 * its records eight times as long as its agreement said.
 *
 * A booking request goes once every date it carries is past the clock: when
 * it was made, the slot it was confirmed for, and its appointment's time.
 * Requests lead the deletes because a confirmed one must keep its appointment
 * (CHECK, 0039) and cannot be rewritten (trigger, 0041), and the runtime role
 * has no DELETE on them, so app_purge_booking_requests() deletes them. It
 * judges a request by its first two dates, which are frozen once it is
 * decided, as well as the third, which the runtime role and a sync can move,
 * so no booking still ahead loses its request. It refuses a cutoff later than
 * the record clock in force by the database's clock (app_record_cutoff(): for
 * a day after the clock is shortened, the longer clock it replaced), so the
 * clock cannot be shortened, used and put back in one go. An appointment a
 * remaining request still holds waits for the night the request goes. A Meta
 * draft abandoned for a day goes here too, as a backstop to the sweep the
 * clinic's next Meta message runs.
 *
 * ## What the record clock never purges, and why
 *
 * `consent_records`, `suppressions` and `contact_attempts` are not on the
 * record clock. A suppression is a person's "stop", or the record that their
 * information was erased (eraseContact below), and has to outlast the rows it
 * stopped; all three are append-only by grant (0010). None of them stays for
 * good, though: they go with the rest of the clinic's data when it is
 * destroyed at offboarding (destroyClinicData in lib/offboarding, through
 * app_destroy_contact_evidence, drizzle/0058). They were kept past that as
 * the TCPA evidence that an outbound contact was lawful, but v1 contacts no
 * one first, so there is nothing for them to evidence, and every agreement's
 * return-or-destroy clause reaches them (BAA 1.3.0 release gate 7).
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
  bookingRequestsDeleted: number;
  transactionsDeleted: number;
  appointmentsDeleted: number;
  conversationsDeleted: number;
  contactsDeleted: number;
  draftsDeleted: number;
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
    bookingRequestsDeleted: 0,
    transactionsDeleted: 0,
    appointmentsDeleted: 0,
    conversationsDeleted: 0,
    contactsDeleted: 0,
    draftsDeleted: 0,
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
    .set({ transcriptUri: null })
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        lt(conversations.startedAt, mediaBefore),
        sql`${conversations.transcriptUri} is not null`,
      ),
    )
    .returning({ id: conversations.id });
  result.mediaCleared = cleared.length;

  // 2. Records, children first. Booking requests lead: one that produced an
  //    appointment holds it, so it goes before it, once its own dates and
  //    its appointment's are all past the clock. Through
  //    app_purge_booking_requests(), as the app role has no DELETE on them,
  //    at the earlier of this job's cutoff and the database's own
  //    (app_record_cutoff(), the record clock in force), in one statement:
  //    the function refuses anything later, so a job clock running ahead of
  //    the database's must not reach it.
  const requests = await tx.db.execute<{ n: number }>(
    sql`select app_purge_booking_requests(least(${recordBefore}::timestamptz, app_record_cutoff())) as n`,
  );
  result.bookingRequestsDeleted = requests.rows[0]?.n ?? 0;

  // Exceptions reference transactions and appointments; they go with the
  // rows they were about.
  const oldTransactions = await tx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.clinicId, tx.clinicId), lt(transactions.collectedAt, recordBefore)));
  // An appointment a remaining request still holds stays until the request
  // goes. Its time can sit before the request's own dates (a sync from the
  // clinic's system writes scheduled_for, lib/sync/upsert.ts), and deleting
  // it would fail the request's foreign key and the whole night's purge.
  const oldAppointments = await tx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        lt(appointments.scheduledFor, recordBefore),
        sql`not exists (select 1 from ${bookingRequests} r where r.appointment_id = ${appointments.id})`,
      ),
    );
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

  // 3. Contacts nothing refers to any more, and that are themselves old. A
  //    request still inside the clock keeps its person: a Meta request reuses
  //    the contact without touching updated_at, and a person a request names
  //    cannot be deleted (booking_requests.contact_id is NO ACTION), so
  //    without this the delete of someone first seen a year ago who asked
  //    again yesterday would fail the whole purge.
  const orphaned = await tx.db
    .delete(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        lt(contacts.updatedAt, recordBefore),
        sql`not exists (select 1 from ${conversations} c where c.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${appointments} a where a.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${transactions} t where t.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${bookingRequests} b where b.contact_id = ${contacts.id})`,
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

  // 5. Abandoned Meta drafts: a first name and a number, "swept after a day"
  //    when the clinic's next Meta message arrives (readMetaDraft in
  //    lib/meta/booking-requests.ts). A clinic whose threads go quiet would
  //    keep them for good without this.
  const drafts = await tx.db
    .delete(metaBookingDrafts)
    .where(
      and(
        eq(metaBookingDrafts.clinicId, tx.clinicId),
        lt(metaBookingDrafts.updatedAt, new Date(now.getTime() - DRAFT_TTL_HOURS * 60 * 60 * 1000)),
      ),
    )
    .returning({ senderId: metaBookingDrafts.senderId });
  result.draftsDeleted = drafts.length;

  // The audit row says what kind and how many — never which person.
  const total =
    result.mediaCleared +
    result.bookingRequestsDeleted +
    result.transactionsDeleted +
    result.appointmentsDeleted +
    result.conversationsDeleted +
    result.contactsDeleted +
    result.draftsDeleted +
    result.webhookEventsDeleted;
  if (total > 0) {
    tx.audit.record({
      action: "delete",
      resourceType: "retention_purge",
      resultCount: total,
      metadata: {
        mediaCleared: result.mediaCleared,
        bookingRequests: result.bookingRequestsDeleted,
        transactions: result.transactionsDeleted,
        appointments: result.appointmentsDeleted,
        conversations: result.conversationsDeleted,
        contacts: result.contactsDeleted,
        drafts: result.draftsDeleted,
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
  bookingRequestsDeleted: number;
  conversationsDeleted: number;
  appointmentsDeleted: number;
  transactionsDeleted: number;
  draftsDeleted: number;
  suppressed: boolean;
};

/**
 * The single-patient path: "delete everything you hold about me".
 *
 * Deletes, not de-identifies: a conversation row with the contact detached
 * still carries a treatment interest and a time, which is a re-identification
 * waiting for a join. Their booking requests go too, whatever the desk
 * decided, as do a payment matched to one of their appointments and a
 * half-collected Meta draft carrying the number. A deleted request's id and
 * token hash are never written again (booking_request_keys). What remains
 * afterwards is a suppression row for the phone number — deliberately. The
 * number is kept so the request itself is honoured for as long as healdesk
 * holds the clinic's data; keeping it is what the law expects of a
 * do-not-contact list, and it is the one thing an erasure must not erase.
 * Destruction at offboarding takes it with everything else (lib/offboarding).
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
    bookingRequestsDeleted: 0,
    conversationsDeleted: 0,
    appointmentsDeleted: 0,
    transactionsDeleted: 0,
    draftsDeleted: 0,
    suppressed: false,
  };

  if (ids.length) {
    const theirAppointments = await tx.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.contactId, ids)));
    const aIds = theirAppointments.map((r) => r.id);
    // Their transactions: the ones tied to them, and any payment matched to
    // one of their appointments, whoever it was matched to. A payment for
    // their appointment is about them, as the call that produced it is; and
    // transactions.appointment_id has no delete action, so one left behind
    // would abort the erasure at the appointment's delete.
    const theirTransactions = await tx.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.clinicId, tx.clinicId),
          or(
            inArray(transactions.contactId, ids),
            aIds.length ? inArray(transactions.appointmentId, aIds) : sql`false`,
          ),
        ),
      );
    const tIds = theirTransactions.map((r) => r.id);

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
    // The rest goes in one call, from their booking requests down to the
    // people: their own requests, whatever the desk decided; their
    // appointments; their conversations and the ones that produced their
    // appointments (a call that led to a booking is about the person who
    // booked, whether or not the caller was matched); then the contacts. The
    // requests have to lead, because a confirmed one holds its appointment
    // (CHECK, 0039; trigger, 0041) and every one names its person (a foreign
    // key with no delete action), and the app role has no DELETE on them, so
    // app_erase_contacts() does it as their owner. It takes the people in the
    // same call and fails with nothing removed if anything else still refers
    // to them, someone else's request on one of their appointments included,
    // so a request leaves only with the person it names.
    const [erased] = (
      await tx.db.execute<{
        requests_deleted: number;
        appointments_deleted: number;
        conversations_deleted: number;
      }>(
        sql`select * from app_erase_contacts(array[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[])`,
      )
    ).rows;
    result.bookingRequestsDeleted = erased?.requests_deleted ?? 0;
    result.appointmentsDeleted = erased?.appointments_deleted ?? 0;
    result.conversationsDeleted = erased?.conversations_deleted ?? 0;
  }

  // A half-collected Meta draft has no contact, only the number typed into
  // the thread, so it is found by number whether or not a contact matched.
  const phones = [...new Set([request.phone, ...matches.map((m) => m.phone)])].filter(
    (p): p is string => Boolean(p),
  );
  if (phones.length) {
    const drafts = await tx.db
      .delete(metaBookingDrafts)
      .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), inArray(metaBookingDrafts.phone, phones)))
      .returning({ senderId: metaBookingDrafts.senderId });
    result.draftsDeleted = drafts.length;
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
      bookingRequests: result.bookingRequestsDeleted,
      conversations: result.conversationsDeleted,
      appointments: result.appointmentsDeleted,
      transactions: result.transactionsDeleted,
      drafts: result.draftsDeleted,
      suppressed: result.suppressed,
    },
  });

  return result;
}
