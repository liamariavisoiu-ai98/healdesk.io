import { BACKUP_RETENTION_DAYS } from "@healdesk/catalog";
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  chatThreads,
  consentRecords,
  contactAttempts,
  contacts,
  conversations,
  erasureRequests,
  metaBookingDrafts,
  suppressions,
  webhookEvents,
  type ErasureVendorStamp,
} from "@/db/schema";
import { identifierRef } from "@/lib/identifier-ref";
import { addBusinessDays } from "@/lib/incidents/incidents";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { eraseContact, type ErasureResult } from "@/lib/retention/purge";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { readSynthflowPayload } from "@/lib/voice/synthflow-payload";

import { REQUESTER_LABELS, type PatientRequester } from "./requesters";

/**
 * Deletion on request: one person, everywhere healdesk holds them, and a
 * record of the request that holds nothing of them.
 *
 * BAA 1.3.0's clause 4(c), and item c of the DPA's state-law clause: when the
 * practice tells healdesk to delete a person's information, healdesk deletes
 * it "within ten business days from healdesk's own records, including the raw
 * copies it keeps of what other services sent it about that person", has
 * each subcontractor that holds it delete it in time, and "keeps only a
 * record of the request, for no longer than it needs one to make sure the
 * information stays deleted". Release gate 6 (SL-06, PT-18) is this file.
 *
 * ## Who the person is
 *
 * The practice names them by telephone number, email address or both. From
 * those the deletion finds, among rows recorded no later than it runs:
 *
 *   - their numbers and addresses: the ones asked, and every number and
 *     address on a contact those match (one step, not a chain);
 *   - their contacts: every contact carrying any of those, erased whole, so
 *     no contact that shares their number keeps its row and its calls while
 *     its payloads, thread and stops go;
 *   - the messaging threads ("<platform>:<sender id>") that may be theirs:
 *     the WhatsApp id each number is (the number without its plus), the
 *     thread each of their own Meta booking requests came from, and the
 *     thread of each half-collected Meta draft carrying one of their numbers.
 *     Whoever wrote on such a thread may not be the person: a parent books
 *     for a child from the parent's own Instagram. So a thread is the
 *     person's own only when everything it sent names them (each request
 *     their contact, each draft their number or none). A thread that also
 *     booked for someone else is not theirs to delete: what it sent for
 *     others stays, with its drafts and its chat_threads row, and the result
 *     counts what was kept (`kept`), never naming anyone;
 *   - the vendor call id of each of their calls, and of each call that
 *     produced one of their appointments.
 *
 * Matching uses what the tables already hold: contacts by number and address,
 * drafts by number, chat threads by their keyed reference
 * (identifierRef("chat_party", …), lib/identifier-ref.ts), raw call payloads
 * by call id or by the number they carry. Nothing stores a new copy of the
 * number to find anyone.
 *
 * ## What goes
 *
 * `eraseContact` (lib/retention/purge.ts), for each number and address the
 * request names: the contacts, their own booking requests whatever the desk
 * decided, their appointments, their calls and the calls that produced their
 * appointments, payments matched to them, the drafts carrying their
 * number, and every amendment of the requests and calls it deletes
 * (record_amendments, lib/patient-rights/amendments.ts). A booking request
 * goes only with the person it names (app_erase_contacts, drizzle/0054): a
 * request the person sent for someone else is that person's record, and
 * stays. Then what it does not reach:
 *
 *   - the drafts on their own threads, and those threads (chat_threads);
 *   - the raw payloads other services sent about them (webhook_events): every
 *     voice payload of their calls, and any payload carrying their number or
 *     address;
 *   - their suppressions, consent records and contact attempts
 *     (app_erase_contact_evidence), so no telephone number of theirs is left.
 *
 * Slot holds that named them keep only the time, with the contact, request
 * and appointment gone from them (their foreign keys), and go with the
 * nightly purge once they have stopped blocking and are a week old, or
 * sooner on a shorter record clock (SLOT_HOLD_RETENTION_DAYS, the calendar
 * session's C12, lib/retention/purge.ts). Until then a spent hold keeps its
 * holder_ref, a plain sha256 of the call it was made on, not a keyed
 * reference: the calendar session's to change. usage_events keep the keyed
 * reference of each call and conversation, as the billing record, with
 * nothing that leads to the person.
 *
 * ## The record, and how long it lasts
 *
 * One `erasure_requests` row: who asked (one of PATIENT_REQUESTERS), when the request
 * arrived, the deadline ten business days on, when the deletion ran (the
 * database's clock), the counts, and a stamp for each subcontractor step
 * (ERASURE_VENDOR_STEPS) the operator does in the vendor's console, since
 * nothing in apps/app talks to the voice vendor yet. The ops console shows
 * each step outstanding, with the deadline, until it is stamped.
 *
 * The record's one reference to the person is `restore_refs`: keyed
 * references to the numbers, addresses and threads the deletion found. A
 * backup taken before the deletion still holds the person for up to
 * BACKUP_RETENTION_DAYS; restored, it would bring them back, and
 * `reapplyErasures` uses the references to find them in it and delete them
 * again, taking only what was recorded before the deletion ran, so anything
 * the person gave afterwards stays. Nothing else reads them, and nothing
 * reads the table to decide whether to contact anyone: v1 contacts no one
 * first, and the do-not-contact list (`suppressions`) is not written by an
 * erasure any more. `expireErasureRecords`, hourly, empties the references
 * BACKUP_RETENTION_DAYS after the deletion, when no backup that held the
 * person is left, and deletes the row then too, or, while a subcontractor
 * step is outstanding, as soon as the operator stamps it. The expiry runs in
 * the worker, which a restore keeps stopped (docs/handover.md, "Restoring"),
 * so a restore in progress keeps the references until it has used them.
 *
 * A restore to a point before the deletion takes the record back with it.
 * The `person data erased` log line, written outside the database, names
 * each request; docs/handover.md says how the records are carried over.
 */

/** The deadline: ten business days after the request reached healdesk (clause 4(c); SL-06). */
export const ERASURE_DEADLINE_BUSINESS_DAYS = 10;

/**
 * The subcontractors that can hold a person's information, each deleted in
 * the vendor's own console by the operator and stamped here. Retell holds the
 * person's calls and transcripts (no call audio is kept). Anthropic is not a
 * step: what it keeps it keeps under the exception clause 4(c) names (the
 * Subcontractors clause's abuse-detection and legal retention), and AWS holds
 * only the database and its backups, which this deletion and the backup
 * window reach. Meta is the practice's own service, not ours. A new
 * subcontractor that holds patient data is a new entry here and in the
 * erasure_requests_vendor_steps_check constraint.
 */
export const ERASURE_VENDOR_STEPS = [
  {
    id: "retell",
    label:
      "Retell (the voice vendor): delete the person's calls and transcripts in Retell's console",
  },
] as const;

export type ErasureVendorStepId = (typeof ERASURE_VENDOR_STEPS)[number]["id"];

export function isErasureVendorStep(value: unknown): value is ErasureVendorStepId {
  return ERASURE_VENDOR_STEPS.some((step) => step.id === value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one deletion removed, table by table. */
export type ErasureCounts = {
  contacts: number;
  /** The people's own requests, whatever the desk decided. */
  bookingRequests: number;
  appointments: number;
  conversations: number;
  transactions: number;
  drafts: number;
  chatThreads: number;
  webhookEvents: number;
  suppressions: number;
  consentRecords: number;
  contactAttempts: number;
  /** Amendments of the requests and conversations deleted (record_amendments, drizzle/0062). */
  amendments: number;
};

function noCounts(): ErasureCounts {
  return {
    contacts: 0,
    bookingRequests: 0,
    appointments: 0,
    conversations: 0,
    transactions: 0,
    drafts: 0,
    chatThreads: 0,
    webhookEvents: 0,
    suppressions: 0,
    consentRecords: 0,
    contactAttempts: 0,
    amendments: 0,
  };
}

export function totalErased(counts: ErasureCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * What a deletion left because it belongs to someone else, by count only:
 * the messaging threads that sent something for the person and something for
 * another (a parent booking for a child and for themselves), and, on those
 * threads, the booking requests and drafts that name another person. Each
 * stays as that person's record, with the thread's chat_threads row; the
 * operator tells the practice so, without naming anyone.
 */
export type ErasureKept = { sharedThreads: number; requests: number; drafts: number };

/** The identifiers a deletion is asked about. */
type Asked = { phones: string[]; emails: string[]; threads: string[] };

/** Everything the identifiers lead to, read before anything is deleted. */
type Survey = {
  contactIds: string[];
  phones: string[];
  emails: string[];
  /** The person's own threads: everything each sent names them. */
  threads: string[];
  kept: ErasureKept;
  callIds: string[];
};

/** "whatsapp:15551234567" for "+15551234567": a WhatsApp sender id is the number without its plus. */
function whatsappThread(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? `whatsapp:${digits}` : null;
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

function partyRefs(clinicId: string, threads: readonly string[]): string[] {
  return threads.map((thread) => identifierRef("chat_party", clinicId, thread));
}

/** The database's clock: what every bound below is compared against, never the app host's. */
async function databaseNow(tx: TenantTx): Promise<Date> {
  const result = await tx.db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  return new Date(result.rows[0]!.now);
}

/** The tenant's contacts recorded by `before` that carry any of the numbers or addresses. */
async function contactsCarrying(
  tx: TenantTx,
  phones: ReadonlySet<string>,
  emails: ReadonlySet<string>,
  before: Date,
): Promise<{ id: string; phone: string | null; email: string | null }[]> {
  if (!phones.size && !emails.size) return [];
  return tx.db
    .select({ id: contacts.id, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        or(
          phones.size ? inArray(contacts.phone, [...phones]) : sql`false`,
          emails.size ? sql`lower(${contacts.email}) = any(${textArray([...emails])})` : sql`false`,
        ),
        lte(contacts.createdAt, before),
      ),
    );
}

async function survey(tx: TenantTx, asked: Asked, before: Date): Promise<Survey> {
  const phones = new Set(asked.phones);
  const emails = new Set(asked.emails);
  const threads = new Set(asked.threads);

  // The person's identifiers: the ones asked, and every number and address
  // on a contact those match. Then every contact carrying any of them is
  // theirs, and is erased whole: a contact that shares their number, found
  // only through the address asked, must not keep its row and its calls
  // while its payloads, thread and stops go, nor be taken later by a
  // restore's re-application alone (review of 12 October 2026). One step,
  // not a chain: an address on that second contact is not followed further.
  for (const person of await contactsCarrying(tx, phones, emails, before)) {
    if (person.phone) phones.add(person.phone);
    if (person.email) emails.add(person.email.toLowerCase());
  }
  const people = await contactsCarrying(tx, phones, emails, before);
  const contactIds = people.map((p) => p.id);

  // The threads that may be theirs: their numbers' WhatsApp ids, and the
  // threads their own requests and drafts came from.
  for (const phone of phones) {
    const thread = whatsappThread(phone);
    if (thread) threads.add(thread);
  }
  if (contactIds.length) {
    const sent = await tx.db
      .select({ platform: bookingRequests.platform, senderId: bookingRequests.senderId })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.clinicId, tx.clinicId),
          inArray(bookingRequests.contactId, contactIds),
          isNotNull(bookingRequests.platform),
          isNotNull(bookingRequests.senderId),
          lte(bookingRequests.createdAt, before),
        ),
      );
    for (const r of sent) threads.add(`${r.platform}:${r.senderId}`);
  }
  if (phones.size) {
    const drafts = await tx.db
      .select({ platform: metaBookingDrafts.platform, senderId: metaBookingDrafts.senderId })
      .from(metaBookingDrafts)
      .where(
        and(
          eq(metaBookingDrafts.clinicId, tx.clinicId),
          inArray(metaBookingDrafts.phone, [...phones]),
          lte(metaBookingDrafts.updatedAt, before),
        ),
      );
    for (const d of drafts) threads.add(`${d.platform}:${d.senderId}`);
  }
  const { own, kept } = await ownThreads(tx, [...threads], new Set(contactIds), phones, before);

  // Their calls, and the calls that produced their appointments: the two
  // kinds app_erase_contacts deletes, read first so their raw payloads can go
  // after them.
  const callIds = contactIds.length
    ? (
        await tx.db
          .select({ callId: conversations.externalCallId })
          .from(conversations)
          .where(
            and(
              eq(conversations.clinicId, tx.clinicId),
              isNotNull(conversations.externalCallId),
              or(
                inArray(conversations.contactId, contactIds),
                inArray(
                  conversations.id,
                  tx.db
                    .select({ id: appointments.conversationId })
                    .from(appointments)
                    .where(
                      and(
                        eq(appointments.clinicId, tx.clinicId),
                        inArray(appointments.contactId, contactIds),
                        isNotNull(appointments.conversationId),
                      ),
                    ),
                ),
              ),
            ),
          )
      )
        .map((r) => r.callId)
        .filter((id): id is string => Boolean(id))
    : [];

  return { contactIds, phones: [...phones], emails: [...emails], threads: own, kept, callIds };
}

/**
 * Which of the candidate threads are the person's own: those every request
 * of which names one of their contacts, and whose draft, if any, carries one
 * of their numbers or none. The rest sent something for someone else, so
 * they are kept, and counted with what they sent for others.
 */
async function ownThreads(
  tx: TenantTx,
  candidates: readonly string[],
  contactIds: ReadonlySet<string>,
  phones: ReadonlySet<string>,
  before: Date,
): Promise<{ own: string[]; kept: ErasureKept }> {
  const kept: ErasureKept = { sharedThreads: 0, requests: 0, drafts: 0 };
  if (candidates.length === 0) return { own: [], kept };
  const forOthers = new Map<string, { requests: number; drafts: number }>();
  const tally = (thread: string) => {
    const entry = forOthers.get(thread) ?? { requests: 0, drafts: 0 };
    forOthers.set(thread, entry);
    return entry;
  };
  const sent = await tx.db
    .select({
      platform: bookingRequests.platform,
      senderId: bookingRequests.senderId,
      contactId: bookingRequests.contactId,
    })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        sql`(${bookingRequests.platform} || ':' || ${bookingRequests.senderId}) = any(${textArray(candidates)})`,
        lte(bookingRequests.createdAt, before),
      ),
    );
  for (const r of sent) {
    if (!contactIds.has(r.contactId)) tally(`${r.platform}:${r.senderId}`).requests += 1;
  }
  const drafts = await tx.db
    .select({
      platform: metaBookingDrafts.platform,
      senderId: metaBookingDrafts.senderId,
      phone: metaBookingDrafts.phone,
    })
    .from(metaBookingDrafts)
    .where(
      and(
        eq(metaBookingDrafts.clinicId, tx.clinicId),
        sql`(${metaBookingDrafts.platform} || ':' || ${metaBookingDrafts.senderId}) = any(${textArray(candidates)})`,
        lte(metaBookingDrafts.updatedAt, before),
      ),
    );
  for (const d of drafts) {
    if (d.phone && !phones.has(d.phone)) tally(`${d.platform}:${d.senderId}`);
  }
  // A shared thread keeps its draft unless the draft carries the person's
  // number (eraseContact takes that one wherever it is).
  for (const d of drafts) {
    const entry = forOthers.get(`${d.platform}:${d.senderId}`);
    if (entry && !(d.phone && phones.has(d.phone))) entry.drafts += 1;
  }
  for (const entry of forOthers.values()) {
    kept.sharedThreads += 1;
    kept.requests += entry.requests;
    kept.drafts += entry.drafts;
  }
  return { own: candidates.filter((t) => !forOthers.has(t)), kept };
}

/** A regular expression's special characters, escaped, for a literal inside a POSIX pattern. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The digit runs a number can be written as: its full international form
 * and, for a North American number, its ten-digit national number, each
 * digit allowed up to two separators after it ("+1 (555) 013-0001",
 * "555 013 0001", "15550130001"). No digit may stand directly before or
 * after the run, so a number is matched whole and never inside a longer one.
 * Other countries' numbers are matched in their international form only.
 */
function numberPatterns(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return [];
  const forms = [digits];
  if (phone.startsWith("+1") && digits.length === 11) forms.push(digits.slice(1));
  return forms.map((form) => `(^|[^0-9])${form.split("").join("[ ().-]{0,2}")}($|[^0-9])`);
}

/**
 * An address, matched whole: nothing that can belong to an address's local
 * part before it, and nothing that continues its domain after it (a full
 * stop ending a sentence is not a continuation). "ann@mail.test" is not
 * found inside "joann@mail.test" or "ann@mail.tester".
 */
function addressPattern(email: string): string {
  return `(^|[^a-z0-9._%+-])${literal(email.toLowerCase())}($|[^a-z0-9.-]|[.]($|[^a-z0-9-]))`;
}

/** The ids of the raw payloads about them: their calls' voice payloads, and any payload naming their number or address. */
async function payloadsAbout(tx: TenantTx, s: Survey, before: Date): Promise<string[]> {
  const found = new Set<string>();
  const patterns = [
    ...new Set([...s.phones.flatMap(numberPatterns), ...s.emails.map(addressPattern)]),
  ];

  // Any provider: the number or the address in the body, matched whole, by a
  // regular expression in the database, so no body is read out of it. The
  // first version tested for a substring, so erasing ann@mail.test deleted
  // joann@mail.test's payloads, possibly the only copy of an unprocessed
  // call, and missed a number written without its country code.
  if (s.callIds.length || patterns.length) {
    const rows = await tx.db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.clinicId, tx.clinicId),
          lte(webhookEvents.receivedAt, before),
          or(
            s.callIds.length
              ? and(
                  eq(webhookEvents.provider, "synthflow"),
                  inArray(webhookEvents.deliveryId, s.callIds),
                )
              : sql`false`,
            patterns.length
              ? sql`lower(${webhookEvents.rawPayload}) ~ any(${textArray(patterns)})`
              : sql`false`,
          ),
        ),
      );
    for (const r of rows) found.add(r.id);
  }

  // The voice vendor's payloads, read as ingestion reads them, for a number
  // in a shape the patterns above miss.
  if (s.phones.length) {
    const wanted = new Set(s.phones);
    for await (const row of synthflowPayloads(tx, before)) {
      if (found.has(row.id)) continue;
      if (row.callerPhone && wanted.has(row.callerPhone)) found.add(row.id);
    }
  }
  return [...found];
}

/** Every voice payload of the clinic recorded by `before`, a page at a time, with the caller's number as ingestion reads it. */
async function* synthflowPayloads(
  tx: TenantTx,
  before: Date,
): AsyncGenerator<{ id: string; callerPhone: string | null }> {
  let after: string | null = null;
  for (;;) {
    const page: { id: string; rawPayload: string }[] = await tx.db
      .select({ id: webhookEvents.id, rawPayload: webhookEvents.rawPayload })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.clinicId, tx.clinicId),
          eq(webhookEvents.provider, "synthflow"),
          lte(webhookEvents.receivedAt, before),
          after ? gt(webhookEvents.id, after) : sql`true`,
        ),
      )
      .orderBy(asc(webhookEvents.id))
      .limit(100);
    if (page.length === 0) return;
    for (const row of page) {
      let callerPhone: string | null = null;
      try {
        callerPhone =
          readSynthflowPayload(JSON.parse(row.rawPayload), tx.clinicId).callerPhone ?? null;
      } catch {
        // A body the reader cannot read names no caller it can match.
      }
      yield { id: row.id, callerPhone };
    }
    after = page[page.length - 1]!.id;
  }
}

function add(counts: ErasureCounts, contact: ErasureResult): void {
  counts.contacts += contact.contactsMatched;
  counts.bookingRequests += contact.bookingRequestsDeleted;
  counts.appointments += contact.appointmentsDeleted;
  counts.conversations += contact.conversationsDeleted;
  counts.transactions += contact.transactionsDeleted;
  counts.drafts += contact.draftsDeleted;
  counts.amendments += contact.amendmentsDeleted;
}

/**
 * The deletes, in the order the foreign keys need, all bounded by `before`,
 * under the record of the request (`erasureId`): the definer that deletes
 * the person's suppressions, consent records and contact attempts refuses
 * without one written in this transaction or still holding its restore
 * references (drizzle/0061).
 */
async function eraseSurveyed(
  tx: TenantTx,
  erasureId: string,
  s: Survey,
  before: Date,
  requestedBy: string,
  extraPartyRefs: readonly string[] = [],
): Promise<ErasureCounts> {
  const counts = noCounts();

  // The raw payloads first, found while the calls they belong to still exist.
  const payloads = await payloadsAbout(tx, s, before);

  // The people, by every number and address the survey made theirs (not
  // only the ones asked), with their own requests whatever thread they came
  // from: every contact carrying one of them goes whole.
  for (const phone of s.phones)
    add(counts, await eraseContact(tx, { phone, requestedBy, before }));
  for (const email of s.emails)
    add(counts, await eraseContact(tx, { email, requestedBy, before }));

  // The drafts on their own threads (eraseContact took the ones carrying
  // their number, wherever they are). A thread that also booked for someone
  // else is not among them, and keeps its draft.
  if (s.threads.length) {
    const drafts = await tx.db
      .delete(metaBookingDrafts)
      .where(
        and(
          eq(metaBookingDrafts.clinicId, tx.clinicId),
          sql`(${metaBookingDrafts.platform} || ':' || ${metaBookingDrafts.senderId}) = any(${textArray(s.threads)})`,
          lte(metaBookingDrafts.updatedAt, before),
        ),
      )
      .returning({ senderId: metaBookingDrafts.senderId });
    counts.drafts += drafts.length;
  }

  // Their own threads, by the keyed reference the table holds.
  const refs = [...new Set([...partyRefs(tx.clinicId, s.threads), ...extraPartyRefs])];
  if (refs.length) {
    const threads = await tx.db
      .delete(chatThreads)
      .where(
        and(
          eq(chatThreads.clinicId, tx.clinicId),
          inArray(chatThreads.partyRef, refs),
          lte(chatThreads.lastInboundAt, before),
        ),
      )
      .returning({ ref: chatThreads.partyRef });
    counts.chatThreads = threads.length;
  }

  if (payloads.length) {
    const gone = await tx.db
      .delete(webhookEvents)
      .where(and(eq(webhookEvents.clinicId, tx.clinicId), inArray(webhookEvents.id, payloads)))
      .returning({ id: webhookEvents.id });
    counts.webhookEvents = gone.length;
  }

  // Their suppressions, consent records and contact attempts, last, so no
  // number of theirs is left anywhere.
  if (s.phones.length) {
    const result = await tx.db.execute<{
      suppressions_deleted: number;
      consent_records_deleted: number;
      contact_attempts_deleted: number;
    }>(
      sql`select * from app_erase_contact_evidence(${erasureId}::uuid, ${textArray(s.phones)})`,
    );
    const row = result.rows[0];
    counts.suppressions = row?.suppressions_deleted ?? 0;
    counts.consentRecords = row?.consent_records_deleted ?? 0;
    counts.contactAttempts = row?.contact_attempts_deleted ?? 0;
  }

  return counts;
}

// -----------------------------------------------------------------------------
// The operator's erase path
// -----------------------------------------------------------------------------

export type ErasePersonInput = {
  /** E.164. */
  phone?: string;
  /** Lower-cased. */
  email?: string;
  /** Who asked: one of the closed set, never typed. */
  requestedBy: PatientRequester;
  /**
   * When the request reached healdesk: the deadline runs from it. Omitted,
   * now; a moment later than the database's clock (an operator's clock a
   * little ahead of it) counts as now.
   */
  receivedAt?: Date;
};

export type ErasePersonResult = {
  erasureId: string;
  erasedAt: Date;
  dueBy: Date;
  deleted: ErasureCounts;
  kept: ErasureKept;
  /**
   * How many numbers and addresses the deletion took as the person's: the
   * ones asked, and every one on a contact those matched. Counts only.
   */
  identifiers: { phones: number; emails: number };
};

/**
 * Delete one person, and record the request without them. Inside the
 * clinic's tenant, in one transaction: either all of it happens, the record
 * included, or none of it does. The record is written first, from what the
 * survey found, because the database deletes the person's suppressions,
 * consent records and contact attempts only under it; its counts are written
 * last, in the same transaction, the only one that may write them. A request
 * that matches nothing is recorded all the same, because a backup may still
 * hold the person (the clock purged them, or they were never matched by these
 * identifiers here), and the record is what deletes them again from a
 * restore.
 */
export async function erasePerson(
  tx: TenantTx,
  input: ErasePersonInput,
): Promise<ErasePersonResult> {
  const phone = input.phone?.trim() || undefined;
  const email = input.email?.trim().toLowerCase() || undefined;
  if (!phone && !email)
    throw new Error("A deletion request needs a telephone number or an email address.");

  const now = await databaseNow(tx);
  const receivedAt =
    input.receivedAt && input.receivedAt.getTime() < now.getTime() ? input.receivedAt : now;
  const asked: Asked = { phones: phone ? [phone] : [], emails: email ? [email] : [], threads: [] };
  const s = await survey(tx, asked, now);

  const restoreRefs = [
    ...new Set([
      ...s.phones.map((p) => identifierRef("erasure", tx.clinicId, `phone:${p}`)),
      ...s.emails.map((e) => identifierRef("erasure", tx.clinicId, `email:${e}`)),
      ...partyRefs(tx.clinicId, s.threads),
    ]),
  ];
  const dueBy = addBusinessDays(receivedAt, ERASURE_DEADLINE_BUSINESS_DAYS);
  const [row] = await tx.db
    .insert(erasureRequests)
    .values({
      clinicId: tx.clinicId,
      requestedBy: input.requestedBy,
      receivedAt,
      dueBy,
      restoreRefs,
    })
    .returning({ id: erasureRequests.id, erasedAt: erasureRequests.erasedAt });
  if (!row) throw new Error("The deletion request was not recorded.");

  const deleted = await eraseSurveyed(tx, row.id, s, now, input.requestedBy);
  await tx.db
    .update(erasureRequests)
    .set({ deleted })
    .where(and(eq(erasureRequests.clinicId, tx.clinicId), eq(erasureRequests.id, row.id)));

  tx.audit.record({
    action: "delete",
    resourceType: "person_erasure",
    resourceId: row.id,
    resultCount: totalErased(deleted),
    metadata: {
      requestedBy: input.requestedBy,
      ...deleted,
      keptSharedThreads: s.kept.sharedThreads,
      keptRequests: s.kept.requests,
      keptDrafts: s.kept.drafts,
    },
  });
  return {
    erasureId: row.id,
    erasedAt: row.erasedAt,
    dueBy,
    deleted,
    kept: s.kept,
    identifiers: { phones: s.phones.length, emails: s.emails.length },
  };
}

// -----------------------------------------------------------------------------
// The record: what the console shows, and the operator's vendor stamps
// -----------------------------------------------------------------------------

export type ErasureRequestView = {
  id: string;
  /** Who asked, as the console says it (REQUESTER_LABELS). */
  requestedBy: string;
  receivedAt: Date;
  dueBy: Date;
  erasedAt: Date;
  deleted: Record<string, number>;
  /** When the restore references are emptied; null once they have been. */
  restoreRecordUntil: Date | null;
  steps: { id: ErasureVendorStepId; label: string; stamp: ErasureVendorStamp | null }[];
};

/** The clinic's deletion requests, newest first. No reference to anyone leaves this function. */
export async function listErasureRequests(tx: TenantTx): Promise<ErasureRequestView[]> {
  const rows = await tx.db
    .select({
      id: erasureRequests.id,
      requestedBy: erasureRequests.requestedBy,
      receivedAt: erasureRequests.receivedAt,
      dueBy: erasureRequests.dueBy,
      erasedAt: erasureRequests.erasedAt,
      deleted: erasureRequests.deleted,
      vendorSteps: erasureRequests.vendorSteps,
      refsHeld: sql<boolean>`cardinality(${erasureRequests.restoreRefs}) > 0`,
    })
    .from(erasureRequests)
    .where(eq(erasureRequests.clinicId, tx.clinicId))
    .orderBy(sql`${erasureRequests.erasedAt} desc`);
  return rows.map((r) => ({
    id: r.id,
    requestedBy: REQUESTER_LABELS[r.requestedBy] ?? r.requestedBy,
    receivedAt: r.receivedAt,
    dueBy: r.dueBy,
    erasedAt: r.erasedAt,
    deleted: r.deleted,
    restoreRecordUntil: r.refsHeld
      ? new Date(r.erasedAt.getTime() + BACKUP_RETENTION_DAYS * DAY_MS)
      : null,
    steps: ERASURE_VENDOR_STEPS.map((step) => ({
      id: step.id,
      label: step.label,
      stamp: r.vendorSteps[step.id] ?? null,
    })),
  }));
}

export type VendorStampOutcome = "stamped" | "already_stamped" | "not_found";

/** The operator's record that a subcontractor deleted what it held about the person. Once per step. */
export async function stampErasureVendorStep(
  tx: TenantTx,
  input: { erasureId: string; step: ErasureVendorStepId; by: string; how: string },
): Promise<VendorStampOutcome> {
  const [row] = await tx.db
    .select({ vendorSteps: erasureRequests.vendorSteps })
    .from(erasureRequests)
    .where(and(eq(erasureRequests.clinicId, tx.clinicId), eq(erasureRequests.id, input.erasureId)))
    .for("update")
    .limit(1);
  if (!row) return "not_found";
  if (row.vendorSteps[input.step]) return "already_stamped";
  // `at` is overwritten with the database's clock by erasure_requests_guard.
  const stamp: ErasureVendorStamp = { at: new Date().toISOString(), by: input.by, how: input.how };
  await tx.db
    .update(erasureRequests)
    .set({
      vendorSteps: sql`${erasureRequests.vendorSteps} || jsonb_build_object(${input.step}::text, ${JSON.stringify(stamp)}::jsonb)`,
    })
    .where(and(eq(erasureRequests.clinicId, tx.clinicId), eq(erasureRequests.id, input.erasureId)));
  tx.audit.record({
    action: "update",
    resourceType: "person_erasure",
    resourceId: input.erasureId,
    metadata: { vendorStep: input.step },
  });
  return "stamped";
}

// -----------------------------------------------------------------------------
// The record's own clock
// -----------------------------------------------------------------------------

const EXPIRY_ACTOR = { type: "service", serviceName: "erasure-expiry" } as const;

/**
 * Hourly, unswitched (lib/scheduler/tick.ts): a record's references go
 * BACKUP_RETENTION_DAYS after its deletion, and the record with them once
 * every subcontractor step is stamped. Not behind a switch, because the
 * agreement's "no longer than it needs one" does not wait for one. It runs in
 * the worker, which a restore keeps stopped, so references a restore still
 * needs are never emptied while it is in progress. The clock is the
 * database's (app_expire_erasure_records, drizzle/0061): the runtime role
 * can neither empty the references sooner nor delete a record itself, and a
 * step counts as stamped only with a stamp the database timestamped.
 */
export async function expireErasureRecords(): Promise<{
  emptied: number;
  deleted: number;
  failures: number;
}> {
  const out = { emptied: 0, deleted: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    try {
      const result = await withTenant({ clinicId: clinic.id, actor: EXPIRY_ACTOR }, async (tx) => {
        const { rows } = await tx.db.execute<{ emptied: number; deleted: number }>(
          sql`select * from app_expire_erasure_records()`,
        );
        return { emptied: rows[0]?.emptied ?? 0, deleted: rows[0]?.deleted ?? 0 };
      });
      out.emptied += result.emptied;
      out.deleted += result.deleted;
    } catch (error) {
      out.failures += 1;
      log.error("erasure record expiry failed", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// After a restore
// -----------------------------------------------------------------------------

const REAPPLY_ACTOR = { type: "service", serviceName: "erasure-reapply" } as const;

/** What the record's references name, among rows recorded no later than the deletion. */
async function recover(tx: TenantTx, refs: ReadonlySet<string>, before: Date): Promise<Asked> {
  const phoneRef = (p: string) => identifierRef("erasure", tx.clinicId, `phone:${p}`);
  const emailRef = (e: string) => identifierRef("erasure", tx.clinicId, `email:${e}`);
  const threadRef = (t: string) => identifierRef("chat_party", tx.clinicId, t);

  const candidatePhones = new Set<string>();
  const candidateEmails = new Set<string>();
  const candidateThreads = new Set<string>();

  for (const r of await tx.db
    .select({ phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.clinicId, tx.clinicId), lte(contacts.createdAt, before)))) {
    if (r.phone) candidatePhones.add(r.phone);
    if (r.email) candidateEmails.add(r.email.toLowerCase());
  }
  for (const r of await tx.db
    .select({
      phone: metaBookingDrafts.phone,
      platform: metaBookingDrafts.platform,
      senderId: metaBookingDrafts.senderId,
    })
    .from(metaBookingDrafts)
    .where(
      and(eq(metaBookingDrafts.clinicId, tx.clinicId), lte(metaBookingDrafts.updatedAt, before)),
    )) {
    if (r.phone) candidatePhones.add(r.phone);
    candidateThreads.add(`${r.platform}:${r.senderId}`);
  }
  for (const r of await tx.db
    .select({ platform: bookingRequests.platform, senderId: bookingRequests.senderId })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        isNotNull(bookingRequests.platform),
        isNotNull(bookingRequests.senderId),
        lte(bookingRequests.createdAt, before),
      ),
    )) {
    candidateThreads.add(`${r.platform}:${r.senderId}`);
  }
  const evidence = [
    ...(await tx.db
      .select({ phone: suppressions.phone })
      .from(suppressions)
      .where(and(eq(suppressions.clinicId, tx.clinicId), lte(suppressions.requestedAt, before)))),
    ...(await tx.db
      .select({ phone: consentRecords.phone })
      .from(consentRecords)
      .where(and(eq(consentRecords.clinicId, tx.clinicId), lte(consentRecords.grantedAt, before)))),
    ...(await tx.db
      .select({ phone: contactAttempts.phone })
      .from(contactAttempts)
      .where(
        and(eq(contactAttempts.clinicId, tx.clinicId), lte(contactAttempts.attemptedAt, before)),
      )),
  ];
  for (const r of evidence) candidatePhones.add(r.phone);
  for await (const row of synthflowPayloads(tx, before)) {
    if (row.callerPhone) candidatePhones.add(row.callerPhone);
  }

  return {
    phones: [...candidatePhones].filter((p) => refs.has(phoneRef(p))),
    emails: [...candidateEmails].filter((e) => refs.has(emailRef(e))),
    threads: [...candidateThreads].filter((t) => refs.has(threadRef(t))),
  };
}

export type ReapplyResult = { requests: number; reapplied: number; rows: number; failures: number };

/**
 * After a restore (docs/handover.md, "Restoring"; npm run reapply-erasures):
 * every deletion whose record still holds its references, applied again to
 * the restored data, taking only what was recorded no later than the
 * deletion ran. Writes no new record. A clinic whose re-application fails is
 * logged and counted, and the script exits non-zero, so the service does not
 * reopen over it.
 */
export async function reapplyErasures(): Promise<ReapplyResult> {
  const out: ReapplyResult = { requests: 0, reapplied: 0, rows: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    try {
      const result = await withTenant({ clinicId: clinic.id, actor: REAPPLY_ACTOR }, async (tx) => {
        const records = await tx.db
          .select({
            id: erasureRequests.id,
            erasedAt: erasureRequests.erasedAt,
            restoreRefs: erasureRequests.restoreRefs,
          })
          .from(erasureRequests)
          .where(
            and(
              eq(erasureRequests.clinicId, tx.clinicId),
              sql`cardinality(${erasureRequests.restoreRefs}) > 0`,
            ),
          )
          .orderBy(asc(erasureRequests.erasedAt));
        let reapplied = 0;
        let rows = 0;
        for (const record of records) {
          const refs = new Set(record.restoreRefs);
          const asked = await recover(tx, refs, record.erasedAt);
          const s = await survey(tx, asked, record.erasedAt);
          const counts = await eraseSurveyed(
            tx,
            record.id,
            s,
            record.erasedAt,
            `restore of erasure ${record.id}`,
            record.restoreRefs,
          );
          const total = totalErased(counts);
          if (total > 0) {
            reapplied += 1;
            rows += total;
            tx.audit.record({
              action: "delete",
              resourceType: "person_erasure_reapplied",
              resourceId: record.id,
              resultCount: total,
              metadata: { ...counts },
            });
          }
        }
        return { requests: records.length, reapplied, rows };
      });
      out.requests += result.requests;
      out.reapplied += result.reapplied;
      out.rows += result.rows;
    } catch (error) {
      out.failures += 1;
      log.error("erasure re-application failed", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return out;
}
