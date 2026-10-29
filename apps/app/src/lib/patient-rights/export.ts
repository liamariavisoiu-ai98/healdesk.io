import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  appointments,
  auditLog,
  bookingRequests,
  chatThreads,
  consentRecords,
  contactAttempts,
  contacts,
  conversations,
  depositPayments,
  handovers,
  metaBookingDrafts,
  missedContacts,
  slotHolds,
  suppressions,
  transactions,
  webhookEvents,
} from "@/db/schema";
import { linkCallHandovers, namedHandover } from "@/lib/handovers/record";
import type { TenantTx } from "@/lib/tenant";

import { amendmentsFor, withAmendments, type RecordAmendment } from "./amendments";
import { isPatientRequester, type PatientRequester } from "./requesters";

/**
 * The patient-rights export: everything held about one person, in one
 * bundle, with the accounting of disclosures beside it.
 *
 * The BAA's patient-rights clause commits healdesk to give the clinic what
 * it needs to answer an access, amendment or accounting request within ten
 * business days. This is that: found by phone, email or a contact's id
 * inside the clinic's tenant, every row that names the contact, and the
 * audit trail filtered to those rows — which is the only possible
 * accounting of disclosures, and which report.ts already proves records
 * even a count.
 *
 * Its own audit row is written for the export itself: producing a bundle is
 * an access, and the next accounting request must show this one.
 *
 * Each booking request, appointment and conversation carries its amendments
 * beside it (`amendments`, oldest first; lib/patient-rights/amendments.ts),
 * as clause 14(b) of the agreement in force promises (BAA 1.5.1, unchanged
 * since 1.3.0): "Every later export of that record, and every screen of
 * healdesk's that shows it, then carries the amendment." So does the whole
 * clinic's bundle. The portal's export (M5) must do the same, and so must
 * any screen that shows a request or a conversation.
 *
 * Each bundle also carries the deposits the clinic took through its own
 * Stripe account for the person's appointments (the whole clinic's, in its
 * bundle): the amount, when and how it was paid, and the Stripe session the
 * clinic can find it by. Destruction deletes them (clause 17 of BAA 1.5.1,
 * as of 1.3.0, lets only two records survive), so the return bundle is the
 * clinic's copy.
 *
 * The whole clinic's bundle also carries the raw payloads other services
 * sent (`rawPayloads`: provider, when it arrived, whether it was processed,
 * and the body, decoded where it parses), which hold the transcripts' words
 * that no other table does, the messaging threads as keyed references, and
 * the half-collected Meta drafts: clause 17 promises "an export of the
 * patient information it holds" (the calendar session's re-audit, C19).
 *
 * Who asked is one of PATIENT_REQUESTERS, chosen, never typed: the audit
 * row this writes outlives the person, so it holds nothing typed.
 *
 * A person's bundle is produced for the covered entity, which validates the
 * request: the operator's script, or the clinic itself from a conversation
 * it opens in the portal behind its passkey (M5, lib/portal/conversations.ts).
 * The whole clinic's bundle is the clinic's to download from the portal at
 * any time, and the operator's to hand over at offboarding.
 */
/** A record as exported: the row, and every amendment Practice directed to it beside it. */
export type Amended<T> = T & { amendments: RecordAmendment[] };

export type PatientBundle = {
  producedAt: string;
  contacts: (typeof contacts.$inferSelect)[];
  conversations: Amended<typeof conversations.$inferSelect>[];
  appointments: Amended<typeof appointments.$inferSelect>[];
  transactions: (typeof transactions.$inferSelect)[];
  consentRecords: (typeof consentRecords.$inferSelect)[];
  suppressions: (typeof suppressions.$inferSelect)[];
  contactAttempts: (typeof contactAttempts.$inferSelect)[];
  /** Booking requests from any channel, handed to the desk on the manual booking path; the token digest is not included. */
  bookingRequests: Amended<Omit<typeof bookingRequests.$inferSelect, "tokenHash">>[];
  /** Deposits taken through the clinic's own Stripe account for their appointments: never the Stripe account id or event id. */
  depositPayments: DepositRecord[];
  /**
   * The times they asked AYA for a person in one of these conversations, or
   * leaving one of these numbers for the call back (drizzle/0092): the channel, when, and when
   * the desk marked it handled.
   * The clinic's bundle carries every one, Meta's by their thread's keyed reference.
   */
  handovers: HandoverRecord[];
  /**
   * Their calls and chats AYA could not answer, in the last 30 days
   * (missed_contacts, drizzle/0139): when, the channel, where it went, the
   * number when known, the clinic's call-back tick and our closing note. A
   * person's bundle carries the ones with their number; the clinic's every one.
   */
  missedContacts?: (typeof missedContacts.$inferSelect)[];
  /** Times the assistant held for them on a call (plan §11.8): when, for how long, and what became of it. */
  slotHolds: { id: string; startsAt: Date; endsAt: Date; status: string; createdAt: Date }[];
  /** Every audit row that touched any of the ids above: the accounting of disclosures. */
  accountingOfDisclosures: (typeof auditLog.$inferSelect)[];
  /**
   * The whole clinic's bundle only. The raw copies the voice vendor and the
   * other services sent (webhook_events), each decoded where it parses and
   * as its text where it does not: the only place a transcript's words sit
   * in our database (a conversation keeps the transcript's address), kept up
   * to the record clock when never processed (C19, 12 October 2026).
   */
  rawPayloads?: RawPayloadRecord[];
  /** The whole clinic's bundle only: messaging threads, as keyed references (never the sender's id) and dates. */
  messagingThreads?: MessagingThreadRecord[];
  /** The whole clinic's bundle only: half-collected Meta bookings (a first name, a number, a time). */
  metaBookingDrafts?: (typeof metaBookingDrafts.$inferSelect)[];
};

export type HandoverRecord = Omit<typeof handovers.$inferSelect, "handledByUserId">;

const HANDOVER_COLUMNS = {
  id: handovers.id,
  clinicId: handovers.clinicId,
  locationId: handovers.locationId,
  channel: handovers.channel,
  platform: handovers.platform,
  externalCallId: handovers.externalCallId,
  conversationId: handovers.conversationId,
  partyRef: handovers.partyRef,
  metaConversationId: handovers.metaConversationId,
  callbackPhone: handovers.callbackPhone,
  callbackFirstName: handovers.callbackFirstName,
  createdAt: handovers.createdAt,
  handledAt: handovers.handledAt,
  handledByLabel: handovers.handledByLabel,
};

export type RawPayloadRecord = {
  id: string;
  provider: string;
  deliveryId: string;
  receivedAt: Date;
  processedAt: Date | null;
  processed: boolean;
  signatureValid: boolean;
  /** The body, decoded, where it parses as JSON; otherwise null and `text` holds it. */
  body: unknown;
  /** The body as received, where it does not parse as JSON; otherwise null. */
  text: string | null;
};

export type MessagingThreadRecord = Pick<
  typeof chatThreads.$inferSelect,
  "channel" | "partyRef" | "conversationStartedAt" | "lastInboundAt" | "conversationsCount"
>;

/**
 * How deep a decoded payload may nest and still go into the bundle decoded.
 * patient-export writes the bundle with JSON.stringify(bundle, null, 2),
 * which recurses once per level and overflows the stack a few thousand
 * levels down, with the bundle's own levels on top; a check that the body
 * alone could be written out ran shallower than that, so a body about 6,900
 * deep decoded here and failed the write (third review of C19, 12 October
 * 2026). A real vendor body nests a dozen levels; anything past this one is
 * not data to read, and goes in as its text.
 */
export const DECODED_PAYLOAD_MAX_DEPTH = 512;

/** Whether a decoded JSON value nests no deeper than `max` arrays and objects. Iterative, so a deep value cannot overflow it. */
function nestsWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth + 1 > max) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return true;
}

/**
 * A raw payload for the bundle: decoded where it parses and nests no deeper
 * than DECODED_PAYLOAD_MAX_DEPTH, its text otherwise (a body too deep to
 * parse included), so the bundle can always be written out.
 */
function payloadRecord(row: typeof webhookEvents.$inferSelect): RawPayloadRecord {
  let body: unknown = null;
  let text: string | null = row.rawPayload;
  try {
    const decoded: unknown = JSON.parse(row.rawPayload);
    if (nestsWithin(decoded, DECODED_PAYLOAD_MAX_DEPTH)) {
      body = decoded;
      text = null;
    }
  } catch {
    body = null;
  }
  return {
    id: row.id,
    provider: row.provider,
    deliveryId: row.deliveryId,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    processed: row.processedAt !== null,
    signatureValid: row.signatureValid,
    body,
    text,
  };
}

export type DepositRecord = Pick<
  typeof depositPayments.$inferSelect,
  "id" | "appointmentId" | "channel" | "amountCents" | "currency" | "status" | "checkoutSessionId" | "paidAt" | "createdAt"
>;

const DEPOSIT_COLUMNS = {
  id: depositPayments.id,
  appointmentId: depositPayments.appointmentId,
  channel: depositPayments.channel,
  amountCents: depositPayments.amountCents,
  currency: depositPayments.currency,
  status: depositPayments.status,
  checkoutSessionId: depositPayments.checkoutSessionId,
  paidAt: depositPayments.paidAt,
  createdAt: depositPayments.createdAt,
};

function assertRequester(requestedBy: unknown): asserts requestedBy is PatientRequester {
  if (!isPatientRequester(requestedBy)) {
    throw new Error("Who asked is one of the closed set (PATIENT_REQUESTERS), never typed.");
  }
}

/** The contact id given matches no contact of this clinic. */
export class ExportContactNotFound extends Error {
  constructor() {
    super("No such contact at this clinic.");
    this.name = "ExportContactNotFound";
  }
}

const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who the bundle is about: a telephone number, an email address, or both;
 * or a contact's id in their place. By id, the person is that contact and
 * every contact carrying its number or its address, read here inside the
 * transaction: the same bundle as asking by the contact's own details,
 * with the contact itself always in it, even one with neither. It is how a
 * per-patient export runs on the AWS host, where no patient's details may be
 * typed or passed in (run-task's overrides are recorded by CloudTrail), as a
 * deletion does (erasure.ts, `contactId`).
 */
export type PatientQuery = {
  phone?: string;
  email?: string;
  contactId?: string;
  requestedBy: PatientRequester;
};

export async function exportPatient(tx: TenantTx, query: PatientQuery): Promise<PatientBundle> {
  assertRequester(query.requestedBy);
  let phone = query.phone;
  let email = query.email?.toLowerCase();
  const contactId = query.contactId;
  let callback: { handoverId: string } | null = null;
  if (contactId !== undefined) {
    if (phone || email) throw new Error("Name the person by a contact's id, or by their details, not both.");
    if (!CONTACT_ID.test(contactId)) throw new Error("A contact's id is its uuid.");
    const [contact] = await tx.db
      .select({ phone: contacts.phone, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)))
      .limit(1);
    // A handover's id, or its chat's, names someone who only left a
    // call-back number in web chat, which no contact holds: that handover and
    // its chat, as erasure takes them, and nothing found by the number they
    // typed (namedHandover; drizzle/0092).
    callback = contact ? null : await namedHandover(tx, contactId);
    if (!contact && !callback) throw new ExportContactNotFound();
    phone = contact?.phone ?? undefined;
    email = contact?.email?.toLowerCase() ?? undefined;
  } else if (!phone && !email) {
    throw new Error("A phone number, an email address or a contact's id is required.");
  }

  const found = await tx.db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        or(
          contactId ? eq(contacts.id, contactId) : sql`false`,
          phone ? eq(contacts.phone, phone) : sql`false`,
          email ? eq(contacts.email, email) : sql`false`,
        ),
      ),
    );
  const ids = found.map((c) => c.id);
  const phones = found.map((c) => c.phone).filter((p): p is string => Boolean(p));
  if (phone) phones.push(phone);

  const convos = ids.length
    ? await tx.db.select().from(conversations).where(and(eq(conversations.clinicId, tx.clinicId), inArray(conversations.contactId, ids)))
    : [];
  const appts = ids.length
    ? await tx.db.select().from(appointments).where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.contactId, ids)))
    : [];
  const txns = ids.length
    ? await tx.db.select().from(transactions).where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.contactId, ids)))
    : [];
  const consents = phones.length
    ? await tx.db.select().from(consentRecords).where(and(eq(consentRecords.clinicId, tx.clinicId), inArray(consentRecords.phone, phones)))
    : [];
  const supp = phones.length
    ? await tx.db.select().from(suppressions).where(and(eq(suppressions.clinicId, tx.clinicId), inArray(suppressions.phone, phones)))
    : [];
  const attempts = phones.length
    ? await tx.db.select().from(contactAttempts).where(and(eq(contactAttempts.clinicId, tx.clinicId), inArray(contactAttempts.phone, phones)))
    : [];
  const bookings = ids.length
    ? (await tx.db.select().from(bookingRequests).where(and(eq(bookingRequests.clinicId, tx.clinicId), inArray(bookingRequests.contactId, ids)))).map(withoutDigest)
    : [];
  // A call's handover the database missed linking is linked first, so it is
  // found through its conversation like the rest.
  await linkCallHandovers(tx);
  // The web chats their booking requests were made in, which erasing them
  // takes, with any handover asked there (lib/patient-rights/erasure.ts).
  const requestChats = [
    ...new Set(
      bookings
        .filter((b) => b.channel === "web_chat" && b.conversationId !== null)
        .map((b) => b.conversationId!),
    ),
  ];
  const asked =
    convos.length || phones.length || callback || requestChats.length
      ? await tx.db
          .select(HANDOVER_COLUMNS)
          .from(handovers)
          .where(
            and(
              eq(handovers.clinicId, tx.clinicId),
              or(
                convos.length ? inArray(handovers.conversationId, convos.map((v) => v.id)) : sql`false`,
                phones.length ? inArray(handovers.callbackPhone, phones) : sql`false`,
                callback ? eq(handovers.id, callback.handoverId) : sql`false`,
                requestChats.length ? inArray(handovers.conversationId, requestChats) : sql`false`,
              ),
            ),
          )
      : [];
  // Their missed calls, by their number (drizzle/0139).
  const missed = phones.length
    ? await tx.db
        .select()
        .from(missedContacts)
        .where(and(eq(missedContacts.clinicId, tx.clinicId), inArray(missedContacts.callerPhone, phones)))
    : [];
  // The web chat behind a call-back handover is the person's too, where no
  // one else's booking holds it (an amended one included: erasure keeps it
  // with its amendment, so access shows it). So is a chat their own booking request was made in.
  // The conversation row holds no contact to find either by.
  const known = new Set(convos.map((v) => v.id));
  const ownChats = requestChats.filter((id) => !known.has(id));
  const chatIds = [
    ...new Set(
      asked
        .map((h) => h.conversationId)
        .filter((id): id is string => id !== null && !known.has(id) && !ownChats.includes(id)),
    ),
  ];
  if (ownChats.length) {
    convos.push(
      ...(await tx.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.clinicId, tx.clinicId), inArray(conversations.id, ownChats), eq(conversations.channel, "web_chat")))),
    );
  }
  if (chatIds.length) {
    convos.push(
      ...(await tx.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.clinicId, tx.clinicId),
            inArray(conversations.id, chatIds),
            eq(conversations.channel, "web_chat"),
            isNull(conversations.contactId),
            sql`not exists (select 1 from booking_requests r where r.conversation_id = ${conversations.id})`,
            sql`not exists (select 1 from appointments a where a.conversation_id = ${conversations.id})`,
          ),
        )),
    );
  }
  const conversationAmendments = await amendmentsFor(tx, "conversation", convos.map((c) => c.id));
  const bookingAmendments = await amendmentsFor(tx, "booking_request", bookings.map((b) => b.id));
  const appointmentAmendments = await amendmentsFor(tx, "appointment", appts.map((a) => a.id));
  const holds = ids.length
    ? await tx.db
        .select({ id: slotHolds.id, startsAt: slotHolds.startsAt, endsAt: slotHolds.endsAt, status: slotHolds.status, createdAt: slotHolds.createdAt })
        .from(slotHolds)
        .where(and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.contactId, ids)))
    : [];
  const deposits = appts.length
    ? await tx.db
        .select(DEPOSIT_COLUMNS)
        .from(depositPayments)
        .where(and(eq(depositPayments.clinicId, tx.clinicId), inArray(depositPayments.appointmentId, appts.map((a) => a.id))))
    : [];


  const everyId = [
    ...ids,
    ...convos.map((c) => c.id),
    ...appts.map((a) => a.id),
    ...txns.map((t) => t.id),
    ...consents.map((c) => c.id),
    ...bookings.map((b) => b.id),
    ...[
      ...conversationAmendments.values(),
      ...bookingAmendments.values(),
      ...appointmentAmendments.values(),
    ]
      .flat()
      .map((a) => a.id),
    ...holds.map((h) => h.id),
    ...deposits.map((d) => d.id),
    ...asked.map((h) => h.id),
  ];
  const accounting = everyId.length
    ? await tx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.clinicId, tx.clinicId),
            or(
              inArray(auditLog.resourceId, everyId),
              sql`${auditLog.resourceIds} ?| array[${sql.join(everyId.map((v) => sql`${v}`), sql`, `)}]::text[]`,
            ),
          ),
        )
    : [];

  tx.audit.record({
    action: "export",
    resourceType: "patient_bundle",
    resourceIds: callback ? [...ids, callback.handoverId] : ids,
    resultCount: everyId.length,
    metadata: {
      requestedBy: query.requestedBy,
      rows: everyId.length,
      by: callback ? "handover" : contactId ? "contact_id" : "details",
    },
  });

  return {
    producedAt: new Date().toISOString(),
    contacts: found,
    conversations: withAmendments(convos, conversationAmendments),
    appointments: withAmendments(appts, appointmentAmendments),
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: withAmendments(bookings, bookingAmendments),
    depositPayments: deposits,
    handovers: asked,
    missedContacts: missed,
    slotHolds: holds,
    accountingOfDisclosures: accounting,
  };
}

/**
 * Amendment where the record can be changed: a real correction.
 *
 * BAA 1.5.1's clause 14(b), as of 1.3.0: "healdesk corrects a person's
 * contact details in its own copy." A contact's name, number and address are
 * those details, so the row changes, and the audit row says which fields
 * changed and who asked, never what they said: a "prior" that carried the
 * old name would keep the wrong data the amendment exists to remove. The
 * records healdesk does not rewrite (a booking request, an appointment, a conversation) take
 * an appended amendment instead (lib/patient-rights/amendments.ts). The operator's path is
 * `npm run ops:amend-contact` in apps/app's own shell (lib/ops/patient-entry.ts),
 * never apps/web; the portal's comes with M5.
 */
export async function amendContact(
  tx: TenantTx,
  contactId: string,
  changes: { fullName?: string | null; phone?: string | null; email?: string | null },
  /** One of PATIENT_REQUESTERS: the audit row outlives the contact, so it holds nothing typed. */
  requestedBy: PatientRequester,
): Promise<boolean> {
  if (!isPatientRequester(requestedBy)) {
    throw new Error("Who asked is one of the closed set (PATIENT_REQUESTERS), never typed.");
  }
  const [before] = await tx.db
    .select({ id: contacts.id, fullName: contacts.fullName, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)))
    .limit(1);
  if (!before) return false;
  await tx.db
    .update(contacts)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)));
  // The 30-day missed-contact record holds the number a call came from. A
  // corrected or cleared number is corrected there too, so the clinic's
  // "call back" list never keeps the wrong one (BAA clause 14(b)); a
  // correction that is not a dialable E.164 number clears it instead, as the
  // row's own check allows only that shape.
  if (changes.phone !== undefined && before.phone && changes.phone !== before.phone) {
    const corrected = changes.phone && /^\+[1-9][0-9]{6,14}$/.test(changes.phone) ? changes.phone : null;
    await tx.db
      .update(missedContacts)
      .set({ callerPhone: corrected })
      .where(and(eq(missedContacts.clinicId, tx.clinicId), eq(missedContacts.callerPhone, before.phone)));
  }
  tx.audit.record({
    action: "update",
    resourceType: "contact_amendment",
    resourceId: contactId,
    metadata: {
      requestedBy,
      fields: Object.keys(changes).join(","),
      // Which fields changed, not what they were: a "prior" that carried the
      // old name would keep the wrong data the amendment exists to remove.
      changed: Object.entries(changes)
        .filter(([k, v]) => (before as Record<string, unknown>)[k] !== v)
        .map(([k]) => k)
        .join(","),
    },
  });
  return true;
}

/**
 * The whole tenant, for the BAA's return clause at offboarding: every patient
 * row the clinic's data holds and the complete audit trail beside it. Same
 * shape as one patient's bundle so the same reader handles both. Its own audit
 * row is written for the export, which is the last accounting the clinic gets.
 */
/**
 * Why a whole clinic's bundle was produced, for its audit row: the return at
 * offboarding (the operator's script), or the clinic's own download from the
 * portal's Conversations screen, which it may take at any time.
 */
export type ClinicExportPurpose = "offboarding_return" | "portal_download";

export async function exportClinic(
  tx: TenantTx,
  requestedBy: PatientRequester,
  purpose: ClinicExportPurpose = "offboarding_return",
): Promise<PatientBundle> {
  assertRequester(requestedBy);
  if (purpose !== "offboarding_return" && purpose !== "portal_download") {
    throw new Error("An export's purpose is one of the closed set (ClinicExportPurpose).");
  }
  const c = tx.clinicId;
  const found = await tx.db.select().from(contacts).where(eq(contacts.clinicId, c));
  const convos = await tx.db.select().from(conversations).where(eq(conversations.clinicId, c));
  const appts = await tx.db.select().from(appointments).where(eq(appointments.clinicId, c));
  const txns = await tx.db.select().from(transactions).where(eq(transactions.clinicId, c));
  const consents = await tx.db.select().from(consentRecords).where(eq(consentRecords.clinicId, c));
  const supp = await tx.db.select().from(suppressions).where(eq(suppressions.clinicId, c));
  const attempts = await tx.db.select().from(contactAttempts).where(eq(contactAttempts.clinicId, c));
  const bookings = (await tx.db.select().from(bookingRequests).where(eq(bookingRequests.clinicId, c))).map(withoutDigest);
  const conversationAmendments = await amendmentsFor(tx, "conversation", convos.map((v) => v.id));
  const bookingAmendments = await amendmentsFor(tx, "booking_request", bookings.map((b) => b.id));
  const appointmentAmendments = await amendmentsFor(tx, "appointment", appts.map((a) => a.id));
  const holds = await tx.db
    .select({ id: slotHolds.id, startsAt: slotHolds.startsAt, endsAt: slotHolds.endsAt, status: slotHolds.status, createdAt: slotHolds.createdAt })
    .from(slotHolds)
    .where(eq(slotHolds.clinicId, c));
  const deposits = await tx.db.select(DEPOSIT_COLUMNS).from(depositPayments).where(eq(depositPayments.clinicId, c));
  const asked = await tx.db.select(HANDOVER_COLUMNS).from(handovers).where(eq(handovers.clinicId, c));
  const missed = await tx.db.select().from(missedContacts).where(eq(missedContacts.clinicId, c));
  const accounting = await tx.db.select().from(auditLog).where(eq(auditLog.clinicId, c));
  // Clause 17's "an export of the patient information it holds": the raw
  // payloads can hold a vendor's transcript, which no other table does, and
  // canceled.ts promises the leaving practice "your export of conversation
  // records" (the calendar session's re-audit, C19, 12 October 2026). Since
  // 13 October 2026 healdesk keeps no transcript of its own: each is emailed
  // to the practice (lib/conversations/transcript-outbox.ts).
  const payloads = (
    await tx.db.select().from(webhookEvents).where(eq(webhookEvents.clinicId, c))
  ).map(payloadRecord);
  const threads = await tx.db
    .select({
      channel: chatThreads.channel,
      partyRef: chatThreads.partyRef,
      conversationStartedAt: chatThreads.conversationStartedAt,
      lastInboundAt: chatThreads.lastInboundAt,
      conversationsCount: chatThreads.conversationsCount,
    })
    .from(chatThreads)
    .where(eq(chatThreads.clinicId, c));
  const drafts = await tx.db.select().from(metaBookingDrafts).where(eq(metaBookingDrafts.clinicId, c));

  const rows = found.length + convos.length + appts.length + txns.length + consents.length + payloads.length;
  tx.audit.record({
    action: "export",
    resourceType: "clinic_bundle",
    resourceId: c,
    resultCount: rows,
    metadata: { requestedBy, rows, purpose },
  });

  return {
    producedAt: new Date().toISOString(),
    contacts: found,
    conversations: withAmendments(convos, conversationAmendments),
    appointments: withAmendments(appts, appointmentAmendments),
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: withAmendments(bookings, bookingAmendments),
    depositPayments: deposits,
    handovers: asked,
    missedContacts: missed,
    slotHolds: holds,
    accountingOfDisclosures: accounting,
    rawPayloads: payloads,
    messagingThreads: threads,
    metaBookingDrafts: drafts,
  };
}

/** The desk's credential digest never leaves the row, even in a bundle the clinic asked for. */
function withoutDigest(row: typeof bookingRequests.$inferSelect): Omit<typeof bookingRequests.$inferSelect, "tokenHash"> {
  const { tokenHash: _digest, ...rest } = row;
  return rest;
}
