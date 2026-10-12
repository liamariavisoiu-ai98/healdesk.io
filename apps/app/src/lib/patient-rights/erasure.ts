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
 *   - their contacts, by number or address, and every number and address on
 *     those contacts;
 *   - their messaging threads ("<platform>:<sender id>"): the WhatsApp id each
 *     number is (the number without its plus), the thread each of their own
 *     Meta booking requests came from, and the thread of each half-collected
 *     Meta draft carrying one of their numbers;
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
 * appointments, payments matched to them, and the drafts carrying their
 * number. Then what it does not reach:
 *
 *   - the Meta booking requests they sent naming someone else's number
 *     (app_erase_thread_requests; the person the request names stays, and goes
 *     with the purge once nothing of theirs is left);
 *   - their drafts on those threads, and the threads themselves (chat_threads);
 *   - the raw payloads other services sent about them (webhook_events): every
 *     voice payload of their calls, and any payload carrying their number or
 *     address;
 *   - their suppressions, consent records and contact attempts
 *     (app_erase_contact_evidence), so no telephone number of theirs is left.
 *
 * Slot holds that named them keep only the time, with the contact, request
 * and appointment gone from them (their foreign keys), and are purged a day
 * after they lapse. usage_events keep the keyed reference of each call and
 * conversation, as the billing record, with nothing that leads to the person.
 *
 * ## The record, and how long it lasts
 *
 * One `erasure_requests` row: who asked by role or ticket, when the request
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
  /** Requests sent from the people's messaging threads naming another number. */
  threadRequests: number;
  appointments: number;
  conversations: number;
  transactions: number;
  drafts: number;
  chatThreads: number;
  webhookEvents: number;
  suppressions: number;
  consentRecords: number;
  contactAttempts: number;
};

function noCounts(): ErasureCounts {
  return {
    contacts: 0,
    bookingRequests: 0,
    threadRequests: 0,
    appointments: 0,
    conversations: 0,
    transactions: 0,
    drafts: 0,
    chatThreads: 0,
    webhookEvents: 0,
    suppressions: 0,
    consentRecords: 0,
    contactAttempts: 0,
  };
}

export function totalErased(counts: ErasureCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** The identifiers a deletion is asked about. */
type Asked = { phones: string[]; emails: string[]; threads: string[] };

/** Everything the identifiers lead to, read before anything is deleted. */
type Survey = {
  contactIds: string[];
  phones: string[];
  emails: string[];
  threads: string[];
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

async function survey(tx: TenantTx, asked: Asked, before: Date): Promise<Survey> {
  const phones = new Set(asked.phones);
  const emails = new Set(asked.emails);
  const threads = new Set(asked.threads);

  const people =
    phones.size || emails.size
      ? await tx.db
          .select({ id: contacts.id, phone: contacts.phone, email: contacts.email })
          .from(contacts)
          .where(
            and(
              eq(contacts.clinicId, tx.clinicId),
              or(
                phones.size ? inArray(contacts.phone, [...phones]) : sql`false`,
                emails.size
                  ? sql`lower(${contacts.email}) = any(${textArray([...emails])})`
                  : sql`false`,
              ),
              lte(contacts.createdAt, before),
            ),
          )
      : [];
  for (const person of people) {
    if (person.phone) phones.add(person.phone);
    if (person.email) emails.add(person.email.toLowerCase());
  }
  const contactIds = people.map((p) => p.id);

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

  return { contactIds, phones: [...phones], emails: [...emails], threads: [...threads], callIds };
}

/** The ids of the raw payloads about them: their calls' voice payloads, and any payload naming their number or address. */
async function payloadsAbout(tx: TenantTx, s: Survey, before: Date): Promise<string[]> {
  const found = new Set<string>();
  const digits = [
    ...new Set(s.phones.map((p) => p.replace(/\D/g, "")).filter((d) => d.length >= 7)),
  ];
  const needles = [...digits, ...s.emails.map((e) => e.toLowerCase())];

  // Any provider: the number's digits or the address, verbatim in the body.
  // A substring test in the database, so no body is read out of it.
  if (s.callIds.length || needles.length) {
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
            needles.length
              ? sql`exists (select 1 from unnest(${textArray(needles)}) n where position(n in lower(${webhookEvents.rawPayload})) > 0)`
              : sql`false`,
          ),
        ),
      );
    for (const r of rows) found.add(r.id);
  }

  // The voice vendor's payloads, read as ingestion reads them, for a number
  // written in a shape the substring test above misses ("(555) 123-4567").
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
}

/** The deletes, in the order the foreign keys need, all bounded by `before`. */
async function eraseSurveyed(
  tx: TenantTx,
  s: Survey,
  asked: Asked,
  before: Date,
  requestedBy: string,
  extraPartyRefs: readonly string[] = [],
): Promise<ErasureCounts> {
  const counts = noCounts();

  // The raw payloads first, found while the calls they belong to still exist.
  const payloads = await payloadsAbout(tx, s, before);

  // The people, by each number and address the request names, with their
  // own requests whatever thread they came from.
  for (const phone of asked.phones)
    add(counts, await eraseContact(tx, { phone, requestedBy, before }));
  for (const email of asked.emails)
    add(counts, await eraseContact(tx, { email, requestedBy, before }));

  // The Meta requests they sent naming someone else's number.
  if (s.threads.length) {
    const result = await tx.db.execute<{ n: number }>(
      sql`select app_erase_thread_requests(${textArray(s.threads)}, ${before.toISOString()}::timestamptz) as n`,
    );
    counts.threadRequests = result.rows[0]?.n ?? 0;
  }

  // Their drafts on their threads (eraseContact took the ones carrying their number).
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

  // Their threads, by the keyed reference the table holds.
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
      sql`select * from app_erase_contact_evidence(${textArray(s.phones)}, ${before.toISOString()}::timestamptz)`,
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
  /** Who asked, by role or ticket. Scanned for patient details by the caller; never a name. */
  requestedBy: string;
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
};

/**
 * Delete one person, and record the request without them. Inside the
 * clinic's tenant, in one transaction: either all of it happens, the record
 * included, or none of it does. A request that matches nothing is recorded
 * all the same, because a backup may still hold the person (the clock purged
 * them, or they were never matched by these identifiers here), and the
 * record is what deletes them again from a restore.
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
  const deleted = await eraseSurveyed(tx, s, asked, now, input.requestedBy);

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
      deleted,
      restoreRefs,
    })
    .returning({ id: erasureRequests.id, erasedAt: erasureRequests.erasedAt });
  if (!row) throw new Error("The deletion request was not recorded.");

  tx.audit.record({
    action: "delete",
    resourceType: "person_erasure",
    resourceId: row.id,
    resultCount: totalErased(deleted),
    metadata: { requestedBy: input.requestedBy, ...deleted },
  });
  return { erasureId: row.id, erasedAt: row.erasedAt, dueBy, deleted };
}

// -----------------------------------------------------------------------------
// The record: what the console shows, and the operator's vendor stamps
// -----------------------------------------------------------------------------

export type ErasureRequestView = {
  id: string;
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
    requestedBy: r.requestedBy,
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
 * needs are never emptied while it is in progress.
 */
export async function expireErasureRecords(
  now: Date = new Date(),
): Promise<{ emptied: number; deleted: number; failures: number }> {
  const cutoff = new Date(now.getTime() - BACKUP_RETENTION_DAYS * DAY_MS);
  const allStamped = textArray(ERASURE_VENDOR_STEPS.map((s) => s.id));
  const out = { emptied: 0, deleted: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    try {
      const result = await withTenant({ clinicId: clinic.id, actor: EXPIRY_ACTOR }, async (tx) => {
        const emptied = await tx.db
          .update(erasureRequests)
          .set({ restoreRefs: sql`'{}'::text[]` })
          .where(
            and(
              eq(erasureRequests.clinicId, tx.clinicId),
              lte(erasureRequests.erasedAt, cutoff),
              sql`cardinality(${erasureRequests.restoreRefs}) > 0`,
            ),
          )
          .returning({ id: erasureRequests.id });
        const deleted = await tx.db
          .delete(erasureRequests)
          .where(
            and(
              eq(erasureRequests.clinicId, tx.clinicId),
              lte(erasureRequests.erasedAt, cutoff),
              sql`${erasureRequests.vendorSteps} ?& ${allStamped}`,
            ),
          )
          .returning({ id: erasureRequests.id });
        return { emptied: emptied.length, deleted: deleted.length };
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
            s,
            asked,
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
